// S19 对拍：读 testdata/log_cases.json（由 scripts/gen-log-cases.mjs 跑原版 LogService.ts 生成），
// 在 Go 实现上逐步重放，逐项比对 result / error / events / timers。

package logs

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"mile-console/internal/contract"
)

// fakeSessions 即原版构造参数 sessions 上实际用到的部分：on('data' | 'exit') 与 list()。
type fakeSessions struct {
	mu     sync.Mutex
	metas  []contract.SessionMeta
	dataFn []func(contract.SessionDataEvent)
	exitFn []func(contract.SessionExitEvent)
}

func (f *fakeSessions) List() []contract.SessionMeta {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]contract.SessionMeta, len(f.metas))
	copy(out, f.metas)
	return out
}

func (f *fakeSessions) OnData(fn func(contract.SessionDataEvent)) func() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.dataFn = append(f.dataFn, fn)
	return func() {}
}

func (f *fakeSessions) OnExit(fn func(contract.SessionExitEvent)) func() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.exitFn = append(f.exitFn, fn)
	return func() {}
}

func (f *fakeSessions) add(m contract.SessionMeta) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.metas = append(f.metas, m)
}

func (f *fakeSessions) drop(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := f.metas[:0]
	for _, m := range f.metas {
		if m.ID != id {
			out = append(out, m)
		}
	}
	f.metas = out
}

func (f *fakeSessions) emitData(id, chunk string) {
	f.mu.Lock()
	fns := append([]func(contract.SessionDataEvent){}, f.dataFn...)
	f.mu.Unlock()
	for _, fn := range fns {
		fn(contract.SessionDataEvent{ID: id, Chunk: chunk})
	}
}

func (f *fakeSessions) emitExit(id string) {
	f.mu.Lock()
	fns := append([]func(contract.SessionExitEvent){}, f.exitFn...)
	f.mu.Unlock()
	for _, fn := range fns {
		fn(contract.SessionExitEvent{ID: id, ExitCode: 0})
	}
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

type harness struct {
	mu       sync.Mutex
	sessions *fakeSessions
	svc      *Service
	timers   []*fakeTimer
	clock    int64
	emitted  []contract.LogLine
}

func newHarness(clock int64, recordLines bool) *harness {
	h := &harness{sessions: &fakeSessions{}, clock: clock}
	h.svc = New(h.sessions, Options{
		Now:       func() time.Time { return time.UnixMilli(h.getClock()) },
		AfterFunc: h.afterFunc,
	})
	if recordLines {
		h.svc.OnLine(func(l contract.LogLine) {
			h.mu.Lock()
			h.emitted = append(h.emitted, l)
			h.mu.Unlock()
		})
	}
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
		if !skip {
			t.f()
		}
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

func (h *harness) emittedSince(n int) []contract.LogLine {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]contract.LogLine{}, h.emitted[n:]...)
}

// logNorm 经 JSON 往返统一数字类型，再递归去掉值为 null 的键。
func logNorm(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return logStripNull(out)
}

func logStripNull(v any) any {
	switch x := v.(type) {
	case map[string]any:
		for k, vv := range x {
			if vv == nil {
				delete(x, k)
				continue
			}
			x[k] = logStripNull(vv)
		}
		return x
	case []any:
		for i := range x {
			x[i] = logStripNull(x[i])
		}
		return x
	}
	return v
}

func logJSON(v any) string {
	b, _ := json.Marshal(v)
	s := string(b)
	if len(s) > 1500 {
		s = s[:1500] + "..."
	}
	return s
}

type logCase struct {
	Name        string            `json:"name"`
	Clock       int64             `json:"clock"`
	RecordLines bool              `json:"recordLines"`
	Steps       []json.RawMessage `json:"steps"`
}

type logStep struct {
	Op        string          `json:"op"`
	ID        string          `json:"id"`
	MS        int64           `json:"ms"`
	Title     string          `json:"title"`
	ProjectID *string         `json:"projectId"`
	Data      string          `json:"data"`
	Unit      string          `json:"unit"`
	Count     int             `json:"count"`
	Q         json.RawMessage `json:"q"`
}

func TestLogGolden(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "log_cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Cases []logCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	if len(file.Cases) == 0 {
		t.Fatal("没有用例")
	}
	steps := 0
	for _, c := range file.Cases {
		steps += len(c.Steps)
		t.Run(c.Name, func(t *testing.T) { logRun(t, c) })
	}
	t.Logf("对拍场景 %d 个，步骤 %d 步", len(file.Cases), steps)
}

func logRun(t *testing.T, c logCase) {
	h := newHarness(c.Clock, c.RecordLines)
	emittedN := 0
	for i, rawStep := range c.Steps {
		var st logStep
		if err := json.Unmarshal(rawStep, &st); err != nil {
			t.Fatalf("step %d: %v", i, err)
		}
		var want map[string]any
		if err := json.Unmarshal(rawStep, &want); err != nil {
			t.Fatalf("step %d: %v", i, err)
		}
		var result any
		hasResult := false

		switch st.Op {
		case "clock":
			h.setClock(st.MS)
		case "session":
			h.sessions.add(contract.SessionMeta{
				ID:        st.ID,
				ProjectID: st.ProjectID,
				Kind:      contract.SessionKindShell,
				Title:     st.Title,
				Pid:       4000,
				Status:    contract.SessionStatusRunning,
			})
		case "dropSession":
			h.sessions.drop(st.ID)
		case "data":
			h.sessions.emitData(st.ID, st.Data)
		case "dataRepeat":
			h.sessions.emitData(st.ID, strings.Repeat(st.Unit, st.Count))
		case "exit":
			h.sessions.emitExit(st.ID)
		case "fire":
			h.fire(st.MS)
		case "query":
			var q contract.LogQuery
			if len(st.Q) > 0 {
				if err := json.Unmarshal(st.Q, &q); err != nil {
					t.Fatalf("step %d query: %v", i, err)
				}
			}
			result, hasResult = h.svc.Query(q), true
		case "clear":
			h.svc.Clear()
		case "badListener":
			h.svc.OnLine(func(contract.LogLine) { panic("listener boom") })
		default:
			t.Fatalf("step %d: 未知 op %q", i, st.Op)
		}

		label := c.Name + "#" + st.Op
		if wantRes, ok := want["result"]; ok {
			if !hasResult {
				t.Errorf("step %d %s: 原版有 result，Go 没有", i, label)
			} else if got, w := logNorm(t, result), logNorm(t, wantRes); !reflect.DeepEqual(got, w) {
				t.Errorf("step %d %s result:\n got  %s\n want %s", i, label, logJSON(got), logJSON(w))
			}
		}
		if _, ok := want["error"]; ok {
			t.Errorf("step %d %s: 原版这一步抛错，Go 没有对应错误", i, label)
		}
		if c.RecordLines {
			events := h.emittedSince(emittedN)
			emittedN += len(events)
			got, w := logNorm(t, events), logNorm(t, want["events"])
			if !reflect.DeepEqual(got, w) {
				t.Errorf("step %d %s events:\n got  %s\n want %s", i, label, logJSON(got), logJSON(w))
			}
		}
		if got, w := logNorm(t, h.pendingMs()), logNorm(t, want["timers"]); !reflect.DeepEqual(got, w) {
			t.Errorf("step %d %s timers: got %s want %s", i, label, logJSON(got), logJSON(w))
		}
	}
}
