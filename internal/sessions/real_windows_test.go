//go:build windows

// S18 真进程验收：真 ConPTY + 真 PowerShell + 真 ownership + 真进程表。
// 覆盖：中文写入与回读、resize 生效、kill 后整棵进程树退出（日志证据）、disposeAll 等待全部 kill、
// Close 之后 Read 返回错误。只起 PowerShell 与系统自带的 ping.exe，不执行任何项目代码。

package sessions

import (
	"context"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"mile-console/internal/contract"
	"mile-console/internal/ownership"
	"mile-console/internal/platform"
	"mile-console/internal/platform/win32"
)

// realScanner 只取进程元信息（kill 重验用），不扫监听端口。
type realScanner struct{ plat *win32.Win32 }

func (s realScanner) Table(ctx context.Context, _ []int) (platform.ProcessTable, error) {
	meta, err := s.plat.ReadProcessMeta(ctx)
	return platform.ProcessTable{ProcessMeta: meta}, err
}

type realRig struct {
	svc  *Service
	plat *win32.Win32
	mu   sync.Mutex
	out  map[string]*strings.Builder
}

func newRealRig(t *testing.T) *realRig {
	t.Helper()
	r := &realRig{plat: win32.New(), out: map[string]*strings.Builder{}}
	own := ownership.New(func() int64 { return time.Now().UnixMilli() })
	r.svc = New(context.Background(), r.plat, own, Options{})
	r.svc.SetScanner(realScanner{r.plat})
	r.svc.OnData(func(e contract.SessionDataEvent) {
		r.mu.Lock()
		defer r.mu.Unlock()
		b := r.out[e.ID]
		if b == nil {
			b = &strings.Builder{}
			r.out[e.ID] = b
		}
		b.WriteString(e.Chunk)
	})
	t.Cleanup(func() { r.svc.DisposeAll(context.Background()) })
	return r
}

func (r *realRig) text(id string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if b := r.out[id]; b != nil {
		return b.String()
	}
	return ""
}

