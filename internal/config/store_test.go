//go:build windows

// S09 对拍：启动（主文件 / .bak 好坏组合）、写盘顺序、只读保护（C2）、导入前备份。
// 一律用 t.TempDir()，不碰真实 %APPDATA%。
//
// 已知原版问题 C2，见 docs/MIGRATION-PLAN.md：TestReadOnlySilentlyDropsWrites 固定「只读时写入静默丢弃」，
// 修 C2 时这条测试要一起改。

package config

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"mile-console/internal/contract"
)

func TestBootMatchesOriginal(t *testing.T) {
	c := loadCases(t)
	if len(c.Boot) < 15 {
		t.Fatalf("启动用例只有 %d 组", len(c.Boot))
	}
	readOnly := 0
	for _, k := range c.Boot {
		label := k.Primary + "+" + k.Backup
		dir := t.TempDir()
		for name, body := range k.Files {
			if body != nil {
				if err := os.WriteFile(filepath.Join(dir, name), []byte(*body), 0o644); err != nil {
					t.Fatal(err)
				}
			}
		}
		s, err := Open(dir, plat)
		if err != nil {
			t.Fatalf("%s：Open 失败 %v", label, err)
		}
		if s.IsReadOnly() != k.ReadOnly {
			t.Errorf("%s：readOnly Go %v，原版 %v", label, s.IsReadOnly(), k.ReadOnly)
		}
		if k.ReadOnly {
			readOnly++
		}
		if g, w := tree(t, s.Get()), project(t, k.Config); !reflect.DeepEqual(g, w) {
			t.Errorf("%s：启动后配置\n Go   %v\n 原版 %v", label, g, w)
		}
		compareSnapshot(t, label+" 启动后", snapshot(t, dir), k.AfterBoot, k.Files)
		if _, err := s.PatchSettings(func(st *contract.Settings) { st.Scrollback = 1234 }); err != nil {
			t.Fatalf("%s：PatchSettings 失败 %v", label, err)
		}
		compareSnapshot(t, label+" 写入后", snapshot(t, dir), k.AfterPatch, k.Files)
	}
	if readOnly == 0 || readOnly == len(c.Boot) {
		t.Fatalf("用例不全：只读 %d / %d", readOnly, len(c.Boot))
	}
	t.Logf("%d 组启动场景与原版一致（%d 组进只读），启动后与写入一次后的目录逐文件相同", len(c.Boot), readOnly)
}

func TestPatchSequenceMatchesOriginal(t *testing.T) {
	c := loadCases(t)
	if len(c.Sequence) != 4 {
		t.Fatalf("序列用例 %d 步", len(c.Sequence))
	}
	dir := t.TempDir()
	s, err := Open(dir, plat)
	if err != nil {
		t.Fatal(err)
	}
	steps := []func(){
		func() {},
		func() { s.Patch(func(c *contract.AppConfig) { c.WatchedKeywords = []string{"one"} }) },
		func() { s.Patch(func(c *contract.AppConfig) { c.WatchedKeywords = []string{"two"} }) },
		func() { s.PatchSettings(func(st *contract.Settings) { st.Theme = contract.ThemeDark }) },
	}
	for i, step := range steps {
		step()
		compareSnapshot(t, "第 "+string(rune('0'+i))+" 步", snapshot(t, dir), c.Sequence[i], nil)
	}
}

// 写盘顺序：.bak 是写入前的主文件，不是刚写的新内容；主文件 JSON 是两空格缩进、无 BOM、无临时文件残留。
func TestPersistOrderAndFormat(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir, plat)
	if err != nil {
		t.Fatal(err)
	}
	s.Patch(func(c *contract.AppConfig) { c.WatchedKeywords = []string{"first"} })
	before, _ := os.ReadFile(filepath.Join(dir, "config.json"))
	s.Patch(func(c *contract.AppConfig) { c.WatchedKeywords = []string{"second"} })
	bak, _ := os.ReadFile(filepath.Join(dir, "config.json.bak"))
	main, _ := os.ReadFile(filepath.Join(dir, "config.json"))
	if string(bak) != string(before) {
		t.Errorf(".bak 应是写入前的主文件")
	}
	if !strings.Contains(string(main), `"second"`) || strings.Contains(string(bak), `"second"`) {
		t.Errorf("新内容应只在主文件里")
	}
	if strings.HasPrefix(string(main), "\xef\xbb\xbf") || !strings.HasPrefix(string(main), "{\n  \"version\": 16,") || strings.HasSuffix(string(main), "\n") {
		t.Errorf("格式不对：%q", string(main)[:40])
	}
	ents, _ := os.ReadDir(dir)
	for _, e := range ents {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Errorf("临时文件残留：%s", e.Name())
		}
	}
}

