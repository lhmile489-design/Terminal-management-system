// S18 单测：对拍数据覆盖不到的部分（跨读块的多字节字符、代理对截断、Attach、红线、disposeAll 等待）。

package sessions

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo"

	"mile-console/internal/contract"
)

func unitShell(t *testing.T, h *harness) contract.SessionMeta {
	t.Helper()
	m, err := h.svc.CreateShell(contract.CreateShellSessionInput{Kind: contract.SessionKindShell}, nil)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

// 一个汉字正好跨 32 KiB 读块边界，以及跨两次写入：都不能出现替换符。
func TestPumpKeepsMultibyteAcrossReads(t *testing.T) {
	h := newHarness(1_700_000_000_000)
	t.Cleanup(h.shutdown)
	m := unitShell(t, h)
	p := h.pty(0)

	big := strings.Repeat("a", readSize-1) + "中文"
	if err := p.Feed(big); err != nil {
		t.Fatal(err)
	}
	zhong := []byte("中")
	if err := p.Feed(string(zhong[:2])); err != nil {
		t.Fatal(err)
	}
	if err := p.Feed(string(zhong[2:]) + "尾"); err != nil {
		t.Fatal(err)
	}
	h.fire(16)
	got := h.svc.History(m.ID)
	if want := big + "中尾"; got != want {
		t.Fatalf("history 尾部 %q，期望 %q", got[len(got)-12:], want[len(want)-12:])
	}
	if strings.ContainsRune(got, 0xFFFD) {
		t.Fatal("history 出现替换符")
	}
}

// 流结束时残留的不完整字节按 node 解码器口径变成一个替换符。
func TestPumpFlushesDanglingBytesAtEOF(t *testing.T) {
	h := newHarness(1_700_000_000_000)
	t.Cleanup(h.shutdown)
	m := unitShell(t, h)
	if err := h.pty(0).Feed("x" + string([]byte("中")[:2])); err != nil {
		t.Fatal(err)
	}
	e := h.svc.get(m.ID)
	h.pty(0).Exit(0)
	<-e.done
	if got := h.svc.History(m.ID); got != "x"+string(rune(0xFFFD)) {
		t.Fatalf("history = %q", got)
	}
}

// Go 字符串放不下孤立代理项：JS 会在代理对中间切开，Go 少留一个单位（MIGRATION-PLAN §6）。
func TestTruncateNeverSplitsSurrogatePair(t *testing.T) {
	if got := truncateTail("a"+unitSmile+"b", 2); got != "b" {
		t.Fatalf("truncateTail = %q", got)
	}
	if got := truncateTail("a"+unitSmile+"b", 3); got != unitSmile+"b" {
		t.Fatalf("truncateTail = %q", got)
	}
	if got := truncateHead("x"+unitSmile, 2); got != "x" {
		t.Fatalf("truncateHead = %q", got)
	}
	if got := truncateHead("x"+unitSmile, 3); got != "x"+unitSmile {
		t.Fatalf("truncateHead = %q", got)
	}
}

type unitSink struct {
	mu     sync.Mutex
	chunks []string
	ids    map[string]bool
}

func (s *unitSink) send(e contract.SessionDataEvent) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.chunks = append(s.chunks, e.Chunk)
	if s.ids == nil {
		s.ids = map[string]bool{}
	}
	s.ids[e.ID] = true
	return nil
}

func (s *unitSink) text() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return strings.Join(s.chunks, "")
}

func unitEventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("等待超时：%s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// Attach：先回放历史，再推后续输出，会话退出且发完后返回 nil。
func TestAttachReplaysThenStreams(t *testing.T) {
	h := newHarness(1_700_000_000_000)
	t.Cleanup(h.shutdown)
	m := unitShell(t, h)
	p := h.pty(0)
	if err := p.Feed("历史 "); err != nil {
		t.Fatal(err)
	}
	h.fire(16)

	sink := &unitSink{}
	done := make(chan error, 1)
	go func() { done <- h.svc.attach(context.Background(), m.ID, sink.send) }()
	unitEventually(t, "回放历史", func() bool { return sink.text() == "历史 " })

	if err := p.Feed("实时"); err != nil {
		t.Fatal(err)
	}
	h.fire(16)
	unitEventually(t, "推送实时输出", func() bool { return sink.text() == "历史 实时" })

	if err := p.Feed(" 收尾"); err != nil {
		t.Fatal(err)
	}
	p.Exit(0)
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("attach 返回 %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("会话退出后 attach 没返回")
	}
	if got := sink.text(); got != "历史 实时 收尾" {
		t.Fatalf("收到 %q", got)
	}
	if len(sink.ids) != 1 || !sink.ids[m.ID] {
		t.Fatalf("事件 id 不对: %v", sink.ids)
	}
}

func TestAttachUnknownDeadAndClosed(t *testing.T) {
	h := newHarness(1_700_000_000_000)
	t.Cleanup(h.shutdown)

	err := h.svc.attach(context.Background(), "nope", (&unitSink{}).send)
	if err == nil || err.Error() != "会话不存在: nope" {
		t.Fatalf("未知 id: %v", err)
	}

	// 已退出的会话：回放完历史立即返回
	m := unitShell(t, h)
	if err := h.pty(0).Feed("bye"); err != nil {
		t.Fatal(err)
	}
	e := h.svc.get(m.ID)
	h.pty(0).Exit(3)
	<-e.done
	sink := &unitSink{}
	if err := h.svc.attach(context.Background(), m.ID, sink.send); err != nil || sink.text() != "bye" {
		t.Fatalf("已退出会话: err=%v text=%q", err, sink.text())
	}

	// 页面关了 Channel：正常结束，返回 nil
	m2 := unitShell(t, h)
	if err := h.pty(1).Feed("x"); err != nil {
		t.Fatal(err)
	}
	h.fire(16)
	closed := func(contract.SessionDataEvent) error { return mygo.ErrChannelClosed }
	if err := h.svc.attach(context.Background(), m2.ID, closed); err != nil {
		t.Fatalf("Channel 关闭应返回 nil，得到 %v", err)
	}
	// 其他发送错误原样返回
	boom := errors.New("boom")
	if err := h.svc.attach(context.Background(), m2.ID, func(contract.SessionDataEvent) error { return boom }); !errors.Is(err, boom) {
		t.Fatalf("发送错误应透传，得到 %v", err)
	}

	// ctx 取消：返回 nil
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- h.svc.attach(ctx, m2.ID, (&unitSink{}).send) }()
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("ctx 取消应返回 nil，得到 %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("ctx 取消后 attach 没返回")
	}
}

// 红线：自由终端入参类型里根本没有可执行文件 / 参数 / 目录 / 环境变量字段。
func TestCreateShellInputHasNoExecFields(t *testing.T) {
	var names []string
	ty := reflect.TypeOf(contract.CreateShellSessionInput{})
	for i := 0; i < ty.NumField(); i++ {
		names = append(names, ty.Field(i).Name)
	}
	sort.Strings(names)
	if want := []string{"EntryID", "Kind", "Title"}; !reflect.DeepEqual(names, want) {
		t.Fatalf("CreateShellSessionInput 字段 %v，期望只有 %v", names, want)
	}
	h := newHarness(1_700_000_000_000)
	t.Cleanup(h.shutdown)
	var in contract.CreateShellSessionInput
	_ = json.Unmarshal([]byte(`{"kind":"shell","file":"C:\\evil.exe","args":["-c"],"cwd":"C:\\evil","env":{"A":"b"}}`), &in)
	m, err := h.svc.CreateShell(in, nil)
	if err != nil {
		t.Fatal(err)
	}
	if m.Command != `C:\pwsh\pwsh.exe -NoLogo` || m.Cwd != `C:\Users\test` {
		t.Fatalf("额外字段起了作用: %+v", m)
	}
	if _, err := h.svc.CreateShell(contract.CreateShellSessionInput{Kind: contract.SessionKindDev}, nil); !errors.Is(err, ErrShellOnly) {
		t.Fatalf("非 shell 应拒绝，得到 %v", err)
	}
}

