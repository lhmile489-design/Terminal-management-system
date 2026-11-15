// 对应 src/shared/types.ts 第 210–281 行与第 328–339 行：外观、设置、CONFIG_VERSION、
// 定位请求、项目外链、分组覆盖、AppConfig。

package contract

// ThemePreference 外观偏好。
type ThemePreference string

const (
	ThemeLight  ThemePreference = "light"
	ThemeDark   ThemePreference = "dark"
	ThemeSystem ThemePreference = "system"
)

// ThemePreferences 与 TS 联合类型同序。
var ThemePreferences = []ThemePreference{ThemeLight, ThemeDark, ThemeSystem}

// ResolvedTheme 解析后的实际外观，页面据此设置 data-theme。
type ResolvedTheme string

const (
	ResolvedLight ResolvedTheme = "light"
	ResolvedDark  ResolvedTheme = "dark"
)

// ResolvedThemes 与 TS 联合类型同序。
var ResolvedThemes = []ResolvedTheme{ResolvedLight, ResolvedDark}

// ThemeState 外观状态。
type ThemeState struct {
	Preference ThemePreference `json:"preference"`
	Resolved   ResolvedTheme   `json:"resolved"`
}

// ScanIntervals 是 Settings.ScanIntervalMs 的合法取值（TS：1000 | 2000 | 5000 | 10000）。
var ScanIntervals = []int{1000, 2000, 5000, 10000}

// ExternalTerminal 外部终端。Windows：wt / pwsh / powershell / cmd / gitbash；macOS：terminal / iterm。按平台校验。
type ExternalTerminal string

const (
	TerminalWT         ExternalTerminal = "wt"
	TerminalPwsh       ExternalTerminal = "pwsh"
	TerminalPowerShell ExternalTerminal = "powershell"
	TerminalCmd        ExternalTerminal = "cmd"
	TerminalGitBash    ExternalTerminal = "gitbash"
	TerminalTerminal   ExternalTerminal = "terminal"
	TerminalITerm      ExternalTerminal = "iterm"
)

// ExternalTerminals 与 TS 联合类型同序。
var ExternalTerminals = []ExternalTerminal{
	TerminalWT, TerminalPwsh, TerminalPowerShell, TerminalCmd, TerminalGitBash, TerminalTerminal, TerminalITerm,
}

// Settings 用户设置，字段顺序与原版一致。
type Settings struct {
	// ScanIntervalMs 取值见 ScanIntervals。
	ScanIntervalMs   int              `json:"scanIntervalMs"`
	Theme            ThemePreference  `json:"theme"`
	ExternalTerminal ExternalTerminal `json:"externalTerminal"`
	TerminalFontSize int              `json:"terminalFontSize"`
	Scrollback       int              `json:"scrollback"`
	KillOwnedOnQuit  bool             `json:"killOwnedOnQuit"`
	CloseToTray      bool             `json:"closeToTray"`
	// NotifyOnTaskDone 任务跑完弹系统通知（PRD §4.7），v3 起。
	NotifyOnTaskDone bool `json:"notifyOnTaskDone"`
	// HideFromTaskbar 从任务栏隐藏，只保留托盘图标，v6 起。
	HideFromTaskbar bool `json:"hideFromTaskbar"`
	// NotifyOnCrash 服务崩溃、启动被预检拦下时弹系统通知，v10 起。
	NotifyOnCrash bool `json:"notifyOnCrash"`
	// NotifyOnlyWhenBackground 通知只在窗口收起、最小化或失焦时弹，v10 起。
	NotifyOnlyWhenBackground bool `json:"notifyOnlyWhenBackground"`
	// GlobalHotkey 全局快捷键 Ctrl+Alt+M，v11 起。
	GlobalHotkey bool `json:"globalHotkey"`
	// LoginShellPath macOS 从登录 shell 读 PATH，Windows 忽略，v13 起。
	LoginShellPath bool `json:"loginShellPath"`
	// PlannerNotify 日程提醒到点弹通知 + 应用内卡片，v16 起。
	PlannerNotify bool `json:"plannerNotify"`
	// PlannerSound 日程提醒通知带声音，v16 起。
	PlannerSound bool `json:"plannerSound"`
}

// ConfigVersion 当前配置结构版本。加字段就要加迁移。
const ConfigVersion = 16

// FocusTab 定位条目时打开的标签。
type FocusTab string

const (
	FocusTabOutput   FocusTab = "output"
	FocusTabDiagnose FocusTab = "diagnose"
)