// 坏主文件 + 好 .bak：恢复后 .bak 内容不变，坏主文件挪成 .corrupt。
func TestRecoverKeepsBackupUntouched(t *testing.T) {
	dir := t.TempDir()
	good := `{"version":16,"entries":[{"id":"keep","name":"keep"}]}`
	write(t, dir, "config.json", "{broken")
	write(t, dir, "config.json.bak", good)
	s, err := Open(dir, plat)
	if err != nil {
		t.Fatal(err)
	}
	if got := read(t, dir, "config.json.bak"); got != good {
		t.Errorf(".bak 被改了：%q", got)
	}
	if got := read(t, dir, "config.json.corrupt"); got != "{broken" {
		t.Errorf(".corrupt 应是坏主文件：%q", got)
	}
	if e := s.Get().Entries; len(e) != 1 || e[0].ID != "keep" {
		t.Errorf("应从 .bak 恢复条目：%+v", e)
	}
}

// .corrupt 挪不走时（那个位置被一个非空目录占着），skipBackup 是唯一保住 .bak 的东西：
// 坏主文件还在原地，常规 persist 会把它复制成 .bak。原版实测：.bak 不变、主文件写回 .bak 的内容、不进只读。
func TestRecoverWhenCorruptRenameFails(t *testing.T) {
	dir := t.TempDir()
	good := `{"version":16,"entries":[{"id":"keep"}]}`
	if err := os.MkdirAll(filepath.Join(dir, "config.json.corrupt", "x"), 0o755); err != nil {
		t.Fatal(err)
	}
	write(t, dir, "config.json", "{broken")
	write(t, dir, "config.json.bak", good)
	s, err := Open(dir, plat)
	if err != nil {
		t.Fatal(err)
	}
	if s.IsReadOnly() {
		t.Error("不应进只读")
	}
	if got := read(t, dir, "config.json.bak"); got != good {
		t.Errorf(".bak 被坏主文件覆盖了：%q", got)
	}
	if !strings.Contains(read(t, dir, "config.json"), `"keep"`) {
		t.Error("主文件应写回 .bak 的内容")
	}
}

// 已知原版问题 C2：两份都坏时进只读，写入静默丢弃（返回成功、缓存变了、磁盘没变）。
func TestReadOnlySilentlyDropsWrites(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "config.json", "{broken")
	write(t, dir, "config.json.bak", "[1]")
	s, err := Open(dir, plat)
	if err != nil {
		t.Fatal(err)
	}
	if !s.IsReadOnly() {
		t.Fatal("两份都坏应进只读")
	}
	got, err := s.Patch(func(c *contract.AppConfig) { c.WatchedKeywords = []string{"lost"} })
	if err != nil {
		t.Fatalf("C2 行为变了：只读写入报错 %v；原版静默成功。修 C2 时同步改这条测试", err)
	}
	if len(got.WatchedKeywords) != 1 {
		t.Errorf("缓存应已更新：%+v", got.WatchedKeywords)
	}
	if read(t, dir, "config.json") != "{broken" || read(t, dir, "config.json.bak") != "[1]" {
		t.Error("只读时不应落盘")
	}
	if _, err := os.Stat(filepath.Join(dir, "config.json.corrupt")); err == nil {
		t.Error("只读时不应挪出 .corrupt")
	}
}

func TestBackupBeforeImportMatchesOriginal(t *testing.T) {
	c := loadCases(t)
	if len(c.ImportBackup) != 2 {
		t.Fatalf("导入备份用例 %d 组", len(c.ImportBackup))
	}
	fixed := func() time.Time { return time.Date(2026, 11, 14, 9, 5, 7, 0, time.Local) }
	for _, k := range c.ImportBackup {
		dir := t.TempDir()
		if k.WithFile {
			write(t, dir, "config.json", k.Files["config.json"])
		}
		s, err := open(dir, plat, fixed)
		if err != nil {
			t.Fatal(err)
		}
		var names []string
		for range 3 {
			p, err := s.BackupBeforeImport()
			if err != nil {
				t.Fatal(err)
			}
			names = append(names, filepath.Base(p))
		}
		if !reflect.DeepEqual(names, k.Names) {
			t.Errorf("withFile=%v 文件名 Go %v，原版 %v", k.WithFile, names, k.Names)
		}
		compareSnapshot(t, "导入备份", snapshot(t, dir), k.Files, map[string]*string{"config.json": new(k.Files["config.json"])})
	}
}

// Get 返回深拷贝：改返回值不影响缓存。
func TestGetReturnsCopy(t *testing.T) {
	s, err := Open(t.TempDir(), plat)
	if err != nil {
		t.Fatal(err)
	}
	s.Patch(func(c *contract.AppConfig) {
		c.Entries = []contract.LaunchEntry{{ID: "a", Env: map[string]string{"K": "v"}, StartAfter: []string{"b"}}}
	})
	g := s.Get()
	g.Entries[0].Env["K"] = "changed"
	g.Entries[0].StartAfter[0] = "changed"
	g.Entries = append(g.Entries, contract.LaunchEntry{ID: "x"})
	again := s.Get()
	if len(again.Entries) != 1 || again.Entries[0].Env["K"] != "v" || again.Entries[0].StartAfter[0] != "b" {
		t.Errorf("Get 返回的不是副本：%+v", again.Entries)
	}
}

func TestDataDirName(t *testing.T) {
	d, err := DataDir()
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(d) != "mile-console" || strings.Contains(strings.ToLower(d), "mile-terminal") {
		t.Errorf("数据目录应是 %%APPDATA%%\\mile-console：%s", d)
	}
}

func write(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func read(t *testing.T, dir, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