// 红线：运行 token 只进 PTY 环境，不出现在 meta、list、事件里。
func TestRunTokenStaysInEnv(t *testing.T) {
	h := newHarness(1_700_000_000_000)
	t.Cleanup(h.shutdown)
	m := unitShell(t, h)
	if err := h.pty(0).Feed("out"); err != nil {
		t.Fatal(err)
	}
	h.fire(16)
	e := h.svc.get(m.ID)
	h.pty(0).Exit(0)
	<-e.done

	calls, _ := h.callsSince(0)
	spawn := calls[0].([]any)[1].(map[string]any)["env"].(map[string]any)
	if spawn["MILE_RUN_TOKEN"] != "tok-1" || spawn["npm_config_progress"] != "false" {
		t.Fatalf("PTY 环境缺 token 或 npm_config_progress: %v", spawn)
	}
	events, _ := h.eventsSince(0)
	blob, _ := json.Marshal([]any{m, h.svc.List(), events})
	if strings.Contains(string(blob), "tok-1") {
		t.Fatalf("token 泄漏到 meta / list / 事件: %s", blob)
	}
}

// blockingPlatform 的 KillTree 卡住，直到测试放行。
type blockingPlatform struct {
	fakePlatform
	entered chan int
	release chan struct{}
}

func (p blockingPlatform) KillTree(ctx context.Context, pid int) {
	p.entered <- pid
	<-p.release
	p.fakePlatform.KillTree(ctx, pid)
}

func TestDisposeAllWaitsForEveryKill(t *testing.T) {
	h := newHarness(1_700_000_000_000)
	bp := blockingPlatform{fakePlatform: fakePlatform{h}, entered: make(chan int, 4), release: make(chan struct{})}
	h.svc = New(context.Background(), bp, fakeOwnership{h}, Options{
		Now:       func() time.Time { return time.UnixMilli(h.getClock()) },
		Homedir:   func() (string, error) { return `C:\Users\test`, nil },
		Environ:   func() []string { return nil },
		Spawn:     h.spawn,
		AfterFunc: h.afterFunc,
		After:     func(time.Duration) <-chan time.Time { return make(chan time.Time) },
	})
	t.Cleanup(h.shutdown)
	h.svc.SetScanner(fakeScanner{h})
	unitShell(t, h)
	unitShell(t, h)

	done := make(chan struct{})
	go func() { h.svc.DisposeAll(context.Background()); close(done) }()
	<-bp.entered
	<-bp.entered
	select {
	case <-done:
		t.Fatal("killTree 还没结束，DisposeAll 就返回了")
	case <-time.After(50 * time.Millisecond):
	}
	close(bp.release)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("放行后 DisposeAll 没返回")
	}
	if n := h.svc.LiveCount(); n != 0 || len(h.svc.List()) != 0 {
		t.Fatalf("DisposeAll 后仍有会话: live=%d list=%d", n, len(h.svc.List()))
	}
}

var _ Platform = blockingPlatform{}

// unitSmile 一个 BMP 外字符（UTF-16 里是代理对）。
var unitSmile = string(rune(0x1F600))

// jsTrim 与 JS String.prototype.trim 同口径：U+FEFF 算空白，U+0085 不算（Go 的 TrimSpace 正好相反）。
func TestJSTrimMatchesJS(t *testing.T) {
	bom, nel := string(rune(0xFEFF)), string(rune(0x85))
	if got := jsTrim(bom + "标题" + bom); got != "标题" {
		t.Fatalf("U+FEFF 应被去掉，得到 %q", got)
	}
	if got := jsTrim(nel + "x" + nel); got != nel+"x"+nel {
		t.Fatalf("U+0085 不应被去掉，得到 %q", got)
	}
}
