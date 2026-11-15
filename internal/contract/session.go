// 对应 src/shared/types.ts 第 1–56 行：会话类型、会话元数据、新建终端请求、会话事件。
//
// 约定（整个 contract 包通用）：
//   - 时间一律 Unix 毫秒 int64。
//   - JSON 字段名与原版逐字一致，config.json / planner.json 可互读。
//   - TS 里 `x: T | null` 用指针且不带 omitempty（null 要写出来）；`x?: T` 的数字与布尔用指针 + omitempty
//     （0 / false 是有意义的值，如退出码 0）；`x?: string` 用 string + omitempty。
//   - 必填的数组与 map 由服务层保证非 nil，否则会序列化成 null。

package contract

// SessionKind 会话种类。
type SessionKind string

const (
	SessionKindDev     SessionKind = "dev"
	SessionKindBuild   SessionKind = "build"
	SessionKindInstall SessionKind = "install"
	SessionKindShell   SessionKind = "shell"
	SessionKindScript  SessionKind = "script"
)

// SessionKinds 与 TS 联合类型同序。
var SessionKinds = []SessionKind{SessionKindDev, SessionKindBuild, SessionKindInstall, SessionKindShell, SessionKindScript}

// SessionStatus 会话状态。
type SessionStatus string

const (
	SessionStatusStarting SessionStatus = "starting"
	SessionStatusRunning  SessionStatus = "running"
	SessionStatusBuilding SessionStatus = "building"
	SessionStatusStopped  SessionStatus = "stopped"
	SessionStatusCrashed  SessionStatus = "crashed"
)

// SessionStatuses 与 TS 联合类型同序。
var SessionStatuses = []SessionStatus{SessionStatusStarting, SessionStatusRunning, SessionStatusBuilding, SessionStatusStopped, SessionStatusCrashed}

// SessionMeta 会话元数据。
type SessionMeta struct {
	ID        string        `json:"id"`
	ProjectID *string       `json:"projectId"`
	Kind      SessionKind   `json:"kind"`
	Title     string        `json:"title"`
	Command   string        `json:"command"`
	Cwd       string        `json:"cwd"`
	Pid       int           `json:"pid"`
	Status    SessionStatus `json:"status"`
	Port      *int          `json:"port,omitempty"`
	StartedAt int64         `json:"startedAt"`
	ExitCode  *int          `json:"exitCode,omitempty"`
}

// CreateShellSessionInput 是页面「新建终端」唯一能提的请求。
// 可执行文件、参数、工作目录、环境变量一律由 Go 侧决定，其他字段在绑定边界丢弃（PRD §11）。
type CreateShellSessionInput struct {
	// Kind 只接受 "shell"。
	Kind  SessionKind `json:"kind"`
	Title string      `json:"title,omitempty"`
	// EntryID 开在该已登记条目的目录里；目录由 Go 侧解析，页面给不出路径。
	EntryID string `json:"entryId,omitempty"`
}

// CreateSessionInput 是 Go 侧内部的完整会话规格（EntryService 用固定模板构造），
// 绝不接到绑定层上。
type CreateSessionInput struct {
	Kind SessionKind `json:"kind"`
	// Cwd 省略时回退到用户主目录。
	Cwd       string  `json:"cwd,omitempty"`
	ProjectID *string `json:"projectId,omitempty"`
	Title     string  `json:"title,omitempty"`
	// File 可执行文件，缺省时用系统默认 shell。
	File string `json:"file,omitempty"`
	// Args 参数数组，绝不拼接成 shell 字符串。
	Args []string          `json:"args,omitempty"`
	Env  map[string]string `json:"env,omitempty"`
}

// SessionDataEvent 会话输出块。
type SessionDataEvent struct {
	ID    string `json:"id"`
	Chunk string `json:"chunk"`
}

// SessionExitEvent 会话退出。
type SessionExitEvent struct {
	ID       string `json:"id"`
	ExitCode int    `json:"exitCode"`
	Signal   *int   `json:"signal,omitempty"`
}
