//go:build windows

// S15 对拍：重放 testdata/scanner_cases.json（scripts/gen-scanner-cases.mjs 跑原版
// src/main/services/ScannerService.ts 生成），逐步比较发出的增量、错误、定时器设置 / 清除、方法返回值、
// 快照、netstat / CIM 调用次数，以及扫描器改过的三项配置。
//
// 原版的 `void this.tick()` 在这里同步执行（Options.Go），与生成器里每步之后 flush 微任务等价。
// 唯一依赖 JS 异步交错的场景是 tick 互斥（refreshTwice），用「采集进行中再调一次 Refresh」重现。

package scanner

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"

	"mile-console/internal/contract"
	"mile-console/internal/ownership"
	"mile-console/internal/platform"
)

func itoaTest(n int) string { return strconv.Itoa(n) }

type scanStep struct {
	Clock    *int64          `json:"clock"`
	World    json.RawMessage `json:"world"`
	Expect   json.RawMessage `json:"expect"`
	Settings *struct {
		ScanIntervalMs int `json:"scanIntervalMs"`
	} `json:"settings"`
	Op        string                     `json:"op"`
	Args      []json.RawMessage          `json:"args"`
	Error     *string                    `json:"error"`
	Result    json.RawMessage            `json:"result"`
	Diffs     []json.RawMessage          `json:"diffs"`
	DiffCount *int                       `json:"diffCount"`
	Errors    []string                   `json:"errors"`
	Timers    []timerLog                 `json:"timers"`
	Snapshot  json.RawMessage            `json:"snapshot"`
	Reads     struct{ Listen, Meta int } `json:"reads"`
	Config    json.RawMessage            `json:"config"`
}

type scanCase struct {
	Name            string          `json:"name"`
	Clock           int64           `json:"clock"`
	SelfPid         int             `json:"selfPid"`
	NoErrorListener bool            `json:"noErrorListener"`
	Config          json.RawMessage `json:"config"`
	Steps           []scanStep      `json:"steps"`
}

func loadScanCases(t *testing.T) []scanCase {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "scanner_cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f struct{ Cases []scanCase }
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Cases) == 0 {
		t.Fatal("没有用例")
	}
	return f.Cases
}

// loose 把 JSON 解成通用值再比：字段顺序无关，-0 与 0 相等（JS 的 JSON.stringify(-0) 是 0）。
// 期望值里的 U+FFFD 去掉：原版截断命令行时会切出孤立代理，生成器写成 \ud83d，Go 解出来是 U+FFFD；
// Go 侧直接丢掉那半个字符（docs/MIGRATION-PLAN.md §6「孤立代理」）。fffd 记录命中次数，确认这个偏差真被走到。
func loose(t *testing.T, b []byte, fffd *int) any {
	t.Helper()
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("解析 %s：%v", b, err)
	}
	return stripFFFD(v, fffd)
}

