// 对应 src/main/services/PlannerService.ts 的持久化部分：planner.json 的读写、.bak 轮转、
// .corrupt 旁存、只读保护，与 config.Store 同一套机制，但写盘失败语义不同——
// 只读时本 Store 抛错（原版 PlannerService.commit 主动 throw），不像 config 的 C2 静默丢。
//
// 数据独立成文件，不进 config.json（PRD §6.1）。所有方法并发安全。

package planner

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"mile-console/internal/contract"
)

// MaxMissed 原版 PlannerService.ts 模块内常量（200），contract 没搬因为它只用于存储层。
const MaxMissed = 200

// Store 即原版 PlannerService 的存储部分。
type Store struct {
	dir     string
	file    string
	backup  string // planner.json.bak：上一份良好版本
	corrupt string // planner.json.corrupt：解析失败的主文件挪到这里

	mu       sync.Mutex
	cache    contract.PlannerData
	readOnly bool
}

// 与原版 PlannerService.commit 一致的报错文案。
var errReadOnly = errors.New("进度数据文件读不出来，这次运行不会保存改动。请检查 planner.json")

// Open 在 dir 下打开进度数据，即原版构造函数的 boot() 部分。
// 只在「从备份恢复后写回主文件」失败时才返回错误（原版此时构造函数抛错，应用起不来）。
func Open(dir string) (*Store, error) {
	s := &Store{
		dir:     dir,
		file:    filepath.Join(dir, "planner.json"),
		backup:  filepath.Join(dir, "planner.json.bak"),
		corrupt: filepath.Join(dir, "planner.json.corrupt"),
	}
	if err := s.boot(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) boot() error {
	if primary, ok := readObject(s.file); ok {
		s.cache = migrate(primary)
		return nil
	}
	if fallback, ok := readObject(s.backup); ok {
		// 从备份恢复要立刻写回主文件，否则下次启动还得再走一遍这条路。
		// 坏主文件先挪成 .corrupt 留给排查；这一次写入跳过「备份当前主文件」，
		// 否则常规 persist() 会把坏主文件复制到 .bak，唯一的良好版本就没了。
		if exists(s.file) {
			_ = os.Rename(s.file, s.corrupt)
		}
		s.cache = migrate(fallback)
		return s.persist(true)
	}
	// 两份都解析不出来但文件在：不是「首次运行」，是数据出问题了，别覆盖
	if exists(s.file) || exists(s.backup) {
		s.readOnly = true
	}
	s.cache = contract.PlannerData{Version: contract.PlannerVersion, Boards: []contract.PlannerBoard{}}
	return nil
}

// readObject 即原版 read()：读不到、解析失败、顶层不是对象都返回 false。
// 返回原始字节，由 migrate 自己解析（沿用 config 的口径：JSON 解析过的对象交 migrate 校形）。
func readObject(path string) (json.RawMessage, bool) {
	b, err := os.ReadFile(path)
	if err != nil || !json.Valid(b) {
		return nil, false
	}
	if rawKind(b) != '{' {
		return nil, false
	}
	return b, true
}

func rawKind(raw json.RawMessage) byte {
	t := bytes.TrimLeft(raw, " \t\r\n")
	if len(t) == 0 {
		return 0
	}
	return t[0]
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// IsReadOnly 即原版 readOnly。
func (s *Store) IsReadOnly() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.readOnly
}

// Snapshot 即原版 snapshot()：返回整份数据 + 只读标记 + missed 汇总。
// 返回深拷贝：调用方改返回值不影响缓存。
// 原版 missed: structuredClone(this.data.missed ?? [])、boards 同样保数组 ——
// 缓存为 nil 时给空数组，JSON 序列化成 [] 而不是 null。
func (s *Store) Snapshot() contract.PlannerSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	missed := cloneMissed(s.cache.Missed)
	if missed == nil {
		missed = []contract.MissedReminder{}
	}
	boards := cloneBoards(s.cache.Boards)
	if boards == nil {
		boards = []contract.PlannerBoard{}
	}
	return contract.PlannerSnapshot{
		Boards:   boards,
		ReadOnly: s.readOnly,
		Missed:   missed,
	}
}

// Get 返回当前缓存的深拷贝。给 PlannerService 内部用。
func (s *Store) Get() contract.PlannerData {
	s.mu.Lock()
	defer s.mu.Unlock()
	return clone(s.cache)
}

// Patch 即原版 commit：fn 在缓存的副本上改，改完整体换上并落盘。
// 只读时抛错（与原版 commit 一致），不动缓存也不落盘。
// 落盘失败时缓存已换上（与原版一致：先赋值再 persist），返回错误。
func (s *Store) Patch(fn func(d *contract.PlannerData)) (contract.PlannerData, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.readOnly {
		return contract.PlannerData{}, errReadOnly
	}
	next := clone(s.cache)
	fn(&next)
	s.cache = next
	err := s.persist(false)
	return clone(s.cache), err
}

