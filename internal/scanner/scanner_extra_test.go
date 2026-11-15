//go:build windows

// S15 验收卡硬项单独成测：tick 互斥用真并发调用、同端口双 PID 两行都在快照里、不可见时间隔抬到 10 秒、
// 已知原版问题 I7 钉住、真定时器下的启停与 ctx 取消、回调里重入扫描器不死锁。

package scanner

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"mile-console/internal/contract"
	"mile-console/internal/ownership"
)

func newExtra(t *testing.T, w *world, opts Options) (*Service, *memConfig) {
	t.Helper()
	cfg := &memConfig{cfg: contract.AppConfig{IgnoredListeners: []contract.IgnoredListener{}, GroupOverrides: []contract.GroupOverride{}, WatchedKeywords: []string{}}}
	cfg.cfg.Settings.ScanIntervalMs = 2000
	if opts.Now == nil {
		opts.Now = w.now
	}
	if opts.Metrics == nil {
		opts.Metrics = w
	}
	return New(t.Context(), w, ownership.New(w.now), cfg, opts), cfg
}

func setWorld(w *world, js string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.st.merge([]byte(js))
}

// TestTickMutexUnderConcurrency：一轮采集进行中，并发 50 次 Refresh 全部丢弃（不排队），netstat 只被调一次。
func TestTickMutexUnderConcurrency(t *testing.T) {
	w := newWorld(1_700_000_000_000)
	setWorld(w, `{"listens":[[1,10]],"procs":[[10,1,"node.exe",1]]}`)
	entered := make(chan struct{})
	release := make(chan struct{})
	w.onListen = func() {
		close(entered)
		<-release
	}
	var diffs atomic.Int64
	s, _ := newExtra(t, w, Options{OnDiff: func(contract.ScanDiff) { diffs.Add(1) }})
	done := make(chan struct{})
	go func() { s.tick(); close(done) }()
	<-entered
	var wg sync.WaitGroup
	for range 50 {
		wg.Add(1)
		go func() { defer wg.Done(); s.tick() }()
	}
	wg.Wait() // 进行中的那一轮还卡着，50 次调用都已经返回：说明是丢弃，不是排队等
	close(release)
	<-done
	if w.listenReads != 1 || diffs.Load() != 1 {
		t.Errorf("进行中的 tick 应丢弃其余调用：netstat %d 次、增量 %d 个", w.listenReads, diffs.Load())
	}
	// 跑完之后再调能正常采集
	s.tick()
	if w.listenReads != 2 {
		t.Errorf("互斥解除后应能再采集：netstat %d 次", w.listenReads)
	}
}

// TestDualStackSamePortTwoRows：同一端口被 IPv4 / IPv6 两个进程占住，两行都在快照里，冲突计数看全部占用者。
func TestDualStackSamePortTwoRows(t *testing.T) {
	w := newWorld(1_700_000_000_000)
	setWorld(w, `{"listens":[[3000,10,[4]],[3000,11,[6]]],"procs":[[10,1,"node.exe",1,"node C:\\a\\x.js"],[11,1,"node.exe",1,"node C:\\b\\x.js"]]}`)
	s, _ := newExtra(t, w, Options{Go: func(fn func()) { fn() }})
	s.SetExpectationSource(func() []EntryExpectation {
		return []EntryExpectation{{ID: "a", Port: 3000, Cwd: `C:\a`}}
	})
	s.Refresh()
	snap := s.Snapshot()
	if snap == nil || len(snap.Listeners) != 2 {
		t.Fatalf("两个 PID 都应在快照里：%+v", snap)
	}
	if snap.Listeners[0].Pid != 10 || snap.Listeners[1].Pid != 11 || snap.Listeners[0].EntryID != "a" || snap.Listeners[1].EntryID != "" {
		t.Errorf("两行的归属不对：%+v", snap.Listeners)
	}
	// a 自己占着 3000，但另一个进程也占着：仍算冲突（只看第一行会判成不冲突）
	if snap.PortConflicts != 1 {
		t.Errorf("同端口另有占用者应算冲突：%d", snap.PortConflicts)
	}
	if rows := s.ListenRows(); len(rows) != 2 {
		t.Errorf("原始监听行应保留两条：%+v", rows)
	}
}

