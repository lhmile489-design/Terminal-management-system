// S16 对拍：testdata/detect_cases.json 由 scripts/gen-detect-cases.mjs 跑原版 DetectService.ts 生成。
// 每个场景在 t.TempDir() 里建同一棵目录树，结果里的 <ROOT> / <ORIG> 换回本机路径后逐字段比对。

package detect

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"mile-console/internal/contract"
	"mile-console/internal/platform"
)

type fileSpec struct {
	text *string
	dir  bool
	b64  *string
	size *int
}

func (f *fileSpec) UnmarshalJSON(b []byte) error {
	if len(b) > 0 && b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		f.text = &s
		return nil
	}
	var o struct {
		Dir  bool    `json:"dir"`
		B64  *string `json:"b64"`
		Size *int    `json:"size"`
	}
	if err := json.Unmarshal(b, &o); err != nil {
		return err
	}
	f.dir, f.b64, f.size = o.Dir, o.B64, o.Size
	return nil
}

// orderedFiles 保留 JSON 里的键顺序：建树顺序与 node 一致（Object.entries）。
type orderedFiles struct {
	keys []string
	m    map[string]fileSpec
}

func (o *orderedFiles) UnmarshalJSON(b []byte) error {
	dec := json.NewDecoder(bytes.NewReader(b))
	if _, err := dec.Token(); err != nil {
		return err
	}
	o.m = map[string]fileSpec{}
	for dec.More() {
		k, err := dec.Token()
		if err != nil {
			return err
		}
		var f fileSpec
		if err := dec.Decode(&f); err != nil {
			return err
		}
		o.keys = append(o.keys, k.(string))
		o.m[k.(string)] = f
	}
	_, err := dec.Token()
	return err
}

func buildTree(t *testing.T, dir string, files orderedFiles) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, rel := range files.keys {
		f := files.m[rel]
		p := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		var err error
		switch {
		case f.text != nil:
			err = os.WriteFile(p, []byte(*f.text), 0o644)
		case f.dir:
			err = os.MkdirAll(p, 0o755)
		case f.b64 != nil:
			var b []byte
			if b, err = base64.StdEncoding.DecodeString(*f.b64); err == nil {
				err = os.WriteFile(p, b, 0o644)
			}
		case f.size != nil:
			err = os.WriteFile(p, bytes.Repeat([]byte{'A'}, *f.size), 0o644)
		}
		if err != nil {
			t.Fatal(err)
		}
	}
}

type fakePlatform struct{}

func (fakePlatform) WrapperFile() platform.WrapperFiles {
	return platform.WrapperFiles{Maven: "mvnw.cmd", Gradle: "gradlew.bat"}
}
func (fakePlatform) UnsupportedLaunchModes() map[contract.LaunchMode]bool {
	return map[contract.LaunchMode]bool{}
}

type detectCases struct {
	Detect []struct {
		Name    string          `json:"name"`
		Files   orderedFiles    `json:"files"`
		Missing bool            `json:"missing"`
		Result  json.RawMessage `json:"result"`
	} `json:"detect"`
	Lockfile []struct {
		Name   string  `json:"name"`
		Result *string `json:"result"`
	} `json:"lockfile"`
	Favicon []struct {
		Name   string       `json:"name"`
		Files  orderedFiles `json:"files"`
		Result *Favicon     `json:"result"`
	} `json:"favicon"`
	Profiles []struct {
		Name   string       `json:"name"`
		Files  orderedFiles `json:"files"`
		Result []string     `json:"result"`
	} `json:"profiles"`
	Scan []struct {
		Name    string          `json:"name"`
		Limit   int             `json:"limit"`
		Entries orderedFiles    `json:"entries"`
		Missing bool            `json:"missing"`
		Result  json.RawMessage `json:"result"`
	} `json:"scan"`
	Fixtures []struct {
		Name     string          `json:"name"`
		Result   json.RawMessage `json:"result"`
		Lockfile *string         `json:"lockfile"`
		Favicon  *Favicon        `json:"favicon"`
	} `json:"fixtures"`
	Clean []struct {
		Input string `json:"input"`
		Clean string `json:"clean"`
		Ext   string `json:"ext"`
	} `json:"clean"`
	Hrefs []struct {
		HTML   string   `json:"html"`
		Result []string `json:"result"`
	} `json:"hrefs"`
}