// persist 写入前先把当前良好版本留成 .bak，再临时文件 + rename 换上新版本。
// 顺序不能颠倒 —— 先 rename 再备份就会把刚写的新内容备份成「上一份良好版本」。
// 调用方持有 s.mu。skipBackup 用于从 .bak 恢复时写回主文件（不能把坏主文件复制成 .bak）。
func (s *Store) persist(skipBackup bool) error {
	if s.readOnly {
		return nil // persist 自己不再抛错：抛错的是 Patch / 上层调用方，与原版一致
	}
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return err
	}
	if !skipBackup && exists(s.file) {
		_ = copyFile(s.file, s.backup) // 备份失败不该挡住正常写入
	}
	b, err := marshalPlanner(s.cache)
	if err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.%d.tmp", s.file, os.Getpid())
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.file)
}

// marshalPlanner 即 JSON.stringify(data, null, 2)：两空格缩进、UTF-8 无 BOM、末尾无换行、不转义 < > &。
func marshalPlanner(d contract.PlannerData) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(d); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

// copyFile 即 fs.copyFileSync：目标存在时覆盖。
func copyFile(src, dst string) error {
	b, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	info, err := os.Stat(src)
	mode := fs.FileMode(0o644)
	if err == nil {
		mode = info.Mode().Perm()
	}
	return os.WriteFile(dst, b, mode)
}

// ── 深拷贝 ────────────────────────────────────────────────────────────

func clone(d contract.PlannerData) contract.PlannerData {
	return contract.PlannerData{
		Version: d.Version,
		Boards:  cloneBoards(d.Boards),
		Missed:  cloneMissed(d.Missed),
	}
}

func cloneBoards(bs []contract.PlannerBoard) []contract.PlannerBoard {
	if bs == nil {
		return nil
	}
	out := make([]contract.PlannerBoard, len(bs))
	for i, b := range bs {
		out[i] = b
		out[i].Tasks = cloneTasks(b.Tasks)
		out[i].Schedules = cloneSchedules(b.Schedules)
	}
	return out
}

func cloneTasks(ts []contract.PlannerTask) []contract.PlannerTask {
	if ts == nil {
		return nil
	}
	out := make([]contract.PlannerTask, len(ts))
	for i, t := range ts {
		out[i] = t
		out[i].DoneAt = clonePtr(t.DoneAt)
	}
	return out
}

func cloneSchedules(ss []contract.PlannerSchedule) []contract.PlannerSchedule {
	if ss == nil {
		return nil
	}
	out := make([]contract.PlannerSchedule, len(ss))
	for i, s := range ss {
		out[i] = s
		out[i].Repeat.Days = append([]int(nil), s.Repeat.Days...)
		out[i].Repeat.Day = clonePtr(s.Repeat.Day)
		out[i].SnoozeUntil = clonePtr(s.SnoozeUntil)
		out[i].LastFiredAt = clonePtr(s.LastFiredAt)
	}
	return out
}

func cloneMissed(ms []contract.MissedReminder) []contract.MissedReminder {
	if ms == nil {
		return nil
	}
	out := make([]contract.MissedReminder, len(ms))
	copy(out, ms)
	return out
}

func clonePtr[T any](p *T) *T {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}

// ── migrate ────────────────────────────────────────────────────────────

// migrate 即原版 migrate()：版本对齐 + 校形。目前只有 v1，这里做的是字段校形，
// 把手改坏的元素丢掉，免得渲染层拿到缺字段的任务直接抛错。
// 与原版一致：boards / tasks / schedules / missed 逐条过白名单，超上限截断。
func migrate(raw json.RawMessage) contract.PlannerData {
	var top map[string]json.RawMessage
	if json.Unmarshal(raw, &top) != nil {
		return contract.PlannerData{Version: contract.PlannerVersion, Boards: []contract.PlannerBoard{}}
	}
	boards := migrateBoards(top["boards"])
	missed := migrateMissed(top["missed"])
	return contract.PlannerData{Version: contract.PlannerVersion, Boards: boards, Missed: missed}
}

