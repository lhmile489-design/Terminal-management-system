// 对应 src/main/services/EntryService.ts 第 40–320 行的常量区：端口捕获正则、白名单、字段标签与上限。

package entries

import (
	"regexp"

	"mile-console/internal/contract"
)

// jsSpace 是 JS 正则 \s 的集合：WhiteSpace（TAB、VT、FF、ZWNBSP、Zs）加 LineTerminator（LF、CR、LS、PS）。
// 原版的 `\s` 出现在端口正则里，Go 的 \s 不含 U+00A0、U+FEFF 与 U+2028，直接搬会漏。
const jsSpace = `[\t\n\v\f\r\x{2028}\x{2029}\x{feff}\p{Zs}]`

// PortPatterns 即原版 PORT_PATTERNS（PRD §8.4）。
//
// Spring Boot / Tomcat / Netty 专用格式必须排在通用 `port \d+` 之前，
// 否则 Spring Boot 冷启动日志里别处的 "port" 会先命中通用正则。顺序不能动。
var PortPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)Tomcat started on port\D*(\d+)`),
	regexp.MustCompile(`(?i)Netty started on port\D*(\d+)`),
	regexp.MustCompile(`(?i)Tomcat initialized with port\D*(\d+)`),
	regexp.MustCompile(`(?i)http://localhost:(\d+)`),
	regexp.MustCompile(`(?i)http://127\.0\.0\.1:(\d+)`),
	regexp.MustCompile(`(?i)Local:` + jsSpace + `+https?://[^\s:]+:(\d+)`),
	regexp.MustCompile(`(?i)listening on\D*(\d+)`),
	regexp.MustCompile(`(?i)port` + jsSpace + `+(\d+)`),
}

// PortTaken 即原版 PORT_TAKEN（带 g 与 i）：「这个端口被占了」里的端口号是它没抢到的那个。
//
// 实测 Next 16 在 3000 被占时打印
// `Port 3000 is in use by process 14944, using available port 3001 instead.`，
// 而 `port\s+(\d+)` 会在这一块里先撞上 3000。只把这句话本身遮掉，不丢整行 ——
// 遮掉之后同一行剩下的 `using available port 3001 instead` 正好命中通用正则，拿到真端口。
var PortTaken = regexp.MustCompile(`(?i)port` + jsSpace + `+\d+` + jsSpace + `+is` + jsSpace + `+in` + jsSpace + `+use|address already in use`)

// SafeScript 脚本名只允许这些字符：它最终要经过 cmd.exe 解析，& | ^ 等会改变命令语义。
var SafeScript = regexp.MustCompile(`^[A-Za-z0-9_.:\-+]+$`)

// SafeProfile Spring Boot profile 名：只允许字母、数字、下划线、连字符。
var SafeProfile = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// SafePythonEntry Python 入口文件名 / 包路径的安全字符（禁 shell 元字符）。
var SafePythonEntry = regexp.MustCompile(`^[A-Za-z0-9_.\-/\\]+$`)

