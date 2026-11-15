// 对应 src/shared/types.ts 第 341–585 行与第 661–745 行：框架、包管理器、启动方式、条目、
// 新建条目入参、可编辑字段与 EntryEdit 补丁。

package contract

import "slices"

// Framework 识别出的框架 / 生态。加一个值在原版要改四处，见原项目 CLAUDE.md。
type Framework string

const (
	FrameworkNext          Framework = "next"
	FrameworkNuxt          Framework = "nuxt"
	FrameworkAngular       Framework = "angular"
	FrameworkVueVite       Framework = "vue-vite"
	FrameworkVueCLI        Framework = "vue-cli"
	FrameworkReactVite     Framework = "react-vite"
	FrameworkReactCRA      Framework = "react-cra"
	FrameworkSvelte        Framework = "svelte"
	FrameworkElectron      Framework = "electron"
	FrameworkHexo          Framework = "hexo"
	FrameworkNode          Framework = "node"
	FrameworkSpringBoot    Framework = "spring-boot"
	FrameworkUniapp        Framework = "uniapp"
	FrameworkHugo          Framework = "hugo"
	FrameworkJekyll        Framework = "jekyll"
	FrameworkDjango        Framework = "django"
	FrameworkFastAPI       Framework = "fastapi"
	FrameworkFlask         Framework = "flask"
	FrameworkStreamlit     Framework = "streamlit"
	FrameworkPython        Framework = "python"
	FrameworkDockerCompose Framework = "docker-compose"
	FrameworkGo            Framework = "go"
	FrameworkRust          Framework = "rust"
	FrameworkCpp           Framework = "cpp"
	FrameworkStatic        Framework = "static"
	FrameworkUnknown       Framework = "unknown"
)

// Frameworks 与 TS 联合类型同序。
var Frameworks = []Framework{
	FrameworkNext, FrameworkNuxt, FrameworkAngular, FrameworkVueVite, FrameworkVueCLI, FrameworkReactVite,
	FrameworkReactCRA, FrameworkSvelte, FrameworkElectron, FrameworkHexo, FrameworkNode, FrameworkSpringBoot,
	FrameworkUniapp, FrameworkHugo, FrameworkJekyll, FrameworkDjango, FrameworkFastAPI, FrameworkFlask,
	FrameworkStreamlit, FrameworkPython, FrameworkDockerCompose, FrameworkGo, FrameworkRust, FrameworkCpp,
	FrameworkStatic, FrameworkUnknown,
}

// PackageManager 包管理器。
type PackageManager string

const (
	PackageManagerNpm  PackageManager = "npm"
	PackageManagerPnpm PackageManager = "pnpm"
	PackageManagerYarn PackageManager = "yarn"
	PackageManagerBun  PackageManager = "bun"
)

// PackageManagers 与 TS 联合类型同序。
var PackageManagers = []PackageManager{PackageManagerNpm, PackageManagerPnpm, PackageManagerYarn, PackageManagerBun}

// WebFrameworks 会产出网站首页、因此有本地 favicon 可读的前端生态。顺序照搬原版 WEB_FRAMEWORKS。
var WebFrameworks = []Framework{
	FrameworkNext, FrameworkNuxt, FrameworkAngular, FrameworkVueVite, FrameworkVueCLI, FrameworkReactVite,
	FrameworkReactCRA, FrameworkSvelte, FrameworkHexo, FrameworkHugo, FrameworkJekyll, FrameworkStatic,
}

// IsWebFramework 对应原版 isWebFramework。
func IsWebFramework(f Framework) bool { return slices.Contains(WebFrameworks, f) }

// SpringBootLaunchMode Spring Boot 启动方式，仅 framework 为 spring-boot 时使用。
type SpringBootLaunchMode = LaunchMode

// MavenGoal Maven / Gradle 构建目标。固定枚举，不接受自由输入。
type MavenGoal string

const (
	MavenGoalClean   MavenGoal = "clean"
	MavenGoalCompile MavenGoal = "compile"
	MavenGoalPackage MavenGoal = "package"
	MavenGoalTest    MavenGoal = "test"
	MavenGoalInstall MavenGoal = "install"
	MavenGoalVerify  MavenGoal = "verify"
)

// MavenGoals 与 TS 联合类型同序。
var MavenGoals = []MavenGoal{MavenGoalClean, MavenGoalCompile, MavenGoalPackage, MavenGoalTest, MavenGoalInstall, MavenGoalVerify}

// LaunchMode 跨语言的启动方式。每个 mode 的可执行文件与子命令都固定，用户只能选方式，改不了命令。
type LaunchMode string

