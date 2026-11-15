// 对应 src/shared/types.ts 第 785–843 行：配置导入导出、整组启动结果、端口占用者、条目诊断。

package contract

// ConfigExportResult 配置导出结果（2.3.0）。环境变量只导出变量名。
type ConfigExportResult struct {
	Path    string `json:"path"`
	Entries int    `json:"entries"`
	Groups  int    `json:"groups"`
}

// ImportSkipped 导入时跳过的条目。
type ImportSkipped struct {
	Name   string `json:"name"`
	Reason string `json:"reason"`
}

// ImportEnvRefill 导入后需要重填值的环境变量名。
type ImportEnvRefill struct {
	ID   string   `json:"id"`
	Name string   `json:"name"`
	Keys []string `json:"keys"`
}

// ConfigImportResult 配置导入结果（2.3.0）。
type ConfigImportResult struct {
	// Backup 导入前的备份位置。
	Backup      string            `json:"backup"`
	Added       int               `json:"added"`
	GroupsAdded int               `json:"groupsAdded"`
	Skipped     []ImportSkipped   `json:"skipped"`
	EnvToRefill []ImportEnvRefill `json:"envToRefill"`
}

// OrderedStartResult 按依赖顺序整组启动的逐条结果。
type OrderedStartResult struct {
	ID string `json:"id"`
	OK bool   `json:"ok"`
	// Precheck 被预检拦下时的结果。
	Precheck *PrecheckResult `json:"precheck,omitempty"`
	// Skipped 没有启动的原因（前置没起来、启动抛错）。
	Skipped string `json:"skipped,omitempty"`
}

// PortHolder 端口占用者。
type PortHolder struct {
	Pid         int       `json:"pid"`
	ProcessName string    `json:"processName"`
	Ownership   Ownership `json:"ownership"`
	// EntryID 仅在能按会话归属精确映射到受控条目时提供。
	EntryID string `json:"entryId,omitempty"`
}

// EntryDiagnosis 条目诊断。
type EntryDiagnosis struct {
	EntryID  string         `json:"entryId"`
	Precheck PrecheckResult `json:"precheck"`
	// Port 被诊断的预期端口，无则 null。
	Port *int `json:"port"`
	// PortHolder 预期端口现状，无预期端口或空闲时为 null。
	PortHolder    *PortHolder `json:"portHolder"`
	LastExitCode  *int        `json:"lastExitCode,omitempty"`
	LastStartedAt *int64      `json:"lastStartedAt,omitempty"`
	// LastRunMs 上次运行时长（毫秒），未运行过时省略。
	LastRunMs      *int64 `json:"lastRunMs,omitempty"`
	FirstErrorLine string `json:"firstErrorLine,omitempty"`
	// LastErrorLine 退出前输出里的最后一个错误行，只在内存。
	LastErrorLine string `json:"lastErrorLine,omitempty"`
	// TailLines 退出前最后 30 行可见输出（已去 ANSI），只在内存。
	TailLines      []string       `json:"tailLines"`
	Node           string         `json:"node"`
	PackageManager PackageManager `json:"packageManager"`
	// PackageManagerPath PATH 中找不到时为 null。
	PackageManagerPath *string `json:"packageManagerPath"`
	// EnvKeys 只给键名，绝不含值（PRD §4.4）。
	EnvKeys []string `json:"envKeys"`
	// OutputDir 任务产物目录，不存在为 null。
	OutputDir *string `json:"outputDir"`
}
