// 对应 src/main/services/PlannerService.ts 的「校形」与「日程校形」两节：
// sanitizeText / sanitizeDate / assertRange / sanitizeBoardPatch / sanitizeTaskInput /
// sanitizeIds / findTask / findSchedule / sanitizeRepeat / sanitizeScheduleInput / assertScheduleRange。
//
// 入参是页面传来的原始 JSON（json.RawMessage），白名单外的键丢弃，非法值返回与原版逐字相同的中文错误。
// 键不存在对应原版的 `!('k' in p)`；JSON 传不了 undefined，所以「键在但值为 undefined」这一态不存在，
// 见 docs/MIGRATION-PLAN.md §6。

package planner

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"slices"

	"mile-console/internal/contract"
)

// CONTROL 逐字照搬原版 /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/（按码点写）。
var CONTROL = regexp.MustCompile(`[\x{0000}-\x{0008}\x{000B}\x{000C}\x{000E}-\x{001F}\x{007F}]`)

// lineBreakOrTab 即原版 /[\r\n\t]/。
var lineBreakOrTab = regexp.MustCompile(`[\r\n\t]`)

// maxIDLen 原版各处 `id.length > 64` 的上限。
const maxIDLen = 64

// field 记一个可被显式清空的补丁字段：In = 键出现在校形结果里，V = nil 表示 null（清空）。
type field[T any] struct {
	In bool
	V  *T
}

func set[T any](v T) field[T] { return field[T]{In: true, V: &v} }
func null[T any]() field[T]   { return field[T]{In: true} }

// sanitizeText 即原版 sanitizeText：必须是字符串，trim 后按 UTF-16 码元计长，拒绝控制字符。
func sanitizeText(raw json.RawMessage, label string, max int, allowNewline bool) (string, error) {
	v, ok := jsStr(raw)
	if !ok {
		return "", fmt.Errorf("%s必须是字符串", label)
	}
	s := jsTrim(v)
	if utf16Len(s) > max {
		return "", fmt.Errorf("%s不能超过 %d 字", label, max)
	}
	if CONTROL.MatchString(s) || (!allowNewline && lineBreakOrTab.MatchString(s)) {
		return "", fmt.Errorf("%s不能包含控制字符", label)
	}
	return s, nil
}

// sanitizeDate 即原版 sanitizeDate：null 与空串返回 null（nil），否则必须是合法日期。
func sanitizeDate(raw json.RawMessage, label string) (*string, error) {
	if kindOf(raw) == kindNull {
		return nil, nil
	}
	if s, ok := jsStr(raw); ok && s == "" {
		return nil, nil
	}
	s, ok := jsStr(raw)
	if !ok || !IsValidDate(s) {
		return nil, fmt.Errorf("%s必须是有效的日期", label)
	}
	return &s, nil
}

// assertRange 即原版 assertRange：两端都有时结束不能早于开始（字符串比较，格式固定所以等价于日期比较）。
func assertRange(start, end, endLabel string) error {
	if start != "" && end != "" && end < start {
		return fmt.Errorf("%s不能早于开始日期", endLabel)
	}
	return nil
}

// sanitizeNote 即原版 `p.note === null ? null : sanitizeText(p.note, '备注', NOTE_MAX, true) || null`。
func sanitizeNote(raw json.RawMessage) (field[string], error) {
	if kindOf(raw) == kindNull {
		return null[string](), nil
	}
	s, err := sanitizeText(raw, "备注", contract.NoteMax, true)
	if err != nil {
		return field[string]{}, err
	}
	if s == "" {
		return null[string](), nil
	}
	return set(s), nil
}

func dateField(p map[string]json.RawMessage, key, label string) (field[string], error) {
	raw, ok := p[key]
	if !ok {
		return field[string]{}, nil
	}
	v, err := sanitizeDate(raw, label)
	if err != nil {
		return field[string]{}, err
	}
	return field[string]{In: true, V: v}, nil
}

// boardPatch 即原版 sanitizeBoardPatch 的返回值。
type boardPatch struct {
	StartDate, EndDate, Note field[string]
}

func sanitizeBoardPatch(raw json.RawMessage) (boardPatch, error) {
	p, ok := asObject(raw)
	if !ok {
		return boardPatch{}, errors.New("看板改动必须是对象")
	}
	var out boardPatch
	var err error
	if out.StartDate, err = dateField(p, "startDate", "开始日期"); err != nil {
		return boardPatch{}, err
	}
	if out.EndDate, err = dateField(p, "endDate", "预计结束日期"); err != nil {
		return boardPatch{}, err
	}
	if v, in := p["note"]; in {
		if out.Note, err = sanitizeNote(v); err != nil {
			return boardPatch{}, err
		}
	}
	return out, nil
}

// taskPatch 即原版 sanitizeTaskInput 的返回值。
type taskPatch struct {
	Title                    *string
	Status                   *contract.PlannerTaskStatus
	StartDate, DueDate, Note field[string]
}

