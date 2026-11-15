// S21c 单测：状态机（启停、端口捕获、退出收尾、分层启动、自动重启、诊断）。
//
// 这一块主要靠「事件 + 定时器 + 会话输出」三者交错，用对拍数据回放成本高、可读性差，
// 所以改为在 Go 侧直接把状态机推到各个分支，逐条断言运行态与事件。

package entries

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"mile-console/internal/contract"
	"mile-console/internal/platform"
)

type evRec struct {
	Name    string
	Payload any
}

type rtScanner struct {
	snap *contract.ScanSnapshot
	rows map[int]platform.ProcessRow
}

func (s *rtScanner) Snapshot() *contract.ScanSnapshot { return s.snap }
func (s *rtScanner) Table(_ context.Context, pids []int) (platform.ProcessTable, error) {
	t := platform.ProcessTable{ProcessMeta: platform.ProcessMeta{ByPid: map[int]platform.ProcessRow{}}}
	for _, p := range pids {
		if r, ok := s.rows[p]; ok {
			t.ByPid[p] = r
		}
	}
	return t, nil
}

type rtOwnership struct {
	assertErr error
	asserts   int
	verdict   contract.OwnershipVerdict
}

func (o *rtOwnership) AssertKillable(int, platform.ProcessMeta, string) (contract.OwnershipVerdict, error) {
	o.asserts++
	return o.verdict, o.assertErr
}

func (o *rtOwnership) Verify(int, platform.ProcessMeta) contract.OwnershipVerdict { return o.verdict }

type rtPlatform struct {
	fakePlatform
	rows []platform.ListenRow
}

func (p *rtPlatform) ReadListenPorts(context.Context) ([]platform.ListenRow, error) {
	return p.rows, nil
}

type rtRig struct {
	svc   *Service
	store *fakeStore
	sess  *fakeSessions
	scan  *rtScanner
	own   *rtOwnership
	plat  *rtPlatform

	mu     sync.Mutex
	clock  int64
	timers []*rtTimer
	events []evRec
	preOK  bool
	preErr error
	// preFail 按条目 id 让预检不过（分层启动要区分「前置失败」与「起不来」）。
	preFail map[string]bool
}

type rtTimer struct {
	rig     *rtRig
	ms      int64
	f       func()
	cleared bool
}

func (t *rtTimer) Stop() bool {
	t.rig.mu.Lock()
	defer t.rig.mu.Unlock()
	live := !t.cleared
	t.cleared = true
	return live
}

func newRTRig(t *testing.T, entries []contract.LaunchEntry) *rtRig {
	t.Helper()
	rec := &recorder{}
	rig := &rtRig{
		store: &fakeStore{cfg: contract.AppConfig{Entries: entries}, rec: rec},
		sess:  &fakeSessions{rec: rec, hist: map[string]string{}},
		scan:  &rtScanner{rows: map[int]platform.ProcessRow{}},
		own:   &rtOwnership{verdict: contract.OwnershipVerdict{Ownership: contract.OwnershipOwned}},
		plat:  &rtPlatform{},
		clock: 1_700_000_000_000,
		preOK: true,
	}
	rig.svc = New(context.Background(), rig.store, rig.plat, rig.sess, Options{
		Now: func() time.Time { return time.UnixMilli(rig.now()) },
		AfterFunc: func(d time.Duration, f func()) Timer {
			tm := &rtTimer{rig: rig, ms: d.Milliseconds(), f: f}
			rig.mu.Lock()
			rig.timers = append(rig.timers, tm)
			rig.mu.Unlock()
			return tm
		},
		// 轮询等待：把虚拟时钟跟着推 d，让 waitRunning / waitPortReleased 的 deadline 会到期
		After: func(d time.Duration) <-chan time.Time {
			rig.advance(d.Milliseconds())
			ch := make(chan time.Time, 1)
			ch <- time.UnixMilli(rig.now())
			return ch
		},
		Emit: func(name string, payload any) {
			rig.mu.Lock()
			rig.events = append(rig.events, evRec{name, payload})
			rig.mu.Unlock()
		},
		Scanner:   rig.scan,
		Ownership: rig.own,
		Which:     pathWhich,
		Precheck: func(_ context.Context, e contract.LaunchEntry, _ *contract.ScanSnapshot, _ []contract.LaunchEntry) (contract.PrecheckResult, error) {
			if rig.preErr != nil {
				return contract.PrecheckResult{}, rig.preErr
			}
			if rig.preFail[e.ID] {
				return contract.PrecheckResult{OK: false}, nil
			}
			return contract.PrecheckResult{OK: rig.preOK}, nil
		},
	})
	return rig
}

