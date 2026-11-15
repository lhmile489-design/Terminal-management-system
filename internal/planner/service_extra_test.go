// S12 验收卡的硬项单独成测（对拍里也覆盖了，这里写成一眼能看懂的断言）：
// id / 时间戳 / doneAt 全由 Go 生成、只读时抛错不落盘、已知原版问题 I4 / I5 的行为钉住、
// 调度器的启停与 ctx 取消、事件回调里可以重入服务。

package planner

import (
	"context"
	"encoding/json"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"mile-console/internal/contract"
)

func raw(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

func newTestService(t *testing.T, opts Options) (*Service, *fakeConfig, string) {
	t.Helper()
	dir := t.TempDir()
	store, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	cfg := &fakeConfig{cfg: contract.AppConfig{Groups: []contract.ProjectGroup{{ID: "g1", Name: "前端"}}}}
	cfg.cfg.Settings.PlannerNotify = true
	if opts.NewID == nil {
		opts.NewID = idSeq()
	}
	return NewService(store, cfg, opts), cfg, dir
}

// TestServerGeneratedFields：入参里带的 id / order / createdAt / doneAt / lastFiredAt 一律不看。
func TestServerGeneratedFields(t *testing.T) {
	now := int64(1763100000000)
	svc, _, _ := newTestService(t, Options{Wall: func() int64 { return now }})
	b, err := svc.AddBoard(raw("g1"))
	if err != nil {
		t.Fatal(err)
	}
	if b.ID != "id-1" || b.CreatedAt != now || b.Order != 0 {
		t.Errorf("看板字段应由 Go 生成：%+v", b)
	}
	task, err := svc.AddTask(raw(b.ID), raw(map[string]any{
		"title": "x", "status": "done", "id": "mine", "order": 99, "doneAt": 5,
	}))
	if err != nil {
		t.Fatal(err)
	}
	if task.ID != "id-2" || task.Order != 0 || task.DoneAt == nil || *task.DoneAt != now {
		t.Errorf("任务字段应由 Go 生成：%+v", task)
	}
	// 离开「已完成」清空 doneAt，再进入时记新的时刻
	now += 1000
	task, _ = svc.EditTask(raw(b.ID), raw(task.ID), raw(map[string]any{"status": "doing", "doneAt": 7}))
	if task.DoneAt != nil {
		t.Errorf("离开已完成应清空 doneAt：%v", *task.DoneAt)
	}
	task, _ = svc.EditTask(raw(b.ID), raw(task.ID), raw(map[string]any{"status": "done"}))
	if task.DoneAt == nil || *task.DoneAt != now {
		t.Errorf("进入已完成应记此刻：%+v", task.DoneAt)
	}
	sch, err := svc.AddSchedule(raw(b.ID), raw(map[string]any{
		"date": "2026-11-15", "time": "10:00", "id": "mine", "lastFiredAt": 5, "snoozeUntil": 9,
	}))
	if err != nil {
		t.Fatal(err)
	}
	if sch.ID != "id-3" || sch.LastFiredAt != nil || sch.SnoozeUntil != nil {
		t.Errorf("新建日程不应接受 id / lastFiredAt / snoozeUntil：%+v", sch)
	}
}

// TestReadOnlyServiceThrows：两份文件都坏时，每个写操作都抛原版文案，磁盘不变；tick 静默返回。
func TestReadOnlyServiceThrows(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "planner.json", "{broken")
	write(t, dir, "planner.json.bak", "[1]")
	store, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	cfg := &fakeConfig{cfg: contract.AppConfig{Groups: []contract.ProjectGroup{{ID: "g1"}}}}
	changed := 0
	svc := NewService(store, cfg, Options{NewID: idSeq(), OnChanged: func(contract.PlannerSnapshot) { changed++ }})
	if !svc.Snapshot().ReadOnly {
		t.Fatal("前提失败：未进只读")
	}
	_, err = svc.AddBoard(raw("g1"))
	const want = "进度数据文件读不出来，这次运行不会保存改动。请检查 planner.json"
	if err == nil || err.Error() != want {
		t.Fatalf("只读时应抛 %q，得到 %v", want, err)
	}
	if err := svc.ReorderBoards(raw([]string{})); err == nil || err.Error() != want {
		t.Errorf("只读时重排也应抛错：%v", err)
	}
	if err := svc.Tick(); err != nil {
		t.Errorf("只读时 tick 应静默返回：%v", err)
	}
	if changed != 0 {
		t.Errorf("只读时不应广播：%d", changed)
	}
	if read(t, dir, "planner.json") != "{broken" || read(t, dir, "planner.json.bak") != "[1]" {
		t.Error("只读时不应改文件")
	}
}

// TestKnownIssueI4EditScheduleWipesTitle：已知原版问题 I4，见 docs/MIGRATION-PLAN.md。
// 补丁不带 title（「稍后提醒」只发 snoozeUntil、暂停开关只发 paused）时标题被清成空串。修的时候这条测试一起改。
func TestKnownIssueI4EditScheduleWipesTitle(t *testing.T) {
	svc, _, _ := newTestService(t, Options{})
	b, _ := svc.AddBoard(raw("g1"))
	s, _ := svc.AddSchedule(raw(b.ID), raw(map[string]any{"title": "站会", "date": "2026-11-15", "time": "10:00"}))
	got, err := svc.EditSchedule(raw(b.ID), raw(s.ID), raw(map[string]any{"paused": true}))
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "" {
		t.Errorf("已知原版问题 I4：补丁不带 title 时原版把标题清空，Go 应保持一致，得到 %q", got.Title)
	}
}

