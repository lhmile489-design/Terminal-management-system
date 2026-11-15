// S18 单测用的假件：假伪终端、假平台、假 ownership / scanner、手动定时器队列。
// 对应 scripts/platform-stub-session.mjs 与 scripts/gen-session-cases.mjs 里的桩，行为口径逐项一致。
//
// 命名注意：conpty_spike_test.go 已占用 collector / pump / waitFor / pidAlive，这里一律用 fake / harness 前缀。

package sessions

import (
	"context"
	"errors"
	"io"
	"strconv"
	"strings"
	"sync"
	"time"

	"mile-console/internal/contract"
	"mile-console/internal/platform"
)

// fakePTY 由测试驱动：Feed 灌入输出，Exit 触发退出。
type fakePTY struct {
	h   *harness
	pid int

	in     chan []byte
	closed chan struct{}
	ack    chan struct{}
	exited chan struct{}

	// rest / needAck 只在 Read 所在的 pump 协程里访问。
	rest    []byte
	needAck bool

	mu   sync.Mutex
	code int

	closeOnce sync.Once
	exitOnce  sync.Once
}

func newFakePTY(h *harness, pid int) *fakePTY {
	return &fakePTY{
		h:      h,
		pid:    pid,
		in:     make(chan []byte),
		closed: make(chan struct{}),
		ack:    make(chan struct{}, 1),
		exited: make(chan struct{}),
	}
}

func (p *fakePTY) Pid() int { return p.pid }

// Read：本块数据被读完、pump 回来要下一块时才发 ack，
// 所以 Feed 返回时 pump 已经 absorb 完这一块（刷新定时器已登记）。
func (p *fakePTY) Read(b []byte) (int, error) {
	if len(p.rest) == 0 {
		if p.needAck {
			p.needAck = false
			select {
			case p.ack <- struct{}{}:
			default:
			}
		}
		select {
		case d := <-p.in:
			p.rest = d
			p.needAck = true
		case <-p.closed:
			return 0, io.EOF
		}
	}
	n := copy(b, p.rest)
	p.rest = p.rest[n:]
	return n, nil
}

func (p *fakePTY) Write(b []byte) (int, error) {
	p.h.record("pty.write", p.pid, string(b))
	if p.h.flag(p.pid, "writeThrows") {
		return 0, errors.New("pty write failed")
	}
	return len(b), nil
}

func (p *fakePTY) Resize(cols, rows int) error {
	p.h.record("pty.resize", p.pid, cols, rows)
	if p.h.flag(p.pid, "resizeThrows") {
		return errors.New("pty resize failed")
	}
	return nil
}

func (p *fakePTY) Close() error {
	p.closeOnce.Do(func() { close(p.closed) })
	return nil
}

func (p *fakePTY) Kill() error {
	p.h.record("pty.kill", p.pid)
	if p.h.flag(p.pid, "killThrows") {
		return errors.New("pty kill failed")
	}
	return nil
}

func (p *fakePTY) Wait() (int, error) {
	<-p.exited
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.code, nil
}

func (p *fakePTY) Exited() <-chan struct{} { return p.exited }

// Feed 灌入一块输出，等 pump 吃完。
func (p *fakePTY) Feed(s string) error {
	select {
	case p.in <- []byte(s):
	case <-p.closed:
		return errors.New("fakePTY 已关闭")
	case <-time.After(5 * time.Second):
		return errors.New("fakePTY Feed 超时：pump 没在读")
	}
	select {
	case <-p.ack:
		return nil
	case <-time.After(5 * time.Second):
		return errors.New("fakePTY Feed 超时：pump 没吃完")
	}
}

// Exit 让根进程退出。
func (p *fakePTY) Exit(code int) {
	p.exitOnce.Do(func() {
		p.mu.Lock()
		p.code = code
		p.mu.Unlock()
		close(p.exited)
	})
}

// fakeTimer 手动定时器：不真等，由 fire 按毫秒数触发。
type fakeTimer struct {
	h       *harness
	ms      int64
	f       func()
	cleared bool
	fired   bool
}