const (
	LaunchModeMavenWrapper    LaunchMode = "maven-wrapper"
	LaunchModeGradleWrapper   LaunchMode = "gradle-wrapper"
	LaunchModeJar             LaunchMode = "jar"
	LaunchModeSystemMaven     LaunchMode = "system-maven"
	LaunchModeSystemGradle    LaunchMode = "system-gradle"
	LaunchModePythonFile      LaunchMode = "python-file"
	LaunchModePythonModule    LaunchMode = "python-module"
	LaunchModeUvicorn         LaunchMode = "uvicorn"
	LaunchModeFlask           LaunchMode = "flask"
	LaunchModeDjango          LaunchMode = "django"
	LaunchModeGoRun           LaunchMode = "go-run"
	LaunchModeCargoRun        LaunchMode = "cargo-run"
	LaunchModeCargoRunRelease LaunchMode = "cargo-run-release"
	LaunchModeCppExe          LaunchMode = "cpp-exe"
)

// SpringBootLaunchModes 与 TS 的 SpringBootLaunchMode 联合类型同序。
var SpringBootLaunchModes = []LaunchMode{
	LaunchModeMavenWrapper, LaunchModeGradleWrapper, LaunchModeJar, LaunchModeSystemMaven, LaunchModeSystemGradle,
}

// LaunchModes 与 TS 的 LaunchMode 联合类型同序（SpringBootLaunchMode 展开在前）。
var LaunchModes = []LaunchMode{
	LaunchModeMavenWrapper, LaunchModeGradleWrapper, LaunchModeJar, LaunchModeSystemMaven, LaunchModeSystemGradle,
	LaunchModePythonFile, LaunchModePythonModule, LaunchModeUvicorn, LaunchModeFlask, LaunchModeDjango,
	LaunchModeGoRun, LaunchModeCargoRun, LaunchModeCargoRunRelease, LaunchModeCppExe,
}

// EntryKind 条目种类。
type EntryKind string

const (
	EntryKindService EntryKind = "service"
	EntryKindTask    EntryKind = "task"
)

// EntryKinds 与 TS 联合类型同序。
var EntryKinds = []EntryKind{EntryKindService, EntryKindTask}

// ServiceIcon 服务卡片允许持久化的图标标识。
type ServiceIcon string

// ServiceIconIDs 照搬原版 SERVICE_ICON_IDS。
var ServiceIconIDs = []ServiceIcon{"rocket", "globe", "database", "terminal", "code", "cube", "cloud", "gear"}

// LaunchEntry 一个已登记的服务或任务。字段顺序与原版一致。
// 可选数组用 omitzero：nil 不输出，[] 原样输出，与原版 JSON 往返一致。
type LaunchEntry struct {
	ID   string    `json:"id"`
	Kind EntryKind `json:"kind"`
	Name string    `json:"name"`
	// Category 1.x 遗留的只读分类。
	Category string      `json:"category,omitempty"`
	Icon     ServiceIcon `json:"icon,omitempty"`
	// ImageID 自定义图片文件名，只由 Go 侧 SetImage 压缩落盘后写入，页面不能经 edit 指定。
	ImageID string `json:"imageId,omitempty"`
	// Path 项目根绝对路径。
	Path string `json:"path"`
	// Cwd monorepo 子包相对路径。
	Cwd            string         `json:"cwd,omitempty"`
	Framework      Framework      `json:"framework"`
	PackageManager PackageManager `json:"packageManager"`
	// Script 服务用 dev 脚本，任务用其命令脚本；可为 null。
	Script *string `json:"script"`
	// Scripts package.json scripts 快照。
	Scripts Scripts `json:"scripts"`
	// Env 返回页面前必须过 redactEntry，值恒为空串。
	Env          map[string]string `json:"env"`
	ExpectedPort *int              `json:"expectedPort,omitempty"`
	OutputDir    string            `json:"outputDir,omitempty"`
	LaunchMode   LaunchMode        `json:"launchMode,omitempty"`
	// JarPath 可执行产物或入口的相对路径（相对项目根，禁 ..），语义随 LaunchMode。
	JarPath string `json:"jarPath,omitempty"`
	// RegisterOnly true = 仅监控不可启动。
	RegisterOnly  bool   `json:"registerOnly"`
	Pinned        bool   `json:"pinned"`
	Order         int    `json:"order"`
	CreatedAt     int64  `json:"createdAt"`
	LastStartedAt *int64 `json:"lastStartedAt,omitempty"`
	LastExitCode  *int   `json:"lastExitCode,omitempty"`
	GroupID       string `json:"groupId,omitempty"`
	// StartAfter 整组启动时先等这些同组条目进入运行中，v12 起。
	StartAfter []string `json:"startAfter,omitzero"`
	// HealthCheck 本机 HTTP 健康检查，v14 起。
	HealthCheck *HealthCheckConfig `json:"healthCheck,omitempty"`
	// AutoRestart 意外退出时自动重启，v14 起。
	AutoRestart *bool `json:"autoRestart,omitempty"`
	// AlertKeywords 输出关键词告警，v14 起。纯子串、不区分大小写。
	AlertKeywords []string `json:"alertKeywords,omitzero"`
	// AlertOnErrors 同时对通用错误行告警，v14 起。
	AlertOnErrors *bool `json:"alertOnErrors,omitempty"`
}

