// S24 绑定层的薄封装（BINDINGS-CONTRACT §3）。每个方法只做三件事：
// 校形 → 调服务 → 返回；不在这里写业务规则，也不碰 I/O 细节（那些都在各服务里）。
//
// 本文件覆盖 App / Window / Theme / Settings / Log / Group / Dialog / Shell / Clipboard / Config
// 十个服务；Entry / Planner / Session / Scanner 四个大服务与 main.go 的装配在下一批。

package app

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"mile-console/internal/contract"
	"mile-console/internal/events"
	"mile-console/internal/groups"
	"mile-console/internal/logs"
)

// SettingsStore 设置读写（由 *config.Store 满足）。
type SettingsStore interface {
	Get() contract.AppConfig
	PatchSettings(fn func(st *contract.Settings)) (contract.AppConfig, error)
	Patch(fn func(c *contract.AppConfig)) (contract.AppConfig, error)
}

// Logs 日志中心（由 *logs.Service 满足）。
type Logs interface {
	Query(q contract.LogQuery) contract.LogResult
	Clear()
}

// WindowOS 窗口控制（由 mygo 的 currentWindow 适配）。
type WindowOS interface {
	Minimize() error
	ToggleMaximize() (bool, error)
	Close() error
	IsMaximized() bool
}

// DialogOS 系统文件对话框。返回值是唯一可信的路径来源（红线）。
// 三个方法都是「取消 → ok=false」，标题与默认文件名由调用方给（照搬原版文案）。
type DialogOS interface {
	PickDirectory(ctx context.Context, title string) (string, bool, error)
	PickJSONToOpen(ctx context.Context, title string) (string, bool, error)
	PickJSONToSave(ctx context.Context, title, defaultName string) (string, bool, error)
}

// ImportScanner 批量导入的子目录扫描（由 *detect.Service 满足）。
type ImportScanner interface {
	ScanChildren(root string, limit int) []contract.DetectResult
}

// ImportRoot 即原版 dialog:pickImportRoot 的返回值 `{ root, items }`。
type ImportRoot struct {
	Root  string                  `json:"root"`
	Items []contract.DetectResult `json:"items"`
}

// ShellOS 外链与定位。只收整数端口、固定键名与白名单路径。
type ShellOS interface {
	OpenLocalhost(port int) error
	OpenPath(target string) error
	OpenProjectLink(key contract.ProjectLink) error
}

// ClipboardOS 只写不读。
type ClipboardOS interface {
	WriteText(text string) error
}

// Transfer 配置导入导出（由 *transfer.Service 满足）。
type Transfer interface {
	ExportTo(file string) (contract.ConfigExportResult, error)
	ImportFrom(file string) (contract.ConfigImportResult, error)
}

// Deps 绑定层的全部依赖。零值字段表示该能力未接入，对应方法会返回明确错误。
type Deps struct {
	Version   string
	Name      string
	Cfg       SettingsStore
	Logs      Logs
	Window    WindowOS
	Dialog    DialogOS
	Shell     ShellOS
	Clipboard ClipboardOS
	Transfer  Transfer
	Events    *events.Bus
	// AfterSettingsPatch 设置落盘后的副作用（原版 index.ts settingsPatch 处理器的后半段：
	// 采集周期立即生效、主题同步运行时、广播 settingsChanged）。nil 表示没有副作用。
	AfterSettingsPatch func(patch contract.SettingsPatch, next contract.Settings)
	// Detect 批量导入扫描子目录用。
	Detect ImportScanner
	// OnGroupsChanged 工作组落盘之后（原版 GroupService 每次改动后 emit('changed')）。
	// 导入配置可能新建工作组，ConfigService.Import 之后也调一次。nil 表示没人关心。
	OnGroupsChanged func()
	// OnGroupRemoved 工作组被删除之后（原版 groupRemove 处理器里的 pauseSchedulesOfGroup）。
	OnGroupRemoved func(id string)
	// Now 时钟，导出文件的默认文件名用；nil 用 time.Now。
	Now func() time.Time
}

