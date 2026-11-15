// 对应 src/main/services/ConfigTransferService.ts。
//
// 配置导入导出（2.3.0），换机器、重装系统时把条目与工作组带走。
//
//   - 导出：环境变量只留变量名，值一律清空 —— 导出文件会被拷来拷去，密钥不能跟着走。
//   - 导入：先把当前配置原样备份，再合并。新条目逐个走条目服务的 Add，与界面添加同一套
//     校验（绝对路径、目录存在、脚本已声明）；设置不覆盖，环境变量不写入，只在结果里列出
//     要重填的变量名。
//
// 文件路径只来自主进程的系统对话框，这里不做选择（红线）。

package transfer

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"mile-console/internal/contract"
	"mile-console/internal/groups"
)

const (
	// Format 导出文件的格式标记。导入时只认带这个标记的文件。
	Format = "mile-terminal-export"
	// FormatVersion 导出格式版本。
	FormatVersion = 1
	// MaxImportBytes 正常导出远小于这个数，超过的多半选错了文件，不读进内存。
	MaxImportBytes = 5 * 1024 * 1024
)

// dropOnExport 导出时去掉的条目字段：运行痕迹与本机图片文件名，换台机器没有意义。
var dropOnExport = map[string]bool{"lastStartedAt": true, "lastExitCode": true, "imageId": true}

// importFields 导入新条目时交给 Add 的字段，其余（id、order、startAfter、env）由这里另行处理。
var importFields = []string{
	"kind", "name", "category", "icon", "path", "cwd", "framework", "packageManager", "script",
	"scripts", "expectedPort", "outputDir", "launchMode", "jarPath", "registerOnly", "pinned",
}

// Config 导入导出用到的配置能力。
type Config interface {
	Get() contract.AppConfig
	IsReadOnly() bool
	Patch(fn func(c *contract.AppConfig)) (contract.AppConfig, error)
	BackupBeforeImport() (string, error)
}

// Entries 导入用到的条目服务能力。
type Entries interface {
	List() []contract.LaunchEntry
	Get(id string) (contract.LaunchEntry, bool)
	Add(in contract.NewLaunchEntry) (contract.LaunchEntry, error)
	Edit(id string, patch contract.EntryEdit) (contract.LaunchEntry, error)
}

// Scanner 关注关键字的规整只在扫描器一处。
type Scanner interface {
	SetWatchedKeywords(raw json.RawMessage) ([]string, error)
}

// Options 可注入的时钟与 id 生成。
type Options struct {
	Now   func() time.Time
	NewID func() string
}

// Service 即原版 ConfigTransferService。
type Service struct {
	cfg     Config
	entries Entries
	scanner Scanner
	opt     Options
}

// New 构造导入导出服务。
func New(cfg Config, entries Entries, scanner Scanner, opt Options) *Service {
	if opt.Now == nil {
		opt.Now = time.Now
	}
	if opt.NewID == nil {
		opt.NewID = newUUID
	}
	return &Service{cfg: cfg, entries: entries, scanner: scanner, opt: opt}
}

// exportFile 即原版 ExportFile。
type exportFile struct {
	Format           string            `json:"format"`
	FormatVersion    int               `json:"formatVersion"`
	ConfigVersion    int               `json:"configVersion"`
	ExportedAt       string            `json:"exportedAt"`
	Entries          []json.RawMessage `json:"entries"`
	Groups           []json.RawMessage `json:"groups"`
	IgnoredListeners []json.RawMessage `json:"ignoredListeners"`
	GroupOverrides   []json.RawMessage `json:"groupOverrides"`
	WatchedKeywords  []json.RawMessage `json:"watchedKeywords"`
	Settings         json.RawMessage   `json:"settings"`
}

