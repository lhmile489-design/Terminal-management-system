// 对应 src/shared/planner.ts：进度与日程（docs/PRD-PLANNER.md）的常量、类型与补丁。
// 这里只搬类型与常量；pendingFires、boardStatus、boardProgress、localDate 等纯函数归 S12（internal/planner）。
// 数据存独立文件 planner.json，不进 config.json（PRD §6.1）。

package contract

// PlannerVersion planner.json 结构版本。
const PlannerVersion = 1

// 上限，PRD §4.4。
const (
	MaxTasksPerBoard     = 500
	MaxBoards            = 200
	TaskTitleMax         = 120
	NoteMax              = 2000
	ScheduleTitleMax     = 120
	MaxSchedulesPerBoard = 200
	// SoonDays 结束前几天内没完成算「快到期」。
	SoonDays = 3
)

// PlannerTaskStatus 任务状态。
type PlannerTaskStatus string

const (
	TaskTodo     PlannerTaskStatus = "todo"
	TaskDoing    PlannerTaskStatus = "doing"
	TaskDone     PlannerTaskStatus = "done"
	TaskCanceled PlannerTaskStatus = "canceled"
)

// TaskStatuses 照搬原版 TASK_STATUSES。
var TaskStatuses = []PlannerTaskStatus{TaskTodo, TaskDoing, TaskDone, TaskCanceled}

// TaskStatusLabel 照搬原版 TASK_STATUS_LABEL。
var TaskStatusLabel = map[PlannerTaskStatus]string{
	TaskTodo:     "待办",
	TaskDoing:    "进行中",
	TaskDone:     "已完成",
	TaskCanceled: "已取消",
}

// LeadMinutes 提前提醒的分钟数，0 = 准时。合法值见 LeadMinutesList。
type LeadMinutes int

// LeadMinutesList 照搬原版 LEAD_MINUTES。
var LeadMinutesList = []LeadMinutes{0, 5, 15, 30, 60, 1440}

// RepeatKind 重复方式。
type RepeatKind string

const (
	RepeatNone     RepeatKind = "none"
	RepeatDaily    RepeatKind = "daily"
	RepeatWorkdays RepeatKind = "workdays"
	RepeatWeekly   RepeatKind = "weekly"
	RepeatMonthly  RepeatKind = "monthly"
)

// RepeatKinds 照搬原版 REPEAT_KINDS。
var RepeatKinds = []RepeatKind{RepeatNone, RepeatDaily, RepeatWorkdays, RepeatWeekly, RepeatMonthly}

// RepeatLabel 照搬原版 REPEAT_LABEL。
var RepeatLabel = map[RepeatKind]string{
	RepeatNone:     "不重复",
	RepeatDaily:    "每天",
	RepeatWorkdays: "工作日",
	RepeatWeekly:   "每周",
	RepeatMonthly:  "每月",
}

// WeekdayLabel 星期几：0=周日 … 6=周六，与 Date.getDay() 一致。
var WeekdayLabel = []string{"日", "一", "二", "三", "四", "五", "六"}

// ScheduleRepeat 是 TS 判别联合的扁平形式：
// none / daily / workdays 只有 kind；weekly 带 days；monthly 带 day。按 kind 校形归 S12。
type ScheduleRepeat struct {
	Kind RepeatKind `json:"kind"`
	// Days weekly 用，0=周日 … 6=周六。
	Days []int `json:"days,omitzero"`
	// Day monthly 用，每月第几天。
	Day *int `json:"day,omitempty"`
}

// PlannerSchedule 一条日程。
type PlannerSchedule struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	TaskID string `json:"taskId,omitempty"`
	// Date 'YYYY-MM-DD'，首次 / 唯一一次的本地日期。
	Date string `json:"date"`
	// Time 'HH:mm'，本地时刻。
	Time   string         `json:"time"`
	Repeat ScheduleRepeat `json:"repeat"`
	// Until 'YYYY-MM-DD'，重复日程到这天为止（含）。
	Until       string      `json:"until,omitempty"`
	LeadMinutes LeadMinutes `json:"leadMinutes"`
	// StopWhenTaskDone 关联任务完成后自动停止，默认开。
	StopWhenTaskDone bool `json:"stopWhenTaskDone"`
	Paused           bool `json:"paused"`
	// SnoozeUntil 稍后提醒，Unix ms。
	SnoozeUntil *int64 `json:"snoozeUntil,omitempty"`
	// LastFiredAt 上次真正弹出的触发时刻（Unix ms），防重。
	LastFiredAt *int64 `json:"lastFiredAt,omitempty"`
}

// MissedReminder 一条错过的提醒。
type MissedReminder struct {
	ScheduleID string `json:"scheduleId"`
	BoardID    string `json:"boardId"`
	Title      string `json:"title"`
	// At 本该触发的时刻（Unix ms）。
	At int64 `json:"at"`
}

// PlannerTask 看板任务。
type PlannerTask struct {
	ID     string            `json:"id"`
	Title  string            `json:"title"`
	Status PlannerTaskStatus `json:"status"`
	// StartDate / DueDate 'YYYY-MM-DD'，本地日期。
	StartDate string `json:"startDate,omitempty"`
	DueDate   string `json:"dueDate,omitempty"`
	Note      string `json:"note,omitempty"`
	// DoneAt 勾选完成时记下，取消完成时清空。
	DoneAt *int64 `json:"doneAt,omitempty"`
	Order  int    `json:"order"`
}