func (r *realRig) await(t *testing.T, id, sub string) string {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for {
		if out := r.text(id); strings.Contains(out, sub) {
			return out
		}
		if time.Now().After(deadline) {
			t.Fatalf("等 %q 超时，输出末尾：%q", sub, realTail(r.text(id), 400))
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func realTail(s string, n int) string {
	if len(s) > n {
		return s[len(s)-n:]
	}
	return s
}

func (r *realRig) shell(t *testing.T) contract.SessionMeta {
	t.Helper()
	m, err := r.svc.CreateShell(contract.CreateShellSessionInput{Kind: contract.SessionKindShell}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("会话 %s pid=%d command=%q", m.ID, m.Pid, m.Command)
	return m
}

// query 取「标记=值=尾标记」之间的内容；标记都拆开拼接，回显里不会出现完整标记。
func (r *realRig) query(t *testing.T, id, expr string) string {
	t.Helper()
	cmd := `Write-Output ("RES" + "ULT=" + (` + expr + `) + "=E" + "ND")` + "\r"
	from := len(r.text(id))
	if err := r.svc.Write(id, cmd); err != nil {
		t.Fatal(err)
	}
	// 只看本次写入之后的输出，避免匹配到上一次查询的结果
	deadline := time.Now().Add(15 * time.Second)
	var out string
	for {
		out = r.text(id)[from:]
		if strings.Contains(out, "=END") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("等查询结果超时，输出末尾：%q", realTail(out, 400))
		}
		time.Sleep(20 * time.Millisecond)
	}
	i := strings.LastIndex(out, "RESULT=")
	j := strings.LastIndex(out, "=END")
	if i < 0 || j < i {
		t.Fatalf("没取到结果：%q", realTail(out, 400))
	}
	return out[i+len("RESULT=") : j]
}

func TestRealShellChineseAndResize(t *testing.T) {
	r := newRealRig(t)
	m := r.shell(t)

	// 中文经 PTY 写入，再由 PowerShell 处理后回读
	got := r.query(t, m.ID, `"中文" + "回读" + "测试".Length`)
	if got != "中文回读2" {
		t.Fatalf("中文回读得到 %q", got)
	}
	t.Logf("中文回读：%q", got)

	r.svc.Resize(m.ID, 100, 40)
	time.Sleep(300 * time.Millisecond)
	size := r.query(t, m.ID, `"" + $Host.UI.RawUI.WindowSize.Width + "x" + $Host.UI.RawUI.WindowSize.Height`)
	if size != "100x40" {
		t.Fatalf("resize 后窗口 %q，期望 100x40", size)
	}
	t.Logf("resize 生效：%s", size)

	if hist := r.svc.History(m.ID); !strings.Contains(hist, "中文回读2") {
		t.Fatalf("history 里没有回读结果")
	}
	if strings.ContainsRune(r.text(m.ID), 0xFFFD) {
		t.Fatalf("输出里出现替换符：%q", realTail(r.text(m.ID), 400))
	}
}

// ping 作为 shell 的子进程跑着；kill 之后 shell 与 ping 都必须退出。
func realSpawnPing(t *testing.T, r *realRig, m contract.SessionMeta) int {
	t.Helper()
	if err := r.svc.Write(m.ID, "Start-Process -FilePath ping.exe -ArgumentList '-n','120','127.0.0.1' -NoNewWindow\r"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		meta, err := r.plat.ReadProcessMeta(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		for pid, row := range meta.ByPid {
			if row.Ppid == m.Pid && strings.EqualFold(row.Name, "ping.exe") {
				return pid
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("会话 %s 下没找到 ping.exe 子进程", m.ID)
	return 0
}

func realWaitDead(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for pidAlive(pid) {
		if time.Now().After(deadline) {
			t.Fatalf("PID %d 在 kill 之后仍存活", pid)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestRealKillTakesWholeTree(t *testing.T) {
	r := newRealRig(t)
	m := r.shell(t)
	r.await(t, m.ID, "PS ")
	child := realSpawnPing(t, r, m)
	if !pidAlive(m.Pid) || !pidAlive(child) {
		t.Fatalf("kill 前应存活：shell=%v ping=%v", pidAlive(m.Pid), pidAlive(child))
	}
	t.Logf("kill 前：shell pid=%d 存活，ping pid=%d（父 %d）存活", m.Pid, child, m.Pid)

	start := time.Now()
	r.svc.Kill(context.Background(), m.ID)
	realWaitDead(t, m.Pid)
	realWaitDead(t, child)
	t.Logf("kill 后 %v：shell pid=%d 已退出，ping pid=%d 已退出", time.Since(start).Round(time.Millisecond), m.Pid, child)

	deadline := time.Now().Add(5 * time.Second)
	for {
		list := r.svc.List()
		if len(list) == 1 && (list[0].Status == contract.SessionStatusStopped || list[0].Status == contract.SessionStatusCrashed) {
			t.Logf("会话状态：%s exitCode=%v", list[0].Status, realCode(list[0].ExitCode))
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("kill 后会话状态没变成已结束：%+v", list)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if n := len(r.svc.OwnedPids()); n != 0 {
		t.Fatalf("kill 后仍登记 %d 个 pid", n)
	}
}

func realCode(p *int) string {
	if p == nil {
		return "nil"
	}
	return strconv.Itoa(*p)
}

func TestRealDisposeAllWaitsForKills(t *testing.T) {
	r := newRealRig(t)
	a := r.shell(t)
	b := r.shell(t)
	r.await(t, a.ID, "PS ")
	r.await(t, b.ID, "PS ")
	childA := realSpawnPing(t, r, a)
	childB := realSpawnPing(t, r, b)

	start := time.Now()
	r.svc.DisposeAll(context.Background())
	took := time.Since(start).Round(time.Millisecond)
	// DisposeAll 返回时 KillTree 已确认结束：这里不再等待，直接查
	for _, pid := range []int{a.Pid, b.Pid, childA, childB} {
		if pidAlive(pid) {
			t.Fatalf("DisposeAll 返回后 PID %d 仍存活", pid)
		}
	}
	t.Logf("DisposeAll 用时 %v，返回时 shell %d/%d 与 ping %d/%d 全部已退出", took, a.Pid, b.Pid, childA, childB)
	if r.svc.LiveCount() != 0 || len(r.svc.List()) != 0 {
		t.Fatal("DisposeAll 后仍有会话")
	}
}

// S02 遗留：Close 之后 Read 必须返回错误或 EOF，pump 才会结束。
func TestRealReadAfterCloseFails(t *testing.T) {
	plat := win32.New()
	sh := plat.DefaultShell()
	p, err := StartPTY(PTYOptions{Path: sh.File, Args: append([]string{sh.File}, plat.ShellArgs(sh.File)...), Cols: 80, Rows: 25})
	if err != nil {
		t.Fatal(err)
	}
	defer plat.KillTree(context.Background(), p.Pid())
	_ = p.Close()
	buf := make([]byte, 1024)
	done := make(chan error, 1)
	go func() {
		for {
			if _, err := p.Read(buf); err != nil {
				done <- err
				return
			}
		}
	}()
	select {
	case err := <-done:
		t.Logf("Close 之后 Read 返回：%v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("Close 之后 Read 没有返回错误")
	}
}
