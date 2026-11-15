// 对应 src/main/services/PlannerService.ts 的「日程（P2）」与「错过的提醒（P3 §5.4）」两节：
// addSchedule / editSchedule / removeSchedule / completeScheduleTask /
// dismissMissed / clearMissed / pauseSchedulesOfGroup。

package planner

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"

	"mile-console/internal/contract"
)

var errTaskNotOnBoard = errors.New("关联的任务不在这个看板里")

// AddSchedule 即原版 addSchedule。
// 与原版一致：这里不调 assertScheduleRange（until 早于 date 的重复日程能建出来，只有编辑时才拦），
// 见 docs/MIGRATION-PLAN.md §5 I5。
func (s *Service) AddSchedule(boardID, input json.RawMessage) (contract.PlannerSchedule, error) {
	var ev pending
	defer func() { s.flush(ev) }()
	s.mu.Lock()
	defer s.mu.Unlock()

	d, i, err := s.board(boardID)
	if err != nil {
		return contract.PlannerSchedule{}, err
	}
	b := d.Boards[i]
	if len(b.Schedules) >= contract.MaxSchedulesPerBoard {
		return contract.PlannerSchedule{}, fmt.Errorf("单个看板最多 %d 条日程", contract.MaxSchedulesPerBoard)
	}
	clean, err := sanitizeScheduleInput(input, true)
	if err != nil {
		return contract.PlannerSchedule{}, err
	}
	// 原版 `if (clean.taskId)`：null 与空串都当没关联
	taskID := ""
	if clean.TaskID.V != nil && *clean.TaskID.V != "" {
		taskID = *clean.TaskID.V
		ti := slices.IndexFunc(b.Tasks, func(t contract.PlannerTask) bool { return t.ID == taskID })
		if ti < 0 {
			return contract.PlannerSchedule{}, errTaskNotOnBoard
		}
		if clean.Title == "" {
			clean.Title = b.Tasks[ti].Title
		}
	}
	sch := contract.PlannerSchedule{
		ID:               s.opts.NewID(),
		Title:            clean.Title,
		Date:             *clean.Date,
		Time:             *clean.Time,
		Repeat:           contract.ScheduleRepeat{Kind: contract.RepeatNone},
		TaskID:           taskID,
		StopWhenTaskDone: true,
	}
	if clean.Repeat != nil {
		sch.Repeat = *clean.Repeat
	}
	if clean.LeadMinutes != nil {
		sch.LeadMinutes = *clean.LeadMinutes
	}
	if clean.StopWhenTaskDone != nil {
		sch.StopWhenTaskDone = *clean.StopWhenTaskDone
	}
	if clean.Paused != nil {
		sch.Paused = *clean.Paused
	}
	if clean.Until.V != nil {
		sch.Until = *clean.Until.V
	}
	d.Boards[i].Schedules = append(b.Schedules, sch)
	if err := s.commit(d, nil, &ev); err != nil {
		return contract.PlannerSchedule{}, err
	}
	return cloneSchedules([]contract.PlannerSchedule{sch})[0], nil
}

// EditSchedule 即原版 editSchedule。
// 标题每次都会被补丁里的 title 覆盖，补丁没带 title 时覆盖成空串：已知原版问题 I4，按原样搬。
func (s *Service) EditSchedule(boardID, scheduleID, patch json.RawMessage) (contract.PlannerSchedule, error) {
	var ev pending
	defer func() { s.flush(ev) }()
	s.mu.Lock()
	defer s.mu.Unlock()

	d, i, err := s.board(boardID)
	if err != nil {
		return contract.PlannerSchedule{}, err
	}
	b := d.Boards[i]
	si, err := findSchedule(b, scheduleID)
	if err != nil {
		return contract.PlannerSchedule{}, err
	}
	clean, err := sanitizeScheduleInput(patch, false)
	if err != nil {
		return contract.PlannerSchedule{}, err
	}
	next := cloneSchedules([]contract.PlannerSchedule{b.Schedules[si]})[0]

	next.Title = clean.Title // 已知原版问题 I4，见 docs/MIGRATION-PLAN.md
	if clean.TaskID.In {
		if clean.TaskID.V == nil {
			next.TaskID = ""
		} else {
			id := *clean.TaskID.V
			if !slices.ContainsFunc(b.Tasks, func(t contract.PlannerTask) bool { return t.ID == id }) {
				return contract.PlannerSchedule{}, errTaskNotOnBoard
			}
			next.TaskID = id
		}
	}
	if clean.Date != nil {
		next.Date = *clean.Date
	}
	if clean.Time != nil {
		next.Time = *clean.Time
	}
	if clean.Repeat != nil {
		next.Repeat = *clean.Repeat
	}
	applyField(&next.Until, clean.Until)
	if clean.LeadMinutes != nil {
		next.LeadMinutes = *clean.LeadMinutes
	}
	if clean.StopWhenTaskDone != nil {
		next.StopWhenTaskDone = *clean.StopWhenTaskDone
	}
	if clean.Paused != nil {
		next.Paused = *clean.Paused
		// 从暂停恢复时清掉 snooze，否则旧的「稍后提醒」可能立刻补弹
		if !next.Paused {
			next.SnoozeUntil = nil
		}
	}
	if clean.SnoozeUntil.In {
		next.SnoozeUntil = clean.SnoozeUntil.V
	}

	if err := assertScheduleRange(next); err != nil {
		return contract.PlannerSchedule{}, err
	}
	d.Boards[i].Schedules[si] = next
	if err := s.commit(d, nil, &ev); err != nil {
		return contract.PlannerSchedule{}, err
	}
	return cloneSchedules([]contract.PlannerSchedule{next})[0], nil
}