// ExportTo 即原版 exportTo。
func (s *Service) ExportTo(file string) (contract.ConfigExportResult, error) {
	cfg := s.cfg.Get()

	entries := make([]json.RawMessage, 0, len(cfg.Entries))
	for _, e := range cfg.Entries {
		raw, err := exportEntry(e)
		if err != nil {
			return contract.ConfigExportResult{}, err
		}
		entries = append(entries, raw)
	}
	groupRaws := make([]json.RawMessage, 0, len(cfg.Groups))
	for _, g := range cfg.Groups {
		raw, err := json.Marshal(g)
		if err != nil {
			return contract.ConfigExportResult{}, err
		}
		groupRaws = append(groupRaws, raw)
	}
	ignored, _ := marshalAll(cfg.IgnoredListeners)
	overrides, _ := marshalAll(cfg.GroupOverrides)
	watched, _ := marshalAll(cfg.WatchedKeywords)
	settings, _ := json.Marshal(cfg.Settings)

	data := exportFile{
		Format:           Format,
		FormatVersion:    FormatVersion,
		ConfigVersion:    cfg.Version,
		ExportedAt:       s.opt.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Entries:          entries,
		Groups:           groupRaws,
		IgnoredListeners: ignored,
		GroupOverrides:   overrides,
		WatchedKeywords:  watched,
		Settings:         settings,
	}
	body, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return contract.ConfigExportResult{}, err
	}
	// 与 node 的 utf8 写入一致：不带 BOM
	if err := os.WriteFile(file, body, 0o644); err != nil {
		return contract.ConfigExportResult{}, err
	}
	return contract.ConfigExportResult{Path: file, Entries: len(entries), Groups: len(groupRaws)}, nil
}

// exportEntry 即原版 exportEntry：去掉运行痕迹与图片名，env 只留变量名。
func exportEntry(entry contract.LaunchEntry) (json.RawMessage, error) {
	body, err := json.Marshal(entry)
	if err != nil {
		return nil, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		return nil, err
	}
	for k := range dropOnExport {
		delete(fields, k)
	}
	// 只带变量名：值清空，导入后在界面里重填
	env := make(map[string]string, len(entry.Env))
	for k := range entry.Env {
		env[k] = ""
	}
	envRaw, err := json.Marshal(env)
	if err != nil {
		return nil, err
	}
	fields["env"] = envRaw
	return json.Marshal(fields)
}

