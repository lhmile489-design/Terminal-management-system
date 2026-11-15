// S06 对拍：testdata/semver_cases.json 由 scripts/gen-semver-cases.mjs 跑原版
// src/main/lib/semver.ts 生成，这里逐条比对 Satisfies 的三值结果（true / false / null）。
// 改了用例输入要重新生成。

package precheck

import (
	"encoding/json"
	"os"
	"testing"
)

func TestSatisfiesMatchesOriginal(t *testing.T) {
	b, err := os.ReadFile("testdata/semver_cases.json")
	if err != nil {
		t.Fatalf("读不到对拍用例（先跑 node scripts/gen-semver-cases.mjs）：%v", err)
	}
	var doc struct {
		Cases []struct {
			Version string `json:"version"`
			Range   string `json:"range"`
			Result  *bool  `json:"result"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Cases) == 0 {
		t.Fatal("用例集为空")
	}
	var yes, no, nul int
	for _, c := range doc.Cases {
		ok, known := Satisfies(c.Version, c.Range)
		if c.Result == nil {
			nul++
			if known {
				t.Errorf("Satisfies(%q, %q) = %v，原版 null", c.Version, c.Range, ok)
			}
			continue
		}
		if !known || ok != *c.Result {
			t.Errorf("Satisfies(%q, %q) = %v,%v，原版 %v", c.Version, c.Range, ok, known, *c.Result)
			continue
		}
		if *c.Result {
			yes++
		} else {
			no++
		}
	}
	// 用例要三种结果都有，否则永远返回 false / null 的实现也能过。
	if yes == 0 || no == 0 || nul == 0 {
		t.Fatalf("用例三态不全：true %d，false %d，null %d", yes, no, nul)
	}
	t.Logf("semver %d 条：true %d，false %d，null %d", len(doc.Cases), yes, no, nul)
}
