// 对应 src/shared/types.ts 第 58–91 行：日志中心（PRD §4.8）。

package contract

// LogLevel 日志级别。
type LogLevel string

const (
	LogLevelInfo  LogLevel = "info"
	LogLevelWarn  LogLevel = "warn"
	LogLevelError LogLevel = "error"
)

// LogLevels 与 TS 联合类型同序。
var LogLevels = []LogLevel{LogLevelInfo, LogLevelWarn, LogLevelError}

// LogLine 一行日志。
type LogLine struct {
	// Seq 全局单调序号，页面据此做 key 与「有没有新行」判断。
	Seq       int64  `json:"seq"`
	SessionID string `json:"sessionId"`
	// EntryID 会话所属条目，shell 会话为 null。
	EntryID *string  `json:"entryId"`
	Title   string   `json:"title"`
	Ts      int64    `json:"ts"`
	Level   LogLevel `json:"level"`
	Text    string   `json:"text"`
}

// LogQuery 日志筛选；各字段可省略或为 null，含义相同（不筛）。
type LogQuery struct {
	SessionID *string   `json:"sessionId,omitempty"`
	EntryID   *string   `json:"entryId,omitempty"`
	Level     *LogLevel `json:"level,omitempty"`
	Text      *string   `json:"text,omitempty"`
	Limit     *int      `json:"limit,omitempty"`
}

// LogSource 日志来源统计。
type LogSource struct {
	SessionID string `json:"sessionId"`
	Title     string `json:"title"`
	Count     int    `json:"count"`
}

// LogResult 查询结果。
type LogResult struct {
	// Lines 按时间正序，最多 limit 条。
	Lines []LogLine `json:"lines"`
	// Total 命中筛选的总条数，可能大于 len(Lines)。
	Total int `json:"total"`
	// Dropped 被环形缓冲挤掉的行数。
	Dropped  int64       `json:"dropped"`
	Capacity int         `json:"capacity"`
	Sources  []LogSource `json:"sources"`
}
