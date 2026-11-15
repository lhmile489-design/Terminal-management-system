// S12 存储层测试：planner.json 的启动组合、原子写顺序、.bak 轮转、.corrupt 旁存、只读保护。
// 一律用 t.TempDir()，不碰真实 %APPDATA%。
//
// 与 ConfigStore 的差异（按原版 PlannerService 的真实语义搬）：
//   - 只读时 Patch 抛错（原版 commit 主动 throw），不像 config 的 C2 静默丢；
//   - 数据 migrate 只做校形（无版本分支），手改坏的元素丢掉；
//   - 文件名 planner.json / .bak / .corrupt 与 config 同规则但不同文件。

package planner

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"mile-console/internal/contract"
)

// 一份合法的 planner.json 内容。
const goodPlannerJSON = `{
  "version": 1,
  "boards": [
    {
      "id": "b1",
      "groupId": "g1",
      "createdAt": 1700000000000,
      "order": 0,
      "tasks": [{"id": "t1", "title": "t", "status": "todo", "order": 0}],
      "schedules": []
    }
  ]
}`

// write 把 body 写到 dir/name。body 为 nil 时不写。
func write(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func read(t *testing.T, dir, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// filesInDir 列出目录里所有文件名。
func filesInDir(t *testing.T, dir string) []string {
	t.Helper()
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	out := make([]string, 0, len(ents))
	for _, e := range ents {
		out = append(out, e.Name())
	}
	return out
}

// TestBootPrimaryGood：主文件可读时直接用，不动备份。
func TestBootPrimaryGood(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "planner.json", goodPlannerJSON)
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if s.IsReadOnly() {
		t.Error("主文件可读时不应进只读")
	}
	if got := s.Get().Boards; len(got) != 1 || got[0].ID != "b1" {
		t.Errorf("应读出 1 个看板：%+v", got)
	}
	// 主文件可读时不应有 .bak / .corrupt / .tmp 残留
	for _, n := range filesInDir(t, dir) {
		if n != "planner.json" {
			t.Errorf("不应有多余文件：%s", n)
		}
	}
}

// TestBootEmpty：完全空目录（首次运行），读到空看板集，不进只读。
func TestBootEmpty(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if s.IsReadOnly() {
		t.Error("空目录不应进只读")
	}
	if got := s.Get(); got.Version != contract.PlannerVersion || len(got.Boards) != 0 {
		t.Errorf("应是空数据：%+v", got)
	}
	// 首次 Open 不应落盘（原版 boot 不写文件）
	if names := filesInDir(t, dir); len(names) != 0 {
		t.Errorf("首次启动不应落盘：%v", names)
	}
}

// TestBootRecoverFromBak：主文件坏 + .bak 好 → 用 .bak 恢复，坏主文件挪 .corrupt，
// 这一次写回主文件时跳过「备份当前主文件」（否则坏文件会覆盖 .bak）。
func TestBootRecoverFromBak(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "planner.json", "{broken")
	write(t, dir, "planner.json.bak", goodPlannerJSON)
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if s.IsReadOnly() {
		t.Error("有可用 .bak 不应进只读")
	}
	if got := s.Get().Boards; len(got) != 1 || got[0].ID != "b1" {
		t.Errorf("应从 .bak 恢复：%+v", got)
	}
	// .bak 内容必须保持原样 —— 不能被坏主文件覆盖
	if got := read(t, dir, "planner.json.bak"); got != goodPlannerJSON {
		t.Errorf(".bak 被改：%q", got)
	}
	// 坏主文件挪到了 .corrupt
	if got := read(t, dir, "planner.json.corrupt"); got != "{broken" {
		t.Errorf(".corrupt 应是坏主文件：%q", got)
	}
	// 主文件已被 .bak 内容写回
	if !strings.Contains(read(t, dir, "planner.json"), `"b1"`) {
		t.Error("主文件应写回 .bak 的内容")
	}
}

// TestBootMissingPrimaryGoodBak：主文件不存在 + .bak 好 → 恢复并写回主文件。
func TestBootMissingPrimaryGoodBak(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "planner.json.bak", goodPlannerJSON)
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if s.IsReadOnly() {
		t.Error("只缺主文件不应进只读（.bak 是好的）")
	}
	if got := s.Get().Boards; len(got) != 1 {
		t.Errorf("应从 .bak 恢复：%+v", got)
	}
	if !strings.Contains(read(t, dir, "planner.json"), `"b1"`) {
		t.Error("主文件应写回 .bak 内容")
	}
}