// PlannerBoard 一个工作组的看板。
type PlannerBoard struct {
	ID string `json:"id"`
	// GroupID 必须是已有工作组；工作组被删后保留看板。
	GroupID   string            `json:"groupId"`
	StartDate string            `json:"startDate,omitempty"`
	EndDate   string            `json:"endDate,omitempty"`
	Note      string            `json:"note,omitempty"`
	CreatedAt int64             `json:"createdAt"`
	Order     int               `json:"order"`
	Tasks     []PlannerTask     `json:"tasks"`
	Schedules []PlannerSchedule `json:"schedules"`
}

// PlannerData 即 planner.json 的结构。
type PlannerData struct {
	Version int            `json:"version"`
	Boards  []PlannerBoard `json:"boards"`
	// Missed 错过的提醒，P3 汇总用。
	Missed []MissedReminder `json:"missed,omitzero"`
}

// PlannerSnapshot 页面拿到的整份数据，多一个只读标记。
type PlannerSnapshot struct {
	Boards   []PlannerBoard   `json:"boards"`
	ReadOnly bool             `json:"readOnly"`
	Missed   []MissedReminder `json:"missed"`
}

// PlannerBoardPatch 看板可编辑字段。null = 显式清空。
type PlannerBoardPatch struct {
	StartDate Patch[string] `json:"startDate,omitzero"`
	EndDate   Patch[string] `json:"endDate,omitzero"`
	Note      Patch[string] `json:"note,omitzero"`
}

// PlannerTaskInput 新建任务入参。新建时 null 与省略同义，所以用指针。
type PlannerTaskInput struct {
	Title     string             `json:"title"`
	Status    *PlannerTaskStatus `json:"status,omitempty"`
	StartDate *string            `json:"startDate,omitempty"`
	DueDate   *string            `json:"dueDate,omitempty"`
	Note      *string            `json:"note,omitempty"`
}

// PlannerTaskPatch 即 Partial<PlannerTaskInput>。
type PlannerTaskPatch struct {
	Title     *string            `json:"title,omitempty"`
	Status    *PlannerTaskStatus `json:"status,omitempty"`
	StartDate Patch[string]      `json:"startDate,omitzero"`
	DueDate   Patch[string]      `json:"dueDate,omitzero"`
	Note      Patch[string]      `json:"note,omitzero"`
}

// PlannerScheduleInput 新建日程入参。
type PlannerScheduleInput struct {
	Title            string          `json:"title"`
	TaskID           *string         `json:"taskId,omitempty"`
	Date             string          `json:"date"`
	Time             string          `json:"time"`
	Repeat           *ScheduleRepeat `json:"repeat,omitempty"`
	Until            *string         `json:"until,omitempty"`
	LeadMinutes      *LeadMinutes    `json:"leadMinutes,omitempty"`
	StopWhenTaskDone *bool           `json:"stopWhenTaskDone,omitempty"`
	Paused           *bool           `json:"paused,omitempty"`
}

// PlannerSchedulePatch 即 Partial<PlannerScheduleInput> & { snoozeUntil?: number | null }。
type PlannerSchedulePatch struct {
	Title            *string         `json:"title,omitempty"`
	TaskID           Patch[string]   `json:"taskId,omitzero"`
	Date             *string         `json:"date,omitempty"`
	Time             *string         `json:"time,omitempty"`
	Repeat           *ScheduleRepeat `json:"repeat,omitempty"`
	Until            Patch[string]   `json:"until,omitzero"`
	LeadMinutes      *LeadMinutes    `json:"leadMinutes,omitempty"`
	StopWhenTaskDone *bool           `json:"stopWhenTaskDone,omitempty"`
	Paused           *bool           `json:"paused,omitempty"`
	SnoozeUntil      Patch[int64]    `json:"snoozeUntil,omitzero"`
}

// ReminderFire 页面收到的一条到点提醒。
type ReminderFire struct {
	BoardID    string `json:"boardId"`
	ScheduleID string `json:"scheduleId"`
	// GroupName 工作组名（Go 侧查好）。
	GroupName string `json:"groupName"`
	Title     string `json:"title"`
	// TaskID 关联任务 id；没有就不显示「标记完成」。
	TaskID string `json:"taskId,omitempty"`
	// When 显示用的时间文本，如「今天 15:00」。
	When string `json:"when"`
	At   int64  `json:"at"`
}

// BoardProgress 看板进度。
type BoardProgress struct {
	Done int `json:"done"`
	// Total 不含已取消。
	Total int `json:"total"`
	// Percent 0..100 的整数；Total 为 0 时为 null。
	Percent *int `json:"percent"`
}

// BoardTone 看板状态色调。
type BoardTone string

const (
	BoardOverdue  BoardTone = "overdue"
	BoardComplete BoardTone = "complete"
	BoardSoon     BoardTone = "soon"
	BoardNormal   BoardTone = "normal"
)

// BoardTones 与 TS 联合类型同序。
var BoardTones = []BoardTone{BoardOverdue, BoardComplete, BoardSoon, BoardNormal}

// BoardStatus 看板状态。
type BoardStatus struct {
	Tone  BoardTone `json:"tone"`
	Label string    `json:"label"`
	// DaysLeft endDate - today；没有结束日期时为 null。
	DaysLeft *int `json:"daysLeft"`
}

// TaskDueTone 任务截止胶囊色调。
type TaskDueTone string

const (
	DueOverdue TaskDueTone = "overdue"
	DueToday   TaskDueTone = "today"
	DueNormal  TaskDueTone = "normal"
)

// TaskDueTones 与 TS 联合类型同序。
var TaskDueTones = []TaskDueTone{DueOverdue, DueToday, DueNormal}

// PendingFire 一次待触发。
type PendingFire struct {
	// At 触发时刻（date + time），lastFiredAt 记的就是它。
	At int64 `json:"at"`
	// Date 该次触发对应的本地日期 'YYYY-MM-DD'。
	Date string `json:"date"`
}