// ImportFrom 即原版 importFrom：先备份，再合并条目、工作组与扫描规则。
func (s *Service) ImportFrom(file string) (contract.ConfigImportResult, error) {
	if s.cfg.IsReadOnly() {
		return contract.ConfigImportResult{}, errors.New("配置处于只读保护，这次运行不能导入")
	}
	// 先验格式再备份：坏文件直接拒绝，不留多余的备份，也不动配置
	data, err := readExport(file)
	if err != nil {
		return contract.ConfigImportResult{}, err
	}
	backup, err := s.cfg.BackupBeforeImport()
	if err != nil {
		return contract.ConfigImportResult{}, err
	}

	skipped := []contract.ImportSkipped{}
	envToRefill := []contract.ImportEnvRefill{}

	// 工作组按名称合并：同名复用，没有就新建
	groupMap := map[string]string{}
	groupsAdded := 0
	for _, raw := range data.Groups {
		var g struct {
			ID          string `json:"id"`
			Name        string `json:"name"`
			Description string `json:"description"`
			Env         string `json:"env"`
		}
		if json.Unmarshal(raw, &g) != nil || g.ID == "" {
			continue
		}
		name := strings.TrimSpace(g.Name)
		existing, found := s.findGroupByName(name)
		if found {
			groupMap[g.ID] = existing
			continue
		}
		created, err := s.addGroup(name, g.Description, g.Env)
		if err != nil {
			skipped = append(skipped, contract.ImportSkipped{Name: "工作组 " + name, Reason: err.Error()})
			continue
		}
		groupMap[g.ID] = created
		groupsAdded++
	}

	// 条目：同目录同子目录同脚本视为已登记，映射到已有条目，供 startAfter 重映射
	idMap := map[string]string{}
	known := map[string]string{}
	for _, e := range s.entries.List() {
		known[entryKey(e)] = e.ID
	}
	type pendingAfter struct {
		id   string
		deps []string
	}
	var pending []pendingAfter
	added := 0

	for _, raw := range data.Entries {
		var fields map[string]json.RawMessage
		if json.Unmarshal(raw, &fields) != nil {
			continue
		}
		name := "（未命名）"
		if v, ok := stringField(fields, "name"); ok {
			name = v
		}
		oldID, hasOldID := stringField(fields, "id")
		if !hasOldID {
			oldID = ""
		}
		path, ok := stringField(fields, "path")
		if !ok {
			skipped = append(skipped, contract.ImportSkipped{Name: name, Reason: "缺少项目目录"})
			continue
		}
		_ = path
		key := entryKey(rawToEntry(fields))
		if dup, ok := known[key]; ok {
			if oldID != "" {
				idMap[oldID] = dup
			}
			skipped = append(skipped, contract.ImportSkipped{Name: name, Reason: "已登记过同一目录与脚本"})
			continue
		}

		var input contract.NewLaunchEntry
		if err := json.Unmarshal(raw, &input); err != nil {
			skipped = append(skipped, contract.ImportSkipped{Name: name, Reason: err.Error()})
			continue
		}
		if gid, ok := stringField(fields, "groupId"); ok {
			if mapped, ok := groupMap[gid]; ok {
				input.GroupID = mapped
			}
		}
		entry, err := s.entries.Add(input)
		if err != nil {
			skipped = append(skipped, contract.ImportSkipped{Name: name, Reason: err.Error()})
			continue
		}
		added++
		known[entryKey(entry)] = entry.ID
		if oldID != "" {
			idMap[oldID] = entry.ID
		}
		keys := envKeysOf(fields)
		if len(keys) > 0 {
			envToRefill = append(envToRefill, contract.ImportEnvRefill{ID: entry.ID, Name: entry.Name, Keys: keys})
		}
		if deps, ok := stringSliceField(fields, "startAfter"); ok {
			pending = append(pending, pendingAfter{id: entry.ID, deps: deps})
		}
	}

	// 先等待要等全部条目落地后才能换成新 id；成环或指向被跳过的条目就丢掉这一项
	for _, p := range pending {
		mapped := make([]string, 0, len(p.deps))
		seen := map[string]bool{}
		for _, d := range p.deps {
			if id, ok := idMap[d]; ok && !seen[id] {
				seen[id] = true
				mapped = append(mapped, id)
			}
		}
		if len(mapped) == 0 {
			continue
		}
		if _, err := s.entries.Edit(p.id, contract.EntryEdit{StartAfter: contract.PatchOf(mapped)}); err != nil {
			name := p.id
			if e, ok := s.entries.Get(p.id); ok {
				name = e.Name
			}
			skipped = append(skipped, contract.ImportSkipped{Name: name + " 的先等待", Reason: err.Error()})
		}
	}

	if err := s.mergeScannerRules(data); err != nil {
		return contract.ConfigImportResult{}, err
	}
	return contract.ConfigImportResult{
		Backup:      backup,
		Added:       added,
		GroupsAdded: groupsAdded,
		Skipped:     skipped,
		EnvToRefill: envToRefill,
	}, nil
}