// TestHiddenIntervalRaisedTo10s：不可见时间隔 max(base, 10000)，恢复可见回到 base 并立即补一轮。
func TestHiddenIntervalRaisedTo10s(t *testing.T) {
	for _, base := range contract.ScanIntervals {
		w := newWorld(1_700_000_000_000)
		timers := &fakeTimers{}
		var ticks atomic.Int64
		s, cfg := newExtra(t, w, Options{After: timers.after, Go: func(fn func()) { fn() },
			OnDiff: func(contract.ScanDiff) { ticks.Add(1) }})
		cfg.cfg.Settings.ScanIntervalMs = base
		s.SetVisible(false)
		log := timers.take()
		if len(log) != 1 || log[0].Set == nil || *log[0].Set != int64(max(base, 10_000)) {
			t.Errorf("周期 %d 不可见：定时器 %+v，应为 %d", base, log, max(base, 10_000))
		}
		s.SetVisible(true)
		log = timers.take()
		if len(log) != 2 || !log[0].Clear || log[1].Set == nil || *log[1].Set != int64(base) {
			t.Errorf("周期 %d 恢复可见：定时器 %+v，应先清再设 %d", base, log, base)
		}
		if ticks.Load() != 1 {
			t.Errorf("周期 %d 恢复可见应立即补一轮：%d", base, ticks.Load())
		}
		s.Stop()
	}
}

// TestKnownIssueI7WatchedCPUAlwaysNull：已知原版问题 I7，见 docs/MIGRATION-PLAN.md。
// 关注进程的 CPU 基线每轮都被清掉（只保留监听表里的 PID），所以只出现在关注列表里的进程 CPU 永远是 —。
// 同时出现在监听表里的进程不受影响。修的时候这条测试一起改。
func TestKnownIssueI7WatchedCPUAlwaysNull(t *testing.T) {
	w := newWorld(1_700_000_000_000)
	setWorld(w, `{"listens":[[3000,10]],"procs":[[10,1,"node.exe",1,"node redis.js"],[20,1,"redis-server.exe",1,"redis-server"]],"usage":{"10":[4,1],"20":[8,2]}}`)
	s, cfg := newExtra(t, w, Options{Go: func(fn func()) { fn() }})
	cfg.cfg.WatchedKeywords = []string{"redis"}
	for range 5 {
		s.Refresh()
		w.mu.Lock()
		w.clock += 2000
		w.mu.Unlock()
	}
	snap := s.Snapshot()
	var only, both *contract.WatchedProcess
	for i := range snap.Watched {
		switch snap.Watched[i].Pid {
		case 20:
			only = &snap.Watched[i]
		case 10:
			both = &snap.Watched[i]
		}
	}
	if only == nil || both == nil {
		t.Fatalf("前提失败：%+v", snap.Watched)
	}
	if only.CPU != nil {
		t.Errorf("已知原版问题 I7：只在关注列表里的进程 CPU 原版永远是 null，Go 得到 %v", *only.CPU)
	}
	if only.Memory != 2 {
		t.Errorf("内存不受 I7 影响：%d", only.Memory)
	}
	if both.CPU == nil || *both.CPU != 4 {
		t.Errorf("同时在监听表里的进程有 CPU：%v", both.CPU)
	}
}

// TestRealTimersStartStop：真定时器下按周期采集，Stop 后不再采；App ctx 取消后也不再排。
func TestRealTimersStartStop(t *testing.T) {
	w := newWorld(0)
	setWorld(w, `{"listens":[[1,10]],"procs":[[10,1,"a.exe",1]]}`)
	var ticks atomic.Int64
	ctx, cancel := context.WithCancel(t.Context())
	cfg := &memConfig{}
	cfg.cfg.Settings.ScanIntervalMs = 5
	s := New(ctx, w, ownership.New(w.now), cfg, Options{Metrics: w, Now: func() int64 { return time.Now().UnixMilli() },
		OnDiff: func(contract.ScanDiff) { ticks.Add(1) }})
	s.Start()
	waitUntil(t, func() bool { return ticks.Load() >= 5 })
	s.Stop()
	time.Sleep(30 * time.Millisecond)
	stopped := ticks.Load()
	time.Sleep(40 * time.Millisecond)
	if ticks.Load() != stopped {
		t.Errorf("Stop 后不应再采集：%d → %d", stopped, ticks.Load())
	}
	s.Start()
	waitUntil(t, func() bool { return ticks.Load() >= stopped+3 })
	cancel()
	time.Sleep(30 * time.Millisecond)
	stopped = ticks.Load()
	time.Sleep(40 * time.Millisecond)
	if ticks.Load() != stopped {
		t.Errorf("ctx 取消后不应再采集：%d → %d", stopped, ticks.Load())
	}
	s.Refresh()
	time.Sleep(10 * time.Millisecond)
	if ticks.Load() != stopped {
		t.Error("ctx 取消后 Refresh 不应再采集")
	}
}

