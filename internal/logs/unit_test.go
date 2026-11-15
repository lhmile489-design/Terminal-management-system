// S19 单测：真定时器收尾、环形缓冲、订阅者抛错、查询隔离、limit 边界。

package logs

import (
	"strings"
	"sync"
	"testing"
	"time"

	"mile-console/internal/contract"
)

func unitLog(t *testing.T) (*Service, *fakeSessions) {
	t.Helper()
	src := &fakeSessions{}
	src.add(contract.SessionMeta{ID: "s1", Kind: contract.SessionKindShell, Title: "终端一", Status: contract.SessionStatusRunning})
	return New(src, Options{Now: func() time.Time { return time.UnixMilli(1_700_000_000_000) }}), src
}

// 真定时器：exit 之后延迟 120ms 收尾，末行不会丢。
func TestFinalFlushWithRealTimer(t *testing.T) {
	svc, src := unitLog(t)
	src.emitData("s1", "head\nlast line")
	if got := svc.Query(contract.LogQuery{}); got.Total != 1 {
		t.Fatalf("exit 前应只有 1 行，得到 %d", got.Total)
	}
	src.emitExit("s1")

	deadline := time.Now().Add(5 * time.Second)
	for {
		r := svc.Query(contract.LogQuery{})
		if r.Total == 2 {
			if r.Lines[1].Text != "last line" {
				t.Fatalf("末行 = %q", r.Lines[1].Text)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("等待收尾超时，只有 %d 行", r.Total)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// 环形缓冲：超过 5000 行只剩最新的，dropped 记下被挤掉的条数。
func TestRingBufferKeepsNewest(t *testing.T) {
	svc, src := unitLog(t)
	for i := 1; i <= MaxLines+7; i++ {
		src.emitData("s1", "line-"+itoa(i)+"\n")
	}
	r := svc.Query(contract.LogQuery{Limit: intPtr(MaxLines)})
	if r.Total != MaxLines || len(r.Lines) != MaxLines {
		t.Fatalf("total=%d len=%d，期望 %d", r.Total, len(r.Lines), MaxLines)
	}
	if r.Dropped != 7 {
		t.Fatalf("dropped=%d，期望 7", r.Dropped)
	}
	if r.Capacity != MaxLines {
		t.Fatalf("capacity=%d", r.Capacity)
	}
	if r.Lines[0].Text != "line-8" || r.Lines[len(r.Lines)-1].Text != "line-5007" {
		t.Fatalf("首尾行不对：%q / %q", r.Lines[0].Text, r.Lines[len(r.Lines)-1].Text)
	}
}

// 订阅者抛错不能拖垮日志收集（原版 try/catch）。
func TestPanickingListenerDoesNotStopCollection(t *testing.T) {
	svc, src := unitLog(t)
	var seen int
	svc.OnLine(func(contract.LogLine) { panic("boom") })
	svc.OnLine(func(contract.LogLine) { seen++ })
	src.emitData("s1", "one\ntwo\n")
	if got := svc.Query(contract.LogQuery{}); got.Total != 2 {
		t.Fatalf("日志应为 2 行，得到 %d", got.Total)
	}
	if seen != 2 {
		t.Fatalf("正常订阅者应收到 2 次，得到 %d", seen)
	}
}

// 查询返回的是拷贝，调用方改动不影响内部状态。
func TestQueryReturnsCopies(t *testing.T) {
	svc, src := unitLog(t)
	src.emitData("s1", "keep\n")
	r := svc.Query(contract.LogQuery{})
	r.Lines[0].Text = "mutated"
	r.Sources[0].Count = 99
	again := svc.Query(contract.LogQuery{})
	if again.Lines[0].Text != "keep" || again.Sources[0].Count != 1 {
		t.Fatalf("内部状态被调用方改动了：%+v", again)
	}
}

// limit 的边界：没给 300，其余收到 [1, 5000]。
func TestClampLimitBounds(t *testing.T) {
	cases := []struct {
		in   *int
		want int
	}{
		{nil, 300},
		{intPtr(0), 1},
		{intPtr(-3), 1},
		{intPtr(1), 1},
		{intPtr(2), 2},
		{intPtr(MaxLines), MaxLines},
		{intPtr(MaxLines + 1), MaxLines},
	}
	for _, c := range cases {
		if got := clampLimit(c.in); got != c.want {
			t.Errorf("clampLimit(%v) = %d，期望 %d", c.in, got, c.want)
		}
	}
}

// 单行按 UTF-16 码元截到 500，切在代理对中间时不以半个字符结尾。
func TestLineTruncatesByUTF16Units(t *testing.T) {
	svc, src := unitLog(t)
	src.emitData("s1", strings.Repeat("a", MaxLineChars-1)+"\U0001F600"+"\n")
	line := svc.Query(contract.LogQuery{}).Lines[0].Text
	if utf16Len(line) != MaxLineChars {
		t.Fatalf("截断后码元数 %d，期望 %d", utf16Len(line), MaxLineChars)
	}
	if !strings.HasSuffix(line, string(rune(0xFFFD))) {
		t.Fatalf("代理对被切开时末尾应是替换符，得到 %q", line[len(line)-3:])
	}
}

// clear 取消挂着的收尾：否则它会把刚清掉的残段再写回来。
func TestClearCancelsPendingFlush(t *testing.T) {
	h := newHarness(1_700_000_000_000, false)
	h.sessions.add(contract.SessionMeta{ID: "s1", Title: "终端一"})
	h.sessions.emitData("s1", "pending")
	h.sessions.emitExit("s1")
	if got := h.pendingMs(); len(got) != 1 {
		t.Fatalf("应有一个收尾定时器，得到 %v", got)
	}
	h.svc.Clear()
	h.fire(120)
	if got := h.svc.Query(contract.LogQuery{}); got.Total != 0 {
		t.Fatalf("clear 后不应有行，得到 %d", got.Total)
	}
}

// 并发灌数据与查询不应死锁或丢行。
func TestConcurrentAbsorbAndQuery(t *testing.T) {
	svc, src := unitLog(t)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				src.emitData("s1", "line\n")
				_ = svc.Query(contract.LogQuery{Limit: intPtr(5)})
			}
		}(i)
	}
	wg.Wait()
	if got := svc.Query(contract.LogQuery{}).Total; got != 400 {
		t.Fatalf("并发灌入后共 %d 行，期望 400", got)
	}
}

func intPtr(v int) *int { return &v }

func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	var b []byte
	for v > 0 {
		b = append([]byte{byte('0' + v%10)}, b...)
		v /= 10
	}
	return string(b)
}