// TestBootBothBroken：主文件坏 + .bak 坏 → 进只读，数据为空，不覆盖任何文件。
func TestBootBothBroken(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "planner.json", "{broken")
	write(t, dir, "planner.json.bak", "[1]")
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !s.IsReadOnly() {
		t.Error("两份都坏应进只读")
	}
	if len(s.Get().Boards) != 0 {
		t.Error("只读时数据应为空集")
	}
	// 不应挪出 .corrupt，不应改文件
	if read(t, dir, "planner.json") != "{broken" || read(t, dir, "planner.json.bak") != "[1]" {
		t.Error("只读时不应改文件")
	}
	for _, n := range filesInDir(t, dir) {
		if n != "planner.json" && n != "planner.json.bak" {
			t.Errorf("不应有额外文件：%s", n)
		}
	}
}

// TestReadOnlyPatchThrows：只读时 Patch 抛错（与原版 commit 的 throw 一致），
// 与 ConfigStore 的 C2 静默丢写入不同。
func TestReadOnlyPatchThrows(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "planner.json", "{broken")
	write(t, dir, "planner.json.bak", "[1]")
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !s.IsReadOnly() {
		t.Fatal("前提失败：未进只读")
	}
	_, err = s.Patch(func(d *contract.PlannerData) {
		d.Boards = append(d.Boards, contract.PlannerBoard{ID: "x", GroupID: "g"})
	})
	if err == nil {
		t.Fatal("只读时 Patch 应抛错")
	}
	if !strings.Contains(err.Error(), "planner.json") {
		t.Errorf("错误文案应提到 planner.json：%v", err)
	}
	// 报错后磁盘不应有变化
	if read(t, dir, "planner.json") != "{broken" || read(t, dir, "planner.json.bak") != "[1]" {
		t.Error("报错后不应落盘")
	}
}

// TestPatchWritesAtomically：写入顺序——.bak 是写入前的主文件，主文件是新内容。
// 不留 .tmp 残留；JSON 两空格缩进、UTF-8 无 BOM、末尾无换行。
func TestPatchWritesAtomically(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Patch(func(d *contract.PlannerData) {
		d.Boards = append(d.Boards, contract.PlannerBoard{
			ID: "b1", GroupID: "g1", CreatedAt: 1700000000000,
			Tasks:     []contract.PlannerTask{},
			Schedules: []contract.PlannerSchedule{},
		})
	}); err != nil {
		t.Fatal(err)
	}
	before := read(t, dir, "planner.json")
	if _, err := s.Patch(func(d *contract.PlannerData) {
		d.Boards = append(d.Boards, contract.PlannerBoard{
			ID: "b2", GroupID: "g2", CreatedAt: 1700000000001,
			Tasks:     []contract.PlannerTask{},
			Schedules: []contract.PlannerSchedule{},
		})
	}); err != nil {
		t.Fatal(err)
	}
	bak := read(t, dir, "planner.json.bak")
	main := read(t, dir, "planner.json")
	if bak != before {
		t.Error(".bak 应是上一次写入的主文件内容")
	}
	if !strings.Contains(main, `"b2"`) || strings.Contains(bak, `"b2"`) {
		t.Error("新条目应只在主文件里")
	}
	// 格式：无 BOM、两空格缩进、末尾无换行
	if strings.HasPrefix(main, "\xef\xbb\xbf") || !strings.HasPrefix(main, "{\n  \"version\": 1,") || strings.HasSuffix(main, "\n") {
		t.Errorf("格式不对：%q", main[:60])
	}
	// 不留 .tmp
	for _, n := range filesInDir(t, dir) {
		if strings.HasSuffix(n, ".tmp") {
			t.Errorf("不应有 .tmp 残留：%s", n)
		}
	}
}

