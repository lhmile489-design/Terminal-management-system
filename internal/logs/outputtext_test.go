// S05 对拍：testdata/outputtext_cases.json 由 scripts/gen-outputtext-cases.mjs 跑原版
// src/main/lib/outputText.ts 生成，这里逐条比对 Go 实现的输出。改了用例输入要重新生成。

package logs

import (
	"encoding/json"
	"os"
	"slices"
	"testing"
)

type outputTextCases struct {
	GeneratedFrom string `json:"generatedFrom"`
	Classify      []struct {
		Text  string `json:"text"`
		Error bool   `json:"error"`
		Warn  bool   `json:"warn"`
	} `json:"classify"`
	Paint []struct {
		Raw string `json:"raw"`
		Out string `json:"out"`
	} `json:"paint"`
	Tail []struct {
		Raw      string   `json:"raw"`
		Limit    int      `json:"limit"`
		MaxChars *int     `json:"maxChars"`
		Out      []string `json:"out"`
	} `json:"tail"`
	Pick []struct {
		Lines []string `json:"lines"`
		Out   *string  `json:"out"`
	} `json:"pick"`
	Strip []struct {
		Raw string `json:"raw"`
		Out string `json:"out"`
	} `json:"strip"`
}

func loadCases(t *testing.T) outputTextCases {
	t.Helper()
	b, err := os.ReadFile("testdata/outputtext_cases.json")
	if err != nil {
		t.Fatalf("读不到对拍用例（先跑 node scripts/gen-outputtext-cases.mjs）：%v", err)
	}
	var c outputTextCases
	if err := json.Unmarshal(b, &c); err != nil {
		t.Fatal(err)
	}
	n := len(c.Classify) + len(c.Paint) + len(c.Tail) + len(c.Pick) + len(c.Strip)
	if n == 0 || len(c.Classify) == 0 || len(c.Paint) == 0 || len(c.Tail) == 0 || len(c.Pick) == 0 || len(c.Strip) == 0 {
		t.Fatalf("用例集有空分组：classify %d paint %d tail %d pick %d strip %d",
			len(c.Classify), len(c.Paint), len(c.Tail), len(c.Pick), len(c.Strip))
	}
	return c
}

func TestClassifyMatchesOriginal(t *testing.T) {
	c := loadCases(t)
	errHits, warnHits := 0, 0
	for _, k := range c.Classify {
		if got := IsErrorLine(k.Text); got != k.Error {
			t.Errorf("IsErrorLine(%q) = %v，原版 %v", k.Text, got, k.Error)
		}
		if got := IsWarnLine(k.Text); got != k.Warn {
			t.Errorf("IsWarnLine(%q) = %v，原版 %v", k.Text, got, k.Warn)
		}
		if k.Error {
			errHits++
		}
		if k.Warn {
			warnHits++
		}
	}
	// 用例要同时覆盖命中与不命中，否则全 true / 全 false 的实现也能过。
	if errHits == 0 || errHits == len(c.Classify) || warnHits == 0 || warnHits == len(c.Classify) {
		t.Fatalf("分类用例两边不全：error 命中 %d/%d，warn 命中 %d/%d", errHits, len(c.Classify), warnHits, len(c.Classify))
	}
	t.Logf("classify %d 条：error 命中 %d，warn 命中 %d", len(c.Classify), errHits, warnHits)
}

func TestLastVisiblePaintMatchesOriginal(t *testing.T) {
	for _, k := range loadCases(t).Paint {
		if got := LastVisiblePaint(k.Raw); got != k.Out {
			t.Errorf("LastVisiblePaint(%q)\n got %q\nwant %q", k.Raw, got, k.Out)
		}
	}
}

func TestVisibleTailMatchesOriginal(t *testing.T) {
	for _, k := range loadCases(t).Tail {
		var got []string
		if k.MaxChars == nil {
			got = VisibleTail(k.Raw, k.Limit)
		} else {
			got = VisibleTailMax(k.Raw, k.Limit, *k.MaxChars)
		}
		if !slices.Equal(got, k.Out) {
			t.Errorf("VisibleTail(%q, %d, %v)\n got %q\nwant %q", k.Raw, k.Limit, k.MaxChars, got, k.Out)
		}
		if got == nil {
			t.Errorf("VisibleTail 不应返回 nil（序列化会变成 null）")
		}
	}
}

func TestPickLastErrorMatchesOriginal(t *testing.T) {
	for _, k := range loadCases(t).Pick {
		got, ok := PickLastError(k.Lines)
		switch {
		case k.Out == nil && ok:
			t.Errorf("PickLastError(%q) = %q，原版 undefined", k.Lines, got)
		case k.Out != nil && (!ok || got != *k.Out):
			t.Errorf("PickLastError(%q) = %q,%v，原版 %q", k.Lines, got, ok, *k.Out)
		}
	}
}

func TestStripAnsiMatchesOriginal(t *testing.T) {
	for _, k := range loadCases(t).Strip {
		if got := StripAnsi(k.Raw); got != k.Out {
			t.Errorf("StripAnsi(%q) = %q，原版 %q", k.Raw, got, k.Out)
		}
	}
}