func writeFile(dir, name, body string) error {
	return os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644)
}

func (r *rtRig) now() int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.clock
}

func (r *rtRig) advance(ms int64) {
	r.mu.Lock()
	r.clock += ms
	r.mu.Unlock()
}

// fire 触发所有未清除的定时器（按毫秒数匹配，够这一层的用例用）。
func (r *rtRig) fire(ms int64) {
	r.mu.Lock()
	var due []*rtTimer
	for _, t := range r.timers {
		if !t.cleared && t.ms == ms {
			due = append(due, t)
		}
	}
	r.mu.Unlock()
	for _, t := range due {
		t.cleared = true
		t.f()
	}
}

func (r *rtRig) eventsOf(name string) []any {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []any
	for _, e := range r.events {
		if e.Name == name {
			out = append(out, e.Payload)
		}
	}
	return out
}

func (r *rtRig) runtimeOf(id string) contract.EntryRuntime {
	rt, _ := r.svc.RuntimeOf(id)
	return rt
}

// serviceDir 造一个有 package.json 的项目目录，让 Start 能走完脚本声明校验。
func serviceDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := writeFile(dir, "package.json", `{"scripts":{"dev":"next dev"}}`); err != nil {
		t.Fatal(err)
	}
	return dir
}

func mkServiceAt(id, dir string, over func(*contract.LaunchEntry)) contract.LaunchEntry {
	return mkEntry(id, func(e *contract.LaunchEntry) {
		e.Path = dir
		e.Script = strPtr("dev")
		if over != nil {
			over(e)
		}
	})
}

func TestStartBranches(t *testing.T) {
	rig := newRTRig(t, []contract.LaunchEntry{mkServiceAt("e1", serviceDir(t), nil)})
	ctx := context.Background()

	// 退出流程中
	rig.svc.BeginQuit()
	if _, err := rig.svc.Start(ctx, "e1"); err == nil || !strings.Contains(err.Error(), "正在退出") {
		t.Fatalf("退出中应拒绝启动，得到 %v", err)
	}
	rig.svc.mu.Lock()
	rig.svc.quitting = false
	rig.svc.mu.Unlock()

	// 停止中
	rig.svc.putRuntime(contract.EntryRuntime{EntryID: "e1", Status: contract.EntryStopping})
	if _, err := rig.svc.Start(ctx, "e1"); err == nil || !strings.Contains(err.Error(), "正在停止中") {
		t.Fatalf("stopping 应拒绝，得到 %v", err)
	}

	// 已在运行：直接返回现有运行态
	rig.svc.putRuntime(contract.EntryRuntime{EntryID: "e1", Status: contract.EntryRunning, SessionID: "s-old"})
	res, err := rig.svc.Start(ctx, "e1")
	if err != nil || !res.OK || res.Runtime == nil || res.Runtime.SessionID != "s-old" {
		t.Fatalf("运行中应直接返回现有运行态，得到 %+v %v", res, err)
	}

	// 预检不过：blocked + blocked 事件
	rig.svc.putRuntime(contract.EntryRuntime{EntryID: "e1", Status: contract.EntryIdle})
	rig.preOK = false
	res, err = rig.svc.Start(ctx, "e1")
	if err != nil || res.OK {
		t.Fatalf("预检不过应返回 ok=false，得到 %+v %v", res, err)
	}
	if got := rig.runtimeOf("e1").Status; got != contract.EntryBlocked {
		t.Fatalf("状态 = %s，期望 blocked", got)
	}
	if len(rig.eventsOf("blocked")) != 1 {
		t.Fatal("blocked 事件没发出")
	}

	// spawn 抛错（脚本不在 scripts 里）：blocked + 错误上抛
	rig.preOK = true
	rig.store.cfg.Entries[0].Script = strPtr("nope")
	if _, err := rig.svc.Start(ctx, "e1"); err == nil {
		t.Fatal("非法脚本应报错")
	}
	if got := rig.runtimeOf("e1").Status; got != contract.EntryBlocked {
		t.Fatalf("spawn 失败后状态 = %s，期望 blocked", got)
	}
}

