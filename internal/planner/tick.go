// 对应 src/main/services/PlannerService.ts 的「触发引擎（P2 §5.3）」一节与模块顶部的常量、测试钩子：
// MISS_AFTER_MS / TICK_MS / DEV_TICK_MS / DEV_NOW_MS，startScheduler / now / tick / firePayload / dispose。

package planner

import (
	"context"
	"math"
	"os"
	"regexp"
	"strconv"
	"time"

	"mile-console/internal/contract"
)

// MissAfterMs 触发时刻过去超过这么久就不再弹，记为错过（PRD-PLANNER §5.3 决策 4：1 小时）。
const MissAfterMs = 60 * 60 * 1000

// DefaultTickMs 检查间隔默认 30 秒。
const DefaultTickMs = 30_000

// timeoutMax 即 Node 的 TIMEOUT_MAX（2^31 - 1）：setInterval 的间隔超过它或小于 1 时按 1ms。
const timeoutMax = 1<<31 - 1

// devOverrides 即原版模块顶部的 P2 测试钩子：只在开发构建生效。
//
//	DEV_TICK_MS = !app.isPackaged ? Number(process.env.MILE_PLANNER_TICK_MS) || 0 : 0
//	DEV_NOW_MS  = DEV_NOW_RAW ? Number(DEV_NOW_RAW) || Date.parse(DEV_NOW_RAW) : 0
//	TICK_MS     = DEV_TICK_MS > 0 ? DEV_TICK_MS : 30_000
//
// 返回 (tickMs, devNowMs)；devNowMs 不大于 0 时表示不固定时间。
func devOverrides(dev bool, getenv func(string) string) (float64, float64) {
	if !dev {
		return DefaultTickMs, 0
	}
	if getenv == nil {
		getenv = os.Getenv
	}
	tick := orZero(jsStringToNumberEnv(getenv("MILE_PLANNER_TICK_MS")))
	if !(tick > 0) {
		tick = DefaultTickMs
	}
	var now float64
	if raw := getenv("MILE_PLANNER_NOW"); raw != "" {
		now = orZero(jsStringToNumber(raw))
		if now == 0 {
			now = dateParse(raw)
		}
	}
	return tick, now
}

// jsStringToNumberEnv 即 Number(process.env.X)：变量不存在时是 Number(undefined) = NaN。
// os.Getenv 分不清「没设」与「设成空串」；空串时 `Number("")` = 0，两者经 `|| 0` 后都是 0，结果相同。
func jsStringToNumberEnv(s string) float64 {
	if s == "" {
		return math.NaN()
	}
	return jsStringToNumber(s)
}

// orZero 即 `x || 0`：NaN 与 0 都得 0。
func orZero(f float64) float64 {
	if math.IsNaN(f) {
		return 0
	}
	return f
}

var isoDate = regexp.MustCompile(`^([+-]\d{6}|\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})?)?$`)

// dateParse 是 Date.parse 的 ISO 8601 子集（ECMA-262 §21.4.3.2 规定必须支持的格式）：
// 只有日期时按 UTC，带时刻且不带时区时按本地时间。与 V8 实测一致的细节：日只查 1–31 不查当月天数
// （2026-02-31 顺延到 3 月 3 日）、小数秒取前三位、年份 -000000 非法、24:00 只接受整点。
// V8 额外接受的非标准写法（'Nov 14 2026'、空格分隔、小写 t / z、+0800）不支持，解析不了返回 NaN。
// 这是只在开发构建生效的测试钩子，见 docs/MIGRATION-PLAN.md §6。
func dateParse(s string) float64 {
	m := isoDate.FindStringSubmatch(s)
	if m == nil {
		return math.NaN()
	}
	atoi := func(v string, def int) int {
		if v == "" {
			return def
		}
		n, _ := strconv.Atoi(v)
		return n
	}
	y := atoi(m[1], 0)
	mo, d := atoi(m[2], 1), atoi(m[3], 1)
	h, mi, sec := atoi(m[4], 0), atoi(m[5], 0), atoi(m[6], 0)
	ms := 0
	if m[7] != "" {
		frac := (m[7] + "00")[:3]
		ms, _ = strconv.Atoi(frac)
	}
	if mo < 1 || mo > 12 || d < 1 || d > 31 || h > 24 || mi > 59 || sec > 59 ||
		(h == 24 && (mi != 0 || sec != 0 || ms != 0)) {
		return math.NaN()
	}
	if m[1] == "-000000" {
		return math.NaN()
	}
	loc := time.Local
	switch {
	case m[4] == "": // 只有日期：UTC
		loc = time.UTC
	case m[8] == "Z":
		loc = time.UTC
	case m[8] != "":
		sign := 1
		if m[8][0] == '-' {
			sign = -1
		}
		off := sign * (atoi(m[8][1:3], 0)*3600 + atoi(m[8][4:6], 0)*60)
		loc = time.FixedZone("", off)
	}
	return float64(time.Date(y, time.Month(mo), d, h, mi, sec, ms*1_000_000, loc).UnixMilli())
}

// TickMs 本次运行的检查间隔（毫秒），即原版 TICK_MS。
func (s *Service) TickMs() float64 { return s.tickMs }

