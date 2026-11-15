// S23 单测：导出裁剪、导入校验与合并、startAfter 重映射、扫描规则并集。

package transfer

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"mile-console/internal/contract"
)

type fakeConfig struct {
	cfg      contract.AppConfig
	readonly bool
	backups  int
}

func (f *fakeConfig) Get() contract.AppConfig { return f.cfg }
func (f *fakeConfig) IsReadOnly() bool        { return f.readonly }
func (f *fakeConfig) Patch(fn func(c *contract.AppConfig)) (contract.AppConfig, error) {
	fn(&f.cfg)
	return f.cfg, nil
}
func (f *fakeConfig) BackupBeforeImport() (string, error) {
	f.backups++
	return "config.before-import-test.json", nil
}

type fakeEntries struct {
	list   []contract.LaunchEntry
	added  []contract.NewLaunchEntry
	edits  map[string]contract.EntryEdit
	addErr error
}

func (f *fakeEntries) List() []contract.LaunchEntry { return f.list }
func (f *fakeEntries) Get(id string) (contract.LaunchEntry, bool) {
	for _, e := range f.list {
		if e.ID == id {
			return e, true
		}
	}
	return contract.LaunchEntry{}, false
}
func (f *fakeEntries) Add(in contract.NewLaunchEntry) (contract.LaunchEntry, error) {
	if f.addErr != nil {
		return contract.LaunchEntry{}, f.addErr
	}
	f.added = append(f.added, in)
	e := contract.LaunchEntry{
		ID: "new-" + in.Name, Name: in.Name, Path: in.Path, Cwd: in.Cwd,
		Script: in.Script, Kind: in.Kind, GroupID: in.GroupID,
	}
	f.list = append(f.list, e)
	return e, nil
}
func (f *fakeEntries) Edit(id string, patch contract.EntryEdit) (contract.LaunchEntry, error) {
	if f.edits == nil {
		f.edits = map[string]contract.EntryEdit{}
	}
	f.edits[id] = patch
	return contract.LaunchEntry{ID: id}, nil
}

type fakeScanner struct{ last []string }

func (f *fakeScanner) SetWatchedKeywords(raw json.RawMessage) ([]string, error) {
	var list []string
	_ = json.Unmarshal(raw, &list)
	f.last = list
	return list, nil
}

func newRig(t *testing.T) (*Service, *fakeConfig, *fakeEntries, *fakeScanner) {
	t.Helper()
	cfg := &fakeConfig{cfg: contract.AppConfig{Version: 16}}
	ents := &fakeEntries{}
	scan := &fakeScanner{}
	var n int
	svc := New(cfg, ents, scan, Options{
		Now:   func() time.Time { return time.UnixMilli(1_700_000_000_000) },
		NewID: func() string { n++; return "g" + string(rune('0'+n)) },
	})
	return svc, cfg, ents, scan
}

func TestExportDropsRuntimeTracesAndEmptiesEnv(t *testing.T) {
	svc, cfg, _, _ := newRig(t)
	started := int64(123)
	exit := 1
	script := "dev"
	cfg.cfg.Entries = []contract.LaunchEntry{{
		ID: "e1", Kind: contract.EntryKindService, Name: "服务", Path: `C:\proj`,
		Framework: contract.FrameworkNext, PackageManager: contract.PackageManagerNpm,
		Script: &script, Env: map[string]string{"SECRET": "s3cr3t", "PORT": "3000"},
		ImageID: "abcdef123456.png", LastStartedAt: &started, LastExitCode: &exit,
		ExpectedPort: func() *int { p := 3000; return &p }(),
	}}
	cfg.cfg.Groups = []contract.ProjectGroup{{ID: "g1", Name: "开发", Env: contract.GroupEnvDev}}

	file := filepath.Join(t.TempDir(), "config.export.json")
	res, err := svc.ExportTo(file)
	if err != nil {
		t.Fatal(err)
	}
	if res.Entries != 1 || res.Groups != 1 || res.Path != file {
		t.Fatalf("结果不对：%+v", res)
	}

	body, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed["format"] != Format || parsed["formatVersion"].(float64) != 1 || parsed["configVersion"].(float64) != 16 {
		t.Fatalf("头部字段不对：%v %v %v", parsed["format"], parsed["formatVersion"], parsed["configVersion"])
	}
	if strings.HasPrefix(string(body), "\uFEFF") {
		t.Fatal("导出文件不该带 BOM")
	}
	entry := parsed["entries"].([]any)[0].(map[string]any)
	for _, k := range []string{"lastStartedAt", "lastExitCode", "imageId"} {
		if _, ok := entry[k]; ok {
			t.Fatalf("导出不该带 %s：%v", k, entry)
		}
	}
	env := entry["env"].(map[string]any)
	if env["SECRET"] != "" || env["PORT"] != "" {
		t.Fatalf("环境变量的值应被清空：%v", env)
	}
	if _, ok := env["SECRET"]; !ok {
		t.Fatal("环境变量的键应保留")
	}
}

