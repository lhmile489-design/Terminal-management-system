// S18 对拍：读 testdata/session_cases.json（由 scripts/gen-session-cases.mjs 跑原版 SessionService.ts 生成），
// 在 Go 实现上逐步重放，逐项比对 result / error / calls / events / timers。

package sessions

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
	"unicode/utf16"

	"mile-console/internal/contract"
)

// summarizeText 与生成脚本的 summarize 同口径：len 是 UTF-16 长度，head / tail 各取 8 个码点，<=200 时附全文。
func summarizeText(s string) map[string]any {
	rs := []rune(s)
	n := len(utf16.Encode(rs))
	head := rs
	if len(head) > 8 {
		head = head[:8]
	}
	tail := rs
	if len(tail) > 8 {
		tail = tail[len(tail)-8:]
	}
	rec := map[string]any{"len": n, "head": string(head), "tail": string(tail)}
	if n <= 200 {
		rec["full"] = s
	}
	return rec
}

// goldenNorm 经 JSON 往返统一数字类型，再递归去掉值为 null 的键（原版省略字段 vs Go 输出 null）。
func goldenNorm(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return goldenStripNull(out)
}

func goldenStripNull(v any) any {
	switch x := v.(type) {
	case map[string]any:
		for k, vv := range x {
			if vv == nil {
				delete(x, k)
				continue
			}
			x[k] = goldenStripNull(vv)
		}
		return x
	case []any:
		for i := range x {
			x[i] = goldenStripNull(x[i])
		}
		return x
	}
	return v
}

// goldenSortCalls 只用于 disposeAll：Go 并发 kill，调用交错顺序不固定。
func goldenSortCalls(calls any) any {
	arr, _ := calls.([]any)
	keys := make([]string, len(arr))
	idx := make([]int, len(arr))
	for i, c := range arr {
		b, _ := json.Marshal(c)
		keys[i] = string(b)
		idx[i] = i
	}
	sort.Slice(idx, func(a, b int) bool { return keys[idx[a]] < keys[idx[b]] })
	out := make([]any, len(arr))
	for i, j := range idx {
		out[i] = arr[j]
	}
	return out
}

type goldenCase struct {
	Name  string            `json:"name"`
	Clock int64             `json:"clock"`
	Steps []json.RawMessage `json:"steps"`
}

type goldenStep struct {
	Op          string          `json:"op"`
	N           int             `json:"n"`
	ID          *string         `json:"id"`
	MS          int64           `json:"ms"`
	TableFails  bool            `json:"tableFails"`
	AssertFails bool            `json:"assertFails"`
	Name        string          `json:"name"`
	Value       bool            `json:"value"`
	Input       json.RawMessage `json:"input"`
	At          *ShellAt        `json:"at"`
	Data        string          `json:"data"`
	Unit        string          `json:"unit"`
	Count       int             `json:"count"`
	Code        int             `json:"code"`
	Cols        int             `json:"cols"`
	Rows        int             `json:"rows"`
	Pid         int             `json:"pid"`
}

func TestSessionGolden(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "session_cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Cases []goldenCase `json:"cases"`
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
		t.Run(c.Name, func(t *testing.T) { goldenRun(t, c) })
	}
	t.Logf("对拍场景 %d 个，步骤 %d 步", len(file.Cases), steps)
}