func TestAbsorbCapturesPortOnce(t *testing.T) {
	rig := newRTRig(t, []contract.LaunchEntry{mkServiceAt("e1", serviceDir(t), nil)})
	rig.store.cfg.Entries[0].Path = t.TempDir()
	if err := writeFile(rig.store.cfg.Entries[0].Path, "package.json", `{"scripts":{"dev":"next dev"}}`); err != nil {
		t.Fatal(err)
	}
	if _, err := rig.svc.Start(context.Background(), "e1"); err != nil {
		t.Fatal(err)
	}
	if got := rig.runtimeOf("e1").Status; got != contract.EntryStarting {
		t.Fatalf("启动后状态 = %s", got)
	}

	rig.sess.emitData("sess-1", "Local: http://localhost:5173/\n")
	rt := rig.runtimeOf("e1")
	if rt.Status != contract.EntryRunning || rt.Port == nil || *rt.Port != 5173 {
		t.Fatalf("端口没捕获到：%+v", rt)
	}
	if got := rig.store.cfg.Entries[0].ExpectedPort; got == nil || *got != 5173 {
		t.Fatalf("端口没回填到配置：%v", got)
	}

	// 第二次输出不再改写
	rig.sess.emitData("sess-1", "port 9999")
	if rt := rig.runtimeOf("e1"); rt.Port == nil || *rt.Port != 5173 {
		t.Fatalf("端口被后来的输出改写：%+v", rt)
	}

	// 旧会话的迟到输出不算数
	rig.store.cfg.Entries[0].Script = strPtr("dev")
	rig.svc.putRuntime(contract.EntryRuntime{EntryID: "e1", Status: contract.EntryStarting, SessionID: "sess-2"})
	rig.svc.mu.Lock()
	rig.svc.watches["sess-1"] = &Watch{EntryID: "e1"}
	rig.svc.mu.Unlock()
	rig.sess.emitData("sess-1", "port 8080")
	if rt := rig.runtimeOf("e1"); rt.Status != contract.EntryStarting {
		t.Fatalf("旧会话的输出改写了运行态：%+v", rt)
	}
}

func TestCaptureTimeoutMarksPortUnknown(t *testing.T) {
	rig := newRTRig(t, []contract.LaunchEntry{mkServiceAt("e1", serviceDir(t), nil)})
	rig.svc.putRuntime(contract.EntryRuntime{EntryID: "e1", Status: contract.EntryStarting, SessionID: "s1"})
	rig.svc.onCaptureTimeout("e1", "s1")
	rt := rig.runtimeOf("e1")
	if rt.Status != contract.EntryRunning || !rt.PortUnknown {
		t.Fatalf("超时应转 running + portUnknown：%+v", rt)
	}
	// 不是当前会话 / 不是 starting：都不动
	rig.svc.putRuntime(contract.EntryRuntime{EntryID: "e1", Status: contract.EntryStarting, SessionID: "s1"})
	rig.svc.onCaptureTimeout("e1", "other")
	if rt := rig.runtimeOf("e1"); rt.Status != contract.EntryStarting {
		t.Fatal("别的会话的超时不该改状态")
	}
}