// AppService 对应 §3.1。
type AppService struct{ deps Deps }

// NewAppService 构造。
func NewAppService(d Deps) AppService { return AppService{deps: d} }

// Info 应用信息。
func (s AppService) Info(_ context.Context) contract.AppInfo {
	return contract.AppInfo{Version: s.deps.Version, Name: s.deps.Name}
}

// Ready 就绪握手：页面订阅完成后调用，把排队的事件补投出去。
func (s AppService) Ready(_ context.Context) error {
	if s.deps.Events == nil {
		return nil
	}
	return s.deps.Events.Ready()
}

// WindowService 对应 §3.2。
type WindowService struct{ deps Deps }

// NewWindowService 构造。
func NewWindowService(d Deps) WindowService { return WindowService{deps: d} }

// Minimize 最小化。
func (s WindowService) Minimize(_ context.Context) error {
	if s.deps.Window == nil {
		return errors.New("窗口控制未接入")
	}
	return s.deps.Window.Minimize()
}

// ToggleMaximize 最大化 / 还原，返回之后是否最大化。
func (s WindowService) ToggleMaximize(_ context.Context) (bool, error) {
	if s.deps.Window == nil {
		return false, errors.New("窗口控制未接入")
	}
	return s.deps.Window.ToggleMaximize()
}

// Close 走正常关窗流程（可能被托盘拦截）。
func (s WindowService) Close(_ context.Context) error {
	if s.deps.Window == nil {
		return errors.New("窗口控制未接入")
	}
	return s.deps.Window.Close()
}

// IsMaximized 页面初始化时拉一次。
func (s WindowService) IsMaximized(_ context.Context) bool {
	return s.deps.Window != nil && s.deps.Window.IsMaximized()
}

// ThemeService 对应 §3.3。
type ThemeService struct {
	deps    Deps
	resolve func(contract.ThemePreference) contract.ResolvedTheme
	// apply 把偏好同步给运行时并广播 themeChanged（main 里接 mygo.Theme.SetSource + 事件总线），
	// 对应原版 ThemeService.set 的 nativeTheme.themeSource 赋值与 emit('changed')。
	// 做成注入而不是直接调 mygo：单测环境里没有 App，直接调会卡住。
	apply func(contract.ThemePreference)
}

// NewThemeService 构造。resolve 把偏好换算成实际主题（跟随系统时由窗口层决定）。
func NewThemeService(
	d Deps,
	resolve func(contract.ThemePreference) contract.ResolvedTheme,
	apply func(contract.ThemePreference),
) ThemeService {
	if resolve == nil {
		resolve = func(contract.ThemePreference) contract.ResolvedTheme { return contract.ResolvedLight }
	}
	if apply == nil {
		apply = func(contract.ThemePreference) {}
	}
	return ThemeService{deps: d, resolve: resolve, apply: apply}
}

// Get 当前外观。
func (s ThemeService) Get(_ context.Context) contract.ThemeState {
	pref := contract.ThemeSystem
	if s.deps.Cfg != nil {
		pref = s.deps.Cfg.Get().Settings.Theme
	}
	return contract.ThemeState{Preference: pref, Resolved: s.resolve(pref)}
}

// Set 设置外观偏好，白名单外的值报错且不落盘。
func (s ThemeService) Set(_ context.Context, pref string) (contract.ThemeState, error) {
	clean := contract.ThemePreference(pref)
	if err := validateTheme(clean); err != nil {
		return contract.ThemeState{}, err
	}
	if s.deps.Cfg == nil {
		return contract.ThemeState{}, errors.New("配置未接入")
	}
	if _, err := s.deps.Cfg.PatchSettings(func(st *contract.Settings) { st.Theme = clean }); err != nil {
		return contract.ThemeState{}, err
	}
	// 同步给运行时：页面据 resolved 写 <html data-theme>，系统外观也跟着变
	s.apply(clean)
	return contract.ThemeState{Preference: clean, Resolved: s.resolve(clean)}, nil
}