func goldenRun(t *testing.T, c goldenCase) {
	h := newHarness(c.Clock)
	t.Cleanup(h.shutdown)
	ctx := context.Background()
	var ids []string
	idOf := func(st goldenStep) string {
		if st.ID != nil {
			return *st.ID
		}
		if st.N < len(ids) {
			return ids[st.N]
		}
		return ""
	}
	callsN, eventsN := 0, 0
	for i, rawStep := range c.Steps {
		var st goldenStep
		if err := json.Unmarshal(rawStep, &st); err != nil {
			t.Fatalf("step %d: %v", i, err)
		}
		var want map[string]any
		if err := json.Unmarshal(rawStep, &want); err != nil {
			t.Fatalf("step %d: %v", i, err)
		}
		var result any
		var stepErr error
		hasResult := false

		switch st.Op {
		case "clock":
			h.setClock(st.MS)
		case "scanner":
			h.mu.Lock()
			h.tableFails = st.TableFails
			h.assertFails = st.AssertFails
			h.mu.Unlock()
			h.svc.SetScanner(fakeScanner{h})
		case "flag":
			h.setFlag(h.pty(st.N).pid, st.Name, st.Value)
		case "createShell", "create":
			h.setEnvKeys(goldenEnvKeyOrder(st.Input))
			var meta contract.SessionMeta
			if st.Op == "createShell" {
				var in contract.CreateShellSessionInput
				_ = json.Unmarshal(st.Input, &in)
				meta, stepErr = h.svc.CreateShell(in, st.At)
			} else {
				var in contract.CreateSessionInput
				_ = json.Unmarshal(st.Input, &in)
				meta, stepErr = h.svc.Create(in)
			}
			if stepErr == nil {
				ids = append(ids, meta.ID)
				result, hasResult = meta, true
			}
		case "feed":
			if err := h.pty(st.N).Feed(st.Data); err != nil {
				t.Fatalf("step %d feed: %v", i, err)
			}
		case "feedRepeat":
			if err := h.pty(st.N).Feed(strings.Repeat(st.Unit, st.Count)); err != nil {
				t.Fatalf("step %d feedRepeat: %v", i, err)
			}
		case "exit":
			e := h.svc.get(idOf(st))
			h.pty(st.N).Exit(st.Code)
			if e != nil {
				select {
				case <-e.done:
				case <-time.After(5 * time.Second):
					t.Fatalf("step %d: 退出收尾超时", i)
				}
			}
		case "fire":
			h.fire(st.MS)
		case "write":
			stepErr = h.svc.Write(idOf(st), st.Data)
		case "resize":
			h.svc.Resize(idOf(st), st.Cols, st.Rows)
		case "history":
			result, hasResult = summarizeText(h.svc.History(idOf(st))), true
		case "list":
			result, hasResult = h.svc.List(), true
		case "stop":
			h.svc.Stop(idOf(st))
		case "kill":
			h.svc.Kill(ctx, idOf(st))
		case "ownedPids":
			result, hasResult = h.svc.OwnedPids(), true
		case "sessionIdByPid":
			if sid, ok := h.svc.SessionIDByPid(st.Pid); ok {
				result = sid
			}
			hasResult = true
		case "liveCount":
			result, hasResult = h.svc.LiveCount(), true
		case "disposeAll":
			h.svc.DisposeAll(ctx)
		default:
			t.Fatalf("step %d: 未知 op %q", i, st.Op)
		}

		label := c.Name + "#" + st.Op
		if wantErr, ok := want["error"]; ok {
			if stepErr == nil || stepErr.Error() != wantErr {
				t.Errorf("step %d %s error: got %v want %v", i, label, stepErr, wantErr)
			}
		} else if stepErr != nil {
			t.Errorf("step %d %s 意外错误: %v", i, label, stepErr)
		}
		if wantRes, ok := want["result"]; ok {
			if !hasResult {
				t.Errorf("step %d %s: 原版有 result，Go 没有", i, label)
			} else if got, w := goldenNorm(t, result), goldenNorm(t, wantRes); !reflect.DeepEqual(got, w) {
				t.Errorf("step %d %s result:\n got  %s\n want %s", i, label, goldenJSON(got), goldenJSON(w))
			}
		}

		calls, nc := h.callsSince(callsN)
		callsN = nc
		events, ne := h.eventsSince(eventsN)
		eventsN = ne
		gotCalls, wantCalls := goldenNorm(t, calls), goldenNorm(t, want["calls"])
		if st.Op == "disposeAll" {
			gotCalls, wantCalls = goldenSortCalls(gotCalls), goldenSortCalls(wantCalls)
		}
		if !reflect.DeepEqual(gotCalls, wantCalls) {
			t.Errorf("step %d %s calls:\n got  %s\n want %s", i, label, goldenJSON(gotCalls), goldenJSON(wantCalls))
		}
		if got, w := goldenNorm(t, events), goldenNorm(t, want["events"]); !reflect.DeepEqual(got, w) {
			t.Errorf("step %d %s events:\n got  %s\n want %s", i, label, goldenJSON(got), goldenJSON(w))
		}
		if got, w := goldenNorm(t, h.pendingMs()), goldenNorm(t, want["timers"]); !reflect.DeepEqual(got, w) {
			t.Errorf("step %d %s timers: got %s want %s", i, label, goldenJSON(got), goldenJSON(w))
		}
	}
}

// goldenEnvKeyOrder 按 JSON 原文顺序取 input.env 的键，对应原版 Object.keys（Go map 无序）。
func goldenEnvKeyOrder(input json.RawMessage) []string {
	var top map[string]json.RawMessage
	if json.Unmarshal(input, &top) != nil || top["env"] == nil {
		return nil
	}
	dec := json.NewDecoder(strings.NewReader(string(top["env"])))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return nil
	}
	var keys []string
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return keys
		}
		k, _ := tok.(string)
		keys = append(keys, k)
		var skip json.RawMessage
		if dec.Decode(&skip) != nil {
			return keys
		}
	}
	return keys
}

func goldenJSON(v any) string {
	b, _ := json.Marshal(v)
	s := string(b)
	if len(s) > 1500 {
		s = s[:1500] + "..."
	}
	return s
}