func TestImportRejectsBadFiles(t *testing.T) {
	dir := t.TempDir()
	svc, cfg, _, _ := newRig(t)

	cfg.readonly = true
	if _, err := svc.ImportFrom(filepath.Join(dir, "x.json")); err == nil || !strings.Contains(err.Error(), "只读保护") {
		t.Fatalf("只读应拒绝：%v", err)
	}
	cfg.readonly = false

	// 不存在
	if _, err := svc.ImportFrom(filepath.Join(dir, "missing.json")); err == nil {
		t.Fatal("不存在的文件应报错")
	}
	// 不是 JSON
	bad := filepath.Join(dir, "bad.json")
	_ = os.WriteFile(bad, []byte("not json"), 0o644)
	if _, err := svc.ImportFrom(bad); err == nil || err.Error() != "文件不是有效的 JSON" {
		t.Fatalf("坏 JSON：%v", err)
	}
	// 格式不对
	wrong := filepath.Join(dir, "wrong.json")
	_ = os.WriteFile(wrong, []byte(`{"format":"other","entries":[]}`), 0o644)
	if _, err := svc.ImportFrom(wrong); err == nil || !strings.Contains(err.Error(), "格式不对") {
		t.Fatalf("格式不对：%v", err)
	}
	// 太大
	big := filepath.Join(dir, "big.json")
	_ = os.WriteFile(big, make([]byte, 5*1024*1024+1), 0o644) // 字面量：用常量会随变异一起涨
	if _, err := svc.ImportFrom(big); err == nil || !strings.Contains(err.Error(), "文件太大") {
		t.Fatalf("太大：%v", err)
	}
	if cfg.backups != 0 {
		t.Fatalf("坏文件不该产生备份：%d", cfg.backups)
	}

	// 带 BOM 的合法文件可以导入
	good := filepath.Join(dir, "good.json")
	_ = os.WriteFile(good, []byte("\uFEFF"+`{"format":"mile-terminal-export","formatVersion":1,"entries":[]}`), 0o644)
	res, err := svc.ImportFrom(good)
	if err != nil {
		t.Fatalf("带 BOM 的合法文件应能导入：%v", err)
	}
	if res.Backup != "config.before-import-test.json" {
		t.Fatalf("备份路径 = %q", res.Backup)
	}
}