// TestPatchCacheUpdatedBeforePersistFail：persist 失败时缓存已被替换（与原版 this.data = next 在 persist 之前一致）。
// 用一个占位的「目录」阻止写入，让 persist 失败。
func TestPatchCacheUpdatedBeforePersistFail(t *testing.T) {
	dir := t.TempDir()
	// 用一个文件占住目录位置，MkdirAll 会失败
	blocked := filepath.Join(dir, "blocked")
	write(t, dir, "blocked", "")
	s := &Store{
		dir:     blocked, // dir 是一个文件，MkdirAll(blocked) 会报 "not a directory"
		file:    filepath.Join(blocked, "planner.json"),
		backup:  filepath.Join(blocked, "planner.json.bak"),
		corrupt: filepath.Join(blocked, "planner.json.corrupt"),
	}
	// 不走 Open（Open 会读 dir 下的文件），手动塞一份缓存
	s.cache = contract.PlannerData{Version: contract.PlannerVersion, Boards: []contract.PlannerBoard{}}
	next, err := s.Patch(func(d *contract.PlannerData) {
		d.Boards = append(d.Boards, contract.PlannerBoard{ID: "b1", GroupID: "g1"})
	})
	if err == nil {
		t.Fatal("persist 应失败")
	}
	// 与原版一致：data = next 在 persist 之前，缓存已经换上
	if len(next.Boards) != 1 || next.Boards[0].ID != "b1" {
		t.Errorf("缓存应已更新：%+v", next.Boards)
	}
	if len(s.Get().Boards) != 1 {
		t.Error("缓存里的数据应已被替换")
	}
}

