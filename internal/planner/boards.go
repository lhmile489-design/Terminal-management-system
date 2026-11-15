// 对应 src/main/services/PlannerService.ts 的「看板」与「任务」两节：
// addBoard / editBoard / reassignBoard / removeBoard / reorderBoards /
// addTask / editTask / removeTask / reorderTasks。

package planner

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"

	"mile-console/internal/contract"
)

// AddBoard 即原版 addBoard。
func (s *Service) AddBoard(groupID json.RawMessage) (contract.PlannerBoard, error) {
	var ev pending
	defer func() { s.flush(ev) }()
	s.mu.Lock()
	defer s.mu.Unlock()

	gid, err := s.assertGroup(groupID)
	if err != nil {
		return contract.PlannerBoard{}, err
	}
	d := s.store.Get()
	if slices.ContainsFunc(d.Boards, func(b contract.PlannerBoard) bool { return b.GroupID == gid }) {
		return contract.PlannerBoard{}, errors.New("这个工作组已经有看板了")
	}
	if len(d.Boards) >= contract.MaxBoards {
		return contract.PlannerBoard{}, fmt.Errorf("看板最多 %d 块", contract.MaxBoards)
	}
	board := contract.PlannerBoard{
		ID:        s.opts.NewID(),
		GroupID:   gid,
		CreatedAt: s.opts.Wall(),
		Order:     len(d.Boards),
		Tasks:     []contract.PlannerTask{},
		Schedules: []contract.PlannerSchedule{},
	}
	d.Boards = append(d.Boards, board)
	if err := s.commit(d, nil, &ev); err != nil {
		return contract.PlannerBoard{}, err
	}
	return cloneBoards([]contract.PlannerBoard{board})[0], nil
}

// EditBoard 即原版 editBoard：startDate / endDate / note 三个键，null 清空。
func (s *Service) EditBoard(boardID, patch json.RawMessage) (contract.PlannerBoard, error) {
	var ev pending
	defer func() { s.flush(ev) }()
	s.mu.Lock()
	defer s.mu.Unlock()

	d, i, err := s.board(boardID)
	if err != nil {
		return contract.PlannerBoard{}, err
	}
	clean, err := sanitizeBoardPatch(patch)
	if err != nil {
		return contract.PlannerBoard{}, err
	}
	next := d.Boards[i]
	applyField(&next.StartDate, clean.StartDate)
	applyField(&next.EndDate, clean.EndDate)
	applyField(&next.Note, clean.Note)
	if err := assertRange(next.StartDate, next.EndDate, "预计结束日期"); err != nil {
		return contract.PlannerBoard{}, err
	}
	d.Boards[i] = next
	if err := s.commit(d, nil, &ev); err != nil {
		return contract.PlannerBoard{}, err
	}
	return cloneBoards([]contract.PlannerBoard{next})[0], nil
}

// applyField 即原版 `if (!(k in clean)) continue; v == null ? delete next[k] : next[k] = v`。
// Go 结构体用空串表示字段不存在（omitempty），所以 delete 写成置空。
func applyField(dst *string, f field[string]) {
	if !f.In {
		return
	}
	if f.V == nil {
		*dst = ""
	} else {
		*dst = *f.V
	}
}

// ReassignBoard 即原版 reassignBoard：工作组被删后改挂到另一个工作组。
func (s *Service) ReassignBoard(boardID, groupID json.RawMessage) (contract.PlannerBoard, error) {
	var ev pending
	defer func() { s.flush(ev) }()
	s.mu.Lock()
	defer s.mu.Unlock()

	d, i, err := s.board(boardID)
	if err != nil {
		return contract.PlannerBoard{}, err
	}
	gid, err := s.assertGroup(groupID)
	if err != nil {
		return contract.PlannerBoard{}, err
	}
	self := d.Boards[i].ID
	if slices.ContainsFunc(d.Boards, func(b contract.PlannerBoard) bool { return b.GroupID == gid && b.ID != self }) {
		return contract.PlannerBoard{}, errors.New("这个工作组已经有看板了")
	}
	d.Boards[i].GroupID = gid
	next := d.Boards[i]
	if err := s.commit(d, nil, &ev); err != nil {
		return contract.PlannerBoard{}, err
	}
	return cloneBoards([]contract.PlannerBoard{next})[0], nil
}

// RemoveBoard 即原版 removeBoard：删掉后剩下的 order 重编。
func (s *Service) RemoveBoard(boardID json.RawMessage) error {
	var ev pending
	defer func() { s.flush(ev) }()
	s.mu.Lock()
	defer s.mu.Unlock()

	d, i, err := s.board(boardID)
	if err != nil {
		return err
	}
	d.Boards = slices.Delete(d.Boards, i, i+1)
	for k := range d.Boards {
		d.Boards[k].Order = k
	}
	return s.commit(d, nil, &ev)
}

// ReorderBoards 即原版 reorderBoards。
func (s *Service) ReorderBoards(ids json.RawMessage) error {
	var ev pending
	defer func() { s.flush(ev) }()
	s.mu.Lock()
	defer s.mu.Unlock()

	list, err := sanitizeIds(ids, contract.MaxBoards)
	if err != nil {
		return err
	}
	d := s.store.Get()
	d.Boards = rankSort(d.Boards, list,
		func(b contract.PlannerBoard) string { return b.ID },
		func(b contract.PlannerBoard) int { return b.Order })
	for k := range d.Boards {
		d.Boards[k].Order = k
	}
	return s.commit(d, nil, &ev)
}