// mergeScannerRules 即原版：忽略规则、手动分组、关注关键字取并集；已有的规则优先。
func (s *Service) mergeScannerRules(data exportFile) error {
	cfg := s.cfg.Get()
	ignored := append([]contract.IgnoredListener{}, cfg.IgnoredListeners...)
	for _, raw := range data.IgnoredListeners {
		var row contract.IgnoredListener
		if json.Unmarshal(raw, &row) != nil {
			continue
		}
		if row.ProcessName == "" || len([]rune(row.ProcessName)) > 260 {
			continue
		}
		if row.Port < 1 || row.Port > 65535 {
			continue
		}
		exists := false
		for _, i := range ignored {
			if i.ProcessName == row.ProcessName && i.Port == row.Port {
				exists = true
				break
			}
		}
		if !exists {
			ignored = append(ignored, row)
		}
	}
	overrides := append([]contract.GroupOverride{}, cfg.GroupOverrides...)
	for _, raw := range data.GroupOverrides {
		var row contract.GroupOverride
		if json.Unmarshal(raw, &row) != nil {
			continue
		}
		if row.ProcessName == "" || len([]rune(row.ProcessName)) > 260 {
			continue
		}
		if row.Group != contract.ListenerGroupMine && row.Group != contract.ListenerGroupBackground {
			continue
		}
		exists := false
		for _, o := range overrides {
			if strings.EqualFold(o.ProcessName, row.ProcessName) {
				exists = true
				break
			}
		}
		if !exists {
			overrides = append(overrides, row)
		}
	}
	if _, err := s.cfg.Patch(func(c *contract.AppConfig) {
		c.IgnoredListeners = ignored
		c.GroupOverrides = overrides
	}); err != nil {
		return err
	}
	// 关键字的规整（去空、小写、去重、限量）只在扫描器一处
	merged := append([]string{}, cfg.WatchedKeywords...)
	for _, raw := range data.WatchedKeywords {
		var w string
		if json.Unmarshal(raw, &w) == nil {
			merged = append(merged, w)
		}
	}
	body, err := json.Marshal(merged)
	if err != nil {
		return err
	}
	_, err = s.scanner.SetWatchedKeywords(body)
	return err
}

// readExport 即原版 readExport：大小上限 → 剥 BOM → 解析 → 格式校验。
func readExport(file string) (exportFile, error) {
	info, err := os.Stat(file)
	if err != nil {
		return exportFile{}, err
	}
	if info.Size() > MaxImportBytes {
		return exportFile{}, errors.New("文件太大，不是 Mile Terminal 导出的配置文件")
	}
	body, err := os.ReadFile(file)
	if err != nil {
		return exportFile{}, err
	}
	// 别的编辑器另存过可能带 BOM，剥掉再解析
	text := strings.TrimPrefix(string(body), "\uFEFF")
	var parsed map[string]json.RawMessage
	if err := json.Unmarshal([]byte(text), &parsed); err != nil {
		return exportFile{}, errors.New("文件不是有效的 JSON")
	}
	var format string
	_ = json.Unmarshal(parsed["format"], &format)
	var entries []json.RawMessage
	if err := json.Unmarshal(parsed["entries"], &entries); err != nil || format != Format {
		return exportFile{}, errors.New("格式不对：不是 Mile Terminal 导出的配置文件")
	}

	list := func(key string) []json.RawMessage {
		var out []json.RawMessage
		if err := json.Unmarshal(parsed[key], &out); err != nil {
			return nil
		}
		// 只留对象（数组、字符串、null 都丢掉）
		kept := make([]json.RawMessage, 0, len(out))
		for _, raw := range out {
			var probe map[string]json.RawMessage
			if json.Unmarshal(raw, &probe) == nil {
				kept = append(kept, raw)
			}
		}
		return kept
	}
	number := func(key string) int {
		var v float64
		if json.Unmarshal(parsed[key], &v) == nil {
			return int(v)
		}
		return 0
	}
	var exportedAt string
	_ = json.Unmarshal(parsed["exportedAt"], &exportedAt)

	return exportFile{
		Format:           Format,
		FormatVersion:    number("formatVersion"),
		ConfigVersion:    number("configVersion"),
		ExportedAt:       exportedAt,
		Entries:          list("entries"),
		Groups:           list("groups"),
		IgnoredListeners: rawList(parsed["ignoredListeners"]),
		GroupOverrides:   rawList(parsed["groupOverrides"]),
		WatchedKeywords:  rawList(parsed["watchedKeywords"]),
		Settings:         parsed["settings"],
	}, nil
}

