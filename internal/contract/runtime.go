// 对应 src/shared/types.ts 第 539–660 行与第 747–783 行：健康检查、自动重启、输出告警、识别结果、
// 预检、条目状态与运行态。

package contract

// HealthCheckConfig 本机 HTTP 健康检查配置。只存路径，主机、端口、协议由 Go 侧按条目自己的监听决定。
type HealthCheckConfig struct {
	// Path 以 / 开头的请求路径，sanitizeEdit 按字符白名单校形。
	Path    string `json:"path"`
	Enabled bool   `json:"enabled"`
}

// HealthState 健康检查结果状态。
//   - ok：2xx / 3xx
//   - fail：其他状态码、超时、连接被拒
//   - unknown：条目在运行，但快照里还找不到它自己的监听行，没有发请求
//   - off：未开启或条目不在运行
type HealthState string

const (
	HealthOK      HealthState = "ok"
	HealthFail    HealthState = "fail"
	HealthUnknown HealthState = "unknown"
	HealthOff     HealthState = "off"
)

// HealthStates 与 TS 联合类型同序。
var HealthStates = []HealthState{HealthOK, HealthFail, HealthUnknown, HealthOff}

// EntryHealth 健康检查结果，只在内存。
type EntryHealth struct {
	EntryID    string      `json:"entryId"`
	State      HealthState `json:"state"`
	StatusCode *int        `json:"statusCode,omitempty"`
	LatencyMs  *int64      `json:"latencyMs,omitempty"`
	// Reason fail 时的简短原因，不含响应体。
	Reason    string `json:"reason,omitempty"`
	CheckedAt int64  `json:"checkedAt"`
}

// AutoRestartPending 等待中的自动重启。
type AutoRestartPending struct {
	// NextAt 计划重启的时刻，Unix ms。
	NextAt int64 `json:"nextAt"`
	// Attempt 第几次重启（从 1 开始）。
	Attempt int `json:"attempt"`
	Max     int `json:"max"`
}

// OutputAlert 输出告警命中，只在内存。
type OutputAlert struct {
	EntryID   string `json:"entryId"`
	SessionID string `json:"sessionId"`
	Name      string `json:"name"`
	// Keyword 命中的关键词；通用错误行命中时为 null。
	Keyword *string `json:"keyword"`
	// Line 命中行，已去 ANSI，截断到 200 字符。
	Line string `json:"line"`
	At   int64  `json:"at"`
}

// DetectResult 目录识别结果。
type DetectResult struct {
	Path string `json:"path"`
	// HasPackageJSON 存在 package.json 才算可推断。
	HasPackageJSON bool           `json:"hasPackageJson"`
	Name           string         `json:"name"`
	Framework      Framework      `json:"framework"`
	PackageManager PackageManager `json:"packageManager"`
	Scripts        Scripts        `json:"scripts"`
	DevScript      *string        `json:"devScript"`
	BuildScript    *string        `json:"buildScript"`
	// MonorepoHint 根目录无 dev 脚本时为 true（PRD §8.5）。
	MonorepoHint bool `json:"monorepoHint"`
	RegisterOnly bool `json:"registerOnly"`
	// DetectedLaunchMode 识别时探测到的默认启动方式，推不出时为空。
	DetectedLaunchMode LaunchMode `json:"detectedLaunchMode,omitempty"`
	// DetectedPort 从 application.properties / application.yml 读到的 server.port。
	DetectedPort *int     `json:"detectedPort,omitempty"`
	Warnings     []string `json:"warnings"`
}

// PrecheckLevel 预检项级别。
type PrecheckLevel string

const (
	PrecheckPass PrecheckLevel = "pass"
	PrecheckWarn PrecheckLevel = "warn"
	PrecheckFail PrecheckLevel = "fail"
)

// PrecheckLevels 与 TS 联合类型同序。
var PrecheckLevels = []PrecheckLevel{PrecheckPass, PrecheckWarn, PrecheckFail}

// PrecheckFixAction 修复入口的动作标识（PRD §5.3）。
type PrecheckFixAction string

const (
	FixPickDirectory        PrecheckFixAction = "pickDirectory"
	FixRemoveEntry          PrecheckFixAction = "removeEntry"
	FixOpenInEditor         PrecheckFixAction = "openInEditor"
	FixPickScript           PrecheckFixAction = "pickScript"
	FixUseNpm               PrecheckFixAction = "useNpm"
	FixCreateInstallSession PrecheckFixAction = "createInstallSession"
	FixShowNodeRequirement  PrecheckFixAction = "showNodeRequirement"
	FixResolvePort          PrecheckFixAction = "resolvePort"
	// FixSwitchPort 把 expectedPort 切到 Go 侧扫描出的空闲端口。
	FixSwitchPort PrecheckFixAction = "switchPort"
)