// SettingsService 对应 §3.4。
type SettingsService struct{ deps Deps }

// NewSettingsService 构造。
func NewSettingsService(d Deps) SettingsService { return SettingsService{deps: d} }

// Get 当前设置。
func (s SettingsService) Get(_ context.Context) (contract.Settings, error) {
	if s.deps.Cfg == nil {
		return contract.Settings{}, errors.New("配置未接入")
	}
	return s.deps.Cfg.Get().Settings, nil
}

// Patch 只覆盖出现的字段；非法值报错且不落盘。
func (s SettingsService) Patch(_ context.Context, patch contract.SettingsPatch) (contract.Settings, error) {
	if s.deps.Cfg == nil {
		return contract.Settings{}, errors.New("配置未接入")
	}
	next, err := SanitizeSettings(s.deps.Cfg.Get().Settings, patch)
	if err != nil {
		return contract.Settings{}, err
	}
	if _, err := s.deps.Cfg.PatchSettings(func(st *contract.Settings) { *st = next }); err != nil {
		return contract.Settings{}, err
	}
	if s.deps.AfterSettingsPatch != nil {
		s.deps.AfterSettingsPatch(patch, next)
	}
	return next, nil
}

// LogService 对应 §3.9。
type LogService struct{ deps Deps }

// NewLogService 构造。
func NewLogService(d Deps) LogService { return LogService{deps: d} }

// Query 筛选在 Go 侧做，页面只拿要显示的那一屏。
func (s LogService) Query(_ context.Context, q contract.LogQuery) (contract.LogResult, error) {
	if s.deps.Logs == nil {
		return contract.LogResult{}, errors.New("日志中心未接入")
	}
	clean, err := SanitizeLogQuery(q)
	if err != nil {
		return contract.LogResult{}, err
	}
	return s.deps.Logs.Query(clean), nil
}

// Clear 清空日志中心。
func (s LogService) Clear(_ context.Context) error {
	if s.deps.Logs == nil {
		return errors.New("日志中心未接入")
	}
	s.deps.Logs.Clear()
	return nil
}

// GroupService 对应 §3.6。
type GroupService struct {
	deps  Deps
	newID func() string
	now   func() int64
}

// NewGroupService 构造。
func NewGroupService(d Deps, newID func() string, now func() int64) GroupService {
	if newID == nil {
		newID = func() string { return "g" }
	}
	if now == nil {
		now = func() int64 { return 0 }
	}
	return GroupService{deps: d, newID: newID, now: now}
}

// List 全部工作组（已按置顶与顺序排好）。
func (s GroupService) List(_ context.Context) ([]contract.ProjectGroup, error) {
	if s.deps.Cfg == nil {
		return nil, errors.New("配置未接入")
	}
	return groups.OrderGroups(s.deps.Cfg.Get().Groups), nil
}

// Add 新建工作组。
func (s GroupService) Add(_ context.Context, in contract.NewProjectGroup) (contract.ProjectGroup, error) {
	if s.deps.Cfg == nil {
		return contract.ProjectGroup{}, errors.New("配置未接入")
	}
	created, next, err := groups.CreateGroup(s.deps.Cfg.Get().Groups, s.newID(), s.now(), in)
	if err != nil {
		return contract.ProjectGroup{}, err
	}
	if _, err := s.deps.Cfg.Patch(func(c *contract.AppConfig) { c.Groups = next }); err != nil {
		return contract.ProjectGroup{}, err
	}
	s.changed()
	return created, nil
}