// AddTask 即原版 addTask：status 缺省 todo；新建即「已完成」时记 doneAt。
func (s *Service) AddTask(boardID, input json.RawMessage) (contract.PlannerTask, error) {
	var ev pending
	defer func() { s.flush(ev) }()
	s.mu.Lock()
	defer s.mu.Unlock()

	d, i, err := s.board(boardID)
	if err != nil {
		return contract.PlannerTask{}, err
	}
	b := d.Boards[i]
	if len(b.Tasks) >= contract.MaxTasksPerBoard {
		return contract.PlannerTask{}, fmt.Errorf("单个看板最多 %d 项任务", contract.MaxTasksPerBoard)
	}
	clean, err := sanitizeTaskInput(input, true)
	if err != nil {
		return contract.PlannerTask{}, err
	}
	status := contract.TaskTodo
	if clean.Status != nil {
		status = *clean.Status
	}
	task := contract.PlannerTask{
		ID:     s.opts.NewID(),
		Title:  *clean.Title,
		Status: status,
		Order:  len(b.Tasks),
	}
	// 原版 `if (clean.startDate) task.startDate = ...`：null 与空串都不设
	applyField(&task.StartDate, clean.StartDate)
	applyField(&task.DueDate, clean.DueDate)
	applyField(&task.Note, clean.Note)
	if status == contract.TaskDone {
		now := s.opts.Wall()
		task.DoneAt = &now
	}
	if err := assertRange(task.StartDate, task.DueDate, "截止日期"); err != nil {
		return contract.PlannerTask{}, err
	}
	d.Boards[i].Tasks = append(b.Tasks, task)
	if err := s.commit(d, nil, &ev); err != nil {
		return contract.PlannerTask{}, err
	}
	return cloneTasks([]contract.PlannerTask{task})[0], nil
}

// EditTask 即原版 editTask：状态变化时进入「已完成」记下此刻，离开「已完成」清空 doneAt。
func (s *Service) EditTask(boardID, taskID, patch json.RawMessage) (contract.PlannerTask, error) {
	var ev pending
	defer func() { s.flush(ev) }()
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.editTaskLocked(boardID, taskID, patch, &ev)
}

func (s *Service) editTaskLocked(boardID, taskID, patch json.RawMessage, ev *pending) (contract.PlannerTask, error) {
	d, i, err := s.board(boardID)
	if err != nil {
		return contract.PlannerTask{}, err
	}
	b := d.Boards[i]
	ti, err := findTask(b, taskID)
	if err != nil {
		return contract.PlannerTask{}, err
	}
	clean, err := sanitizeTaskInput(patch, false)
	if err != nil {
		return contract.PlannerTask{}, err
	}
	cur := b.Tasks[ti]
	next := cur
	if clean.Title != nil {
		next.Title = *clean.Title
	}
	applyField(&next.StartDate, clean.StartDate)
	applyField(&next.DueDate, clean.DueDate)
	applyField(&next.Note, clean.Note)
	if clean.Status != nil && *clean.Status != cur.Status {
		next.Status = *clean.Status
		if next.Status == contract.TaskDone {
			now := s.opts.Wall()
			next.DoneAt = &now
		} else {
			next.DoneAt = nil
		}
	}
	if err := assertRange(next.StartDate, next.DueDate, "截止日期"); err != nil {
		return contract.PlannerTask{}, err
	}
	d.Boards[i].Tasks[ti] = next
	if err := s.commit(d, nil, ev); err != nil {
		return contract.PlannerTask{}, err
	}
	return cloneTasks([]contract.PlannerTask{next})[0], nil
}

// RemoveTask 即原版 removeTask：挂在这个任务上的日程改成只挂看板，不跟着删。
func (s *Service) RemoveTask(boardID, taskID json.RawMessage) error {
	var ev pending
	defer func() { s.flush(ev) }()
	s.mu.Lock()
	defer s.mu.Unlock()

	d, i, err := s.board(boardID)
	if err != nil {
		return err
	}
	b := d.Boards[i]
	ti, err := findTask(b, taskID)
	if err != nil {
		return err
	}
	gone := b.Tasks[ti].ID
	tasks := slices.Delete(b.Tasks, ti, ti+1)
	for k := range tasks {
		tasks[k].Order = k
	}
	for k := range b.Schedules {
		if b.Schedules[k].TaskID == gone {
			b.Schedules[k].TaskID = ""
		}
	}
	d.Boards[i].Tasks = tasks
	return s.commit(d, nil, &ev)
}

// ReorderTasks 即原版 reorderTasks。
func (s *Service) ReorderTasks(boardID, ids json.RawMessage) error {
	var ev pending
	defer func() { s.flush(ev) }()
	s.mu.Lock()
	defer s.mu.Unlock()

	d, i, err := s.board(boardID)
	if err != nil {
		return err
	}
	list, err := sanitizeIds(ids, contract.MaxTasksPerBoard)
	if err != nil {
		return err
	}
	tasks := rankSort(d.Boards[i].Tasks, list,
		func(t contract.PlannerTask) string { return t.ID },
		func(t contract.PlannerTask) int { return t.Order })
	for k := range tasks {
		tasks[k].Order = k
	}
	d.Boards[i].Tasks = tasks
	return s.commit(d, nil, &ev)
}