func stripFFFD(v any, hits *int) any {
	switch x := v.(type) {
	case string:
		if hits != nil && strings.Contains(x, repl) {
			*hits++
			return strings.ReplaceAll(x, repl, "")
		}
		return x
	case []any:
		for i := range x {
			x[i] = stripFFFD(x[i], hits)
		}
	case map[string]any:
		for k := range x {
			x[k] = stripFFFD(x[k], hits)
		}
	}
	return v
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

func initialConfig(raw json.RawMessage) contract.AppConfig {
	cfg := contract.AppConfig{IgnoredListeners: []contract.IgnoredListener{}, GroupOverrides: []contract.GroupOverride{}, WatchedKeywords: []string{}}
	var in struct {
		IgnoredListeners *[]contract.IgnoredListener `json:"ignoredListeners"`
		GroupOverrides   *[]contract.GroupOverride   `json:"groupOverrides"`
		WatchedKeywords  *[]string                   `json:"watchedKeywords"`
		Settings         *struct {
			ScanIntervalMs *int `json:"scanIntervalMs"`
		} `json:"settings"`
	}
	_ = json.Unmarshal(raw, &in)
	if in.IgnoredListeners != nil {
		cfg.IgnoredListeners = *in.IgnoredListeners
	}
	if in.GroupOverrides != nil {
		cfg.GroupOverrides = *in.GroupOverrides
	}
	if in.WatchedKeywords != nil {
		cfg.WatchedKeywords = *in.WatchedKeywords
	}
	cfg.Settings.ScanIntervalMs = 2000
	if in.Settings != nil && in.Settings.ScanIntervalMs != nil {
		cfg.Settings.ScanIntervalMs = *in.Settings.ScanIntervalMs
	}
	return cfg
}

func parseExpect(t *testing.T, raw json.RawMessage) []EntryExpectation {
	var in []struct {
		ID        string `json:"id"`
		Port      int    `json:"port"`
		Cwd       string `json:"cwd"`
		Pid       *int   `json:"pid"`
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(raw, &in); err != nil {
		t.Fatal(err)
	}
	out := make([]EntryExpectation, len(in))
	for i, e := range in {
		out[i] = EntryExpectation{ID: e.ID, Port: e.Port, Cwd: e.Cwd, Pid: e.Pid, SessionID: e.SessionID}
	}
	return out
}

type tableOut struct {
	ByPid   []int `json:"byPid"`
	Mine    []int `json:"mine"`
	At      int64 `json:"at"`
	Listens any   `json:"listens"`
}

func TestScannerMatchesOriginal(t *testing.T) {
	ops := map[string]int{}
	fffd := 0
	steps := 0
	for _, c := range loadScanCases(t) {
		t.Run(c.Name, func(t *testing.T) {
			w := newWorld(c.Clock)
			timers := &fakeTimers{}
			cfg := &memConfig{cfg: initialConfig(c.Config)}
			own := ownership.New(w.now)
			var diffs []contract.ScanDiff
			var errs []string
			opts := Options{
				Now: w.now, SelfPid: c.SelfPid, Metrics: w, After: timers.after,
				Go:     func(fn func()) { fn() },
				OnDiff: func(d contract.ScanDiff) { diffs = append(diffs, d) },
			}
			if !c.NoErrorListener {
				opts.OnError = func(err error) { errs = append(errs, err.Error()) }
			}
			s := New(t.Context(), w, own, cfg, opts)
			var exps []EntryExpectation
			s.SetExpectationSource(func() []EntryExpectation { return exps })

			for i, st := range c.Steps {
				where := c.Name + " #" + strconv.Itoa(i) + " " + st.Op
				switch {
				case st.Clock != nil:
					w.mu.Lock()
					w.clock = *st.Clock
					w.mu.Unlock()
					continue
				case st.World != nil:
					w.mu.Lock()
					w.st.merge(st.World)
					w.mu.Unlock()
					continue
				case st.Expect != nil:
					exps = parseExpect(t, st.Expect)
					continue
				case st.Settings != nil:
					cfg.mu.Lock()
					cfg.cfg.Settings.ScanIntervalMs = st.Settings.ScanIntervalMs
					cfg.mu.Unlock()
					continue
				}
				steps++
				ops[st.Op]++
				result, err := runOp(t, s, own, timers, w, st)
				if st.Error != nil {
					if err == nil || err.Error() != *st.Error {
						t.Errorf("%s：Go 错误 %v，原版 %q", where, err, *st.Error)
					}
				} else if err != nil {
					t.Errorf("%s：Go 报错 %v，原版没有", where, err)
				} else if st.Result != nil {
					if got, want := loose(t, mustJSON(result), nil), loose(t, st.Result, &fffd); !reflect.DeepEqual(got, want) {
						t.Errorf("%s 返回值：\n  Go   %s\n  原版 %s", where, mustJSON(got), mustJSON(want))
					}
				}

				gotDiffs := diffs
				if st.DiffCount != nil {
					if len(diffs) != *st.DiffCount {
						t.Errorf("%s：Go 发了 %d 个增量，原版 %d 个", where, len(diffs), *st.DiffCount)
					}
					gotDiffs = diffs[max(0, len(diffs)-1):]
				}
				if got, want := loose(t, mustJSON(orEmpty(gotDiffs)), nil), loose(t, mustJSON(orEmpty(st.Diffs)), &fffd); !reflect.DeepEqual(got, want) {
					t.Errorf("%s 增量：\n  Go   %s\n  原版 %s", where, mustJSON(got), mustJSON(want))
				}
				if !slices.Equal(errs, st.Errors) && !(len(errs) == 0 && len(st.Errors) == 0) {
					t.Errorf("%s 错误事件：Go %q，原版 %q", where, errs, st.Errors)
				}
				if got, want := mustJSON(orEmpty(timers.take())), mustJSON(orEmpty(st.Timers)); string(got) != string(want) {
					t.Errorf("%s 定时器：Go %s，原版 %s", where, got, want)
				}
				if got, want := loose(t, mustJSON(s.Snapshot()), nil), loose(t, st.Snapshot, &fffd); !reflect.DeepEqual(got, want) {
					t.Errorf("%s 快照：\n  Go   %s\n  原版 %s", where, mustJSON(got), mustJSON(want))
				}
				w.mu.Lock()
				lr, mr := w.listenReads, w.metaReads
				w.mu.Unlock()
				if lr != st.Reads.Listen || mr != st.Reads.Meta {
					t.Errorf("%s 采集次数：Go netstat %d / CIM %d，原版 %d / %d", where, lr, mr, st.Reads.Listen, st.Reads.Meta)
				}
				cur := cfg.Get()
				gotCfg := map[string]any{"ignoredListeners": cur.IgnoredListeners, "groupOverrides": cur.GroupOverrides, "watchedKeywords": cur.WatchedKeywords}
				if got, want := loose(t, mustJSON(gotCfg), nil), loose(t, st.Config, &fffd); !reflect.DeepEqual(got, want) {
					t.Errorf("%s 配置：\n  Go   %s\n  原版 %s", where, mustJSON(got), mustJSON(want))
				}
				diffs, errs = nil, nil
			}
			s.Stop()
		})
	}
	for _, op := range []string{"refresh", "refreshTwice", "start", "stop", "fire", "setVisible", "reschedule", "ignore",
		"hideOnce", "hideOnceMany", "setGroup", "setWatched", "table", "knownPath", "isVisible", "listenRows", "register", "unregister"} {
		if ops[op] == 0 {
			t.Errorf("对拍数据没覆盖 %s", op)
		}
	}
	if fffd == 0 {
		t.Error("孤立代理的偏差用例没有被走到，生成器里的输入变了")
	}
	t.Logf("%d 步，%v；孤立代理偏差命中 %d 处", steps, ops, fffd)
}

// jsListens 即原版 ListenRow 的 JSON 形状（platform.ListenRow 不带 json 标签）。
func jsListens(rows []platform.ListenRow) []map[string]any {
	out := []map[string]any{}
	for _, r := range rows {
		out = append(out, map[string]any{"port": r.Port, "pid": r.Pid, "families": orEmpty(r.Families)})
	}
	return out
}

func orEmpty[T any](xs []T) []T {
	if xs == nil {
		return []T{}
	}
	return xs
}

func arg[T any](t *testing.T, st scanStep, i int) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(st.Args[i], &v); err != nil {
		t.Fatalf("参数 %d %s：%v", i, st.Args[i], err)
	}
	return v
}

func runOp(t *testing.T, s *Service, own *ownership.Service, timers *fakeTimers, w *world, st scanStep) (any, error) {
	switch st.Op {
	case "register":
		own.Register(arg[string](t, st, 0), arg[int](t, st, 1), "tok")
	case "unregister":
		own.Unregister(arg[string](t, st, 0))
	case "refresh":
		s.Refresh()
	case "refreshTwice":
		// 原版两次同步调用：第一次 tick 停在第一个 await，第二次看到 running 直接返回。这里在采集中途再调一次
		w.mu.Lock()
		w.onListen = s.Refresh
		w.mu.Unlock()
		s.Refresh()
	case "start":
		s.Start()
	case "stop":
		s.Stop()
	case "fire":
		return nil, timers.fire()
	case "setVisible":
		s.SetVisible(arg[bool](t, st, 0))
	case "reschedule":
		s.Reschedule()
	case "ignore":
		return nil, s.Ignore(arg[string](t, st, 0), arg[int](t, st, 1))
	case "hideOnce":
		s.HideOnce(arg[int](t, st, 0), arg[int](t, st, 1))
	case "hideOnceMany":
		base, n, port := arg[int](t, st, 0), arg[int](t, st, 1), arg[int](t, st, 2)
		for i := range n {
			s.HideOnce(base+i, port)
		}
	case "setGroup":
		var g *contract.ListenerGroup
		if string(st.Args[1]) != "null" {
			v := arg[contract.ListenerGroup](t, st, 1)
			g = &v
		}
		return nil, s.SetGroup(arg[string](t, st, 0), g)
	case "setWatched":
		return s.SetWatchedKeywords(st.Args[0])
	case "table":
		hint := arg[[]int](t, st, 0)
		tb, err := s.Table(t.Context(), hint)
		if err != nil {
			return nil, err
		}
		out := tableOut{At: tb.At, Listens: jsListens(tb.Listens)}
		for p := range tb.ByPid {
			out.ByPid = append(out.ByPid, p)
		}
		for p := range tb.Mine {
			out.Mine = append(out.Mine, p)
		}
		slices.Sort(out.ByPid)
		slices.Sort(out.Mine)
		out.ByPid, out.Mine = orEmpty(out.ByPid), orEmpty(out.Mine)
		return out, nil
	case "knownPath":
		return s.KnownPath(arg[string](t, st, 0)), nil
	case "isVisible":
		return s.IsVisible(), nil
	case "listenRows":
		return jsListens(s.ListenRows()), nil
	default:
		t.Fatalf("未知操作 %s", st.Op)
	}
	return nil, nil
}