func loadDetect(t *testing.T) detectCases {
	t.Helper()
	b, err := os.ReadFile("testdata/detect_cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var c detectCases
	if err := json.Unmarshal(b, &c); err != nil {
		t.Fatal(err)
	}
	return c
}

// jsonEscapePath 路径在 JSON 字符串里的形式（反斜杠转义），用来替换占位符。
func jsonEscapePath(p string) string {
	b, _ := json.Marshal(p)
	return string(b[1 : len(b)-1])
}

// canon 把期望值的占位符换回本机路径，再与实际值统一序列化后比较（键顺序按 Go 结构体，值逐字段）。
func canon(t *testing.T, raw json.RawMessage, root, orig string) string {
	t.Helper()
	s := strings.ReplaceAll(string(raw), "<ROOT>", jsonEscapePath(root))
	s = strings.ReplaceAll(s, "<ORIG>", jsonEscapePath(orig))
	var v any
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		t.Fatal(err)
	}
	out, _ := json.Marshal(v)
	return string(out)
}

func actual(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var x any
	_ = json.Unmarshal(b, &x)
	out, _ := json.Marshal(x)
	return string(out)
}

// expectedScriptsOrder 期望值里 scripts 的键顺序：canon 解成 map 后顺序丢了，用 contract.Scripts 解一次保住原文顺序。
func expectedScriptsOrder(t *testing.T, raw json.RawMessage) []string {
	t.Helper()
	var r contract.DetectResult
	if err := json.Unmarshal(raw, &r); err != nil {
		t.Fatal(err)
	}
	return r.Scripts.Keys()
}

func TestDetectMatchesOriginal(t *testing.T) {
	c := loadDetect(t)
	if len(c.Detect) < 90 {
		t.Fatalf("only %d detect cases", len(c.Detect))
	}
	svc := New(fakePlatform{})
	root := t.TempDir()
	for _, tc := range c.Detect {
		dir := filepath.Join(root, "d", tc.Name)
		if tc.Missing {
			dir = filepath.Join(root, "d", "no-such-dir")
		} else {
			buildTree(t, dir, tc.Files)
		}
		got := svc.Detect(dir)
		if a, w := actual(t, got), canon(t, tc.Result, root, ""); a != w {
			t.Errorf("%s\n got  %s\n want %s", tc.Name, a, w)
			continue
		}
		if a, w := got.Scripts.Keys(), expectedScriptsOrder(t, tc.Result); !slices.Equal(a, w) {
			t.Errorf("%s scripts order\n got  %q\n want %q", tc.Name, a, w)
		}
	}
	for _, tc := range c.Lockfile {
		pm, ok := svc.LockfileFor(filepath.Join(root, "d", tc.Name))
		if (tc.Result == nil) != !ok || (ok && string(pm) != *tc.Result) {
			t.Errorf("lockfile %s: got %q %v want %v", tc.Name, pm, ok, tc.Result)
		}
	}
}

func TestReadFaviconMatchesOriginal(t *testing.T) {
	c := loadDetect(t)
	if len(c.Favicon) < 10 {
		t.Fatalf("only %d favicon cases", len(c.Favicon))
	}
	svc := New(fakePlatform{})
	root := t.TempDir()
	hits := 0
	for _, tc := range c.Favicon {
		dir := filepath.Join(root, "f", tc.Name)
		buildTree(t, dir, tc.Files)
		got := svc.ReadFavicon(dir)
		if (got == nil) != (tc.Result == nil) || (got != nil && *got != *tc.Result) {
			t.Errorf("%s: got %+v want %+v", tc.Name, got, tc.Result)
		}
		if tc.Result != nil {
			hits++
		}
	}
	if hits < 8 {
		t.Fatalf("only %d favicon hits; cases too weak", hits)
	}
}