// TestMigrateDropsMalformedBoards：手改坏的板子整条丢（缺 id / groupId / 非对象）；
// 合法板子的非法 startDate / endDate 置空（不整条丢）。
func TestMigrateDropsMalformedBoards(t *testing.T) {
	raw := `{
  "version": 1,
  "boards": [
    {"id": "b1", "groupId": "g1", "createdAt": 1, "order": 5, "tasks": [], "schedules": []},
    {"id": "b2", "tasks": [], "schedules": []},
    {"groupId": "g1", "tasks": [], "schedules": []},
    "x",
    5,
    null,
    [],
    {"id": "b3", "groupId": "g3", "startDate": "bad", "endDate": "2026-02-30", "note": "n", "createdAt": 3, "order": 99, "tasks": [], "schedules": []}
  ]
}`
	writeJSON := func(dir string) *Store {
		write(t, dir, "planner.json", raw)
		s, err := Open(dir)
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	s := writeJSON(t.TempDir())
	got := s.Get().Boards
	if len(got) != 2 {
		t.Fatalf("应剩 2 个看板：%+v", got)
	}
	if got[0].ID != "b1" || got[0].Order != 0 {
		t.Errorf("第一个板子应是 b1 且 order 重编为 0：%+v", got[0])
	}
	if got[1].ID != "b3" || got[1].Order != 1 {
		t.Errorf("第二个板子应是 b3 且 order 重编为 1：%+v", got[1])
	}
	if got[1].StartDate != "" || got[1].EndDate != "" {
		t.Errorf("非法 startDate / endDate 应置空：%+v", got[1])
	}
	if got[1].Note != "n" {
		t.Errorf("note 应保留：%+v", got[1])
	}
}

// TestMigrateDropsMalformedTasks：缺字段或非白名单 status 的任务丢掉；
// 合法任务的可选字段（startDate / dueDate / note / doneAt）保留。
func TestMigrateDropsMalformedTasks(t *testing.T) {
	raw := `{
  "version": 1,
  "boards": [{
    "id": "b1", "groupId": "g1", "createdAt": 1, "order": 0,
    "tasks": [
      {"id": "t1", "title": "x", "status": "todo", "startDate": "2026-11-14", "dueDate": "2026-11-15", "note": "n", "doneAt": 1700000000000, "order": 7},
      {"id": "t2", "title": "y", "status": "doing", "order": 0},
      {"id": "t3", "status": "todo"},
      {"title": "no id", "status": "todo"},
      {"id": "t5", "title": "y", "status": "bogus"},
      "x",
      null
    ],
    "schedules": []
  }]
}`
	dir := t.TempDir()
	write(t, dir, "planner.json", raw)
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	tasks := s.Get().Boards[0].Tasks
	if len(tasks) != 2 {
		t.Fatalf("应剩 2 个任务：%+v", tasks)
	}
	if tasks[0].ID != "t1" || tasks[0].Order != 0 || tasks[0].StartDate != "2026-11-14" || *tasks[0].DoneAt != 1700000000000 {
		t.Errorf("第一个任务字段不对：%+v", tasks[0])
	}
	if tasks[1].ID != "t2" || tasks[1].Order != 1 || tasks[1].Status != contract.TaskDoing {
		t.Errorf("第二个任务字段不对：%+v", tasks[1])
	}
}

// TestMigrateDropsMalformedSchedules：缺 id / 非法 date / 非法 time 的日程丢掉；合法的保留全部字段。
func TestMigrateDropsMalformedSchedules(t *testing.T) {
	raw := `{
  "version": 1,
  "boards": [{
    "id": "b1", "groupId": "g1", "createdAt": 1, "order": 0, "tasks": [],
    "schedules": [
      {"id": "s1", "title": "x", "date": "2026-11-14", "time": "15:00", "repeat": {"kind": "daily"}, "leadMinutes": 30, "stopWhenTaskDone": false, "paused": false, "snoozeUntil": 1700000000000, "lastFiredAt": 1700000001000},
      {"id": "s2", "date": "bad", "time": "15:00"},
      {"id": "s3", "date": "2026-11-14", "time": "bad"},
      {"date": "2026-11-14", "time": "15:00"},
      {"id": "s5", "title": "y", "taskId": "t1", "date": "2026-11-14", "time": "15:00", "repeat": {"kind": "weekly", "days": [1, 3]}, "until": "2026-12-31"},
      "x"
    ]
  }]
}`
	dir := t.TempDir()
	write(t, dir, "planner.json", raw)
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	schs := s.Get().Boards[0].Schedules
	if len(schs) != 2 {
		t.Fatalf("应剩 2 条日程：%+v", schs)
	}
	if schs[0].ID != "s1" || schs[0].LeadMinutes != 30 || *schs[0].SnoozeUntil != 1700000000000 {
		t.Errorf("第一条日程字段不对：%+v", schs[0])
	}
	if schs[1].ID != "s5" || schs[1].TaskID != "t1" || schs[1].Until != "2026-12-31" {
		t.Errorf("第二条日程字段不对：%+v", schs[1])
	}
	if schs[1].Repeat.Kind != contract.RepeatWeekly || len(schs[1].Repeat.Days) != 2 {
		t.Errorf("第二条日程 repeat 不对：%+v", schs[1].Repeat)
	}
}

// TestMigrateMissedSlice：missed 数组逐条过滤（缺字段丢），最多保留最后 200 条。
func TestMigrateMissedSlice(t *testing.T) {
	dir := t.TempDir()
	// 构造 250 条合法 + 几条坏的
	var sb strings.Builder
	sb.WriteString(`{"version":1,"boards":[],"missed":[`)
	for i := range 250 {
		if i > 0 {
			sb.WriteString(",")
		}
		sb.WriteString(`{"scheduleId":"s","boardId":"b","title":"x","at":`)
		sb.WriteString(itoa(int64(i)))
		sb.WriteString(`}`)
	}
	sb.WriteString(`,{"scheduleId":"s","boardId":"b"},{"scheduleId":"s","boardId":"b","title":"x","at":"bad"},null,{"scheduleId":"s","boardId":"b","title":"x","at":9999}`)
	sb.WriteString(`]}`)
	write(t, dir, "planner.json", sb.String())
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	missed := s.Get().Missed
	if len(missed) != MaxMissed {
		t.Fatalf("missed 应截到 %d 条：%d", MaxMissed, len(missed))
	}
	// slice(-MAX_MISSED)：原数组共 251 条合法（前 250 + 末尾 at=9999），
	// 取最后 200 条 → 下标 51..250，即 at=51..249 + at=9999。
	if missed[0].At != 51 {
		t.Errorf("第一条应是 at=51（最后 200 条的起点）：%v", missed[0].At)
	}
	if missed[len(missed)-1].At != 9999 {
		t.Errorf("最后一条应是补上的合法 at=9999：%v", missed[len(missed)-1].At)
	}
}

// TestSnapshotMissedAlwaysArray：snapshot 里 missed 总是数组（不为 nil），与原版的 `?? []` 一致。
func TestSnapshotMissedAlwaysArray(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	snap := s.Snapshot()
	if snap.Missed == nil {
		t.Error("snapshot.missed 应为空数组而非 nil")
	}
	if len(snap.Missed) != 0 {
		t.Error("missed 应为空")
	}
	// JSON 输出应为 [] 而非 null
	b, _ := json.Marshal(snap)
	if !strings.Contains(string(b), `"missed":[]`) {
		t.Errorf("snapshot JSON 应含 missed:[]：%s", b)
	}
}

// TestPersistSkippedOnBootEmpty：首次启动 Open 不写文件（原版 boot 只在恢复路径写）。
func TestPersistSkippedOnBootEmpty(t *testing.T) {
	dir := t.TempDir()
	if _, err := Open(dir); err != nil {
		t.Fatal(err)
	}
	if names := filesInDir(t, dir); len(names) != 0 {
		t.Errorf("首次 Open 不应落盘：%v", names)
	}
}

// TestGetReturnsCopy：Get 返回深拷贝，改返回值不影响缓存。
func TestGetReturnsCopy(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Patch(func(d *contract.PlannerData) {
		d.Boards = []contract.PlannerBoard{{
			ID: "b1", GroupID: "g1",
			Tasks: []contract.PlannerTask{{ID: "t1", Title: "t", Status: contract.TaskTodo}},
		}}
	}); err != nil {
		t.Fatal(err)
	}
	got := s.Get()
	got.Boards[0].Tasks[0].Title = "changed"
	got.Boards[0].Tasks = append(got.Boards[0].Tasks, contract.PlannerTask{ID: "x"})
	again := s.Get()
	if len(again.Boards) != 1 || len(again.Boards[0].Tasks) != 1 || again.Boards[0].Tasks[0].Title != "t" {
		t.Errorf("Get 返回的不是副本：%+v", again.Boards)
	}
}

// ── 工具 ──────────────────────────────────────────────────────────────

func itoa(n int64) string {
	return strings.TrimSpace(jsonNumber(n))
}

func jsonNumber(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}

// TestScheduleMomentNilHandling：原版的 scheduleMoment 返回 NaN，Go 返回 (0, false)，
// 但调用方在 pendingFires / migrate 里要看清楚「非法输入」这条分支。这里固定语义。
func TestScheduleMomentInvalid(t *testing.T) {
	if _, ok := ScheduleMoment("bad", "10:00"); ok {
		t.Error("非法日期应 ok=false")
	}
	if _, ok := ScheduleMoment("2026-02-30", "10:00"); ok {
		t.Error("2 月 30 日应 ok=false")
	}
	if _, ok := ScheduleMoment("2026-11-14", "bad"); ok {
		t.Error("非法时刻应 ok=false")
	}
}

// TestPendingFiresPausedNil：暂停的日程 pendingFires 返回空集，对应原版的 `return []`。
// nil 与空切片在 len() 上一致，但 Go 返回 nil 是更准确的表达。
func TestPendingFiresPausedNil(t *testing.T) {
	s := contract.PlannerSchedule{
		ID: "s", Date: "2026-11-14", Time: "15:00", Paused: true,
		Repeat: contract.ScheduleRepeat{Kind: contract.RepeatNone},
	}
	if out := PendingFires(s, 0, 9_000_000_000_000); len(out) != 0 {
		t.Errorf("paused 应返回空集：%v", out)
	}
}

// TestJSONRoundTrip：写入的 JSON 再读回应与内存数据一致（含 missed=[] 的写法）。
func TestJSONRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	snooze, lastFired := int64(1700000000000), int64(1700000001000)
	want := contract.PlannerData{
		Version: contract.PlannerVersion,
		Boards: []contract.PlannerBoard{{
			ID: "b1", GroupID: "g1", CreatedAt: 1700000000000, Order: 0,
			StartDate: "2026-11-01", EndDate: "2026-12-31",
			Tasks: []contract.PlannerTask{{
				ID: "t1", Title: "x", Status: contract.TaskDoing,
				StartDate: "2026-11-01", DueDate: "2026-12-01", Note: "n",
			}},
			Schedules: []contract.PlannerSchedule{{
				ID: "s1", Title: "x", Date: "2026-11-14", Time: "15:00",
				Repeat:           contract.ScheduleRepeat{Kind: contract.RepeatWeekly, Days: []int{1, 3}},
				Until:            "2026-12-31",
				LeadMinutes:      15,
				StopWhenTaskDone: true,
				SnoozeUntil:      &snooze,
				LastFiredAt:      &lastFired,
			}},
		}},
		Missed: []contract.MissedReminder{{ScheduleID: "s1", BoardID: "b1", Title: "x", At: 1700000000000}},
	}
	if _, err := s.Patch(func(d *contract.PlannerData) { *d = want }); err != nil {
		t.Fatal(err)
	}
	got := s.Get()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("读回的数据不同\n Go   %+v\n 写入 %+v", got, want)
	}
	// 重启后读到的应相同
	s2, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got := s2.Get(); !reflect.DeepEqual(got, want) {
		t.Errorf("重启后读回的数据不同\n Go   %+v\n 写入 %+v", got, want)
	}
}
