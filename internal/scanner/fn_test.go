//go:build windows

// S15 纯函数对拍：testdata/scanner_fn_cases.json 由 scripts/gen-scanner-fn-cases.mjs 直接调原版
// ScannerService.ts 末尾的 guessCwd / normalizeKeywords / truncate / countConflicts / matchEntry 生成。

package scanner

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"mile-console/internal/contract"
)

type fnCases struct {
	GuessCwd []struct {
		Input  string  `json:"input"`
		Result *string `json:"result"`
	} `json:"guessCwd"`
	Normalize []struct {
		Input  []string `json:"input"`
		Result []string `json:"result"`
	} `json:"normalize"`
	Truncate []struct {
		Input  *string `json:"input"`
		Max    int     `json:"max"`
		Result *string `json:"result"`
	} `json:"truncate"`
	Conflicts []struct {
		Exps []struct {
			ID   string `json:"id"`
			Port int    `json:"port"`
			Cwd  string `json:"cwd"`
		} `json:"exps"`
		Listeners []struct {
			Pid     int    `json:"pid"`
			Ports   []int  `json:"ports"`
			EntryID string `json:"entryId"`
		} `json:"listeners"`
		Result int `json:"result"`
	} `json:"conflicts"`
	MatchExps []struct {
		ID        string `json:"id"`
		Cwd       string `json:"cwd"`
		Pid       *int   `json:"pid"`
		SessionID string `json:"sessionId"`
	} `json:"matchExps"`
	Match []struct {
		Pid       int     `json:"pid"`
		SessionID *string `json:"sessionId"`
		Cwd       *string `json:"cwd"`
		Result    *string `json:"result"`
	} `json:"match"`
}

func loadFn(t *testing.T) fnCases {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "scanner_fn_cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var c fnCases
	if err := json.Unmarshal(b, &c); err != nil {
		t.Fatal(err)
	}
	return c
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// noLone 期望值里的孤立代理（JSON 解出来是 U+FFFD）在 Go 侧被丢掉，比较前去掉。
func noLone(s string, hits *int) string {
	if strings.Contains(s, repl) {
		*hits++
		return strings.ReplaceAll(s, repl, "")
	}
	return s
}

// repl 即 U+FFFD。写成转义：源码里不放字面替换符，编码扫描才能把它当成损坏的信号。
const repl = "\uFFFD"

func TestPureFunctionsMatchOriginal(t *testing.T) {
	c := loadFn(t)
	s := New(t.Context(), newWorld(0), nil, &memConfig{}, Options{Metrics: newWorld(0)})
	lone := 0

	if len(c.GuessCwd) < 400 {
		t.Fatalf("guessCwd 用例太少：%d", len(c.GuessCwd))
	}
	hitNM, hitCut, hitNone := 0, 0, 0
	for _, k := range c.GuessCwd {
		got, want := s.guessCwd(k.Input), deref(k.Result)
		if got != want {
			t.Errorf("guessCwd(%q)：Go %q，原版 %q", k.Input, got, want)
		}
		switch {
		case want == "":
			hitNone++
		case strings.Contains(strings.ToLower(k.Input), "node_modules"):
			hitNM++
		default:
			hitCut++
		}
	}
	if hitNM == 0 || hitCut == 0 || hitNone == 0 {
		t.Errorf("guessCwd 三条分支都要有用例命中：node_modules %d、取父目录 %d、推不出 %d", hitNM, hitCut, hitNone)
	}

	for _, k := range c.Normalize {
		want := make([]string, len(k.Result))
		for i, w := range k.Result {
			want[i] = noLone(w, &lone)
		}
		if got := normalizeKeywords(k.Input); !slices.Equal(got, want) {
			t.Errorf("normalizeKeywords(%q)：Go %q，原版 %q", k.Input, got, want)
		}
	}
	for _, k := range c.Truncate {
		want := noLone(deref(k.Result), &lone)
		if got := truncate(deref(k.Input), k.Max); got != want {
			t.Errorf("truncate(%q, %d)：Go %q，原版 %q", deref(k.Input), k.Max, got, want)
		}
	}
	if lone == 0 {
		t.Error("孤立代理的偏差用例没有被走到")
	}

	for i, k := range c.Conflicts {
		var exps []EntryExpectation
		for _, e := range k.Exps {
			exps = append(exps, EntryExpectation{ID: e.ID, Port: e.Port, Cwd: e.Cwd})
		}
		var ls []contract.ListenerSnapshot
		for _, l := range k.Listeners {
			ls = append(ls, contract.ListenerSnapshot{Pid: l.Pid, Ports: l.Ports, EntryID: l.EntryID})
		}
		if got := countConflicts(exps, ls); got != k.Result {
			t.Errorf("countConflicts 第 %d 组：Go %d，原版 %d", i, got, k.Result)
		}
	}

	var exps []EntryExpectation
	for _, e := range c.MatchExps {
		exps = append(exps, EntryExpectation{ID: e.ID, Cwd: e.Cwd, Pid: e.Pid, SessionID: e.SessionID})
	}
	seen := map[string]bool{}
	for _, k := range c.Match {
		got, want := s.matchEntry(exps, k.Pid, deref(k.Cwd), deref(k.SessionID)), deref(k.Result)
		if got != want {
			t.Errorf("matchEntry(pid %d, cwd %q, session %q)：Go %q，原版 %q", k.Pid, deref(k.Cwd), deref(k.SessionID), got, want)
		}
		seen[want] = true
	}
	// 四层匹配（pid / 会话 / 全等 / 前缀）和不匹配都要有用例命中
	for _, id := range []string{"p", "s", "e", "g", ""} {
		if !seen[id] {
			t.Errorf("matchEntry 没有用例命中 %q", id)
		}
	}
	t.Logf("guessCwd %d（node_modules %d / 父目录 %d / 推不出 %d），normalize %d，truncate %d，conflicts %d，match %d；孤立代理偏差 %d 处",
		len(c.GuessCwd), hitNM, hitCut, hitNone, len(c.Normalize), len(c.Truncate), len(c.Conflicts), len(c.Match), lone)
}