func (t *fakeTimer) Stop() bool {
	t.h.mu.Lock()
	defer t.h.mu.Unlock()
	live := !t.cleared && !t.fired
	t.cleared = true
	return live
}

// harness 把所有假件装在一起，记录调用与事件。
type harness struct {
	mu      sync.Mutex
	calls   []any
	ptys    []*fakePTY
	flags   map[int]map[string]bool
	envKeys []string
	timers  []*fakeTimer
	clock   int64
	tokenN  int

	assertFails bool
	tableFails  bool

	evMu   sync.Mutex
	events []any

	svc *Service
}

var harnessFixedEnvKeys = []string{
	"MILE_TEST_BASE", "MILE_RUN_TOKEN", "MILE_SESSION_ID", "LANG", "LC_ALL",
	"PYTHONIOENCODING", "FORCE_COLOR", "TERM", "npm_config_progress",
}

func newHarness(clock int64) *harness {
	h := &harness{flags: map[int]map[string]bool{}, clock: clock, envKeys: append([]string{}, harnessFixedEnvKeys...)}
	h.svc = New(context.Background(), fakePlatform{h}, fakeOwnership{h}, Options{
		Now:       func() time.Time { return time.UnixMilli(h.getClock()) },
		Homedir:   func() (string, error) { return `C:\Users\test`, nil },
		Environ:   func() []string { return []string{"MILE_TEST_BASE=base", "PATH=x"} },
		Spawn:     h.spawn,
		AfterFunc: h.afterFunc,
		After:     func(time.Duration) <-chan time.Time { return make(chan time.Time) },
	})
	h.svc.OnData(func(e contract.SessionDataEvent) {
		rec := summarizeText(e.Chunk)
		rec["type"] = "data"
		rec["id"] = e.ID
		h.evMu.Lock()
		h.events = append(h.events, rec)
		h.evMu.Unlock()
	})
	h.svc.OnExit(func(e contract.SessionExitEvent) {
		h.evMu.Lock()
		h.events = append(h.events, map[string]any{"type": "exit", "id": e.ID, "exitCode": e.ExitCode})
		h.evMu.Unlock()
	})
	return h
}

func (h *harness) getClock() int64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.clock
}

func (h *harness) setClock(ms int64) {
	h.mu.Lock()
	h.clock = ms
	h.mu.Unlock()
}

func (h *harness) record(parts ...any) {
	h.mu.Lock()
	h.calls = append(h.calls, parts)
	h.mu.Unlock()
}

func (h *harness) flag(pid int, name string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.flags[pid][name]
}

func (h *harness) setFlag(pid int, name string, v bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.flags[pid] == nil {
		h.flags[pid] = map[string]bool{}
	}
	h.flags[pid][name] = v
}

func (h *harness) setEnvKeys(extra []string) {
	h.mu.Lock()
	h.envKeys = append(append([]string{}, harnessFixedEnvKeys...), extra...)
	h.mu.Unlock()
}

func (h *harness) spawn(o PTYOptions) (PTYProc, error) {
	h.mu.Lock()
	pid := 4000 + 100*len(h.ptys)
	p := newFakePTY(h, pid)
	h.ptys = append(h.ptys, p)
	want := map[string]bool{}
	for _, k := range h.envKeys {
		want[k] = true
	}
	h.mu.Unlock()

	env := map[string]any{}
	for _, kv := range o.Env {
		k, v, _ := strings.Cut(kv, "=")
		if want[k] {
			env[k] = v
		}
	}
	args := []any{}
	if len(o.Args) > 1 {
		for _, a := range o.Args[1:] {
			args = append(args, a)
		}
	}
	h.record("spawn", map[string]any{
		"file": o.Path, "args": args, "cwd": o.Dir, "cols": o.Cols, "rows": o.Rows, "env": env,
	})
	return p, nil
}

func (h *harness) afterFunc(d time.Duration, f func()) Timer {
	t := &fakeTimer{h: h, ms: d.Milliseconds(), f: f}
	h.mu.Lock()
	h.timers = append(h.timers, t)
	h.mu.Unlock()
	return t
}