// migrateBoards 对应原版 migrate 里 boards 的过滤与字段重排。
// 缺字段或类型错的板子整条丢；合法板子的 startDate / endDate 不合法时置空（不是整条丢）。
func migrateBoards(raw json.RawMessage) []contract.PlannerBoard {
	var list []json.RawMessage
	if json.Unmarshal(raw, &list) != nil {
		return []contract.PlannerBoard{}
	}
	out := make([]contract.PlannerBoard, 0, len(list))
	for _, it := range list {
		var b map[string]json.RawMessage
		if json.Unmarshal(it, &b) != nil || b == nil {
			continue
		}
		var id, groupID string
		if !asString(b["id"], &id) || !asString(b["groupId"], &groupID) {
			continue
		}
		board := contract.PlannerBoard{
			ID:        id,
			GroupID:   groupID,
			CreatedAt: asInt64Default(b["createdAt"], nowMilli()),
			Order:     len(out), // 原版重新编 order = out.length，不读 b.order
			Tasks:     migrateTasks(b["tasks"]),
			Schedules: migrateSchedules(b["schedules"]),
		}
		// startDate / endDate：合法才保留，否则 undefined
		if s, ok := stringField(b["startDate"]); ok && IsValidDate(s) {
			board.StartDate = s
		}
		if s, ok := stringField(b["endDate"]); ok && IsValidDate(s) {
			board.EndDate = s
		}
		if s, ok := stringField(b["note"]); ok {
			board.Note = s
		}
		out = append(out, board)
		if len(out) >= contract.MaxBoards {
			break
		}
	}
	return out
}

// migrateTasks 对应原版 tasks 过滤：id、title 必须为 string，status 必须在白名单内；
// 其他字段照抄，order 重编为下标，超出 MaxTasksPerBoard 截断。
func migrateTasks(raw json.RawMessage) []contract.PlannerTask {
	var list []json.RawMessage
	if json.Unmarshal(raw, &list) != nil {
		return []contract.PlannerTask{}
	}
	out := make([]contract.PlannerTask, 0, len(list))
	for _, it := range list {
		var t map[string]json.RawMessage
		if json.Unmarshal(it, &t) != nil || t == nil {
			continue
		}
		var id, title, status string
		if !asString(t["id"], &id) || !asString(t["title"], &title) || !asString(t["status"], &status) {
			continue
		}
		st := contract.PlannerTaskStatus(status)
		if !containsTaskStatus(st) {
			continue
		}
		task := contract.PlannerTask{ID: id, Title: title, Status: st, Order: len(out)}
		if s, ok := stringField(t["startDate"]); ok {
			task.StartDate = s
		}
		if s, ok := stringField(t["dueDate"]); ok {
			task.DueDate = s
		}
		if s, ok := stringField(t["note"]); ok {
			task.Note = s
		}
		if n, ok := int64Field(t["doneAt"]); ok {
			task.DoneAt = &n
		}
		out = append(out, task)
		if len(out) >= contract.MaxTasksPerBoard {
			break
		}
	}
	return out
}

// migrateSchedules 对应原版 schedules 过滤：id / date / time 必须合法；其他字段照抄；
// 超出 MaxSchedulesPerBoard 截断。
func migrateSchedules(raw json.RawMessage) []contract.PlannerSchedule {
	var list []json.RawMessage
	if json.Unmarshal(raw, &list) != nil {
		return []contract.PlannerSchedule{}
	}
	out := make([]contract.PlannerSchedule, 0, len(list))
	for _, it := range list {
		var s map[string]json.RawMessage
		if json.Unmarshal(it, &s) != nil || s == nil {
			continue
		}
		var id, date, tm string
		if !asString(s["id"], &id) || !asString(s["date"], &date) || !asString(s["time"], &tm) {
			continue
		}
		if !IsValidDate(date) || !IsValidTime(tm) {
			continue
		}
		sch := contract.PlannerSchedule{ID: id, Date: date, Time: tm}
		if v, ok := stringField(s["title"]); ok {
			sch.Title = v
		}
		if v, ok := stringField(s["taskId"]); ok {
			sch.TaskID = v
		}
		sch.Repeat = migrateRepeat(s["repeat"])
		if v, ok := stringField(s["until"]); ok && IsValidDate(v) {
			sch.Until = v
		}
		if n, ok := intField(s["leadMinutes"]); ok {
			sch.LeadMinutes = contract.LeadMinutes(n)
		}
		if v, ok := boolField(s["stopWhenTaskDone"]); ok {
			sch.StopWhenTaskDone = v
		}
		if v, ok := boolField(s["paused"]); ok {
			sch.Paused = v
		}
		if n, ok := int64Field(s["snoozeUntil"]); ok {
			sch.SnoozeUntil = &n
		}
		if n, ok := int64Field(s["lastFiredAt"]); ok {
			sch.LastFiredAt = &n
		}
		out = append(out, sch)
		if len(out) >= contract.MaxSchedulesPerBoard {
			break
		}
	}
	return out
}