// RemoveSchedule 即原版 removeSchedule。
func (s *Service) RemoveSchedule(boardID, scheduleID json.RawMessage) error {
	var ev pending
	defer func() { s.flush(ev) }()
	s.mu.Lock()
	defer s.mu.Unlock()

	d, i, err := s.board(boardID)
	if err != nil {
		return err
	}
	si, err := findSchedule(d.Boards[i], scheduleID)
	if err != nil {
		return err
	}
	d.Boards[i].Schedules = slices.Delete(d.Boards[i].Schedules, si, si+1)
	return s.commit(d, nil, &ev)
}

// CompleteScheduleTask 即原版 completeScheduleTask：勾掉关联任务；没关联任务时什么都不做。
func (s *Service) CompleteScheduleTask(boardID, scheduleID json.RawMessage) error {
	var ev pending
	defer func() { s.flush(ev) }()
	s.mu.Lock()
	defer s.mu.Unlock()

	d, i, err := s.board(boardID)
	if err != nil {
		return err
	}
	si, err := findSchedule(d.Boards[i], scheduleID)
	if err != nil {
		return err
	}
	taskID := d.Boards[i].Schedules[si].TaskID
	if taskID == "" {
		return nil
	}
	rawTask, _ := json.Marshal(taskID)
	_, err = s.editTaskLocked(boardID, rawTask, json.RawMessage(`{"status":"done"}`), &ev)
	return err
}

// DismissMissed 即原版 dismissMissed：scheduleId + at 一起定位一条；at 缺省或 null 时清掉该日程的全部。
// at 用严格相等比较：只有数字才可能命中。没删掉任何一条时不写盘（只读时也就不报错）。
func (s *Service) DismissMissed(boardID, scheduleID, at json.RawMessage) error {
	var ev pending
	defer func() { s.flush(ev) }()
	s.mu.Lock()
	defer s.mu.Unlock()

	d, i, err := s.board(boardID)
	if err != nil {
		return err
	}
	sid, ok := jsStr(scheduleID)
	if !ok || utf16Len(sid) > maxIDLen {
		return errors.New("日程 id 非法")
	}
	bid := d.Boards[i].ID
	all := kindOf(at) == kindUndefined || kindOf(at) == kindNull
	atNum, atIsNum := jsNum(at)
	next := make([]contract.MissedReminder, 0, len(d.Missed))
	for _, m := range d.Missed {
		hit := m.BoardID == bid && m.ScheduleID == sid && (all || (atIsNum && float64(m.At) == atNum))
		if !hit {
			next = append(next, m)
		}
	}
	if len(next) == len(d.Missed) {
		return nil
	}
	d.Missed = next
	return s.commit(d, nil, &ev)
}

// ClearMissed 即原版 clearMissed：没有可清的就不写盘。
func (s *Service) ClearMissed() error {
	var ev pending
	defer func() { s.flush(ev) }()
	s.mu.Lock()
	defer s.mu.Unlock()

	d := s.store.Get()
	if len(d.Missed) == 0 {
		return nil
	}
	d.Missed = []contract.MissedReminder{}
	return s.commit(d, nil, &ev)
}

// PauseSchedulesOfGroup 即原版 pauseSchedulesOfGroup：工作组被删除时把该组所有日程停下，返回暂停的条数。
// 一条都没停时不写盘。
func (s *Service) PauseSchedulesOfGroup(groupID string) (int, error) {
	var ev pending
	defer func() { s.flush(ev) }()
	s.mu.Lock()
	defer s.mu.Unlock()

	d := s.store.Get()
	n := 0
	for bi := range d.Boards {
		if d.Boards[bi].GroupID != groupID {
			continue
		}
		for si := range d.Boards[bi].Schedules {
			if !d.Boards[bi].Schedules[si].Paused {
				d.Boards[bi].Schedules[si].Paused = true
				n++
			}
		}
	}
	if n == 0 {
		return 0, nil
	}
	if err := s.commit(d, nil, &ev); err != nil {
		return n, err
	}
	return n, nil
}
