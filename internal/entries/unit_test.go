// S21a 单测：对拍覆盖不到的部分（id 形状、删除时终止会话、撤销排队中的重启、
// 新建时的序位与时间戳、文件判定的真实行为）。

package entries

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"mile-console/internal/contract"
)

type unitRig struct {
	svc    *Service
	store  *fakeStore
	rec    *recorder
	timers []*fakeTimer
	mu     sync.Mutex
}

type fakeTimer struct {
	h       *unitRig
	f       func()
	cleared bool
}

func (t *fakeTimer) Stop() bool {
	t.h.mu.Lock()
	defer t.h.mu.Unlock()
	live := !t.cleared
	t.cleared = true
	return live
}

func newUnitRig(t *testing.T, entries []contract.LaunchEntry) *unitRig {
	t.Helper()
	rig := &unitRig{rec: &recorder{}}
	rig.store = &fakeStore{cfg: contract.AppConfig{Entries: entries}, rec: rig.rec}
	rig.svc = New(context.Background(), rig.store, fakePlatform{}, fakeSessions{rec: rig.rec}, Options{
		Now:   func() time.Time { return time.UnixMilli(1_700_000_000_000) },
		NewID: func() string { return "id-fixed" },
		AfterFunc: func(d time.Duration, f func()) Timer {
			tm := &fakeTimer{h: rig, f: f}
			rig.mu.Lock()
			rig.timers = append(rig.timers, tm)
			rig.mu.Unlock()
			return tm
		},
	})
	return rig
}

func strPtr(s string) *string { return &s }

func mkEntry(id string, over func(*contract.LaunchEntry)) contract.LaunchEntry {
	e := contract.LaunchEntry{
		ID: id, Kind: contract.EntryKindService, Name: "条目" + id,
		Path: `C:\proj`, Framework: contract.FrameworkNext, PackageManager: contract.PackageManagerNpm,
		Script: strPtr("dev"), Scripts: contract.ScriptsOf("dev", "next dev"),
		Env: map[string]string{}, CreatedAt: 1,
	}
	if over != nil {
		over(&e)
	}
	return e
}

func TestNewUUIDShape(t *testing.T) {
	re := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	seen := map[string]bool{}
	for i := 0; i < 50; i++ {
		id := newUUID()
		if !re.MatchString(id) {
			t.Fatalf("uuid 形状不对：%q", id)
		}
		if seen[id] {
			t.Fatalf("重复的 uuid：%q", id)
		}
		seen[id] = true
	}
}