// rawList 即原版 `Array.isArray(v) ? v : []`。
func rawList(raw json.RawMessage) []json.RawMessage {
	var out []json.RawMessage
	if json.Unmarshal(raw, &out) != nil {
		return nil
	}
	return out
}

// entryKey 即原版：同一目录、同一子目录、同一脚本算同一个条目；Windows 路径大小写不敏感。
func entryKey(e contract.LaunchEntry) string {
	path := strings.ToLower(strings.TrimRight(cleanPath(e.Path), `\/`))
	cwd := strings.ToLower(strings.TrimRight(strings.ReplaceAll(e.Cwd, `\`, "/"), "/"))
	script := ""
	if e.Script != nil {
		script = *e.Script
	}
	return path + "|" + cwd + "|" + script
}

func cleanPath(p string) string {
	// 即 node path.resolve 对绝对路径的规整：消掉 . 与冗余分隔符
	if p == "" {
		return ""
	}
	return strings.ReplaceAll(p, "/", `\`)
}

func (s *Service) findGroupByName(name string) (string, bool) {
	for _, g := range s.cfg.Get().Groups {
		if g.Name == name {
			return g.ID, true
		}
	}
	return "", false
}

func (s *Service) addGroup(name, desc, env string) (string, error) {
	in := contract.NewProjectGroup{Name: name, Env: contract.GroupEnvironment(env)}
	in.Description = desc
	created, next, err := groups.CreateGroup(s.cfg.Get().Groups, s.opt.NewID(), s.opt.Now().UnixMilli(), in)
	if err != nil {
		return "", err
	}
	if _, err := s.cfg.Patch(func(c *contract.AppConfig) { c.Groups = next }); err != nil {
		return "", err
	}
	return created.ID, nil
}

func stringField(fields map[string]json.RawMessage, key string) (string, bool) {
	raw, ok := fields[key]
	if !ok {
		return "", false
	}
	var v string
	if json.Unmarshal(raw, &v) != nil {
		return "", false
	}
	return v, true
}

func stringSliceField(fields map[string]json.RawMessage, key string) ([]string, bool) {
	raw, ok := fields[key]
	if !ok {
		return nil, false
	}
	var list []json.RawMessage
	if json.Unmarshal(raw, &list) != nil {
		return nil, false
	}
	out := make([]string, 0, len(list))
	for _, item := range list {
		var v string
		if json.Unmarshal(item, &v) == nil {
			out = append(out, v)
		}
	}
	return out, true
}

// envKeysOf 即原版：env 是对象时取键名（限 128 字符以内）。
func envKeysOf(fields map[string]json.RawMessage) []string {
	raw, ok := fields["env"]
	if !ok {
		return nil
	}
	var env map[string]json.RawMessage
	if json.Unmarshal(raw, &env) != nil {
		return nil
	}
	keys := make([]string, 0, len(env))
	for k := range env {
		if len([]rune(k)) <= 128 {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	return keys
}

// rawToEntry 把导入条目里 entryKey 需要的三个字段读出来。
func rawToEntry(fields map[string]json.RawMessage) contract.LaunchEntry {
	var e contract.LaunchEntry
	if v, ok := stringField(fields, "path"); ok {
		e.Path = v
	}
	if v, ok := stringField(fields, "cwd"); ok {
		e.Cwd = v
	}
	if v, ok := stringField(fields, "script"); ok {
		e.Script = &v
	}
	return e
}

func marshalAll[T any](list []T) ([]json.RawMessage, error) {
	out := make([]json.RawMessage, 0, len(list))
	for _, v := range list {
		raw, err := json.Marshal(v)
		if err != nil {
			return nil, err
		}
		out = append(out, raw)
	}
	return out, nil
}

// newUUID 与条目服务同一形状（RFC 4122 v4），工作组的 id 也用它。
func newUUID() string {
	return fmt.Sprintf("g-%d", time.Now().UnixNano())
}