func TestProfilesMatchOriginal(t *testing.T) {
	c := loadDetect(t)
	svc := New(fakePlatform{})
	root := t.TempDir()
	nonEmpty := 0
	for _, tc := range c.Profiles {
		dir := filepath.Join(root, "p", tc.Name)
		buildTree(t, dir, tc.Files)
		got := svc.DetectSpringBootProfiles(dir)
		if !slices.Equal(got, tc.Result) {
			t.Errorf("%s: got %q want %q", tc.Name, got, tc.Result)
		}
		if len(tc.Result) > 0 {
			nonEmpty++
		}
	}
	if nonEmpty < 2 {
		t.Fatal("profile cases too weak")
	}
}

func TestScanChildrenMatchesOriginal(t *testing.T) {
	c := loadDetect(t)
	svc := New(fakePlatform{})
	root := t.TempDir()
	for _, tc := range c.Scan {
		dir := filepath.Join(root, "s", tc.Name)
		if !tc.Missing {
			buildTree(t, dir, tc.Entries)
		} else {
			dir = filepath.Join(root, "s", "nope")
		}
		limit := tc.Limit
		if limit == 0 {
			limit = DefaultScanLimit
		}
		got := svc.ScanChildren(dir, limit)
		if a, w := actual(t, got), canon(t, tc.Result, root, ""); a != w {
			t.Errorf("%s\n got  %s\n want %s", tc.Name, a, w)
		}
	}
}

func TestOriginalFixtures(t *testing.T) {
	c := loadDetect(t)
	orig, err := filepath.Abs("../../../../mile-terminal-management/scripts")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(orig); err != nil {
		t.Skipf("original fixtures not present: %v", err)
	}
	svc := New(fakePlatform{})
	if len(c.Fixtures) != 4 {
		t.Fatalf("fixtures %d", len(c.Fixtures))
	}
	for _, tc := range c.Fixtures {
		if tc.Name == "<scan>" {
			if a, w := actual(t, svc.ScanChildren(orig, DefaultScanLimit)), canon(t, tc.Result, "", orig); a != w {
				t.Errorf("scan original scripts\n got  %s\n want %s", a, w)
			}
			continue
		}
		dir := filepath.Join(orig, tc.Name)
		if a, w := actual(t, svc.Detect(dir)), canon(t, tc.Result, "", orig); a != w {
			t.Errorf("%s\n got  %s\n want %s", tc.Name, a, w)
		}
		pm, ok := svc.LockfileFor(dir)
		if (tc.Lockfile == nil) != !ok || (ok && string(pm) != *tc.Lockfile) {
			t.Errorf("%s lockfile: got %q want %v", tc.Name, pm, tc.Lockfile)
		}
		if got := svc.ReadFavicon(dir); (got == nil) != (tc.Favicon == nil) {
			t.Errorf("%s favicon: got %v want %v", tc.Name, got, tc.Favicon)
		}
	}
}

func TestCleanIconPath(t *testing.T) {
	c := loadDetect(t)
	if len(c.Clean) < 20 {
		t.Fatalf("only %d", len(c.Clean))
	}
	for _, tc := range c.Clean {
		if got := cleanIconPath(tc.Input); got != tc.Clean {
			t.Errorf("clean(%q) = %q want %q", tc.Input, got, tc.Clean)
		}
		if got := jsToLower(jsExtname(tc.Clean)); got != tc.Ext {
			t.Errorf("ext(%q) = %q want %q", tc.Clean, got, tc.Ext)
		}
	}
}

func TestParseIconHrefs(t *testing.T) {
	c := loadDetect(t)
	n := 0
	for _, tc := range c.Hrefs {
		got := parseIconHrefs(tc.HTML)
		if !slices.Equal(got, tc.Result) {
			t.Errorf("%q\n got  %q\n want %q", tc.HTML, got, tc.Result)
		}
		n += len(tc.Result)
	}
	if n < 8 {
		t.Fatalf("only %d hrefs found; cases too weak", n)
	}
}