// FocusTabs 与 TS 联合类型同序。
var FocusTabs = []FocusTab{FocusTabOutput, FocusTabDiagnose}

// FocusEntryRequest Go 侧要求页面定位到某个服务的某个标签。通知点击不触发写操作。
type FocusEntryRequest struct {
	ID  string   `json:"id"`
	Tab FocusTab `json:"tab"`
}

// PlannerTab 进度页的标签。
type PlannerTab string

const (
	PlannerTabTasks     PlannerTab = "tasks"
	PlannerTabSchedules PlannerTab = "schedules"
	PlannerTabOverview  PlannerTab = "overview"
)

// PlannerTabs 与 TS 联合类型同序。
var PlannerTabs = []PlannerTab{PlannerTabTasks, PlannerTabSchedules, PlannerTabOverview}

// PlannerFocusRequest 定位到某看板（通知点击 / 提醒卡片）；TaskID 可选。
type PlannerFocusRequest struct {
	BoardID string     `json:"boardId"`
	TaskID  string     `json:"taskId,omitempty"`
	Tab     PlannerTab `json:"tab,omitempty"`
}

// ProjectLink 关于页可打开的外部链接键名。页面只传键名，URL 只在这里定义。
type ProjectLink string

const (
	ProjectLinkRepo   ProjectLink = "repo"
	ProjectLinkIssues ProjectLink = "issues"
)

// ProjectLinkKeys 与 TS 对象键同序。
var ProjectLinkKeys = []ProjectLink{ProjectLinkRepo, ProjectLinkIssues}

// ProjectLinks 外链白名单，逐字照搬原版 PROJECT_LINKS。
var ProjectLinks = map[ProjectLink]string{
	ProjectLinkRepo:   "https://github.com/lhmile489-design/Terminal-management-system",
	ProjectLinkIssues: "https://github.com/lhmile489-design/Terminal-management-system/issues",
}

// GroupOverride 用户手动改过分组的进程（PRD §5.2）。按进程名而非 PID。
type GroupOverride struct {
	ProcessName string        `json:"processName"`
	Group       ListenerGroup `json:"group"`
}

// IgnoredListener 被忽略的监听。
type IgnoredListener struct {
	ProcessName string `json:"processName"`
	Port        int    `json:"port"`
}

// AppConfig 即 config.json 的结构。
type AppConfig struct {
	Version int           `json:"version"`
	Entries []LaunchEntry `json:"entries"`
	// Groups 工作组，v9 起；旧版迁移时初始化为 []。
	Groups           []ProjectGroup    `json:"groups"`
	IgnoredListeners []IgnoredListener `json:"ignoredListeners"`
	// GroupOverrides v2 起。
	GroupOverrides []GroupOverride `json:"groupOverrides"`
	// WatchedKeywords 关注进程关键字（PRD §5.5），v2 起。
	WatchedKeywords []string `json:"watchedKeywords"`
	Settings        Settings `json:"settings"`
}

// AppInfo 应用信息（绑定层 AppService.Info）。
type AppInfo struct {
	Version string `json:"version"`
	Name    string `json:"name"`
}

// SettingsPatch 设置补丁：只覆盖出现的字段，没带的不动。
// 指针即「出现过」，与原版 `raw.x !== undefined` 同一判定。
type SettingsPatch struct {
	ScanIntervalMs           *int              `json:"scanIntervalMs,omitempty"`
	Theme                    *ThemePreference  `json:"theme,omitempty"`
	ExternalTerminal         *ExternalTerminal `json:"externalTerminal,omitempty"`
	TerminalFontSize         *int              `json:"terminalFontSize,omitempty"`
	Scrollback               *int              `json:"scrollback,omitempty"`
	KillOwnedOnQuit          *bool             `json:"killOwnedOnQuit,omitempty"`
	CloseToTray              *bool             `json:"closeToTray,omitempty"`
	NotifyOnTaskDone         *bool             `json:"notifyOnTaskDone,omitempty"`
	HideFromTaskbar          *bool             `json:"hideFromTaskbar,omitempty"`
	NotifyOnCrash            *bool             `json:"notifyOnCrash,omitempty"`
	NotifyOnlyWhenBackground *bool             `json:"notifyOnlyWhenBackground,omitempty"`
	GlobalHotkey             *bool             `json:"globalHotkey,omitempty"`
	LoginShellPath           *bool             `json:"loginShellPath,omitempty"`
	PlannerNotify            *bool             `json:"plannerNotify,omitempty"`
	PlannerSound             *bool             `json:"plannerSound,omitempty"`
}