// TestKnownIssueI5AddScheduleSkipsRange：已知原版问题 I5，见 docs/MIGRATION-PLAN.md。
// 新建重复日程时不查 until 是否早于 date（只有编辑才查），所以能建出永远不会触发的日程。
func TestKnownIssueI5AddScheduleSkipsRange(t *testing.T) {
	svc, _, _ := newTestService(t, Options{})
	b, _ := svc.AddBoard(raw("g1"))
	in := map[string]any{"date": "2026-11-15", "time": "10:00", "repeat": map[string]any{"kind": "daily"}, "until": "2026-11-01"}
	s, err := svc.AddSchedule(raw(b.ID), raw(in))
	if err != nil {
		t.Fatalf("已知原版问题 I5：新建时原版不拦 until 早于 date，得到 %v", err)
	}
	if _, err := svc.EditSchedule(raw(b.ID), raw(s.ID), raw(map[string]any{"title": "x"})); err == nil ||
		err.Error() != "结束日期不能早于开始日期" {
		t.Errorf("编辑时应拦下：%v", err)
	}
}

// TestKnownIssueI6DailyLead1440EveryOtherDay：已知原版问题 I6，见 docs/MIGRATION-PLAN.md。
// 每天重复 + 提前 1440 分钟：上一次的触发时刻恰好等于下一次的提醒时刻，tick 的窗口从 lastFiredAt + 1 开始，
// 把它挡在外面，于是只隔天弹一次。提前 0 分钟的对照每天都弹。修的时候这条测试一起改。
func TestKnownIssueI6DailyLead1440EveryOtherDay(t *testing.T) {
	for _, tc := range []struct {
		lead int
		want int
	}{{0, 5}, {60, 5}, {1440, 3}} {
		start, _ := ScheduleMoment("2026-11-14", "08:00")
		now := start
		fired := 0
		svc, _, _ := newTestService(t, Options{
			Wall:       func() int64 { return now },
			OnReminder: func(contract.ReminderFire) { fired++ },
		})
		b, _ := svc.AddBoard(raw("g1"))
		if _, err := svc.AddSchedule(raw(b.ID), raw(map[string]any{
			"title": "x", "date": "2026-11-16", "time": "09:00",
			"repeat": map[string]any{"kind": "daily"}, "leadMinutes": tc.lead,
		})); err != nil {
			t.Fatal(err)
		}
		for range 24 * 7 { // 一周里每小时查一次
			if err := svc.Tick(); err != nil {
				t.Fatal(err)
			}
			now += 3_600_000
		}
		if fired != tc.want {
			t.Errorf("提前 %d 分钟：原版一周弹 %d 次，Go 弹了 %d 次", tc.lead, tc.want, fired)
		}
	}
}

// TestSchedulerStartStop：StartScheduler 立刻查一次，之后按间隔查；重复启动无效；Dispose 与 ctx 取消都能停。
func TestSchedulerStartStop(t *testing.T) {
	var reads atomic.Int64
	env := map[string]string{"MILE_PLANNER_TICK_MS": "5"}
	svc, cfg, _ := newTestService(t, Options{Dev: true, Getenv: func(k string) string { return env[k] }})
	counting := &countingConfig{inner: cfg, n: &reads}
	svc.config = counting // tick 每轮读一次设置，用它数 tick 次数

	ctx, cancel := context.WithCancel(t.Context())
	svc.StartScheduler(ctx)
	if reads.Load() < 1 {
		t.Fatal("StartScheduler 应立刻查一次")
	}
	svc.StartScheduler(ctx) // 重复启动：不应再起一个
	waitFor(t, func() bool { return reads.Load() >= 5 })
	svc.Dispose()
	time.Sleep(20 * time.Millisecond)
	stopped := reads.Load()
	time.Sleep(30 * time.Millisecond)
	if reads.Load() != stopped {
		t.Errorf("Dispose 后不应再查：%d → %d", stopped, reads.Load())
	}

	// Dispose 之后可以再启动；ctx 取消也能停
	svc.StartScheduler(ctx)
	waitFor(t, func() bool { return reads.Load() >= stopped+3 })
	cancel()
	time.Sleep(20 * time.Millisecond)
	stopped = reads.Load()
	time.Sleep(30 * time.Millisecond)
	if reads.Load() != stopped {
		t.Errorf("ctx 取消后不应再查：%d → %d", stopped, reads.Load())
	}
	svc.Dispose()
}

type countingConfig struct {
	inner ConfigSource
	n     *atomic.Int64
}

func (c *countingConfig) Get() contract.AppConfig {
	c.n.Add(1)
	return c.inner.Get()
}

func waitFor(t *testing.T, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatal("等待超时")
		}
		time.Sleep(time.Millisecond)
	}
}

// TestCallbacksMayReenter：事件在锁外发出，回调里调服务不会死锁；changed 先于 reminder。
func TestCallbacksMayReenter(t *testing.T) {
	now := int64(0)
	var svc *Service
	var order []string
	svc, _, _ = newTestService(t, Options{
		Wall: func() int64 { return now },
		OnChanged: func(contract.PlannerSnapshot) {
			order = append(order, "changed")
			_ = svc.Snapshot()
		},
		OnReminder: func(r contract.ReminderFire) {
			order = append(order, "reminder:"+r.When)
			_ = svc.ClearMissed()
		},
	})
	b, _ := svc.AddBoard(raw("g1"))
	at, _ := ScheduleMoment("2026-11-15", "10:00")
	if _, err := svc.AddSchedule(raw(b.ID), raw(map[string]any{"title": "x", "date": "2026-11-15", "time": "10:00"})); err != nil {
		t.Fatal(err)
	}
	order = nil
	now = at
	done := make(chan error, 1)
	go func() { done <- svc.Tick() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("回调里重入服务死锁了")
	}
	if strings.Join(order, ",") != "changed,reminder:今天 10:00" {
		t.Errorf("事件顺序不对：%v", order)
	}
}