// migrateRepeat 对应原版对 repeat 字段的处理：migrate 不单独校形 repeat，
// 直接照抄（{...b, schedules: filter(...)}）—— 但 Go 端结构体是判别联合的扁平形式，
// 必须把 kind / days / day 单独还原出来。kind 不合法时回退到 none，免得 PendingFires 走死循环。
func migrateRepeat(raw json.RawMessage) contract.ScheduleRepeat {
	var r map[string]json.RawMessage
	if json.Unmarshal(raw, &r) != nil || r == nil {
		return contract.ScheduleRepeat{Kind: contract.RepeatNone}
	}
	var kind string
	if !asString(r["kind"], &kind) {
		return contract.ScheduleRepeat{Kind: contract.RepeatNone}
	}
	out := contract.ScheduleRepeat{Kind: contract.RepeatKind(kind)}
	switch out.Kind {
	case contract.RepeatWeekly:
		var days []int
		if arr, ok := r["days"]; ok {
			var raw []json.RawMessage
			if json.Unmarshal(arr, &raw) == nil {
				for _, it := range raw {
					if n, ok := intField(it); ok {
						days = append(days, n)
					}
				}
			}
		}
		out.Days = days
	case contract.RepeatMonthly:
		if n, ok := intField(r["day"]); ok {
			out.Day = &n
		}
	}
	return out
}

// migrateMissed 对应原版 missed 过滤：四项（scheduleId / boardId / title / at）必须齐备；
// 最多保留最后 MaxMissed 条（slice(-MAX_MISSED)）。
func migrateMissed(raw json.RawMessage) []contract.MissedReminder {
	var list []json.RawMessage
	if json.Unmarshal(raw, &list) != nil {
		return nil
	}
	out := make([]contract.MissedReminder, 0, len(list))
	for _, it := range list {
		var m map[string]json.RawMessage
		if json.Unmarshal(it, &m) != nil || m == nil {
			continue
		}
		var sid, bid, title string
		var at int64
		if !asString(m["scheduleId"], &sid) || !asString(m["boardId"], &bid) ||
			!asString(m["title"], &title) || !asInt64(m["at"], &at) {
			continue
		}
		out = append(out, contract.MissedReminder{
			ScheduleID: sid, BoardID: bid, Title: title, At: at,
		})
	}
	if len(out) > MaxMissed {
		out = out[len(out)-MaxMissed:]
	}
	return out
}

// ── 校形工具（仅 migrate 用） ──────────────────────────────────────────

// asString 把 JSON 值解成 string 写入 *out；失败返回 false。
// 与原版 typeof v === 'string' 等价：非字符串（含 null / 数字 / 对象）返回 false。
func asString(raw json.RawMessage, out *string) bool {
	if len(raw) == 0 {
		return false
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return false
	}
	*out = s
	return true
}

// asInt64 把 JSON 值解成 int64；非整数返回 false。
// 原版 typeof v === 'number' + 直接当 ms 用；这里要求整数（毫秒时间戳语义上必须是整数）。
func asInt64(raw json.RawMessage, out *int64) bool {
	if len(raw) == 0 {
		return false
	}
	var f float64
	if err := json.Unmarshal(raw, &f); err != nil {
		return false
	}
	if f != float64(int64(f)) {
		return false
	}
	*out = int64(f)
	return true
}

// asInt64Default 字段缺失或不是数字时返回默认值（原版 typeof b.createdAt === 'number' ? ... : Date.now()）。
func asInt64Default(raw json.RawMessage, def int64) int64 {
	var v int64
	if asInt64(raw, &v) {
		return v
	}
	return def
}

// stringField 字段缺失或非字符串时返回 ("", false)；是字符串原样返回（含空串）。
func stringField(raw json.RawMessage) (string, bool) {
	var s string
	if !asString(raw, &s) {
		return "", false
	}
	return s, true
}

// int64Field 字段是整数才返回；其他类型（含 null、字符串、小数）返回 false。
func int64Field(raw json.RawMessage) (int64, bool) {
	var v int64
	if !asInt64(raw, &v) {
		return 0, false
	}
	return v, true
}

// intField 字段是整数且能装进 int 才返回。
func intField(raw json.RawMessage) (int, bool) {
	v, ok := int64Field(raw)
	if !ok {
		return 0, false
	}
	return int(v), true
}

// boolField 字段是布尔才返回。
func boolField(raw json.RawMessage) (bool, bool) {
	if len(raw) == 0 {
		return false, false
	}
	var b bool
	if err := json.Unmarshal(raw, &b); err != nil {
		return false, false
	}
	return b, true
}

// containsTaskStatus 即原版 TASK_STATUSES.includes(status)。
func containsTaskStatus(s contract.PlannerTaskStatus) bool {
	return slices.Contains(contract.TaskStatuses, s)
}

// nowMilli 即原版 Date.now()。包内函数便于测试时注入固定时间。
func nowMilli() int64 {
	return time.Now().UnixMilli()
}