func TestImportMergesGroupsEntriesAndStartAfter(t *testing.T) {
	svc, cfg, ents, scan := newRig(t)
	cfg.cfg.Groups = []contract.ProjectGroup{{ID: "g1", Name: "开发", Env: contract.GroupEnvDev}}
	cfg.cfg.IgnoredListeners = []contract.IgnoredListener{{ProcessName: "node.exe", Port: 3000}}
	cfg.cfg.WatchedKeywords = []string{"error"}
	cfg.cfg.GroupOverrides = []contract.GroupOverride{{ProcessName: "node.exe", Group: contract.ListenerGroupMine}}

	payload := map[string]any{
		"format":        Format,
		"formatVersion": 1,
		"groups": []any{
			map[string]any{"id": "old-g1", "name": "开发", "env": "dev"},  // 同名复用
			map[string]any{"id": "old-g2", "name": "生产", "env": "prod"}, // 新建
		},
		"entries": []any{
			map[string]any{
				"id": "old-e1", "kind": "service", "name": "甲", "path": `C:\a`,
				"framework": "next", "packageManager": "npm", "script": "dev",
				"env": map[string]any{"TOKEN": ""}, "groupId": "old-g2",
			},
			map[string]any{
				"id": "old-e2", "kind": "service", "name": "乙", "path": `C:\b`,
				"framework": "next", "packageManager": "npm", "script": "dev",
				"startAfter": []any{"old-e1"},
			},
			map[string]any{"id": "old-e3", "name": "没有目录"}, // 缺 path
		},
		"ignoredListeners": []any{
			map[string]any{"processName": "node.exe", "port": 3000}, // 已有
			map[string]any{"processName": "java.exe", "port": 8080}, // 新增
			map[string]any{"processName": "", "port": 1},            // 进程名为空
			map[string]any{"processName": "x.exe", "port": 0},       // 端口越界
		},
		"groupOverrides": []any{
			map[string]any{"processName": "Node.exe", "group": "mine"}, // 大小写不同也算已有
			map[string]any{"processName": "redis.exe", "group": "background"},
			map[string]any{"processName": "bad.exe", "group": "other"},
		},
		"watchedKeywords": []any{"timeout", 42},
	}
	body, _ := json.Marshal(payload)
	file := filepath.Join(t.TempDir(), "export.json")
	_ = os.WriteFile(file, body, 0o644)

	res, err := svc.ImportFrom(file)
	if err != nil {
		t.Fatal(err)
	}
	if res.Added != 2 || res.GroupsAdded != 1 {
		t.Fatalf("added=%d groupsAdded=%d", res.Added, res.GroupsAdded)
	}
	if len(res.Skipped) != 1 || res.Skipped[0].Reason != "缺少项目目录" {
		t.Fatalf("跳过记录不对：%+v", res.Skipped)
	}
	if len(res.EnvToRefill) != 1 || len(res.EnvToRefill[0].Keys) != 1 || res.EnvToRefill[0].Keys[0] != "TOKEN" {
		t.Fatalf("待重填变量不对：%+v", res.EnvToRefill)
	}
	// 工作组按名称复用 + 新建
	if len(cfg.cfg.Groups) != 2 || cfg.cfg.Groups[1].Name != "生产" {
		t.Fatalf("工作组合并不对：%+v", cfg.cfg.Groups)
	}
	// 新条目挂到新建的工作组上
	if ents.added[0].GroupID != cfg.cfg.Groups[1].ID {
		t.Fatalf("groupId 没重映射：%q", ents.added[0].GroupID)
	}
	// startAfter 重映射到新 id
	if len(ents.edits) != 1 {
		t.Fatalf("应当有一次 startAfter 编辑：%v", ents.edits)
	}
	for _, patch := range ents.edits {
		if patch.StartAfter.Value == nil || len(*patch.StartAfter.Value) != 1 || (*patch.StartAfter.Value)[0] != "new-甲" {
			t.Fatalf("startAfter 重映射不对：%v", patch.StartAfter)
		}
	}
	// 扫描规则取并集、已有优先
	if len(cfg.cfg.IgnoredListeners) != 2 {
		t.Fatalf("忽略规则不对：%+v", cfg.cfg.IgnoredListeners)
	}
	if len(cfg.cfg.GroupOverrides) != 2 {
		t.Fatalf("分组覆盖不对：%+v", cfg.cfg.GroupOverrides)
	}
	if len(scan.last) != 2 {
		t.Fatalf("关注关键字并集不对：%v", scan.last)
	}
}