func TestSessionExitStatuses(t *testing.T) {
	cases := []struct {
		name    string
		kind    contract.EntryKind
		code    int
		stopped bool
		want    contract.EntryStatus
	}{
		{"服务正常退出", contract.EntryKindService, 0, false, contract.EntryStopped},
		{"服务崩溃", contract.EntryKindService, 1, false, contract.EntryCrashed},
		{"用户停止", contract.EntryKindService, 1, true, contract.EntryStopped},
		{"任务成功", contract.EntryKindTask, 0, false, contract.EntrySucceeded},
		{"任务失败", contract.EntryKindTask, 2, false, contract.EntryFailed},
		{"任务取消码", contract.EntryKindTask, 130, false, contract.EntryCanceled},
		{"任务被用户停", contract.EntryKindTask, 1, true, contract.EntryStopped},
	}
	for _, c := range cases {
		rig := newRTRig(t, []contract.LaunchEntry{mkServiceAt("e1", serviceDir(t), func(e *contract.LaunchEntry) { e.Kind = c.kind })})
		rig.svc.putRuntime(contract.EntryRuntime{EntryID: "e1", Status: contract.EntryRunning, SessionID: "s1"})
		rig.svc.mu.Lock()
		rig.svc.watches["s1"] = &Watch{EntryID: "e1", Captured: true, StoppedByUser: c.stopped}
		rig.svc.mu.Unlock()
		rig.sess.hist["s1"] = "\x1b[31mError: boom happened\x1b[0m\nlast line\n"
		rig.sess.emitData("s1", "Error: boom happened")
		rig.svc.onSessionExit("s1", c.code)
		rt := rig.runtimeOf("e1")
		if rt.Status != c.want {
			t.Errorf("%s：状态 = %s，期望 %s", c.name, rt.Status, c.want)
		}
		if rt.ExitCode == nil || *rt.ExitCode != c.code {
			t.Errorf("%s：退出码 = %v", c.name, rt.ExitCode)
		}
		// 留档：最后一行错误与尾部输出
		diag, err := rig.svc.Diagnose(context.Background(), "e1")
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(diag.LastErrorLine, "boom") {
			t.Errorf("%s：诊断没留到错误行 %q", c.name, diag.LastErrorLine)
		}
		if len(diag.TailLines) != 2 {
			t.Errorf("%s：尾部行数 = %d", c.name, len(diag.TailLines))
		}
	}
}

func TestTaskDoneAndCrashEvents(t *testing.T) {
	rig := newRTRig(t, []contract.LaunchEntry{mkServiceAt("task", serviceDir(t), func(e *contract.LaunchEntry) { e.Kind = contract.EntryKindTask })})
	rig.svc.putRuntime(contract.EntryRuntime{EntryID: "task", Status: contract.EntryRunning, SessionID: "s1"})
	rig.svc.mu.Lock()
	rig.svc.watches["s1"] = &Watch{EntryID: "task", Captured: true}
	rig.svc.mu.Unlock()
	rig.svc.onSessionExit("s1", 0)
	if len(rig.eventsOf("taskDone")) != 1 {
		t.Fatal("任务完成事件没发出")
	}
	if len(rig.eventsOf("crashed")) != 0 {
		t.Fatal("任务不该发 crashed")
	}

	rig2 := newRTRig(t, []contract.LaunchEntry{mkServiceAt("svc", serviceDir(t), nil)})
	rig2.svc.putRuntime(contract.EntryRuntime{EntryID: "svc", Status: contract.EntryRunning, SessionID: "s1"})
	rig2.svc.mu.Lock()
	rig2.svc.watches["s1"] = &Watch{EntryID: "svc", Captured: true}
	rig2.svc.mu.Unlock()
	rig2.svc.onSessionExit("s1", 3)
	if len(rig2.eventsOf("crashed")) != 1 {
		t.Fatal("崩溃事件没发出")
	}
}

func TestAutoRestartBackoffAndCap(t *testing.T) {
	entry := mkServiceAt("e1", serviceDir(t), func(e *contract.LaunchEntry) {
		yes := true
		e.AutoRestart = &yes
	})
	rig := newRTRig(t, []contract.LaunchEntry{entry})
	ctx := context.Background()

	// 第一次崩溃：排 2000ms
	rig.svc.putRuntime(contract.EntryRuntime{EntryID: "e1", Status: contract.EntryRunning, SessionID: "s1"})
	rig.svc.mu.Lock()
	rig.svc.watches["s1"] = &Watch{EntryID: "e1", Captured: true, Dev: true}
	rig.svc.mu.Unlock()
	rig.store.cfg.Entries[0].Name = "服务一"
	rig.svc.onSessionExit("s1", 1)
	rt := rig.runtimeOf("e1")
	if rt.AutoRestart == nil || rt.AutoRestart.Attempt != 1 || rt.AutoRestart.NextAt != rig.now()+2000 {
		t.Fatalf("第一次重启排程不对：%+v", rt.AutoRestart)
	}

	// 让定时器触发：会再次 Start（这里预检通过，会话起得来）
	rig.fire(2000)
	if len(rig.eventsOf("warning")) != 0 {
		t.Fatalf("重启不该报错：%v", rig.eventsOf("warning"))
	}

	// 再崩两次，第三次超过上限
	for i := 0; i < 2; i++ {
		rig.svc.putRuntime(contract.EntryRuntime{EntryID: "e1", Status: contract.EntryRunning, SessionID: "s" + string(rune('a'+i))})
		sid := "s" + string(rune('a'+i))
		rig.svc.mu.Lock()
		rig.svc.watches[sid] = &Watch{EntryID: "e1", Captured: true, Dev: true}
		rig.svc.mu.Unlock()
		rig.svc.onSessionExit(sid, 1)
		if i == 0 {
			rig.fire(8000)
		}
	}
	// 第三次崩溃 → 第 3 次尝试，退避 30000
	if rt := rig.runtimeOf("e1"); rt.AutoRestart == nil || rt.AutoRestart.Attempt != 3 {
		t.Fatalf("第三次尝试不对：%+v", rt.AutoRestart)
	}
	rig.fire(30000)

	// 第四次崩溃：窗口内已 3 次，放弃
	rig.svc.putRuntime(contract.EntryRuntime{EntryID: "e1", Status: contract.EntryRunning, SessionID: "sz"})
	rig.svc.mu.Lock()
	rig.svc.watches["sz"] = &Watch{EntryID: "e1", Captured: true, Dev: true}
	rig.svc.mu.Unlock()
	rig.svc.onSessionExit("sz", 1)
	rt = rig.runtimeOf("e1")
	if rt.AutoRestartGaveUp == nil || !*rt.AutoRestartGaveUp {
		t.Fatalf("超过上限应标 gaveUp：%+v", rt)
	}
	if len(rig.eventsOf("autoRestartGaveUp")) != 1 {
		t.Fatal("gaveUp 事件没发出")
	}
	_ = ctx
}