// fire 触发所有 ms 相等且仍待触发的定时器；回调在不持锁的情况下同步运行。
func (h *harness) fire(ms int64) {
	h.mu.Lock()
	var due []*fakeTimer
	for _, t := range h.timers {
		if !t.cleared && !t.fired && t.ms == ms {
			due = append(due, t)
		}
	}
	h.mu.Unlock()
	for _, t := range due {
		h.mu.Lock()
		skip := t.cleared || t.fired
		if !skip {
			t.fired = true
		}
		h.mu.Unlock()
		if skip {
			continue
		}
		t.f()
	}
}

// pendingMs 仍待触发的定时器毫秒数，升序；空时返回非 nil 空切片。
func (h *harness) pendingMs() []int64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := []int64{}
	for _, t := range h.timers {
		if !t.cleared && !t.fired {
			out = append(out, t.ms)
		}
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j-1] > out[j]; j-- {
			out[j-1], out[j] = out[j], out[j-1]
		}
	}
	return out
}

func (h *harness) pty(n int) *fakePTY {
	h.mu.Lock()
	defer h.mu.Unlock()
	if n < 0 || n >= len(h.ptys) {
		return nil
	}
	return h.ptys[n]
}

func (h *harness) callsSince(n int) ([]any, int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := append([]any{}, h.calls[n:]...)
	return out, len(h.calls)
}

func (h *harness) eventsSince(n int) ([]any, int) {
	h.evMu.Lock()
	defer h.evMu.Unlock()
	out := append([]any{}, h.events[n:]...)
	return out, len(h.events)
}

// 清理：让所有假进程退出，watch 协程收尾，不留 goroutine。
func (h *harness) shutdown() {
	h.mu.Lock()
	ps := append([]*fakePTY{}, h.ptys...)
	h.mu.Unlock()
	for _, p := range ps {
		p.Exit(0)
	}
	for _, e := range h.svc.ordered() {
		select {
		case <-e.done:
		case <-time.After(5 * time.Second):
		}
	}
}

type fakePlatform struct{ h *harness }

func (fakePlatform) DefaultShell() platform.Shell {
	return platform.Shell{File: `C:\pwsh\pwsh.exe`, Title: "PowerShell 7"}
}
func (fakePlatform) ShellArgs(string) []string       { return []string{"-NoLogo"} }
func (fakePlatform) ShellInit(string) (string, bool) { return "INIT\r", true }
func (p fakePlatform) KillTree(_ context.Context, pid int) {
	p.h.record("killTree", pid)
}

type fakeOwnership struct{ h *harness }

func (o fakeOwnership) IssueToken() string {
	o.h.mu.Lock()
	defer o.h.mu.Unlock()
	o.h.tokenN++
	return "tok-" + strconv.Itoa(o.h.tokenN)
}
func (o fakeOwnership) Register(sid string, pid int, token string) {
	o.h.record("own.register", sid, pid, token)
}
func (o fakeOwnership) Unregister(sid string) { o.h.record("own.unregister", sid) }
func (o fakeOwnership) AssertKillable(pid int, _ platform.ProcessMeta, sid string) (contract.OwnershipVerdict, error) {
	o.h.record("own.assertKillable", pid, sid)
	o.h.mu.Lock()
	fails := o.h.assertFails
	o.h.mu.Unlock()
	if fails {
		return contract.OwnershipVerdict{}, errors.New("assert failed")
	}
	return contract.OwnershipVerdict{}, nil
}

type fakeScanner struct{ h *harness }

func (s fakeScanner) Table(_ context.Context, pids []int) (platform.ProcessTable, error) {
	cp := []any{}
	for _, p := range pids {
		cp = append(cp, p)
	}
	s.h.record("scanner.table", cp)
	s.h.mu.Lock()
	fails := s.h.tableFails
	s.h.mu.Unlock()
	if fails {
		return platform.ProcessTable{}, errors.New("table failed")
	}
	return platform.ProcessTable{}, nil
}