// SafePythonModule Python 模块名（点分标识符，如 uvicorn、app.main），不含路径分隔符。
var SafePythonModule = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*(:[A-Za-z_][A-Za-z0-9_]*)?$`)

// SafeGoPkg Go 包路径：项目内相对路径或 `.`（禁 shell 元字符）。
var SafeGoPkg = regexp.MustCompile(`^[A-Za-z0-9_.\-/]+$`)

// envNameRE 即原版 `/^[A-Za-z_][A-Za-z0-9_]*$/`：环境变量名。
var envNameRE = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// controlCharRE 即原版 `/[\u0000-\u001F\u007F]/`。
var controlCharRE = regexp.MustCompile(`[\x00-\x1f\x7f]`)

// 原版的两条路径分隔符切分：`p.split(/[\\/]/)`。
var pathSepRE = regexp.MustCompile(`[\\/]`)

// 后缀与其它形状检查。
var (
	jarSuffixRE = regexp.MustCompile(`(?i)\.jar$`)
	exeSuffixRE = regexp.MustCompile(`(?i)\.exe$`)
	pySuffixRE  = regexp.MustCompile(`(?i)\.py$`)
)

// OutputDirCandidates 任务产物目录的常见约定，按序探测（PRD §4.2）。
var OutputDirCandidates = []string{"dist", "build", "out", ".next", ".output", "release"}

const (
	// MaxAlertKeywords 输出告警关键词数量上限：每块会话输出都要逐个匹配。
	MaxAlertKeywords = 10
	// MaxAlertKeywordLen 单个关键词长度上限。
	MaxAlertKeywordLen = 64
	// CategoryMaxLength 分类长度上限。
	CategoryMaxLength = 40
	// TaskCanceledCode 任务退出码 130 是脚本自报的用户取消，与失败区分开（PRD §4.6）。
	TaskCanceledCode = 130
	// PortCaptureTimeoutMS 服务启动未捕获端口但进程存活，转 running（端口未知），PRD §4.3。
	PortCaptureTimeoutMS = 60_000
	// PortReleaseTimeoutMS 停止后等端口释放的上限。
	PortReleaseTimeoutMS = 5000
	// TailLines 会话退出时留下的可见输出行数（只在内存）。
	TailLines = 30
	// AutoRestartWindowMS 自动重启的滑动窗口。
	AutoRestartWindowMS = 10 * 60_000
	// AutoRestartMax 窗口内最多自动重启次数。
	AutoRestartMax = 3
	// ReadyHistory 每个条目保留最近几次启动耗时。
	ReadyHistory = 10
)

// AutoRestartBackoffMS 自动重启的退避（第 1、2、3 次），PRD-FEATURE-UPGRADE P0-2。
var AutoRestartBackoffMS = []int64{2000, 8000, 30_000}

// editableSet 可编辑字段白名单（PRD §4.6）。未列出的键在 SanitizeEdit 里被静默丢弃。
var editableSet = func() map[contract.EditableEntryField]bool {
	m := make(map[contract.EditableEntryField]bool, len(contract.EditableEntryFields))
	for _, f := range contract.EditableEntryFields {
		m[f] = true
	}
	return m
}()

// identityFields 决定「这张卡片是谁」的字段，运行中不可改（PRD §4.6）。
var identityFields = []contract.EditableEntryField{
	"kind", "path", "cwd", "script", "packageManager", "expectedPort", "env", "launchMode", "jarPath",
}

var packageManagerSet = func() map[contract.PackageManager]bool {
	m := map[contract.PackageManager]bool{}
	for _, p := range contract.PackageManagers {
		m[p] = true
	}
	return m
}()

var serviceIconSet = func() map[contract.ServiceIcon]bool {
	m := map[contract.ServiceIcon]bool{}
	for _, i := range contract.ServiceIconIDs {
		m[i] = true
	}
	return m
}()

var frameworkSet = func() map[contract.Framework]bool {
	m := map[contract.Framework]bool{}
	for _, f := range contract.Frameworks {
		m[f] = true
	}
	return m
}()

// launchModeSet 全部合法的 launchMode 枚举。
var launchModeSet = func() map[contract.LaunchMode]bool {
	m := map[contract.LaunchMode]bool{}
	for _, l := range contract.LaunchModes {
		m[l] = true
	}
	return m
}()

// springBootModeSet 即原版 SPRING_BOOT_LAUNCH_MODES。
var springBootModeSet = func() map[contract.LaunchMode]bool {
	m := map[contract.LaunchMode]bool{}
	for _, l := range contract.SpringBootLaunchModes {
		m[l] = true
	}
	return m
}()

// launchableFrameworks 支持 launchMode 的框架（命令形状固定、可启动的非 npm 生态）。
var launchableFrameworks = map[contract.Framework]bool{
	contract.FrameworkSpringBoot: true, contract.FrameworkDjango: true, contract.FrameworkFastAPI: true,
	contract.FrameworkFlask: true, contract.FrameworkStreamlit: true, contract.FrameworkPython: true,
	contract.FrameworkGo: true, contract.FrameworkRust: true, contract.FrameworkCpp: true,
}

// fieldLabels 即原版 FIELD_LABEL：报错文案里的字段中文名。
var fieldLabels = map[contract.EditableEntryField]string{
	"icon": "服务图标", "kind": "类型", "path": "项目目录", "cwd": "子目录", "script": "脚本",
	"packageManager": "包管理器", "expectedPort": "端口", "env": "环境变量", "name": "名称",
	"category": "分类", "pinned": "置顶", "launchMode": "启动方式", "jarPath": "jar 路径",
	"registerOnly": "仅登记", "startAfter": "先等待", "healthCheck": "健康检查",
	"autoRestart": "自动重启", "alertKeywords": "告警关键词", "alertOnErrors": "错误行告警",
}

// FieldLabel 即原版 fieldLabel：没有中文名时回落到字段名本身。
func FieldLabel(field contract.EditableEntryField) string {
	if l, ok := fieldLabels[field]; ok {
		return l
	}
	return string(field)
}
