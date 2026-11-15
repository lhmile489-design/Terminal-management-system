// S12 对拍：internal/planner/schedule.go 与原版 src/shared/planner.ts 的纯函数。
// 用例由 scripts/gen-planner-cases.mjs 跑原版代码生成，期望值全部来自原版，不手写。
// 用例覆盖：isValidDate / isValidTime / localDate / timeOfDay / daysBetween /
// boardProgress / boardStatus / taskDueTone / scheduleMoment / repeatMatches /
// pendingFires（每种重复规则 × 提前量 × 跨日 / 跨周 / 跨月 / 跨年 / 暂停 / until）/ nextFireAt。
//
// 用例的期望值依赖系统本地时区（Asia/Shanghai）：localDate / scheduleMoment / timeOfDay /
// pendingFires 都按本地时区算，所以测试启动前先把 TZ 锁到 Asia/Shanghai，
// 让本测试与生成器在同一时区口径下运行；不影响其他测试，因为时间源只在测试期间改。

package planner

import (
	"encoding/json"
	"os"
	"testing"
	"time"

	"mile-console/internal/contract"
)

// 在 TestMain 里锁定时区：用例的期望值是 Asia/Shanghai 下生成的。
func TestMain(m *testing.M) {
	if loc, err := time.LoadLocation("Asia/Shanghai"); err == nil {
		time.Local = loc
	}
	os.Exit(m.Run())
}

// 与生成器的 caseFile 对齐。
type caseFile struct {
	GeneratedFrom string `json:"generatedFrom"`
	Timezone      string `json:"timezone"`
	Now           int64  `json:"now"`
	Today         string `json:"today"`

	IsValidDate []struct {
		Input  any  `json:"input"`
		Output bool `json:"output"`
	} `json:"isValidDate"`
	IsValidTime []struct {
		Input  any  `json:"input"`
		Output bool `json:"output"`
	} `json:"isValidTime"`
	LocalDate []struct {
		Input  int64  `json:"input"`
		Output string `json:"output"`
	} `json:"localDate"`
	TimeOfDay []struct {
		Input  int64  `json:"input"`
		Output string `json:"output"`
	} `json:"timeOfDay"`
	DaysBetween []struct {
		A      string `json:"a"`
		B      string `json:"b"`
		Output int    `json:"output"`
	} `json:"daysBetween"`
	BoardProgress []struct {
		Input struct {
			Tasks []contract.PlannerTask `json:"tasks"`
		} `json:"input"`
		Output contract.BoardProgress `json:"output"`
	} `json:"boardProgress"`
	BoardStatus []struct {
		Input struct {
			Tasks   []contract.PlannerTask `json:"tasks"`
			EndDate string                 `json:"endDate"`
		} `json:"input"`
		Today  string               `json:"today"`
		Output contract.BoardStatus `json:"output"`
	} `json:"boardStatus"`
	TaskDueTone []struct {
		Input  contract.PlannerTask `json:"input"`
		Today  string               `json:"today"`
		Output *string              `json:"output"`
	} `json:"taskDueTone"`
	ScheduleMoment []struct {
		Date   string   `json:"date"`
		Time   string   `json:"time"`
		Output *float64 `json:"output"` // 原版 NaN 经 JSON.stringify 落为 null，指针判空
	} `json:"scheduleMoment"`
	RepeatMatches []struct {
		Repeat json.RawMessage `json:"repeat"`
		Date   string          `json:"date"`
		Output bool            `json:"output"`
	} `json:"repeatMatches"`
	PendingFires []struct {
		Label    string          `json:"label"`
		Schedule json.RawMessage `json:"schedule"`
		FromMs   int64           `json:"fromMs"`
		ToMs     int64           `json:"toMs"`
		Output   []struct {
			At   int64  `json:"at"`
			Date string `json:"date"`
		} `json:"output"`
	} `json:"pendingFires"`
	NextFireAt []struct {
		Label    string          `json:"label"`
		Schedule json.RawMessage `json:"schedule"`
		Now      int64           `json:"now"`
		Output   *int64          `json:"output"`
	} `json:"nextFireAt"`
}