func TestAutoRestartSkippedWhenNotDevOrRegisterOnly(t *testing.T) {
	yes := true
	for _, c := range []struct {
		name string
		mut  func(*contract.LaunchEntry)
	}{
		{"生产环境", func(e *contract.LaunchEntry) { e.AutoRestart = &yes; e.GroupID = "g2" }},
		{"仅登记", func(e *contract.LaunchEntry) { e.AutoRestart = &yes; e.RegisterOnly = true }},
		{"没开自动重启", func(e *contract.LaunchEntry) {}},
	} {
		rig := newRTRig(t, []contract.LaunchEntry{mkServiceAt("e1", serviceDir(t), c.mut)})
		rig.store.cfg.Groups = []contract.ProjectGroup{{ID: "g2", Env: contract.GroupEnvProd}}
		rig.svc.putRuntime(contract.EntryRuntime{EntryID: "e1", Status: contract.EntryRunning, SessionID: "s1"})
		rig.svc.mu.Lock()
		rig.svc.watches["s1"] = &Watch{EntryID: "e1", Captured: true, Dev: true}
		rig.svc.mu.Unlock()
		rig.svc.onSessionExit("s1", 1)
		if rt := rig.runtimeOf("e1"); rt.AutoRestart != nil {
			t.Errorf("%s：不该排重启 %+v", c.name, rt.AutoRestart)
		}
	}
}

// 前置没起来：依赖它的条目跳过并写明原因，后续层不会硬起。
func TestStartOrderedSkipsWhenPrerequisiteFailed(t *testing.T) {
	dirA, dirB := serviceDir(t), serviceDir(t)
	rig := newRTRig(t, []contract.LaunchEntry{
		mkServiceAt("a", dirA, nil),
		mkServiceAt("b", dirB, func(e *contract.LaunchEntry) { e.StartAfter = []string{"a"} }),
	})
	rig.preFail = map[string]bool{"a": true}

	res := rig.svc.StartOrdered(context.Background(), []string{"a", "b"})
	if len(res) != 2 {
		t.Fatalf("结果数 = %d", len(res))
	}
	if res[0].ID != "a" || res[0].OK || res[0].Precheck == nil {
		t.Fatalf("a 应是预检不过：%+v", res[0])
	}
	if res[1].ID != "b" || res[1].OK || !strings.Contains(res[1].Skipped, "前置服务没起来") {
		t.Fatalf("b 应被跳过：%+v", res[1])
	}
}

// 起完没进 running：超时后报「启动后没有进入运行中」。
func TestStartOrderedTimeoutReportsNotRunning(t *testing.T) {
	rig := newRTRig(t, []contract.LaunchEntry{mkServiceAt("a", serviceDir(t), nil)})
	res := rig.svc.StartOrdered(context.Background(), []string{"a"})
	if len(res) != 1 {
		t.Fatalf("结果数 = %d", len(res))
	}
	if res[0].OK || res[0].Skipped != "启动后没有进入运行中" {
		t.Fatalf("应报未进入运行中：%+v", res[0])
	}
}

