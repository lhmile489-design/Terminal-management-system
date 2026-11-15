//go:build windows

// S17 对拍：testdata/precheck_cases.json 由 scripts/gen-precheck-cases.mjs 跑原版 PrecheckService 生成。
// 每个场景在 t.TempDir() 里建同一棵目录树、拼同一条 PATH，注入同样的 Node 版本、statfs 与 findFreePort 结果，
// 比对整份 PrecheckResult（或原版抛出的错误文案），以及 findFreePort / statfs 的调用参数与次数。

package precheck

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"mile-console/internal/contract"
	"mile-console/internal/detect"
	"mile-console/internal/platform/win32"
)

type fileSpec struct {
	Dir bool `json:"dir"`
	str *string
}

func (f *fileSpec) UnmarshalJSON(b []byte) error {
	var s string
	if json.Unmarshal(b, &s) == nil {
		f.str = &s
		return nil
	}
	type plain fileSpec
	return json.Unmarshal(b, (*plain)(f))
}

type statfsSpec struct {
	throw         bool
	bsize, bavail uint64
}

func (s *statfsSpec) UnmarshalJSON(b []byte) error {
	if string(b) == `"throw"` {
		s.throw = true
		return nil
	}
	var v struct{ Bsize, Bavail uint64 }
	err := json.Unmarshal(b, &v)
	s.bsize, s.bavail = v.Bsize, v.Bavail
	return err
}

type precheckCase struct {
	Name          string              `json:"name"`
	Files         map[string]fileSpec `json:"files"`
	Path          *[]string           `json:"path"`
	Entry         json.RawMessage     `json:"entry"`
	Snapshot      json.RawMessage     `json:"snapshot"`
	All           json.RawMessage     `json:"all"`
	Node          string              `json:"node"`
	Statfs        statfsSpec          `json:"statfs"`
	FreePort      map[string]int      `json:"freePort"`
	Result        json.RawMessage     `json:"result"`
	Error         string              `json:"error"`
	ResolvedCwd   string              `json:"resolvedCwd"`
	FreePortCalls []int               `json:"freePortCalls"`
	StatfsCalls   []string            `json:"statfsCalls"`
}

type casesFile struct {
	Cases      []precheckCase `json:"cases"`
	ResolveCwd []struct {
		Path   string  `json:"path"`
		Cwd    *string `json:"cwd"`
		Result string  `json:"result"`
	} `json:"resolveCwd"`
}

