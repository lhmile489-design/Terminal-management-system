// S22 单测：关键词与错误行命中、60 秒去重、命中上限、延迟通知与崩溃吸收。

package alerts

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"mile-console/internal/contract"
)

type fakeSource struct {
	mu      sync.Mutex
	entries []contract.LaunchEntry
	changeF []func([]contract.LaunchEntry)
}

func (f *fakeSource) Get(id string) (contract.LaunchEntry, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, e := range f.entries {
		if e.ID == id {
			return e, true
		}
	}
	return contract.LaunchEntry{}, false
}

func (f *fakeSource) OnEntriesChanged(fn func([]contract.LaunchEntry)) func() {
	f.mu.Lock()
	f.changeF = append(f.changeF, fn)
	f.mu.Unlock()
	return func() {}
}

func (f *fakeSource) emitChanged(list []contract.LaunchEntry) {
	f.mu.Lock()
	f.entries = list
	fns := append([]func([]contract.LaunchEntry){}, f.changeF...)
	f.mu.Unlock()
	for _, fn := range fns {
		fn(list)
	}
}

type fakeTimer struct {
	f       func()
	cleared bool
}

func (t *fakeTimer) Stop() bool {
	live := !t.cleared
	t.cleared = true
	return live
}

type rig struct {
	svc      *Service
	src      *fakeSource
	mu       sync.Mutex
	clock    int64
	timers   []*fakeTimer
	alerts   []contract.OutputAlert
	notifies []contract.OutputAlert
}

func newRig(t *testing.T) *rig {
	t.Helper()
	r := &rig{src: &fakeSource{}, clock: 1_700_000_000_000}
	r.svc = New(r.src, Options{
		Now: func() time.Time { return time.UnixMilli(r.now()) },
		AfterFunc: func(d time.Duration, f func()) Timer {
			tm := &fakeTimer{f: f}
			r.mu.Lock()
			r.timers = append(r.timers, tm)
			r.mu.Unlock()
			return tm
		},
		EmitAlert:  func(a contract.OutputAlert) { r.mu.Lock(); r.alerts = append(r.alerts, a); r.mu.Unlock() },
		EmitNotify: func(a contract.OutputAlert) { r.mu.Lock(); r.notifies = append(r.notifies, a); r.mu.Unlock() },
	})
	return r
}

func (r *rig) now() int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.clock
}

func (r *rig) advance(ms int64) {
	r.mu.Lock()
	r.clock += ms
	r.mu.Unlock()
}

// fire 触发所有未取消的延迟通知。
func (r *rig) fire() {
	r.mu.Lock()
	due := append([]*fakeTimer{}, r.timers...)
	r.timers = nil
	r.mu.Unlock()
	for _, t := range due {
		if !t.cleared {
			t.cleared = true
			t.f()
		}
	}
}

func (r *rig) counts() (int, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.alerts), len(r.notifies)
}

func entryWith(id string, words []string, onErrors bool) contract.LaunchEntry {
	e := contract.LaunchEntry{ID: id, Kind: contract.EntryKindService, Name: "服务" + id, AlertKeywords: words}
	if onErrors {
		yes := true
		e.AlertOnErrors = &yes
	}
	return e
}

func line(entryID, session, text string) contract.LogLine {
	id := entryID
	return contract.LogLine{EntryID: &id, SessionID: session, Text: text}
}

func TestKeywordMatchAndDedup(t *testing.T) {
	r := newRig(t)
	r.src.entries = []contract.LaunchEntry{entryWith("e1", []string{"Timeout"}, false)}

	r.svc.Check(line("e1", "s1", "request TIMEOUT after 30s"))
	if a, n := r.counts(); a != 1 || n != 0 {
		t.Fatalf("首次命中应只发 alert：%d %d", a, n)
	}
	if got := r.svc.List("e1"); len(got) != 1 || got[0].Keyword == nil || *got[0].Keyword != "Timeout" {
		t.Fatalf("命中记录不对：%+v", got)
	}

	// 60 秒内同一关键词不再告警
	r.svc.Check(line("e1", "s1", "another timeout"))
	if a, _ := r.counts(); a != 1 {
		t.Fatalf("窗口内不应重复：%d", a)
	}

	// 窗口外可以再来一次
	r.advance(60_000) // 去重窗口的字面量
	r.svc.Check(line("e1", "s1", "timeout again"))
	if a, _ := r.counts(); a != 2 {
		t.Fatalf("窗口外应再告警：%d", a)
	}
}

func TestErrorLineMatchHasNilKeyword(t *testing.T) {
	r := newRig(t)
	r.src.entries = []contract.LaunchEntry{entryWith("e1", nil, true)}
	r.svc.Check(line("e1", "s1", "Error: boom"))
	if a, _ := r.counts(); a != 1 {
		t.Fatal("错误行应命中")
	}
	r.mu.Lock()
	got := r.alerts[0]
	r.mu.Unlock()
	if got.Keyword != nil {
		t.Fatalf("通用错误行的 keyword 应为 null：%v", *got.Keyword)
	}
	// 同一行再来一次：去重
	r.svc.Check(line("e1", "s1", "Error: boom"))
	if a, _ := r.counts(); a != 1 {
		t.Fatal("错误行也应去重")
	}
}