func TestStopRejectsWhenOwnershipFails(t *testing.T) {
	rig := newRTRig(t, []contract.LaunchEntry{mkServiceAt("e1", serviceDir(t), nil)})
	pid := 4000
	rig.svc.putRuntime(contract.EntryRuntime{EntryID: "e1", Status: contract.EntryRunning, SessionID: "s1", Pid: &pid})
	rig.own.assertErr = errors.New("拒绝终止 PID 4000：归属判定为 external")
	if _, err := rig.svc.Stop(context.Background(), "e1"); err == nil {
		t.Fatal("归属校验失败时应拒绝停止")
	}
	if got := rig.runtimeOf("e1").Status; got != contract.EntryRunning {
		t.Fatalf("归属校验失败后状态 = %s，应保持 running", got)
	}

	// 校验通过：转 stopping 并给会话发停止
	rig.own.assertErr = nil
	rt, err := rig.svc.Stop(context.Background(), "e1")
	if err != nil {
		t.Fatal(err)
	}
	if rt.Status != contract.EntryStopping {
		t.Fatalf("状态 = %s", rt.Status)
	}
	calls := rig.store.rec.callsSince(0)
	found := false
	for _, c := range calls {
		if arr, ok := c.([]any); ok && len(arr) == 2 && arr[0] == "sessions.stop" && arr[1] == "s1" {
			found = true
		}
	}
	if !found {
		t.Fatal("没有给会话发停止")
	}
}

func TestDiagnoseExcludesOwnListeners(t *testing.T) {
	rig := newRTRig(t, []contract.LaunchEntry{mkServiceAt("e1", serviceDir(t), func(e *contract.LaunchEntry) {
		port := 3000
		e.ExpectedPort = &port
		e.Env = map[string]string{"B": "2", "A": "1"}
	})})
	pid := 4000
	rig.svc.putRuntime(contract.EntryRuntime{EntryID: "e1", Status: contract.EntryRunning, SessionID: "s1", Pid: &pid})
	// 端口上有两个监听：自己的 4000 与别人的 5555，排除自己后应报 5555
	rig.plat.rows = []platform.ListenRow{{Pid: 4000, Port: 3000}, {Pid: 5555, Port: 3000}}
	rig.scan.rows[5555] = platform.ProcessRow{Pid: 5555, Name: "node.exe"}

	diag, err := rig.svc.Diagnose(context.Background(), "e1")
	if err != nil {
		t.Fatal(err)
	}
	if diag.PortHolder == nil || diag.PortHolder.Pid != 5555 {
		t.Fatalf("端口持有者应是 5555：%+v", diag.PortHolder)
	}
	if diag.PortHolder.ProcessName != "node.exe" {
		t.Fatalf("进程名 = %q", diag.PortHolder.ProcessName)
	}
	if strings.Join(diag.EnvKeys, ",") != "A,B" {
		t.Fatalf("环境变量键 = %v", diag.EnvKeys)
	}
}

func TestCaptureTimeoutIgnoresNonStarting(t *testing.T) {
	rig := newRTRig(t, []contract.LaunchEntry{mkServiceAt("e1", serviceDir(t), nil)})
	rig.svc.putRuntime(contract.EntryRuntime{EntryID: "e1", Status: contract.EntryRunning, SessionID: "s1"})
	rig.svc.onCaptureTimeout("e1", "s1")
	if rt := rig.runtimeOf("e1"); rt.Status != contract.EntryRunning || rt.PortUnknown {
		t.Fatalf("非 starting 不该被改写：%+v", rt)
	}
}

func TestWaitPortReleasedOnlyCaresAboutOwnPids(t *testing.T) {
	rig := newRTRig(t, []contract.LaunchEntry{mkServiceAt("e1", serviceDir(t), nil)})
	// 端口上还有别人在听，但本条目自己的监听已经放手 → 立刻算释放
	rig.plat.rows = []platform.ListenRow{{Pid: 9999, Port: 3000}}
	if !rig.svc.waitPortReleased(context.Background(), 3000, map[int]bool{4000: true}, "e1") {
		t.Fatal("自有 PID 已经不在监听表里，应判释放")
	}
	// 自己的还在听 → 等满 5 秒后告警
	rig.plat.rows = []platform.ListenRow{{Pid: 4000, Port: 3000}}
	before := len(rig.eventsOf("warning"))
	if rig.svc.waitPortReleased(context.Background(), 3000, map[int]bool{4000: true}, "e1") {
		t.Fatal("自有 PID 还在听，应判未释放")
	}
	if len(rig.eventsOf("warning")) != before+1 {
		t.Fatal("未释放应发一条告警")
	}
	if len(rig.eventsOf("portUnreleased")) != 1 {
		t.Fatal("未释放应发 portUnreleased")
	}
}