func loadScheduleCases(t *testing.T) caseFile {
	t.Helper()
	b, err := os.ReadFile("testdata/planner_cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var c caseFile
	if err := json.Unmarshal(b, &c); err != nil {
		t.Fatal(err)
	}
	return c
}

// asJSStr 把生成器写出的 input（可能是 string / null / number）按 JS 语义还原成 Go 参数。
// 原版函数签名是 unknown，Go 函数签名是 string，非字符串输入原版返回 false，Go 也判 false。
// 返回 (str, pass)：pass=false 表示非字符串，等价于 Go 函数应该返回 false。
func asJSStr(t *testing.T, v any) (string, bool) {
	t.Helper()
	if v == nil {
		return "", false
	}
	if s, ok := v.(string); ok {
		if s == "__undefined__" {
			return "", false
		}
		return s, true
	}
	return "", false
}

func TestIsValidDate(t *testing.T) {
	c := loadScheduleCases(t)
	for i, k := range c.IsValidDate {
		s, isStr := asJSStr(t, k.Input)
		got := false
		if isStr {
			got = IsValidDate(s)
		}
		if got != k.Output {
			t.Errorf("#%d input=%v Go %v，原版 %v", i, k.Input, got, k.Output)
		}
	}
	t.Logf("isValidDate %d 条全过", len(c.IsValidDate))
}

func TestIsValidTime(t *testing.T) {
	c := loadScheduleCases(t)
	for i, k := range c.IsValidTime {
		s, isStr := asJSStr(t, k.Input)
		got := false
		if isStr {
			got = IsValidTime(s)
		}
		if got != k.Output {
			t.Errorf("#%d input=%v Go %v，原版 %v", i, k.Input, got, k.Output)
		}
	}
	t.Logf("isValidTime %d 条全过", len(c.IsValidTime))
}

func TestLocalDate(t *testing.T) {
	c := loadScheduleCases(t)
	for i, k := range c.LocalDate {
		if got := LocalDate(k.Input); got != k.Output {
			t.Errorf("#%d input=%v Go %q，原版 %q", i, k.Input, got, k.Output)
		}
	}
	t.Logf("localDate %d 条全过（时区 %s）", len(c.LocalDate), c.Timezone)
}

func TestTimeOfDay(t *testing.T) {
	c := loadScheduleCases(t)
	for i, k := range c.TimeOfDay {
		if got := TimeOfDay(k.Input); got != k.Output {
			t.Errorf("#%d input=%v Go %q，原版 %q", i, k.Input, got, k.Output)
		}
	}
	t.Logf("timeOfDay %d 条全过（时区 %s）", len(c.TimeOfDay), c.Timezone)
}

func TestDaysBetween(t *testing.T) {
	c := loadScheduleCases(t)
	for i, k := range c.DaysBetween {
		if got := DaysBetween(k.A, k.B); got != k.Output {
			t.Errorf("#%d a=%q b=%q Go %v，原版 %v", i, k.A, k.B, got, k.Output)
		}
	}
	t.Logf("daysBetween %d 条全过", len(c.DaysBetween))
}

func TestBoardProgress(t *testing.T) {
	c := loadScheduleCases(t)
	for i, k := range c.BoardProgress {
		got := BoardProgress(k.Input.Tasks)
		if got.Done != k.Output.Done || got.Total != k.Output.Total {
			t.Errorf("#%d Go done=%d total=%d，原版 done=%d total=%d", i, got.Done, got.Total, k.Output.Done, k.Output.Total)
			continue
		}
		if (got.Percent == nil) != (k.Output.Percent == nil) {
			t.Errorf("#%d percent nil 性不同 Go=%v 原版=%v", i, got.Percent, k.Output.Percent)
			continue
		}
		if got.Percent != nil && *got.Percent != *k.Output.Percent {
			t.Errorf("#%d percent Go=%v 原版=%v", i, *got.Percent, *k.Output.Percent)
		}
	}
	t.Logf("boardProgress %d 条全过", len(c.BoardProgress))
}

func TestBoardStatus(t *testing.T) {
	c := loadScheduleCases(t)
	for i, k := range c.BoardStatus {
		board := contract.PlannerBoard{Tasks: k.Input.Tasks, EndDate: k.Input.EndDate}
		got := BoardStatus(board, k.Today)
		if got.Tone != k.Output.Tone || got.Label != k.Output.Label {
			t.Errorf("#%d Go tone=%q label=%q，原版 tone=%q label=%q",
				i, got.Tone, got.Label, k.Output.Tone, k.Output.Label)
			continue
		}
		if (got.DaysLeft == nil) != (k.Output.DaysLeft == nil) {
			t.Errorf("#%d daysLeft nil 性不同", i)
			continue
		}
		if got.DaysLeft != nil && *got.DaysLeft != *k.Output.DaysLeft {
			t.Errorf("#%d daysLeft Go=%v 原版=%v", i, *got.DaysLeft, *k.Output.DaysLeft)
		}
	}
	t.Logf("boardStatus %d 条全过", len(c.BoardStatus))
}

func TestTaskDueTone(t *testing.T) {
	c := loadScheduleCases(t)
	for i, k := range c.TaskDueTone {
		got, ok := TaskDueTone(k.Input, k.Today)
		// 原版返回 TaskDueTone | null：output 为 null 时 Go 应返回 ok=false
		if k.Output == nil {
			if ok {
				t.Errorf("#%d Go 返回 (%v, true)，原版返回 null", i, got)
			}
			continue
		}
		if !ok {
			t.Errorf("#%d Go 返回 ok=false，原版 %q", i, *k.Output)
			continue
		}
		if string(got) != *k.Output {
			t.Errorf("#%d Go=%q 原版=%q", i, got, *k.Output)
		}
	}
	t.Logf("taskDueTone %d 条全过", len(c.TaskDueTone))
}

func TestScheduleMoment(t *testing.T) {
	c := loadScheduleCases(t)
	for i, k := range c.ScheduleMoment {
		got, ok := ScheduleMoment(k.Date, k.Time)
		// 原版返回 NaN（JSON 序列化成 null），Go 返回 ok=false。
		if k.Output == nil {
			if ok {
				t.Errorf("#%d %q %q Go 返回 (%v, true)，原版返回 NaN", i, k.Date, k.Time, got)
			}
			continue
		}
		if !ok {
			t.Errorf("#%d %q %q Go ok=false，原版 %v", i, k.Date, k.Time, *k.Output)
			continue
		}
		if got != int64(*k.Output) {
			t.Errorf("#%d %q %q Go=%v 原版=%v", i, k.Date, k.Time, got, int64(*k.Output))
		}
	}
	t.Logf("scheduleMoment %d 条全过（时区 %s）", len(c.ScheduleMoment), c.Timezone)
}

func TestRepeatMatches(t *testing.T) {
	c := loadScheduleCases(t)
	for i, k := range c.RepeatMatches {
		r := decodeRepeat(t, k.Repeat)
		if got := RepeatMatches(r, k.Date); got != k.Output {
			t.Errorf("#%d repeat=%s date=%s Go=%v 原版=%v", i, k.Repeat, k.Date, got, k.Output)
		}
	}
	t.Logf("repeatMatches %d 条全过", len(c.RepeatMatches))
}

func TestPendingFires(t *testing.T) {
	c := loadScheduleCases(t)
	for i, k := range c.PendingFires {
		s := decodeSchedule(t, k.Schedule)
		got := PendingFires(s, k.FromMs, k.ToMs)
		if len(got) != len(k.Output) {
			t.Errorf("#%d %s Go %d 条，原版 %d 条\n Go   %v\n 原版 %v", i, k.Label, len(got), len(k.Output), got, k.Output)
			continue
		}
		for j, f := range got {
			want := k.Output[j]
			if f.At != want.At || f.Date != want.Date {
				t.Errorf("#%d %s [%d] Go at=%v date=%q，原版 at=%v date=%q",
					i, k.Label, j, f.At, f.Date, want.At, want.Date)
			}
		}
	}
	t.Logf("pendingFires %d 条全过（时区 %s）", len(c.PendingFires), c.Timezone)
}

func TestNextFireAt(t *testing.T) {
	c := loadScheduleCases(t)
	for i, k := range c.NextFireAt {
		s := decodeSchedule(t, k.Schedule)
		got, ok := NextFireAt(s, k.Now)
		if k.Output == nil {
			if ok {
				t.Errorf("#%d %s Go (%v,true)，原版 null", i, k.Label, got)
			}
			continue
		}
		if !ok {
			t.Errorf("#%d %s Go ok=false，原版 %v", i, k.Label, *k.Output)
			continue
		}
		if got != *k.Output {
			t.Errorf("#%d %s Go=%v 原版=%v", i, k.Label, got, *k.Output)
		}
	}
	t.Logf("nextFireAt %d 条全过（时区 %s）", len(c.NextFireAt), c.Timezone)
}

// ── 解码工具：用例 JSON 的 ScheduleRepeat / PlannerSchedule 与 Go 结构体对齐 ──

// decodeRepeat 把生成器里 TS 判别联合的 repeat 解成 Go 的扁平形式。
// 原版 weekly 有 days 字段，monthly 有 day 字段，其他只有 kind。
func decodeRepeat(t *testing.T, raw json.RawMessage) contract.ScheduleRepeat {
	t.Helper()
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("repeat JSON 不是对象：%s", raw)
	}
	var kind string
	if err := json.Unmarshal(m["kind"], &kind); err != nil {
		t.Fatalf("repeat 缺 kind：%s", raw)
	}
	out := contract.ScheduleRepeat{Kind: contract.RepeatKind(kind)}
	if v, ok := m["days"]; ok {
		var days []int
		if err := json.Unmarshal(v, &days); err != nil {
			t.Fatalf("repeat.days 解码失败：%s", raw)
		}
		out.Days = days
	}
	if v, ok := m["day"]; ok {
		var day int
		if err := json.Unmarshal(v, &day); err != nil {
			t.Fatalf("repeat.day 解码失败：%s", raw)
		}
		out.Day = &day
	}
	return out
}

// decodeSchedule 把生成器里 TS 的 PlannerSchedule 解成 Go 结构体。
// TS 的字段是 camelCase + optional，与 contract.PlannerSchedule 直接对齐。
// taskId / until / snoozeUntil / lastFiredAt 在 JSON 里可能是 undefined / null / number。
func decodeSchedule(t *testing.T, raw json.RawMessage) contract.PlannerSchedule {
	t.Helper()
	var s contract.PlannerSchedule
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatalf("schedule JSON 解码失败：%s\n%s", err, raw)
	}
	// repeat 单独解，因为 TS 判别联合与 Go 扁平结构字段不一样（days / day 可选）。
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil {
		t.Fatal(err)
	}
	if v, ok := top["repeat"]; ok {
		s.Repeat = decodeRepeat(t, v)
	}
	return s
}