func sanitizeTaskInput(raw json.RawMessage, requireTitle bool) (taskPatch, error) {
	p, ok := asObject(raw)
	if !ok {
		return taskPatch{}, errors.New("任务内容必须是对象")
	}
	var out taskPatch
	if v, in := p["title"]; in || requireTitle {
		title, err := sanitizeText(v, "任务标题", contract.TaskTitleMax, false)
		if err != nil {
			return taskPatch{}, err
		}
		if title == "" {
			return taskPatch{}, errors.New("任务标题不能为空")
		}
		out.Title = &title
	}
	if v, in := p["status"]; in {
		s, ok := jsStr(v)
		st := contract.PlannerTaskStatus(s)
		if !ok || !slices.Contains(contract.TaskStatuses, st) {
			return taskPatch{}, errors.New("任务状态非法")
		}
		out.Status = &st
	}
	var err error
	if out.StartDate, err = dateField(p, "startDate", "开始日期"); err != nil {
		return taskPatch{}, err
	}
	if out.DueDate, err = dateField(p, "dueDate", "截止日期"); err != nil {
		return taskPatch{}, err
	}
	if v, in := p["note"]; in {
		if out.Note, err = sanitizeNote(v); err != nil {
			return taskPatch{}, err
		}
	}
	return out, nil
}

// sanitizeIds 即原版 sanitizeIds：数组、不超过 max 项、每项是不超过 64 码元的字符串。
func sanitizeIds(raw json.RawMessage, max int) ([]string, error) {
	bad := errors.New("ids 必须是 id 字符串数组")
	items, ok := asArray(raw)
	if !ok || len(items) > max {
		return nil, bad
	}
	out := make([]string, len(items))
	for i, it := range items {
		s, ok := jsStr(it)
		if !ok || utf16Len(s) > maxIDLen {
			return nil, bad
		}
		out[i] = s
	}
	return out, nil
}

// findTask 即原版 findTask：id 只校验是字符串（不查长度，与原版一致）。返回下标。
func findTask(b contract.PlannerBoard, raw json.RawMessage) (int, error) {
	id, ok := jsStr(raw)
	if !ok {
		return -1, errors.New("任务 id 非法")
	}
	for i, t := range b.Tasks {
		if t.ID == id {
			return i, nil
		}
	}
	return -1, errors.New("任务不存在")
}

// findSchedule 即原版 findSchedule。返回下标。
func findSchedule(b contract.PlannerBoard, raw json.RawMessage) (int, error) {
	id, ok := jsStr(raw)
	if !ok {
		return -1, errors.New("日程 id 非法")
	}
	for i, s := range b.Schedules {
		if s.ID == id {
			return i, nil
		}
	}
	return -1, errors.New("日程不存在")
}

// sanitizeRepeat 即原版 sanitizeRepeat（键存在时才调用，所以没有 undefined 分支）。
func sanitizeRepeat(raw json.RawMessage) (contract.ScheduleRepeat, error) {
	bad := errors.New("重复方式非法")
	r, ok := asObject(raw)
	if !ok {
		return contract.ScheduleRepeat{}, bad
	}
	k, ok := jsStr(r["kind"])
	kind := contract.RepeatKind(k)
	if !ok || !slices.Contains(contract.RepeatKinds, kind) {
		return contract.ScheduleRepeat{}, bad
	}
	switch kind {
	case contract.RepeatWeekly:
		items, ok := asArray(r["days"])
		if !ok || len(items) == 0 {
			return contract.ScheduleRepeat{}, errors.New("每周重复要勾至少一天")
		}
		// [...new Set(r.days.map(Number))]：按 SameValueZero 去重，保留首次出现的顺序
		var nums []float64
		for _, it := range items {
			n := jsNumber(it)
			dup := slices.ContainsFunc(nums, func(x float64) bool {
				return x == n || (math.IsNaN(x) && math.IsNaN(n))
			})
			if !dup {
				nums = append(nums, n)
			}
		}
		days := make([]int, 0, len(nums))
		for _, n := range nums {
			if !isInteger(n) || n < 0 || n > 6 {
				return contract.ScheduleRepeat{}, errors.New("星期几只能是 0–6")
			}
			days = append(days, int(n))
		}
		slices.Sort(days)
		return contract.ScheduleRepeat{Kind: kind, Days: days}, nil
	case contract.RepeatMonthly:
		n := jsNumber(r["day"])
		if !isInteger(n) || n < 1 || n > 31 {
			return contract.ScheduleRepeat{}, errors.New("每月几号只能是 1–31")
		}
		day := int(n)
		return contract.ScheduleRepeat{Kind: kind, Day: &day}, nil
	}
	return contract.ScheduleRepeat{Kind: kind}, nil
}