// PrecheckFixActions 与 TS 联合类型同序。
var PrecheckFixActions = []PrecheckFixAction{
	FixPickDirectory, FixRemoveEntry, FixOpenInEditor, FixPickScript, FixUseNpm,
	FixCreateInstallSession, FixShowNodeRequirement, FixResolvePort, FixSwitchPort,
}

// PrecheckFix 预检项的修复入口。
type PrecheckFix struct {
	Action PrecheckFixAction `json:"action"`
	Label  string            `json:"label"`
	// SuggestedPort switchPort 动作时预扫描的候选空闲端口。
	SuggestedPort *int `json:"suggestedPort,omitempty"`
}

// PrecheckItem 一条预检结果。
type PrecheckItem struct {
	ID     string        `json:"id"`
	Label  string        `json:"label"`
	Level  PrecheckLevel `json:"level"`
	Detail string        `json:"detail,omitempty"`
	Fix    *PrecheckFix  `json:"fix,omitempty"`
}

// PrecheckResult 预检结果。
type PrecheckResult struct {
	OK    bool           `json:"ok"`
	Items []PrecheckItem `json:"items"`
}

// EntryStatus 条目状态。
type EntryStatus string

const (
	EntryIdle      EntryStatus = "idle"
	EntryPrecheck  EntryStatus = "precheck"
	EntryBlocked   EntryStatus = "blocked"
	EntryStarting  EntryStatus = "starting"
	EntryRunning   EntryStatus = "running"
	EntryStopping  EntryStatus = "stopping"
	EntryStopped   EntryStatus = "stopped"
	EntryCrashed   EntryStatus = "crashed"
	EntrySucceeded EntryStatus = "succeeded"
	EntryFailed    EntryStatus = "failed"
	// EntryCanceled 任务以 130 退出，即脚本自报的用户取消（PRD §4.6）。
	EntryCanceled EntryStatus = "canceled"
)

// EntryStatuses 与 TS 联合类型同序。
var EntryStatuses = []EntryStatus{
	EntryIdle, EntryPrecheck, EntryBlocked, EntryStarting, EntryRunning, EntryStopping,
	EntryStopped, EntryCrashed, EntrySucceeded, EntryFailed, EntryCanceled,
}

// ReadySource 就绪时刻的来源。
type ReadySource string

const (
	ReadyPort   ReadySource = "port"
	ReadyHealth ReadySource = "health"
)

// ReadySources 与 TS 联合类型同序。
var ReadySources = []ReadySource{ReadyPort, ReadyHealth}

// EntryRuntime 条目运行态，不持久化。
type EntryRuntime struct {
	EntryID   string      `json:"entryId"`
	Status    EntryStatus `json:"status"`
	SessionID string      `json:"sessionId,omitempty"`
	Pid       *int        `json:"pid,omitempty"`
	Port      *int        `json:"port,omitempty"`
	// PortUnknown 服务 60s 未捕获端口但进程存活（PRD §4.3）。
	PortUnknown bool            `json:"portUnknown"`
	StartedAt   *int64          `json:"startedAt,omitempty"`
	ExitCode    *int            `json:"exitCode,omitempty"`
	Precheck    *PrecheckResult `json:"precheck,omitempty"`
	// LastBuiltJar 最近一次 packageWithProfile 成功后扫描到的 jar 相对路径；下一次 build 开始时清空。
	LastBuiltJar string `json:"lastBuiltJar,omitempty"`
	// AutoRestart 等待中的自动重启；null / 缺省表示没有排队。原版会显式写 null，这里 nil 时省略，页面两者同义。
	AutoRestart *AutoRestartPending `json:"autoRestart,omitempty"`
	// AutoRestartGaveUp 10 分钟内已重启 3 次仍崩溃，停止自动重启。
	AutoRestartGaveUp *bool `json:"autoRestartGaveUp,omitempty"`
	// ReadyMs 本次启动耗时（毫秒）。
	ReadyMs     *int64      `json:"readyMs,omitempty"`
	ReadySource ReadySource `json:"readySource,omitempty"`
	// ReadyHistory 最近 10 次启动耗时，旧的在前。
	ReadyHistory []int64 `json:"readyHistory,omitzero"`
}

// EntryStartResult 启动结果。
type EntryStartResult struct {
	OK       bool           `json:"ok"`
	Precheck PrecheckResult `json:"precheck"`
	Runtime  *EntryRuntime  `json:"runtime,omitempty"`
}