func TestAutoRestartIgnoresOldHistoryOutsideWindow(t *testing.T) {
	yes := true
	rig := newRTRig(t, []contract.LaunchEntry{mkServiceAt("e1", serviceDir(t), func(e *contract.LaunchEntry) {
		e.AutoRestart = &yes
	})})
	// 三次重启都在 11 分钟之前：窗口外的历史不该计入上限
	old := rig.now() - AutoRestartWindowMS - 60_000
	rig.svc.mu.Lock()
	rig.svc.restartHistory["e1"] = []int64{old, old + 1, old + 2}
	rig.svc.mu.Unlock()

	rig.svc.putRuntime(contract.EntryRuntime{EntryID: "e1", Status: contract.EntryRunning, SessionID: "s1"})
	rig.svc.mu.Lock()
	rig.svc.watches["s1"] = &Watch{EntryID: "e1", Captured: true, Dev: true}
	rig.svc.mu.Unlock()
	rig.svc.onSessionExit("s1", 1)
	rt := rig.runtimeOf("e1")
	if rt.AutoRestartGaveUp != nil && *rt.AutoRestartGaveUp {
		t.Fatal("窗口外的历史不该触发放弃")
	}
	if rt.AutoRestart == nil || rt.AutoRestart.Attempt != 1 {
		t.Fatalf("应重新从第 1 次算：%+v", rt.AutoRestart)
	}
}

func TestAutoRestartBackoffSequence(t *testing.T) {
	yes := true
	// 第 4 次会撞到窗口内的 3 次上限（由下一个用例覆盖），这里只验前三档退避
	want := []int64{2000, 8000, 30_000}
	for i, w := range want {
		rig := newRTRig(t, []contract.LaunchEntry{mkServiceAt("e1", serviceDir(t), func(e *contract.LaunchEntry) {
			e.AutoRestart = &yes
		})})
		now := rig.now()
		rig.svc.mu.Lock()
		hist := make([]int64, i)
		for k := range hist {
			hist[k] = now - 1000
		}
		rig.svc.restartHistory["e1"] = hist
		rig.svc.mu.Unlock()

		rig.svc.putRuntime(contract.EntryRuntime{EntryID: "e1", Status: contract.EntryRunning, SessionID: "s1"})
		rig.svc.mu.Lock()
		rig.svc.watches["s1"] = &Watch{EntryID: "e1", Captured: true, Dev: true}
		rig.svc.mu.Unlock()
		rig.svc.onSessionExit("s1", 1)

		rt := rig.runtimeOf("e1")
		if rt.AutoRestart == nil {
			t.Fatalf("第 %d 次应排重启", i+1)
		}
		if got := rt.AutoRestart.NextAt - now; got != w {
			t.Fatalf("第 %d 次退避 = %d，期望 %d", i+1, got, w)
		}
	}
}

func TestReadyHistoryKeepsLastTen(t *testing.T) {
	rig := newRTRig(t, []contract.LaunchEntry{mkServiceAt("e1", serviceDir(t), nil)})
	started := rig.now() - 100
	rig.svc.putRuntime(contract.EntryRuntime{EntryID: "e1", Status: contract.EntryRunning, SessionID: "s1", StartedAt: &started})
	for i := 0; i < ReadyHistory+2; i++ {
		rig.svc.recordReady("e1", contract.ReadyPort)
	}
	rt := rig.runtimeOf("e1")
	if len(rt.ReadyHistory) != ReadyHistory {
		t.Fatalf("历史长度 = %d，期望 %d", len(rt.ReadyHistory), ReadyHistory)
	}
	if rt.ReadyMs == nil || *rt.ReadyMs != 100 {
		t.Fatalf("本次耗时 = %v", rt.ReadyMs)
	}
}