// NewLaunchEntry 新建条目入参：LaunchEntry 去掉 id / order / createdAt，pinned 与 registerOnly 可省。
type NewLaunchEntry struct {
	Kind           EntryKind          `json:"kind"`
	Name           string             `json:"name"`
	Category       string             `json:"category,omitempty"`
	Icon           ServiceIcon        `json:"icon,omitempty"`
	ImageID        string             `json:"imageId,omitempty"`
	Path           string             `json:"path"`
	Cwd            string             `json:"cwd,omitempty"`
	Framework      Framework          `json:"framework"`
	PackageManager PackageManager     `json:"packageManager"`
	Script         *string            `json:"script"`
	Scripts        Scripts            `json:"scripts"`
	Env            map[string]string  `json:"env"`
	ExpectedPort   *int               `json:"expectedPort,omitempty"`
	OutputDir      string             `json:"outputDir,omitempty"`
	LaunchMode     LaunchMode         `json:"launchMode,omitempty"`
	JarPath        string             `json:"jarPath,omitempty"`
	RegisterOnly   *bool              `json:"registerOnly,omitempty"`
	Pinned         *bool              `json:"pinned,omitempty"`
	LastStartedAt  *int64             `json:"lastStartedAt,omitempty"`
	LastExitCode   *int               `json:"lastExitCode,omitempty"`
	GroupID        string             `json:"groupId,omitempty"`
	StartAfter     []string           `json:"startAfter,omitzero"`
	HealthCheck    *HealthCheckConfig `json:"healthCheck,omitempty"`
	AutoRestart    *bool              `json:"autoRestart,omitempty"`
	AlertKeywords  []string           `json:"alertKeywords,omitzero"`
	AlertOnErrors  *bool              `json:"alertOnErrors,omitempty"`
}

// EditableEntryField 用户可编辑的字段白名单（PRD §4.6）。
type EditableEntryField string

// EditableEntryFields 与 TS 联合类型同序。
var EditableEntryFields = []EditableEntryField{
	"name", "category", "groupId", "pinned", "kind", "path", "cwd", "script", "scripts", "framework",
	"packageManager", "env", "icon", "imageId", "expectedPort", "outputDir", "launchMode", "jarPath",
	"registerOnly", "startAfter", "healthCheck", "autoRestart", "alertKeywords", "alertOnErrors",
}

// EntryEdit 条目补丁。Patch 字段接受 null 表示显式清空，指针 / map 字段为 nil 表示没提。
// script 在 LaunchEntry 里就是 string | null，Partial 之后同样接受 null，所以也用 Patch。
type EntryEdit struct {
	Name           *string         `json:"name,omitempty"`
	Category       Patch[string]   `json:"category,omitzero"`
	GroupID        Patch[string]   `json:"groupId,omitzero"`
	Pinned         *bool           `json:"pinned,omitempty"`
	Kind           *EntryKind      `json:"kind,omitempty"`
	Path           *string         `json:"path,omitempty"`
	Cwd            *string         `json:"cwd,omitempty"`
	Script         Patch[string]   `json:"script,omitzero"`
	Scripts        Scripts         `json:"scripts,omitzero"`
	Framework      *Framework      `json:"framework,omitempty"`
	PackageManager *PackageManager `json:"packageManager,omitempty"`
	// Env 合并补丁：字符串 = 新增或覆盖，null = 删除，没提到的键保持原值。
	Env  map[string]*string `json:"env,omitzero"`
	Icon Patch[ServiceIcon] `json:"icon,omitzero"`
	// ImageID 只接受 null（清除自定义图片）；非 null 值由 sanitize 拒绝。设置图片走 SetImage。
	ImageID       Patch[string]            `json:"imageId,omitzero"`
	ExpectedPort  Patch[int]               `json:"expectedPort,omitzero"`
	OutputDir     Patch[string]            `json:"outputDir,omitzero"`
	LaunchMode    Patch[LaunchMode]        `json:"launchMode,omitzero"`
	JarPath       Patch[string]            `json:"jarPath,omitzero"`
	RegisterOnly  *bool                    `json:"registerOnly,omitempty"`
	StartAfter    Patch[[]string]          `json:"startAfter,omitzero"`
	HealthCheck   Patch[HealthCheckConfig] `json:"healthCheck,omitzero"`
	AutoRestart   *bool                    `json:"autoRestart,omitempty"`
	AlertKeywords Patch[[]string]          `json:"alertKeywords,omitzero"`
	AlertOnErrors *bool                    `json:"alertOnErrors,omitempty"`
}