func loadCases(t *testing.T) casesFile {
	t.Helper()
	b, err := os.ReadFile("testdata/precheck_cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var f casesFile
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

// jsonEscaped 路径在 JSON 字符串里的写法（反斜杠成对）。
func jsonEscaped(s string) string {
	b, _ := json.Marshal(s)
	return string(b[1 : len(b)-1])
}

func subRoot(raw json.RawMessage, dir string) []byte {
	return []byte(strings.ReplaceAll(string(raw), "<ROOT>", jsonEscaped(dir)))
}

func maskRoot(s, dir string) string { return strings.ReplaceAll(s, jsonEscaped(dir), "<ROOT>") }

func buildTree(t *testing.T, dir string, files map[string]fileSpec) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for rel, f := range files {
		p := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if f.str != nil {
			if err := os.WriteFile(p, []byte(*f.str), 0o644); err != nil {
				t.Fatal(err)
			}
		} else if f.Dir {
			if err := os.MkdirAll(p, 0o755); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func canonJSON(t *testing.T, b []byte) any {
	t.Helper()
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("%v: %s", err, b)
	}
	return v
}

func runCase(t *testing.T, c precheckCase, plat *win32.Win32) {
	dir := filepath.Join(t.TempDir(), c.Name)
	buildTree(t, dir, c.Files)

	pathEnv, pathSet := "", c.Path != nil
	if pathSet {
		segs := make([]string, len(*c.Path))
		for i, p := range *c.Path {
			if p != "" {
				segs[i] = filepath.Join(dir, filepath.FromSlash(p))
			}
		}
		pathEnv = strings.Join(segs, ";")
	}
	var freeCalls []int
	var statfsCalls []string
	svc := New(plat, detect.New(plat), Options{
		Getenv: func(k string) (string, bool) {
			if strings.EqualFold(k, "PATH") {
				return pathEnv, pathSet
			}
			return os.LookupEnv(k)
		},
		NodeVersion: func() (string, bool) { return c.Node, true },
		FreeSpace: func(cwd string) (uint64, error) {
			statfsCalls = append(statfsCalls, strings.ReplaceAll(cwd, dir, "<ROOT>"))
			if c.Statfs.throw {
				return 0, errors.New("stub")
			}
			return c.Statfs.bsize * c.Statfs.bavail, nil
		},
		FindFreePort: func(_ context.Context, start int) (int, bool) {
			freeCalls = append(freeCalls, start)
			v, ok := c.FreePort[itoa(start)]
			return v, ok
		},
	})

	var entry contract.LaunchEntry
	if err := json.Unmarshal(subRoot(c.Entry, dir), &entry); err != nil {
		t.Fatal(err)
	}
	var snapshot *contract.ScanSnapshot
	if err := json.Unmarshal(subRoot(c.Snapshot, dir), &snapshot); err != nil {
		t.Fatal(err)
	}
	var all []contract.LaunchEntry
	if err := json.Unmarshal(subRoot(c.All, dir), &all); err != nil {
		t.Fatal(err)
	}

	if got := strings.ReplaceAll(ResolveCwd(entry), dir, "<ROOT>"); got != c.ResolvedCwd {
		t.Errorf("resolveCwd %q / want %q", got, c.ResolvedCwd)
	}

	res, err := svc.Run(context.Background(), entry, snapshot, all)
	if c.Error != "" {
		if err == nil || err.Error() != c.Error {
			t.Fatalf("error %v / want %q", err, c.Error)
		}
	} else {
		if err != nil {
			t.Fatal(err)
		}
		b, _ := json.Marshal(res)
		got := maskRoot(string(b), dir)
		if !reflect.DeepEqual(canonJSON(t, []byte(got)), canonJSON(t, c.Result)) {
			t.Fatalf("result\n got  %s\n want %s", got, c.Result)
		}
	}
	if !reflect.DeepEqual(nz(freeCalls), nz(c.FreePortCalls)) {
		t.Errorf("findFreePort calls %v / want %v", freeCalls, c.FreePortCalls)
	}
	if !reflect.DeepEqual(nzs(statfsCalls), nzs(c.StatfsCalls)) {
		t.Errorf("statfs calls %v / want %v", statfsCalls, c.StatfsCalls)
	}
}

func nz(v []int) []int {
	if v == nil {
		return []int{}
	}
	return v
}

func nzs(v []string) []string {
	if v == nil {
		return []string{}
	}
	return v
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

func TestPrecheckMatchesOriginal(t *testing.T) {
	f := loadCases(t)
	if len(f.Cases) < 100 {
		t.Fatalf("only %d cases", len(f.Cases))
	}
	plat := win32.New()
	seen := map[string]int{}
	for _, c := range f.Cases {
		if c.Result != nil && string(c.Result) != "null" {
			var r contract.PrecheckResult
			_ = json.Unmarshal(c.Result, &r)
			for _, it := range r.Items {
				seen[it.ID+"/"+string(it.Level)]++
			}
		}
		t.Run(c.Name, func(t *testing.T) { runCase(t, c, plat) })
	}
	// 12 个检查项各自的 pass / warn / fail 分支都有场景命中（原版不存在的组合不要求）
	for _, k := range []string{
		"cwd/pass", "cwd/fail", "disk/pass", "disk/warn", "java/pass", "java/fail", "launchMode/pass", "launchMode/fail",
		"lockfile/pass", "lockfile/warn", "node/pass", "node/warn", "nodeModules/pass", "nodeModules/fail",
		"packageJson/pass", "packageJson/fail", "packageManager/pass", "packageManager/fail", "port/pass", "port/warn",
		"registerOnly/fail", "script/pass", "script/fail",
		"python/pass", "python/fail", "go/pass", "go/fail", "cargo/pass", "cargo/fail",
	} {
		if seen[k] == 0 {
			t.Errorf("branch %s not covered", k)
		}
	}
}

func TestResolveCwdMatchesOriginal(t *testing.T) {
	f := loadCases(t)
	if len(f.ResolveCwd) == 0 {
		t.Fatal("no cases")
	}
	for _, c := range f.ResolveCwd {
		e := contract.LaunchEntry{Path: c.Path}
		if c.Cwd != nil {
			e.Cwd = *c.Cwd
		}
		if got := ResolveCwd(e); got != c.Result {
			t.Errorf("resolveCwd(%q, %v) = %q / want %q", c.Path, c.Cwd, got, c.Result)
		}
	}
}
