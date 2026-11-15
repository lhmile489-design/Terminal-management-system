// S24 单测：就绪握手、未就绪期间的合并队列、导航重置、关窗退出。

package events

import (
	"errors"
	"reflect"
	"testing"
)

type sent struct {
	Name    string
	Payload any
}

type sender struct {
	sent []sent
	err  error
}

func (s *sender) fn(name string, payload any) error {
	if s.err != nil {
		return s.err
	}
	s.sent = append(s.sent, sent{name, payload})
	return nil
}

func TestEmitWhileReadySendsImmediately(t *testing.T) {
	s := &sender{}
	b := New(s.fn)
	if err := b.Ready(); err != nil {
		t.Fatal(err)
	}
	if err := b.Emit("entryChanged", []int{1}); err != nil {
		t.Fatal(err)
	}
	if len(s.sent) != 1 || s.sent[0].Name != "entryChanged" {
		t.Fatalf("应立即投递：%+v", s.sent)
	}
	if got := b.Queued(); len(got) != 0 {
		t.Fatalf("不应排队：%v", got)
	}
}

func TestQueueCoalescesPerNameAndKeepsOrder(t *testing.T) {
	s := &sender{}
	b := New(s.fn)

	// 未就绪：同类事件只留最近一次，但不同类的顺序保留
	_ = b.Emit("entryRuntimeChanged", "first")
	_ = b.Emit("entryChanged", "list-1")
	_ = b.Emit("entryRuntimeChanged", "second")

	if got, want := b.Queued(), []string{"entryRuntimeChanged", "entryChanged"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("排队顺序 = %v，期望 %v", got, want)
	}
	if len(s.sent) != 0 {
		t.Fatal("未就绪时不该投递")
	}

	if err := b.Ready(); err != nil {
		t.Fatal(err)
	}
	if len(s.sent) != 2 {
		t.Fatalf("就绪后应投递 2 条：%+v", s.sent)
	}
	if s.sent[0].Name != "entryRuntimeChanged" || s.sent[0].Payload != "second" {
		t.Fatalf("同类应留下最近一次：%+v", s.sent[0])
	}
	if s.sent[1].Name != "entryChanged" || s.sent[1].Payload != "list-1" {
		t.Fatalf("另一类应原样投递：%+v", s.sent[1])
	}
	if len(b.Queued()) != 0 {
		t.Fatal("投递后队列应清空")
	}
}

func TestNavigateResetsQueueAndReadiness(t *testing.T) {
	s := &sender{}
	b := New(s.fn)
	_ = b.Ready()
	_ = b.Emit("a", 1)

	b.Navigate()
	if b.IsReady() {
		t.Fatal("导航开始应置未就绪")
	}
	// 再排一条意图，然后又一次导航：上一轮排队的东西必须被清掉
	_ = b.Emit("stale", 0)
	b.Navigate()
	if got := b.Queued(); len(got) != 0 {
		t.Fatalf("导航应清掉上一轮排队的意图：%v", got)
	}
	_ = b.Emit("b", 2)
	if len(s.sent) != 1 {
		t.Fatalf("导航后的事件应排队而不是投递：%+v", s.sent)
	}
	if got := b.Queued(); len(got) != 1 || got[0] != "b" {
		t.Fatalf("队列 = %v", got)
	}
	if err := b.Ready(); err != nil {
		t.Fatal(err)
	}
	if len(s.sent) != 2 || s.sent[1].Name != "b" {
		t.Fatalf("就绪后应补投：%+v", s.sent)
	}
}

func TestCloseStopsDelivery(t *testing.T) {
	s := &sender{}
	b := New(s.fn)
	_ = b.Ready()
	b.Close()
	if err := b.Emit("x", nil); !errors.Is(err, ErrClosed) {
		t.Fatalf("关窗后应返回 ErrClosed：%v", err)
	}
	if err := b.Ready(); !errors.Is(err, ErrClosed) {
		t.Fatalf("关窗后 Ready 也应报错：%v", err)
	}
	if len(s.sent) != 0 {
		t.Fatalf("关窗后不该再投递：%+v", s.sent)
	}
}

func TestSendErrorClosesBus(t *testing.T) {
	s := &sender{err: ErrClosed}
	b := New(s.fn)
	_ = b.Ready()
	if err := b.Emit("x", nil); !errors.Is(err, ErrClosed) {
		t.Fatalf("发送失败应原样返回：%v", err)
	}
	// 发送实现恢复正常也不该再试：总线已记住窗口关闭
	s.err = nil
	if err := b.Emit("y", nil); !errors.Is(err, ErrClosed) {
		t.Fatal("窗口已关后应记住关闭状态，不再调用发送")
	}
	if len(s.sent) != 0 {
		t.Fatalf("关窗后不该真的发出去：%+v", s.sent)
	}
}

func TestQueueCapDropsOldest(t *testing.T) {
	s := &sender{}
	b := New(s.fn)
	for i := 0; i < 69; i++ { // 字面量：用 maxQueued 会随变异一起涨
		_ = b.Emit(string(rune('a'+i%26))+string(rune('a'+i/26)), i)
	}
	if got := len(b.Queued()); got != 64 {
		t.Fatalf("队列长度 = %d，期望上限 64", got)
	}
}