// 退出后又来数据，收尾要推后（原版 `if (this.finalizers.has(id)) this.scheduleFinalFlush(id)`）。
// 用放大 10 倍的定时器把窗口拉开，避免与 120ms 的真时序抢边缘。
func TestLateDataPostponesFinalFlush(t *testing.T) {
	const scale = 10
	src := &fakeSessions{}
	src.add(contract.SessionMeta{ID: "s1", Title: "终端一"})
	svc := New(src, Options{
		AfterFunc: func(d time.Duration, f func()) Timer { return time.AfterFunc(d*scale, f) },
	})

	src.emitData("s1", "head\n")
	src.emitExit("s1") // 收尾预定在 +1200ms
	time.Sleep(300 * time.Millisecond)
	src.emitData("s1", "late") // 推后到 +1500ms

	// 原定时器到点（+1200ms）时不应收尾：此刻只过了 +1300ms
	time.Sleep(time.Second)
	if got := svc.Query(contract.LogQuery{}); got.Total != 1 {
		t.Fatalf("收尾没有被推后：+1300ms 时就出现了 %d 行", got.Total)
	}

	deadline := time.Now().Add(3 * time.Second)
	for {
		r := svc.Query(contract.LogQuery{})
		if r.Total == 2 {
			if r.Lines[1].Text != "late" {
				t.Fatalf("末行 = %q", r.Lines[1].Text)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("推后的收尾没有发生，只有 %d 行", r.Total)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