func TestOwnListenPidsMergesSnapshot(t *testing.T) {
	rig := newRTRig(t, []contract.LaunchEntry{mkServiceAt("e1", serviceDir(t), nil)})
	pid := 4000
	rig.svc.putRuntime(contract.EntryRuntime{EntryID: "e1", Status: contract.EntryRunning, SessionID: "s1", Pid: &pid})
	rig.scan.snap = &contract.ScanSnapshot{Listeners: []contract.ListenerSnapshot{
		{Pid: 5000, EntryID: "e1"},
		{Pid: 6000, EntryID: "e2"},
	}}
	own := rig.svc.OwnListenPids("e1")
	if !own[4000] || !own[5000] {
		t.Fatalf("自有 PID 并集不对：%v", own)
	}
	if own[6000] {
		t.Fatal("别的条目的监听不该算进来")
	}
}

// 端口与已有 expectedPort 相同：不写盘，免得每次启动都轮转一次 .bak。
func TestAbsorbSkipsWriteWhenPortUnchanged(t *testing.T) {
	dir := serviceDir(t)
	rig := newRTRig(t, []contract.LaunchEntry{mkServiceAt("e1", dir, func(e *contract.LaunchEntry) {
		p := 5173
		e.ExpectedPort = &p
	})})
	if _, err := rig.svc.Start(context.Background(), "e1"); err != nil {
		t.Fatal(err)
	}
	before := len(rig.store.rec.callsSince(0))
	rig.sess.emitData("sess-1", "Local: http://localhost:5173/\n")
	after := rig.store.rec.callsSince(before)
	for _, c := range after {
		if arr, ok := c.([]any); ok && arr[0] == "config.patch" {
			t.Fatalf("端口没变不该写盘：%v", after)
		}
	}
}

// 退出后诊断里要看得到上次运行时长。
func TestDiagnoseReportsLastRunMs(t *testing.T) {
	rig := newRTRig(t, []contract.LaunchEntry{mkServiceAt("e1", serviceDir(t), nil)})
	started := rig.now() - 1500
	rig.svc.putRuntime(contract.EntryRuntime{EntryID: "e1", Status: contract.EntryRunning, SessionID: "s1", StartedAt: &started})
	rig.svc.mu.Lock()
	rig.svc.watches["s1"] = &Watch{EntryID: "e1", Captured: true}
	rig.svc.mu.Unlock()
	rig.svc.onSessionExit("s1", 0)
	diag, err := rig.svc.Diagnose(context.Background(), "e1")
	if err != nil {
		t.Fatal(err)
	}
	if diag.LastRunMs == nil || *diag.LastRunMs != 1500 {
		t.Fatalf("运行时长 = %v", diag.LastRunMs)
	}
}

// 退出流程开始后不再排自动重启，否则每次关窗都会被当成崩溃互相拉起。
func TestBeginQuitStopsAutoRestart(t *testing.T) {
	yes := true
	rig := newRTRig(t, []contract.LaunchEntry{mkServiceAt("e1", serviceDir(t), func(e *contract.LaunchEntry) {
		e.AutoRestart = &yes
	})})
	rig.svc.BeginQuit()
	rig.svc.putRuntime(contract.EntryRuntime{EntryID: "e1", Status: contract.EntryRunning, SessionID: "s1"})
	rig.svc.mu.Lock()
	rig.svc.watches["s1"] = &Watch{EntryID: "e1", Captured: true, Dev: true}
	rig.svc.mu.Unlock()
	rig.svc.onSessionExit("s1", 1)
	if rt := rig.runtimeOf("e1"); rt.AutoRestart != nil {
		t.Fatalf("退出流程中不该排重启：%+v", rt.AutoRestart)
	}
}

// 只有 running 时才记启动耗时。
func TestRecordReadyRequiresRunning(t *testing.T) {
	rig := newRTRig(t, []contract.LaunchEntry{mkServiceAt("e1", serviceDir(t), nil)})
	started := rig.now() - 100
	rig.svc.putRuntime(contract.EntryRuntime{EntryID: "e1", Status: contract.EntryStarting, SessionID: "s1", StartedAt: &started})
	rig.svc.recordReady("e1", contract.ReadyPort)
	if rt := rig.runtimeOf("e1"); rt.ReadyMs != nil {
		t.Fatalf("非 running 不该记耗时：%v", rt.ReadyMs)
	}
}