func TestRemoveKillsSessionAndDropsRuntime(t *testing.T) {
	rig := newUnitRig(t, []contract.LaunchEntry{mkEntry("e1", nil)})
	rig.svc.setRuntime(contract.EntryRuntime{EntryID: "e1", Status: contract.EntryRunning, SessionID: "s1"})
	if err := rig.svc.Remove("e1"); err != nil {
		t.Fatal(err)
	}
	if _, ok := rig.svc.RuntimeOf("e1"); ok {
		t.Fatal("运行态没被删掉")
	}
	// 会话终止在后台协程里做，等它到账
	deadline := time.Now().Add(2 * time.Second)
	for {
		found := false
		for _, c := range rig.rec.callsSince(0) {
			if arr, ok := c.([]any); ok && len(arr) == 2 && arr[0] == "sessions.kill" && arr[1] == "s1" {
				found = true
			}
		}
		if found {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("删除条目没有终止会话")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if _, ok := rig.svc.Get("e1"); ok {
		t.Fatal("条目还在配置里")
	}
}

func TestEditCancelsPendingRestart(t *testing.T) {
	rig := newUnitRig(t, []contract.LaunchEntry{mkEntry("e1", nil)})
	// 模拟 S21c 排好的自动重启
	rig.svc.mu.Lock()
	rig.svc.restartTimers["e1"] = rig.svc.opt.AfterFunc(time.Second, func() {
		t.Error("被撤销的自动重启仍然触发了")
	})
	timer := rig.timers[0]
	rig.svc.mu.Unlock()

	if _, err := rig.svc.Edit("e1", contract.EntryEdit{Name: strPtr("新名字")}); err != nil {
		t.Fatal(err)
	}
	if !timer.cleared {
		t.Fatal("edit 没有撤销排队中的重启")
	}
	if _, ok := rig.svc.restartTimers["e1"]; ok {
		t.Fatal("撤销后仍留在表里")
	}
}

func TestAddUsesLengthAsOrder(t *testing.T) {
	rig := newUnitRig(t, []contract.LaunchEntry{mkEntry("e1", nil), mkEntry("e2", func(e *contract.LaunchEntry) { e.Order = 7 })})
	dir := t.TempDir()
	got, err := rig.svc.Add(contract.NewLaunchEntry{
		Kind: contract.EntryKindService, Name: "新", Path: dir,
		Framework: contract.FrameworkStatic, PackageManager: contract.PackageManagerNpm,
	})
	if err != nil {
		t.Fatal(err)
	}
	// 原版用 entries.length 而不是「最大 order + 1」
	if got.Order != 2 {
		t.Fatalf("order = %d，期望 2", got.Order)
	}
	if got.CreatedAt != 1_700_000_000_000 || got.ID != "id-fixed" {
		t.Fatalf("id / createdAt 不对：%q %d", got.ID, got.CreatedAt)
	}
	if got.Env == nil || len(got.Env) != 0 {
		t.Fatalf("新条目 env 应为空对象，得到 %v", got.Env)
	}
}

func TestFileHelpers(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !IsDirectory(dir) || IsDirectory(file) || IsDirectory(filepath.Join(dir, "nope")) {
		t.Fatal("IsDirectory 判定不对")
	}
	if !IsFile(file) || IsFile(dir) || IsFile(filepath.Join(dir, "nope")) {
		t.Fatal("IsFile 判定不对")
	}
	if !IsRunnable(fakePlatform{}, file) || IsRunnable(fakePlatform{}, dir) {
		t.Fatal("IsRunnable 判定不对")
	}
}

func TestCapturePortPrefersSpecificPatterns(t *testing.T) {
	cases := []struct {
		chunk string
		want  int
		ok    bool
	}{
		{"Tomcat started on port(s): 8080 (http)", 8080, true},
		{"nothing", 0, false},
		{"http://localhost:0/", 0, false},
		{"\x1b[32mLocal:\x1b[0m http://127.0.0.1:5173/", 5173, true},
	}
	for _, c := range cases {
		got, ok := CapturePort(c.chunk)
		if got != c.want || ok != c.ok {
			t.Errorf("CapturePort(%q) = %d,%v，期望 %d,%v", c.chunk, got, ok, c.want, c.ok)
		}
	}
	// 被占用那句话里的端口不算，后面的真端口才算
	got, ok := CapturePort("Port 3000 is in use, using available port 3001 instead.")
	if !ok || got != 3001 {
		t.Fatalf("被占用误判：%d,%v", got, ok)
	}
}

func TestIsRunnableNeedsExecBitOffWindows(t *testing.T) {
	// Windows 上平台不要求执行位：普通文件即可
	dir := t.TempDir()
	f := filepath.Join(dir, "mvnw.cmd")
	if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !IsRunnable(fakePlatform{}, f) {
		t.Fatal("Windows 上不该要求执行位")
	}
	if !strings.HasSuffix(f, ".cmd") {
		t.Fatal("夹具文件名不对")
	}
}

// stopping 也算「还在跑」：停止过程中改身份字段一样危险（进程还没退，归属还没撤）。
func TestStoppingLocksIdentityFields(t *testing.T) {
	for _, status := range []contract.EntryStatus{contract.EntryPrecheck, contract.EntryStarting, contract.EntryRunning, contract.EntryStopping} {
		rig := newUnitRig(t, []contract.LaunchEntry{mkEntry("e1", nil)})
		rig.svc.setRuntime(contract.EntryRuntime{EntryID: "e1", Status: status})
		_, err := rig.svc.Edit("e1", contract.EntryEdit{Cwd: strPtr("sub")})
		if err == nil || !strings.Contains(err.Error(), "需要先停止再改") {
			t.Errorf("%s 状态下应挡住改身份字段，得到 %v", status, err)
		}
	}
	// idle 状态下不锁
	rig := newUnitRig(t, []contract.LaunchEntry{mkEntry("e1", nil)})
	rig.svc.setRuntime(contract.EntryRuntime{EntryID: "e1", Status: contract.EntryIdle})
	if _, err := rig.svc.Edit("e1", contract.EntryEdit{Cwd: strPtr("sub")}); err != nil {
		t.Fatalf("idle 状态不该锁：%v", err)
	}
}

// PATH 里缺东西时每个生态各自的报错文案（对拍里夹具齐全，这几条走不到）。
func TestMissingBinaryMessages(t *testing.T) {
	rig := newUnitRig(t, nil)
	rig.svc.opt.Which = func([]string) (string, bool) { return "", false }
	dir := t.TempDir()
	// npm 分支的脚本声明校验在读 PATH 之前，所以目录里要有 package.json
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"scripts":{"dev":"next dev"}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name string
		e    contract.LaunchEntry
		want string
	}{
		{"npm", mkEntry("e", func(e *contract.LaunchEntry) { e.Path = dir }), "PATH 中找不到 npm"},
		{"python", mkEntry("e", func(e *contract.LaunchEntry) {
			e.Framework, e.LaunchMode = contract.FrameworkPython, contract.LaunchModeFlask
		}), "PATH 中找不到 python"},
		{"go", mkEntry("e", func(e *contract.LaunchEntry) {
			e.Framework, e.LaunchMode = contract.FrameworkGo, contract.LaunchModeGoRun
		}), "PATH 中找不到 go"},
		{"cargo", mkEntry("e", func(e *contract.LaunchEntry) {
			e.Framework, e.LaunchMode = contract.FrameworkRust, contract.LaunchModeCargoRun
		}), "PATH 中找不到 cargo"},
	}
	for _, c := range cases {
		script := (*string)(nil)
		if c.name == "npm" {
			s := "dev"
			script = &s
		}
		_, err := rig.svc.BuildCommand(c.e, dir, script)
		if err == nil || err.Error() != c.want {
			t.Errorf("%s: got %v want %q", c.name, err, c.want)
		}
	}

	// Spring Boot 的 java / mvn / gradle
	for _, m := range []struct {
		mode contract.LaunchMode
		jar  string
		want string
	}{
		{contract.LaunchModeJar, "a.jar", "PATH 中找不到 java"},
		{contract.LaunchModeSystemMaven, "", "PATH 中找不到 mvn"},
		{contract.LaunchModeSystemGradle, "", "PATH 中找不到 gradle"},
	} {
		e := mkEntry("e", func(e *contract.LaunchEntry) {
			e.Framework, e.LaunchMode, e.JarPath = contract.FrameworkSpringBoot, m.mode, m.jar
		})
		if m.jar != "" {
			if err := os.WriteFile(filepath.Join(dir, "a.jar"), []byte("x"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		_, err := rig.svc.BuildCommand(e, dir, nil)
		if err == nil || err.Error() != m.want {
			t.Errorf("%s: got %v want %q", m.mode, err, m.want)
		}
	}
}

// package.json 是字面量 null 时，原版抛 TypeError，这里给同文案。
func TestScriptDeclaredNullPackageJSON(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte("null"), 0o644); err != nil {
		t.Fatal(err)
	}
	err := assertScriptDeclared(dir, "dev")
	if err == nil || err.Error() != "Cannot read properties of null (reading 'scripts')" {
		t.Fatalf("got %v", err)
	}
}

func TestAssertInsideEntry(t *testing.T) {
	root := filepath.Join(t.TempDir(), "proj")
	entry := mkEntry("e", func(e *contract.LaunchEntry) { e.Path = root })
	inside := []string{root, filepath.Join(root, "sub"), filepath.Join(root, "a", "b")}
	for _, p := range inside {
		if err := assertInsideEntry(entry, p); err != nil {
			t.Errorf("%q 应该在条目内：%v", p, err)
		}
	}
	outside := []string{filepath.Dir(root), filepath.Join(root, "..", "escape"), filepath.Join(filepath.Dir(root), "other")}
	for _, p := range outside {
		if err := assertInsideEntry(entry, p); err == nil {
			t.Errorf("%q 应该被拒", p)
		}
	}
}