// TestCanceledCtxSetsNoTimer：App ctx 取消后 schedule 不再设定时器（只看采集次数证明不了：tick 自己也会早退）。
func TestCanceledCtxSetsNoTimer(t *testing.T) {
	w := newWorld(1_700_000_000_000)
	timers := &fakeTimers{}
	ctx, cancel := context.WithCancel(t.Context())
	cfg := &memConfig{}
	cfg.cfg.Settings.ScanIntervalMs = 2000
	s := New(ctx, w, ownership.New(w.now), cfg, Options{Metrics: w, Now: w.now, After: timers.after, Go: func(fn func()) { fn() }})
	s.Reschedule()
	if log := timers.take(); len(log) != 1 || log[0].Set == nil {
		t.Fatalf("取消前应设一个定时器：%+v", log)
	}
	cancel()
	s.Reschedule()
	s.SetVisible(false)
	if log := timers.take(); len(log) != 1 || !log[0].Clear {
		t.Errorf("取消后只应清掉旧定时器、不再设新的：%+v", log)
	}
}

// TestCanceledTimerCallbackIgnored：time.AfterFunc 的 Stop 与触发有竞争，已取消的定时器回调仍可能跑起来；
// 代数不对就什么都不做（原版 clearTimeout 之后回调一定不跑）。
func TestCanceledTimerCallbackIgnored(t *testing.T) {
	w := newWorld(1_700_000_000_000)
	timers := &fakeTimers{}
	s, _ := newExtra(t, w, Options{After: timers.after, Go: func(fn func()) { fn() }})
	s.Reschedule()
	s.Reschedule()
	timers.take()
	timers.mu.Lock()
	stale := timers.pending[0].fn
	timers.mu.Unlock()
	stale()
	if w.listenReads != 0 {
		t.Errorf("已取消的定时器不应采集：netstat %d 次", w.listenReads)
	}
	if log := timers.take(); len(log) != 0 {
		t.Errorf("已取消的定时器不应再排：%+v", log)
	}
	if err := timers.fire(); err != nil || w.listenReads != 1 {
		t.Errorf("当前定时器应正常采集：%v，netstat %d 次", err, w.listenReads)
	}
}

// TestCallbacksMayReenter：增量回调与条目回调里调扫描器的方法不死锁。
func TestCallbacksMayReenter(t *testing.T) {
	w := newWorld(1_700_000_000_000)
	setWorld(w, `{"listens":[[1,10]],"procs":[[10,1,"a.exe",1]]}`)
	var s *Service
	s, _ = newExtra(t, w, Options{OnDiff: func(contract.ScanDiff) {
		_ = s.Snapshot()
		_ = s.KnownPath("x")
		_ = s.IsVisible()
	}, OnError: func(error) { _ = s.ListenRows() }})
	s.SetExpectationSource(func() []EntryExpectation {
		_ = s.Snapshot()
		return nil
	})
	done := make(chan struct{})
	go func() {
		s.tick()
		setWorld(w, `{"failListen":"x"}`)
		s.tick()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("回调里重入扫描器死锁了")
	}
}

// TestSnapshotIsCopy：调用方改返回的快照不影响内部状态。
func TestSnapshotIsCopy(t *testing.T) {
	w := newWorld(1_700_000_000_000)
	setWorld(w, `{"listens":[[1,10],[2,10]],"procs":[[10,1,"a.exe",1,"node C:\\w\\a.js"]]}`)
	s, _ := newExtra(t, w, Options{Go: func(fn func()) { fn() }})
	s.Refresh()
	a := s.Snapshot()
	a.Listeners[0].Ports[0] = 999
	a.Listeners[0].Cwd = "hacked"
	if b := s.Snapshot(); b.Listeners[0].Ports[0] != 1 || b.Listeners[0].Cwd != `C:\w` {
		t.Errorf("快照应是副本：%+v", b.Listeners[0])
	}
	if s.KnownPath("hacked") {
		t.Error("改副本不应进路径白名单")
	}
}

func waitUntil(t *testing.T, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatal("等待超时")
		}
		time.Sleep(time.Millisecond)
	}
}