// Patch 编辑工作组。
func (s GroupService) Patch(_ context.Context, id string, patch contract.GroupPatch) (contract.ProjectGroup, error) {
	if s.deps.Cfg == nil {
		return contract.ProjectGroup{}, errors.New("配置未接入")
	}
	updated, next, err := groups.EditGroup(s.deps.Cfg.Get().Groups, id, patch)
	if err != nil {
		return contract.ProjectGroup{}, err
	}
	if _, err := s.deps.Cfg.Patch(func(c *contract.AppConfig) { c.Groups = next }); err != nil {
		return contract.ProjectGroup{}, err
	}
	s.changed()
	return updated, nil
}

// Remove 删除工作组（条目回到未分组）。
func (s GroupService) Remove(_ context.Context, id string) error {
	if s.deps.Cfg == nil {
		return errors.New("配置未接入")
	}
	nextGroups, nextEntries := groups.RemoveGroup(s.deps.Cfg.Get().Groups, s.deps.Cfg.Get().Entries, id)
	_, err := s.deps.Cfg.Patch(func(c *contract.AppConfig) {
		c.Groups = nextGroups
		c.Entries = nextEntries
	})
	if err != nil {
		return err
	}
	s.changed()
	// PRD-PLANNER §6.3：看板保留，但该组的日程全部停下，不再弹也不再记错过
	if s.deps.OnGroupRemoved != nil {
		s.deps.OnGroupRemoved(id)
	}
	return nil
}

// Reorder 按 id 顺序重排。
func (s GroupService) Reorder(_ context.Context, ids []string) error {
	if s.deps.Cfg == nil {
		return errors.New("配置未接入")
	}
	next := groups.ReorderGroups(s.deps.Cfg.Get().Groups, ids)
	if _, err := s.deps.Cfg.Patch(func(c *contract.AppConfig) { c.Groups = next }); err != nil {
		return err
	}
	s.changed()
	return nil
}

func (s GroupService) changed() {
	if s.deps.OnGroupsChanged != nil {
		s.deps.OnGroupsChanged()
	}
}

// DialogService 对应 §3.11 的对话框部分。返回值是唯一可信的路径来源。
type DialogService struct{ deps Deps }

// NewDialogService 构造。
func NewDialogService(d Deps) DialogService { return DialogService{deps: d} }

// PickDirectory 即原版 dialog:pickDirectory：让用户选一个项目目录，取消返回 nil。
func (s DialogService) PickDirectory(ctx context.Context) (*string, error) {
	if s.deps.Dialog == nil {
		return nil, errors.New("对话框未接入")
	}
	dir, ok, err := s.deps.Dialog.PickDirectory(ctx, "选择项目目录")
	if err != nil || !ok {
		return nil, err
	}
	return &dir, nil
}

// PickImportRoot 即原版 dialog:pickImportRoot：选目录与扫描一次完成，
// 扫描根只能是系统选择框刚返回的目录。取消返回 nil。
func (s DialogService) PickImportRoot(ctx context.Context) (*ImportRoot, error) {
	if s.deps.Dialog == nil || s.deps.Detect == nil {
		return nil, errors.New("对话框未接入")
	}
	root, ok, err := s.deps.Dialog.PickDirectory(ctx, "选择包含多个项目的父目录")
	if err != nil || !ok {
		return nil, err
	}
	return &ImportRoot{Root: root, Items: s.deps.Detect.ScanChildren(root, 60)}, nil
}

// ShellService 对应 §3.11 的外链部分。
type ShellService struct{ deps Deps }

// NewShellService 构造。
func NewShellService(d Deps) ShellService { return ShellService{deps: d} }

// OpenLocalhost 只收 1–65535 的整数端口。
func (s ShellService) OpenLocalhost(_ context.Context, port int) error {
	if port < 1 || port > 65535 {
		return fmt.Errorf("端口必须是 1–65535 的整数：%d", port)
	}
	if s.deps.Shell == nil {
		return errors.New("外链未接入")
	}
	return s.deps.Shell.OpenLocalhost(port)
}

