// 对应 src/shared/planner.ts 的纯函数部分：日期与时间、看板状态、日程触发计算。
// 主进程（Go 侧 PlannerService）与渲染层都用这里的口径算进度、判超期、判定该弹哪一条提醒，
// 避免两边各写一份后对不上。这里不读写文件、不依赖配置，全是确定性计算。

package planner

import (
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"mile-console/internal/contract"
)

// dateRE 即原版 /^(\d{4})-(\d{2})-(\d{2})$/。
var dateRE = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})$`)

// timeRE 即原版 /^(\d{2}):(\d{2})$/。
var timeRE = regexp.MustCompile(`^(\d{2}):(\d{2})$`)

// IsValidDate 即原版 isValidDate：格式对、月日真实存在（2 月 30 日不算）。
// Go 里用 time.Date 验证：time.Date 对越界会归一化（如 2 月 30 日 → 3 月 2 日），
// 所以这里要显式比较 year/month/day 是否与原值一致。
func IsValidDate(s string) bool {
	m := dateRE.FindStringSubmatch(s)
	if m == nil {
		return false
	}
	y, _ := strconv.Atoi(m[1])
	mo, _ := strconv.Atoi(m[2])
	d, _ := strconv.Atoi(m[3])
	if y < 1970 || y > 2999 || mo < 1 || mo > 12 || d < 1 {
		return false
	}
	// new Date(y, mo, 0).getDate() 即该月最后一天；d <= 该值才合法
	last := time.Date(y, time.Month(mo)+1, 0, 0, 0, 0, 0, time.Local).Day()
	return d <= last
}

// LocalDate 即原版 localDate：'YYYY-MM-DD' 本地日期。
// 不用 UTC：toISOString 会把东八区凌晨算成前一天。
func LocalDate(at int64) string {
	t := time.UnixMilli(at).Local()
	return t.Format("2006-01-02")
}

// DaysBetween 即原版 daysBetween：b - a 相差的整天数。
// 两端都是 'YYYY-MM-DD' 本地日期字符串；用 UTC 构造只是为了避开夏令时的 23/25 小时。
func DaysBetween(a, b string) int {
	ay, am, ad := splitDate(a)
	by, bm, bd := splitDate(b)
	diff := time.Date(by, time.Month(bm), bd, 0, 0, 0, 0, time.UTC).
		Sub(time.Date(ay, time.Month(am), ad, 0, 0, 0, 0, time.UTC))
	// Math.round：四舍五入，与原版一致；这里 diff 总是 24h 的整数倍，直接除即可
	return int(math.Round(diff.Hours() / 24))
}

// splitDate 即原版 'YYYY-MM-DD'.split('-').map(Number)。不校验，调用方保证已 isValidDate 或来源可控。
func splitDate(s string) (y, mo, d int) {
	parts := strings.SplitN(s, "-", 3)
	if len(parts) != 3 {
		return 0, 0, 0
	}
	y, _ = strconv.Atoi(parts[0])
	mo, _ = strconv.Atoi(parts[1])
	d, _ = strconv.Atoi(parts[2])
	return
}

// BoardProgress 即原版 boardProgress：只算「已完成」；「已取消」不计入分子也不计入分母。
// Total 为 0 时 Percent 为 nil（界面显示「还没有任务」，不显示 0%）。
func BoardProgress(tasks []contract.PlannerTask) contract.BoardProgress {
	done, total := 0, 0
	for _, t := range tasks {
		if t.Status == contract.TaskCanceled {
			continue
		}
		total++
		if t.Status == contract.TaskDone {
			done++
		}
	}
	out := contract.BoardProgress{Done: done, Total: total}
	if total > 0 {
		p := int(math.Round(float64(done) / float64(total) * 100))
		out.Percent = &p
	}
	return out
}

// BoardStatus 即原版 boardStatus（PRD §4.6）：
// 全部完成 → complete；过了结束日期没完成 → overdue；结束前 SOON_DAYS 内没完成 → soon。
// 没有任务的看板不算完成。
func BoardStatus(board contract.PlannerBoard, today string) contract.BoardStatus {
	p := BoardProgress(board.Tasks)
	var daysLeft *int
	if board.EndDate != "" && IsValidDate(board.EndDate) {
		d := DaysBetween(today, board.EndDate)
		daysLeft = &d
	}
	if p.Total > 0 && p.Done == p.Total {
		return contract.BoardStatus{Tone: contract.BoardComplete, Label: "已完成", DaysLeft: daysLeft}
	}
	if daysLeft != nil && *daysLeft < 0 {
		return contract.BoardStatus{
			Tone:     contract.BoardOverdue,
			Label:    "已超期 " + strconv.Itoa(-*daysLeft) + " 天",
			DaysLeft: daysLeft,
		}
	}
	if daysLeft != nil && *daysLeft <= contract.SoonDays {
		label := "今天结束"
		if *daysLeft != 0 {
			label = "还剩 " + strconv.Itoa(*daysLeft) + " 天"
		}
		return contract.BoardStatus{Tone: contract.BoardSoon, Label: label, DaysLeft: daysLeft}
	}
	label := ""
	if daysLeft != nil {
		label = "剩 " + strconv.Itoa(*daysLeft) + " 天"
	}
	return contract.BoardStatus{Tone: contract.BoardNormal, Label: label, DaysLeft: daysLeft}
}

// TaskDueTone 即原版 taskDueTone：今天到期 / 已过期 / 其余。
// 完成与取消的任务不再提示（返回 normal 而不是 nil，与原版一致）。
// 返回 (*TaskDueTone, bool)：false 对应原版的 null（无 dueDate 或非法）。
func TaskDueTone(task contract.PlannerTask, today string) (contract.TaskDueTone, bool) {
	if task.DueDate == "" || !IsValidDate(task.DueDate) {
		return "", false
	}
	if task.Status == contract.TaskDone || task.Status == contract.TaskCanceled {
		return contract.DueNormal, true
	}
	d := DaysBetween(today, task.DueDate)
	if d < 0 {
		return contract.DueOverdue, true
	}
	if d == 0 {
		return contract.DueToday, true
	}
	return contract.DueNormal, true
}

// IsValidTime 即原版 isValidTime：'HH:mm'，小时 0–23、分 0–59。
func IsValidTime(s string) bool {
	m := timeRE.FindStringSubmatch(s)
	if m == nil {
		return false
	}
	h, _ := strconv.Atoi(m[1])
	mi, _ := strconv.Atoi(m[2])
	return h <= 23 && mi <= 59
}

// ScheduleMoment 即原版 scheduleMoment：'YYYY-MM-DD' + 'HH:mm' → 本地 Unix ms。
// 日期或时刻非法时返回 NaN 对应物 —— Go 里用 (0, false)。
func ScheduleMoment(date, tm string) (int64, bool) {
	if !IsValidDate(date) || !IsValidTime(tm) {
		return 0, false
	}
	y, mo, d := splitDate(date)
	parts := strings.SplitN(tm, ":", 2)
	h, _ := strconv.Atoi(parts[0])
	mi, _ := strconv.Atoi(parts[1])
	return time.Date(y, time.Month(mo), d, h, mi, 0, 0, time.Local).UnixMilli(), true
}

// TimeOfDay 即原版 timeOfDay：ms → 'HH:mm' 本地时刻。
func TimeOfDay(at int64) string {
	t := time.UnixMilli(at).Local()
	return t.Format("15:04")
}

// clampDay 即原版 clampDay：某月的第几天，超过当月天数落到月末（每月 31 号在 2 月落到 28/29）。
// mo1 是 0-based 月份；time.Date(y, mo1+2, 0) 取该月最后一天（0 是「上一月最后一天」）。
func clampDay(y, mo1, day int) int {
	last := time.Date(y, time.Month(mo1+2), 0, 0, 0, 0, 0, time.Local).Day()
	if day < last {
		return day
	}
	return last
}

// RepeatMatches 即原版 repeatMatches：这一天是否被该重复规则命中。
// date 已是 'YYYY-MM-DD' 合法格式；不校验，调用方保证。
func RepeatMatches(r contract.ScheduleRepeat, date string) bool {
	y, mo, d := splitDate(date)
	dow := int(time.Date(y, time.Month(mo), d, 0, 0, 0, 0, time.Local).Weekday())
	switch r.Kind {
	case contract.RepeatNone:
		return false
	case contract.RepeatDaily:
		return true
	case contract.RepeatWorkdays:
		return dow >= 1 && dow <= 5
	case contract.RepeatWeekly:
		return slices.Contains(r.Days, dow)
	case contract.RepeatMonthly:
		if r.Day == nil {
			return false
		}
		return d == clampDay(y, mo-1, *r.Day)
	}
	return false
}

// PendingFires 即原版 pendingFires：列出 [fromMs, toMs] 之间所有该弹的触发。
// 弹出时刻 = 触发时刻 - leadMinutes，落在这个闭区间内才算；按时间升序。
func PendingFires(s contract.PlannerSchedule, fromMs, toMs int64) []contract.PendingFire {
	if s.Paused {
		return nil
	}
	lead := int64(s.LeadMinutes) * 60_000
	out := []contract.PendingFire{}
	untilMs := int64(math.MaxInt64)
	if s.Until != "" && IsValidDate(s.Until) {
		if at, ok := ScheduleMoment(s.Until, "23:59"); ok {
			untilMs = at
		}
	}

	if s.Repeat.Kind == contract.RepeatNone {
		if at, ok := ScheduleMoment(s.Date, s.Time); ok &&
			at <= untilMs && at-lead >= fromMs && at-lead <= toMs {
			out = append(out, contract.PendingFire{At: at, Date: s.Date})
		}
		return out
	}

	// 重复日程：逐日扫，从 fromMs-lead 那天扫到 toMs+lead 那天（提醒可比触发早一天弹）
	startDay := time.UnixMilli(fromMs - lead - 86_400_000).Local()
	endDay := time.UnixMilli(toMs + 86_400_000).Local()
	cur := time.Date(startDay.Year(), startDay.Month(), startDay.Day(), 0, 0, 0, 0, time.Local)
	last := time.Date(endDay.Year(), endDay.Month(), endDay.Day(), 0, 0, 0, 0, time.Local)
	for !cur.After(last) {
		ds := cur.Format("2006-01-02")
		if DaysBetween(s.Date, ds) >= 0 && RepeatMatches(s.Repeat, ds) {
			if at, ok := ScheduleMoment(ds, s.Time); ok &&
				at <= untilMs && at-lead >= fromMs && at-lead <= toMs {
				out = append(out, contract.PendingFire{At: at, Date: ds})
			}
		}
		cur = cur.AddDate(0, 0, 1)
	}
	return out
}

// NextFireAt 即原版 nextFireAt：下一条提醒的业务触发时刻（用于「下次提醒」列），没找到返回 (0, false)。
// 窗口与原版一致：now → now + 370 天。
func NextFireAt(s contract.PlannerSchedule, now int64) (int64, bool) {
	fires := PendingFires(s, now, now+370*86_400_000)
	if len(fires) == 0 {
		return 0, false
	}
	return fires[0].At, true
}