// Now 即原版 now()：开发构建下可被 MILE_PLANNER_NOW 固定。
// 原版允许小数毫秒，这里向下取整：比较的另一边都是整数毫秒，floor 不改变 `<=` 的结果。
func (s *Service) Now() int64 {
	if s.devNow > 0 {
		if s.devNow >= math.MaxInt64 {
			return math.MaxInt64
		}
		return int64(math.Floor(s.devNow))
	}
	return s.opts.Wall()
}

// StartScheduler 即原版 startScheduler：起周期检查并立刻查一次。重复调用无效。
// ctx 是 App 生命周期 ctx，取消或 Dispose 后停止。
func (s *Service) StartScheduler(ctx context.Context) {
	s.schedMu.Lock()
	if s.stop != nil {
		s.schedMu.Unlock()
		return
	}
	stop := make(chan struct{})
	s.stop = stop
	s.schedMu.Unlock()

	interval := s.tickMs
	if !(interval >= 1 && interval <= timeoutMax) {
		interval = 1
	}
	ticker := time.NewTicker(time.Duration(interval * float64(time.Millisecond)))
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-stop:
				return
			case <-ticker.C:
				_ = s.Tick() // 原版 setInterval 回调里抛错只会变成未捕获异常，下一轮照常
			}
		}
	}()
	_ = s.Tick()
}

// Dispose 即原版 dispose()：停掉周期检查。
func (s *Service) Dispose() {
	s.schedMu.Lock()
	defer s.schedMu.Unlock()
	if s.stop != nil {
		close(s.stop)
		s.stop = nil
	}
}

// Tick 即原版 tick()：一轮检查——snooze 到点重弹、到点提醒、过点超过 1 小时记错过。
// 只读时直接返回；没有任何变化时不写盘。电源恢复 / 解锁时由绑定层补调。
func (s *Service) Tick() error {
	var ev pending
	defer func() { s.flush(ev) }()
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.store.IsReadOnly() {
		return nil
	}
	now := s.Now()
	notifyOn := s.config.Get().Settings.PlannerNotify
	dirty := false
	var fires []contract.ReminderFire
	var missed []contract.MissedReminder

	d := s.store.Get()
	for bi := range d.Boards {
		board := &d.Boards[bi]
		groupName := s.groupName(board.GroupID)
		for si := range board.Schedules {
			next := &board.Schedules[si]
			// snooze 到点优先
			if !next.Paused && next.SnoozeUntil != nil && *next.SnoozeUntil <= now {
				next.SnoozeUntil = nil
				dirty = true
				if notifyOn {
					fires = append(fires, firePayload(*board, *next, groupName, now))
				}
			}
			// 常规触发：算 [上次触发后, now] 里所有该弹的。列表在循环前一次算好，
			// 循环中途因「完成后停止」暂停也不会少走后面几条（只是不再弹，与原版 for...of 一致）
			var from int64
			if next.LastFiredAt != nil {
				from = *next.LastFiredAt + 1
			}
			for _, f := range PendingFires(*next, from, now) {
				if next.LastFiredAt != nil && *next.LastFiredAt == f.At {
					continue
				}
				at := f.At
				next.LastFiredAt = &at
				dirty = true
				age := now - (f.At - int64(next.LeadMinutes)*60_000)
				if age > MissAfterMs {
					missed = append(missed, contract.MissedReminder{
						ScheduleID: next.ID, BoardID: board.ID, Title: next.Title, At: f.At,
					})
				} else if notifyOn && !next.Paused {
					fires = append(fires, firePayload(*board, *next, groupName, f.At))
				}
				// 关联任务完成且「完成后停止」开着：这次弹完就停
				if next.StopWhenTaskDone && next.TaskID != "" && linkedTaskClosed(*board, next.TaskID) {
					next.Paused = true
				}
			}
			// 「关联任务已完成且开着 stopWhenTaskDone」的，不再排下一条，标为停
			if next.StopWhenTaskDone && next.TaskID != "" && !next.Paused && linkedTaskClosed(*board, next.TaskID) {
				next.Paused = true
				dirty = true
			}
		}
	}

	if !dirty && len(missed) == 0 {
		return nil
	}
	all := append(cloneMissed(d.Missed), missed...)
	if len(all) > MaxMissed {
		all = all[len(all)-MaxMissed:]
	}
	if all == nil {
		all = []contract.MissedReminder{}
	}
	next := contract.PlannerData{Version: contract.PlannerVersion, Boards: d.Boards, Missed: all}
	return s.commit(next, fires, &ev)
}

func linkedTaskClosed(b contract.PlannerBoard, taskID string) bool {
	for _, t := range b.Tasks {
		if t.ID == taskID {
			return isClosed(t.Status)
		}
	}
	return false
}

// firePayload 即原版 firePayload。
func firePayload(b contract.PlannerBoard, s contract.PlannerSchedule, groupName string, at int64) contract.ReminderFire {
	return contract.ReminderFire{
		BoardID:    b.ID,
		ScheduleID: s.ID,
		GroupName:  groupName,
		Title:      s.Title,
		TaskID:     s.TaskID,
		When:       "今天 " + s.Time,
		At:         at,
	}
}