// OpenPath 只放行白名单路径（监听进程 cwd、条目 cwd、合法 outputDir）。
func (s ShellService) OpenPath(_ context.Context, target string) error {
	if strings.TrimSpace(target) == "" {
		return errors.New("路径不能为空")
	}
	if s.deps.Shell == nil {
		return errors.New("外链未接入")
	}
	return s.deps.Shell.OpenPath(target)
}

// OpenProjectLink 只收固定键名，URL 写死。
func (s ShellService) OpenProjectLink(_ context.Context, key string) error {
	link := contract.ProjectLink(key)
	if _, ok := contract.ProjectLinks[link]; !ok {
		return fmt.Errorf("未知的项目外链：%s", key)
	}
	if s.deps.Shell == nil {
		return errors.New("外链未接入")
	}
	return s.deps.Shell.OpenProjectLink(link)
}

// ClipboardService 对应 §3.11 的剪贴板部分：只写不读。
type ClipboardService struct{ deps Deps }

// NewClipboardService 构造。
func NewClipboardService(d Deps) ClipboardService { return ClipboardService{deps: d} }

// WriteText 写剪贴板，超过 64KB 直接拒绝。
func (s ClipboardService) WriteText(_ context.Context, text string) (bool, error) {
	if len([]byte(text)) > 64*1024 {
		return false, errors.New("剪贴板内容不能超过 64KB")
	}
	if s.deps.Clipboard == nil {
		return false, errors.New("剪贴板未接入")
	}
	if err := s.deps.Clipboard.WriteText(text); err != nil {
		return false, err
	}
	return true, nil
}

// ConfigService 对应 §3.11 的导入导出部分：文件由系统对话框选。
type ConfigService struct{ deps Deps }

// NewConfigService 构造。
func NewConfigService(d Deps) ConfigService { return ConfigService{deps: d} }

// Export 即原版 config:export：文件只能是系统保存框刚返回的那一个，页面给不出路径。取消返回 nil。
func (s ConfigService) Export(ctx context.Context) (*contract.ConfigExportResult, error) {
	if s.deps.Transfer == nil || s.deps.Dialog == nil {
		return nil, errors.New("导入导出未接入")
	}
	now := time.Now
	if s.deps.Now != nil {
		now = s.deps.Now
	}
	// 原版 `new Date().toISOString().slice(0, 10)`：UTC 日期
	name := "mile-terminal-config-" + now().UTC().Format("2006-01-02") + ".json"
	file, ok, err := s.deps.Dialog.PickJSONToSave(ctx, "导出配置", name)
	if err != nil || !ok {
		return nil, err
	}
	res, err := s.deps.Transfer.ExportTo(file)
	if err != nil {
		return nil, err
	}
	return &res, nil
}

// Import 即原版 config:import：文件只能是系统打开框刚返回的那一个。取消返回 nil。
func (s ConfigService) Import(ctx context.Context) (*contract.ConfigImportResult, error) {
	if s.deps.Transfer == nil || s.deps.Dialog == nil {
		return nil, errors.New("导入导出未接入")
	}
	file, ok, err := s.deps.Dialog.PickJSONToOpen(ctx, "导入配置")
	if err != nil || !ok {
		return nil, err
	}
	res, err := s.deps.Transfer.ImportFrom(file)
	if err != nil {
		return nil, err
	}
	// 原版导入走 groups.add，每建一个工作组就 emit('changed')；这里导入完成后补发一次
	if s.deps.OnGroupsChanged != nil {
		s.deps.OnGroupsChanged()
	}
	return &res, nil
}

func validateTheme(pref contract.ThemePreference) error {
	if !themes[pref] {
		return errors.New("主题只接受 light / dark / system")
	}
	return nil
}

// var _ 断言：真实服务满足这里的接口。
var (
	_ Logs = (*logs.Service)(nil)
)
