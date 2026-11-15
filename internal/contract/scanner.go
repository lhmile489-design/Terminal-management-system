// 对应 src/shared/types.ts 第 93–208 行：归属判定、监听分组、启动来源、采集快照与增量。

package contract

// Ownership 归属判定（PRD §6.2）。foreign 已在采集层过滤，不下发页面。
type Ownership string

const (
	OwnershipOwned    Ownership = "owned"
	OwnershipExternal Ownership = "external"
	OwnershipForeign  Ownership = "foreign"
)

// Ownerships 与 TS 联合类型同序。
var Ownerships = []Ownership{OwnershipOwned, OwnershipExternal, OwnershipForeign}

// CredentialResult 单条凭据的校验结果，读不到环境块时为 unknown。
type CredentialResult string

const (
	CredentialHit     CredentialResult = "hit"
	CredentialMiss    CredentialResult = "miss"
	CredentialUnknown CredentialResult = "unknown"
)

// CredentialResults 与 TS 联合类型同序。
var CredentialResults = []CredentialResult{CredentialHit, CredentialMiss, CredentialUnknown}

// OwnershipVerdict 三重凭据判定结果。
type OwnershipVerdict struct {
	Pid          int              `json:"pid"`
	Ownership    Ownership        `json:"ownership"`
	Token        CredentialResult `json:"token"`
	ProcessGroup CredentialResult `json:"processGroup"`
	SameUser     CredentialResult `json:"sameUser"`
	SessionID    string           `json:"sessionId,omitempty"`
}

// ListenerGroup 监听分组（PRD §5.2）。
type ListenerGroup string

const (
	ListenerGroupMine       ListenerGroup = "mine"
	ListenerGroupBackground ListenerGroup = "background"
)

// ListenerGroups 与 TS 联合类型同序。
var ListenerGroups = []ListenerGroup{ListenerGroupMine, ListenerGroupBackground}

// LaunchSource 启动来源（PRD §5.3），仅用于展示。
// 来自父进程链上的进程名与命令行，二者都是进程自己能随便写的，绝不参与 kill 授权。
type LaunchSource string

const (
	LaunchSourceMile      LaunchSource = "mile"
	LaunchSourceVSCode    LaunchSource = "vscode"
	LaunchSourceCursor    LaunchSource = "cursor"
	LaunchSourceJetBrains LaunchSource = "jetbrains"
	LaunchSourceClaude    LaunchSource = "claude"
	LaunchSourceCodex     LaunchSource = "codex"
	LaunchSourceTerminal  LaunchSource = "terminal"
	LaunchSourceExplorer  LaunchSource = "explorer"
	LaunchSourceService   LaunchSource = "service"
	LaunchSourceUnknown   LaunchSource = "unknown"
)

// LaunchSources 与 TS 联合类型同序。
var LaunchSources = []LaunchSource{
	LaunchSourceMile, LaunchSourceVSCode, LaunchSourceCursor, LaunchSourceJetBrains, LaunchSourceClaude,
	LaunchSourceCodex, LaunchSourceTerminal, LaunchSourceExplorer, LaunchSourceService, LaunchSourceUnknown,
}

// ListenerSnapshot 一次采集中单个监听进程的快照。
type ListenerSnapshot struct {
	Pid         int    `json:"pid"`
	Ports       []int  `json:"ports"`
	ProcessName string `json:"processName"`
	ExecPath    string `json:"execPath,omitempty"`
	Cwd         string `json:"cwd,omitempty"`
	// CPU 首轮无增量基线，为 null 而非 0。
	CPU       *float64      `json:"cpu"`
	Memory    int64         `json:"memory"`
	StartedAt *int64        `json:"startedAt,omitempty"`
	Ownership Ownership     `json:"ownership"`
	EntryID   string        `json:"entryId,omitempty"`
	SessionID string        `json:"sessionId,omitempty"`
	Group     ListenerGroup `json:"group"`
	// GroupOverridden 用户手动提升或移回过。
	GroupOverridden bool         `json:"groupOverridden"`
	LaunchSource    LaunchSource `json:"launchSource"`
}

// WatchedProcess 关注进程命中项（PRD §5.5）。命令行按 WATCHED_CMD_MAX 截断后下发。
type WatchedProcess struct {
	Pid         int    `json:"pid"`
	ProcessName string `json:"processName"`
	// Keyword 命中的关键字，取首个。
	Keyword     string   `json:"keyword"`
	CommandLine string   `json:"commandLine,omitempty"`
	CPU         *float64 `json:"cpu"`
	Memory      int64    `json:"memory"`
	StartedAt   *int64   `json:"startedAt,omitempty"`
}

// SystemLoad 系统负载。两项都是百分比、保留一位小数（原版 Math.round(x * 1000) / 10）。
type SystemLoad struct {
	CPU    *float64 `json:"cpu"`
	Memory float64  `json:"memory"`
}

// UnmanagedListener 本次窗口会话期间新出现的未纳管监听（PRD §7）。
type UnmanagedListener struct {
	Pid         int    `json:"pid"`
	Port        int    `json:"port"`
	ProcessName string `json:"processName"`
	Cwd         string `json:"cwd,omitempty"`
	GuessedName string `json:"guessedName"`
	StartedAt   *int64 `json:"startedAt,omitempty"`
}

// ScanSnapshot 整份采集快照。
type ScanSnapshot struct {
	At        int64               `json:"at"`
	Listeners []ListenerSnapshot  `json:"listeners"`
	Unmanaged []UnmanagedListener `json:"unmanaged"`
	Watched   []WatchedProcess    `json:"watched"`
	System    SystemLoad          `json:"system"`
	// PortConflicts 预期端口被非本条目占用的数量。
	PortConflicts int `json:"portConflicts"`
	// Failed 采集失败时保留上次成功时间，页面据此标黄。
	Failed        bool   `json:"failed"`
	LastSuccessAt *int64 `json:"lastSuccessAt"`
}

// ScanDiff 相对上一次快照的增量。
type ScanDiff struct {
	At            int64               `json:"at"`
	Added         []ListenerSnapshot  `json:"added"`
	Updated       []ListenerSnapshot  `json:"updated"`
	RemovedPids   []int               `json:"removedPids"`
	Unmanaged     []UnmanagedListener `json:"unmanaged"`
	Watched       []WatchedProcess    `json:"watched"`
	System        SystemLoad          `json:"system"`
	PortConflicts int                 `json:"portConflicts"`
	Failed        bool                `json:"failed"`
	LastSuccessAt *int64              `json:"lastSuccessAt"`
}
