//go:build windows

// S09 对拍的公共部分：读 testdata/config_cases.json（scripts/gen-config-cases.mjs 跑原版 ConfigStore 生成），
// 以及「把原版输出投影到 Go 结构体」的比较口径。
//
// 投影：原版输出先按 contract.AppConfig 宽松解码再序列化，去掉 Go 结构体没有的键（未知键在写盘时丢掉，
// 已接受偏差）。类型不对的值投影后成为零值，与 Go 回落到默认值的结果不同，这类用例在 deviations 里单独断言。

package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"mile-console/internal/contract"
	"mile-console/internal/platform/win32"
)

var plat = win32.New()

type caseFile struct {
	MaxIgnored int `json:"maxIgnored"`
	Migrate    []struct {
		Input    json.RawMessage `json:"input"`
		Output   json.RawMessage `json:"output"`
		ReadOnly bool            `json:"readOnly"`
	} `json:"migrate"`
	Boot []struct {
		Primary    string             `json:"primary"`
		Backup     string             `json:"backup"`
		Files      map[string]*string `json:"files"`
		Config     json.RawMessage    `json:"config"`
		ReadOnly   bool               `json:"readOnly"`
		AfterBoot  map[string]string  `json:"afterBoot"`
		AfterPatch map[string]string  `json:"afterPatch"`
	} `json:"boot"`
	Sequence     []map[string]string `json:"sequence"`
	ImportBackup []struct {
		WithFile bool              `json:"withFile"`
		Names    []string          `json:"names"`
		Files    map[string]string `json:"files"`
	} `json:"importBackup"`
}

func loadCases(t *testing.T) caseFile {
	t.Helper()
	b, err := os.ReadFile("testdata/config_cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var c caseFile
	if err := json.Unmarshal(b, &c); err != nil {
		t.Fatal(err)
	}
	return c
}

// project 把原版的 AppConfig JSON 投影成 Go 结构体能表达的样子，再解成通用树。
func project(t *testing.T, raw json.RawMessage) any {
	t.Helper()
	var c contract.AppConfig
	if !decodeLoose(raw, &c) {
		t.Fatalf("原版输出不是对象：%s", raw)
	}
	return tree(t, c)
}

// tree 把任意值序列化后再解成 map / slice / float64 组成的通用树，用来做与键顺序无关的比较。
func tree(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func treeOfBytes(t *testing.T, b []byte) (any, bool) {
	t.Helper()
	var out any
	if json.Unmarshal(b, &out) != nil {
		return nil, false
	}
	return out, true
}

// snapshot 读目录下全部文件。
func snapshot(t *testing.T, dir string) map[string]string {
	t.Helper()
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, e := range ents {
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		out[e.Name()] = string(b)
	}
	return out
}

// compareSnapshot 比较 Go 与原版的目录快照：文件集合相同；原版里与某个输入文件逐字节相同的（没被改过的 .bak、
// 挪成 .corrupt 的坏主文件），Go 也必须逐字节相同；其余能解析成 JSON 的按投影比较，解析不了的逐字节比较。
func compareSnapshot(t *testing.T, label string, got, want map[string]string, inputs map[string]*string) {
	t.Helper()
	if !reflect.DeepEqual(keys(got), keys(want)) {
		t.Errorf("%s：文件集合 Go %v，原版 %v", label, keys(got), keys(want))
		return
	}
	for name, w := range want {
		g := got[name]
		untouched := false
		for _, in := range inputs {
			if in != nil && *in == w {
				untouched = true
			}
		}
		if untouched {
			if g != w {
				t.Errorf("%s：%s 应原样保留（原版逐字节未变），Go 改了内容", label, name)
			}
			continue
		}
		if _, ok := treeOfBytes(t, []byte(w)); !ok {
			if g != w {
				t.Errorf("%s：%s Go %q，原版 %q", label, name, g, w)
			}
			continue
		}
		if !reflect.DeepEqual(project(t, json.RawMessage(g)), project(t, json.RawMessage(w))) {
			t.Errorf("%s：%s 内容不同\n Go   %s\n 原版 %s", label, name, g, w)
		}
	}
}

func keys(m map[string]string) []string {
	var ks []string
	for k := range m {
		ks = append(ks, k)
	}
	if ks == nil {
		return []string{}
	}
	sortStrings(ks)
	return ks
}

func sortStrings(xs []string) {
	for i := 1; i < len(xs); i++ {
		for j := i; j > 0 && xs[j] < xs[j-1]; j-- {
			xs[j], xs[j-1] = xs[j-1], xs[j]
		}
	}
}