// schedulePatch 即原版 sanitizeScheduleInput 的返回值（CleanSchedule）。
//
// Title 没有「键不在」这一态：原版 out 初始化成 `{ title: "" }`，所以 editSchedule 里
// `clean.title !== undefined` 恒为真，补丁不带 title 时也会把标题改成空串。
// 这是已知原版问题 I4，按原样搬，见 docs/MIGRATION-PLAN.md §5。
type schedulePatch struct {
	Title            string
	TaskID           field[string]
	Date, Time       *string
	Repeat           *contract.ScheduleRepeat
	Until            field[string]
	LeadMinutes      *contract.LeadMinutes
	StopWhenTaskDone *bool
	Paused           *bool
	SnoozeUntil      field[int64]
}

func sanitizeScheduleInput(raw json.RawMessage, requireCore bool) (schedulePatch, error) {
	p, ok := asObject(raw)
	if !ok {
		return schedulePatch{}, errors.New("日程内容必须是对象")
	}
	var out schedulePatch

	if v, in := p["title"]; in || requireCore {
		// 关联任务时标题可留空，由 Go 侧取任务标题
		if k := kindOf(v); k != kindUndefined && k != kindNull {
			t, err := sanitizeText(v, "日程标题", contract.ScheduleTitleMax, false)
			if err != nil {
				return schedulePatch{}, err
			}
			out.Title = t
		}
	}
	if v, in := p["taskId"]; in {
		if kindOf(v) == kindNull {
			out.TaskID = null[string]()
		} else if s, ok := jsStr(v); ok {
			out.TaskID = set(s)
		} else {
			return schedulePatch{}, errors.New("关联任务 id 非法")
		}
	}
	if v, in := p["date"]; in || requireCore {
		s, ok := jsStr(v)
		if !ok || !IsValidDate(s) {
			return schedulePatch{}, errors.New("日期必须是有效的日期")
		}
		out.Date = &s
	}
	if v, in := p["time"]; in || requireCore {
		s, ok := jsStr(v)
		if !ok || !IsValidTime(s) {
			return schedulePatch{}, errors.New("时刻必须是 HH:mm")
		}
		out.Time = &s
	}
	if v, in := p["repeat"]; in {
		r, err := sanitizeRepeat(v)
		if err != nil {
			return schedulePatch{}, err
		}
		out.Repeat = &r
	}
	if v, in := p["until"]; in {
		// null → null；'' → undefined；两者在 editSchedule 里都是「删掉 until」，在 addSchedule 里都不设
		if kindOf(v) == kindNull {
			out.Until = null[string]()
		} else {
			d, err := sanitizeDate(v, "结束日期")
			if err != nil {
				return schedulePatch{}, err
			}
			out.Until = field[string]{In: true, V: d}
		}
	}
	if v, in := p["leadMinutes"]; in {
		n, ok := jsNum(v)
		lead := contract.LeadMinutes(n)
		if !ok || !isInteger(n) || !slices.Contains(contract.LeadMinutesList, lead) {
			return schedulePatch{}, errors.New("提前提醒只接受 0/5/15/30/60/1440 分钟")
		}
		out.LeadMinutes = &lead
	}
	if v, in := p["stopWhenTaskDone"]; in {
		b, ok := jsBool(v)
		if !ok {
			return schedulePatch{}, errors.New("完成后停止必须是布尔值")
		}
		out.StopWhenTaskDone = &b
	}
	if v, in := p["paused"]; in {
		b, ok := jsBool(v)
		if !ok {
			return schedulePatch{}, errors.New("暂停必须是布尔值")
		}
		out.Paused = &b
	}
	if v, in := p["snoozeUntil"]; in {
		if kindOf(v) == kindNull {
			out.SnoozeUntil = null[int64]()
		} else if n, ok := jsNum(v); ok && !math.IsInf(n, 0) && !math.IsNaN(n) {
			out.SnoozeUntil = set(ceilMillis(n))
		} else {
			return schedulePatch{}, errors.New("稍后提醒时间非法")
		}
	}
	return out, nil
}

// ceilMillis 把原版允许的任意有限数 snoozeUntil 存成整数毫秒。
// 向上取整：tick 里比较的是 `snoozeUntil <= now`，now 是整数，ceil(x) <= now 与 x <= now 等价，
// 所以到点时刻与原版一致；只有落盘的数值不同（原版存小数）。超出 int64 的夹到边界，同样不改比较结果。
// 见 docs/MIGRATION-PLAN.md §6。
func ceilMillis(f float64) int64 {
	c := math.Ceil(f)
	if c >= math.MaxInt64 {
		return math.MaxInt64
	}
	if c <= math.MinInt64 {
		return math.MinInt64
	}
	return int64(c)
}

// assertScheduleRange 即原版 assertScheduleRange：不重复的日程不查 until。
func assertScheduleRange(s contract.PlannerSchedule) error {
	if s.Repeat.Kind == contract.RepeatNone {
		return nil
	}
	if s.Until != "" && s.Until < s.Date {
		return errors.New("结束日期不能早于开始日期")
	}
	return nil
}