func TestNoMatchCases(t *testing.T) {
	r := newRig(t)
	r.src.entries = []contract.LaunchEntry{
		entryWith("e1", nil, false),              // 没开任何告警
		entryWith("e2", []string{"boom"}, false), // 关键词没命中
	}
	r.svc.Check(line("e1", "s1", "Error: boom")) // 没开 alertOnErrors
	r.svc.Check(line("e2", "s1", "all good"))
	r.idleCheck(t)
	// 没有 entryId 的行直接忽略
	noID := contract.LogLine{SessionID: "s1", Text: "boom"}
	r.svc.Check(noID)
	// 条目不存在
	r.svc.Check(line("gone", "s1", "boom"))
	if a, _ := r.counts(); a != 0 {
		t.Fatalf("不该有告警：%d", a)
	}
}

func (r *rig) idleCheck(t *testing.T) {
	t.Helper()
	if a, _ := r.counts(); a != 0 {
		t.Fatalf("不该有告警：%d", a)
	}
}

func TestHitsCappedPerEntry(t *testing.T) {
	r := newRig(t)
	words := make([]string, 0, MaxHitsPerEntry+5)
	// 定宽编号：互相不是子串，每个关键词各自命中一次、去重键互不相同
	for i := 0; i < MaxHitsPerEntry+5; i++ {
		words = append(words, fmt.Sprintf("kw%03d", i))
	}
	r.src.entries = []contract.LaunchEntry{entryWith("e1", words, false)}
	// 每个关键词各命中一次（去重键不同）
	for i, w := range words {
		r.advance(1)
		r.svc.Check(line("e1", "s1", "hit "+w))
		_ = i
	}
	hits := r.svc.List("e1")
	if len(hits) != 50 {
		t.Fatalf("命中条数 = %d，期望 50", len(hits))
	}
}

func TestLineTruncatedTo200(t *testing.T) {
	r := newRig(t)
	r.src.entries = []contract.LaunchEntry{entryWith("e1", []string{"boom"}, false)}
	long := "boom " + strings.Repeat("x", 400)
	r.svc.Check(line("e1", "s1", long))
	r.mu.Lock()
	got := r.alerts[0]
	r.mu.Unlock()
	if len([]rune(got.Line)) != 200 {
		t.Fatalf("行长度 = %d，期望 200", len([]rune(got.Line)))
	}
}

func TestNotifyDelayedAndAbsorbedByCrash(t *testing.T) {
	r := newRig(t)
	r.src.entries = []contract.LaunchEntry{entryWith("e1", []string{"boom"}, false)}

	r.svc.Check(line("e1", "s1", "boom"))
	if _, n := r.counts(); n != 0 {
		t.Fatal("通知应当延迟")
	}
	r.fire()
	if _, n := r.counts(); n != 1 {
		t.Fatalf("到期应发通知：%d", n)
	}

	// 崩溃后的告警：到期时被吸收
	r.advance(60_000) // 去重窗口的字面量
	r.svc.NoteCrash("e1")
	r.svc.Check(line("e1", "s1", "boom again"))
	r.fire()
	if _, n := r.counts(); n != 1 {
		t.Fatalf("崩溃窗口内不该再弹通知：%d", n)
	}
}

func TestNoteCrashCancelsPending(t *testing.T) {
	r := newRig(t)
	r.src.entries = []contract.LaunchEntry{entryWith("e1", []string{"boom"}, false)}
	r.svc.Check(line("e1", "s1", "boom"))
	r.svc.NoteCrash("e1")
	r.fire()
	if _, n := r.counts(); n != 0 {
		t.Fatalf("崩溃应撤掉排队中的通知：%d", n)
	}
}

func TestForgetOnEntryRemoved(t *testing.T) {
	r := newRig(t)
	r.src.entries = []contract.LaunchEntry{entryWith("e1", []string{"boom"}, false)}
	r.svc.Check(line("e1", "s1", "boom"))
	if len(r.svc.List("e1")) != 1 {
		t.Fatal("应先有命中")
	}
	r.src.emitChanged(nil)
	if len(r.svc.List("e1")) != 0 {
		t.Fatal("条目删掉后命中记录应清空")
	}
	// 去重状态也清了：同一关键词可以立刻再告警
	r.src.entries = []contract.LaunchEntry{entryWith("e1", []string{"boom"}, false)}
	r.svc.Check(line("e1", "s1", "boom"))
	if a, _ := r.counts(); a != 2 {
		t.Fatalf("去重状态应被清除：%d", a)
	}
}

func TestDisposeCancelsAll(t *testing.T) {
	r := newRig(t)
	r.src.entries = []contract.LaunchEntry{
		entryWith("e1", []string{"boom"}, false),
		entryWith("e2", []string{"boom"}, false),
	}
	r.svc.Check(line("e1", "s1", "boom"))
	r.svc.Check(line("e2", "s1", "boom"))
	r.svc.Dispose()
	r.fire()
	if _, n := r.counts(); n != 0 {
		t.Fatalf("dispose 后不该有通知：%d", n)
	}
}
