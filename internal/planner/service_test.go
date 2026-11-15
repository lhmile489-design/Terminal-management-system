// S12 服务层对拍：internal/planner 的 Service 与原版 src/main/services/PlannerService.ts。
// 用例由 scripts/gen-planner-service-cases.mjs 跑原版服务生成（期望值全部来自原版，不手写）：
// 同一份初始 planner.json、工作组、时钟、操作序列，两边逐步比对返回值或错误文案、
// 执行后的快照、changed 事件次数、reminder 事件内容，最后比对磁盘上的 planner.json 与 .bak。
//
// id 两边都用可预测的 id-1、id-2……（原版换了 node:crypto 桩，这里注入 NewID）。

package planner

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"mile-console/internal/contract"
)

type serviceCaseFile struct {
	Timezone string        `json:"timezone"`
	Cases    []serviceCase `json:"cases"`
	Dev      []devCase     `json:"dev"`
}

type serviceCase struct {
	Name       string                  `json:"name"`
	File       *string                 `json:"file"`
	Backup     *string                 `json:"backup"`
	Clock      int64                   `json:"clock"`
	Lite       bool                    `json:"lite"`
	Groups     []contract.ProjectGroup `json:"groups"`
	Notify     bool                    `json:"notify"`
	Steps      []serviceStep           `json:"steps"`
	Disk       *string                 `json:"disk"`
	DiskBackup *string                 `json:"diskBackup"`
}

type serviceStep struct {
	// 三类控制步：拨钟、换工作组、开关通知
	Clock  *int64                  `json:"clock"`
	Groups []contract.ProjectGroup `json:"groups"`
	Notify *bool                   `json:"notify"`

	Op        string            `json:"op"`
	Args      []json.RawMessage `json:"args"`
	Result    json.RawMessage   `json:"result"`
	Error     *string           `json:"error"`
	Snapshot  json.RawMessage   `json:"snapshot"`
	Changed   int               `json:"changed"`
	Reminders json.RawMessage   `json:"reminders"`
}

type devCase struct {
	Packaged  bool    `json:"packaged"`
	Tick      *string `json:"tick"`
	Now       *string `json:"now"`
	Legacy    bool    `json:"legacy"`
	Wall      int64   `json:"wall"`
	TickMs    float64 `json:"tickMs"`
	NowResult float64 `json:"nowResult"`
}

func loadServiceCases(t *testing.T) serviceCaseFile {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "planner_service_cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f serviceCaseFile
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	if f.Timezone != "Asia/Shanghai" {
		t.Fatalf("用例在 %s 生成，与 TestMain 锁定的 Asia/Shanghai 不同", f.Timezone)
	}
	return f
}

// fakeConfig 即生成器里的 ConfigStore 桩：只有 get()。
type fakeConfig struct{ cfg contract.AppConfig }

func (c *fakeConfig) Get() contract.AppConfig { return c.cfg }

// idSeq 与 platform-stub-crypto.mjs 同一口径：id-1、id-2……
func idSeq() func() string {
	n := 0
	return func() string {
		n++
		return fmt.Sprintf("id-%d", n)
	}
}

// call 把一步操作分派到 Service 方法，返回值统一序列化成 JSON（void 方法返回 null）。
func call(s *Service, op string, a []json.RawMessage) (any, error) {
	arg := func(i int) json.RawMessage {
		if i < len(a) {
			return a[i]
		}
		return nil // 原版少传的参数是 undefined
	}
	switch op {
	case "snapshot":
		return s.Snapshot(), nil
	case "addBoard":
		return s.AddBoard(arg(0))
	case "editBoard":
		return s.EditBoard(arg(0), arg(1))
	case "reassignBoard":
		return s.ReassignBoard(arg(0), arg(1))
	case "removeBoard":
		return nil, s.RemoveBoard(arg(0))
	case "reorderBoards":
		return nil, s.ReorderBoards(arg(0))
	case "addTask":
		return s.AddTask(arg(0), arg(1))
	case "editTask":
		return s.EditTask(arg(0), arg(1), arg(2))
	case "removeTask":
		return nil, s.RemoveTask(arg(0), arg(1))
	case "reorderTasks":
		return nil, s.ReorderTasks(arg(0), arg(1))
	case "addSchedule":
		return s.AddSchedule(arg(0), arg(1))
	case "editSchedule":
		return s.EditSchedule(arg(0), arg(1), arg(2))
	case "removeSchedule":
		return nil, s.RemoveSchedule(arg(0), arg(1))
	case "completeScheduleTask":
		return nil, s.CompleteScheduleTask(arg(0), arg(1))
	case "dismissMissed":
		return nil, s.DismissMissed(arg(0), arg(1), arg(2))
	case "clearMissed":
		return nil, s.ClearMissed()
	case "pauseSchedulesOfGroup":
		var gid string
		_ = json.Unmarshal(arg(0), &gid)
		return s.PauseSchedulesOfGroup(gid)
	case "tick":
		return nil, s.Tick()
	}
	panic("未知操作 " + op)
}

// jsonEqual 按 JSON 语义比较（键顺序无关）。
//
// 唯一的放宽：原版 snoozeUntil 可以存小数毫秒，Go 存 ceil 后的整数（MIGRATION-PLAN §6「snoozeUntil 小数」）。
// 比较前把原版的 snoozeUntil 也 ceil 一下，其余字段一律严格相等。
func jsonEqual(t *testing.T, got any, want json.RawMessage) (bool, string) {
	t.Helper()
	g, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var a, b any
	_ = json.Unmarshal(g, &a)
	if len(want) == 0 {
		want = json.RawMessage("null")
	}
	_ = json.Unmarshal(want, &b)
	ceilSnooze(b)
	return reflect.DeepEqual(a, b), string(g)
}

func ceilSnooze(v any) {
	switch x := v.(type) {
	case map[string]any:
		for k, e := range x {
			if f, ok := e.(float64); ok && k == "snoozeUntil" {
				x[k] = math.Ceil(f)
				continue
			}
			ceilSnooze(e)
		}
	case []any:
		for _, e := range x {
			ceilSnooze(e)
		}
	}
}

func TestServiceMatchesOriginal(t *testing.T) {
	f := loadServiceCases(t)
	if len(f.Cases) < 18 {
		t.Fatalf("用例太少：%d", len(f.Cases))
	}
	ops := map[string]int{}
	for _, sc := range f.Cases {
		for _, st := range sc.Steps {
			if st.Op != "" {
				ops[st.Op]++
			}
		}
	}
	for _, sc := range f.Cases {
		t.Run(sc.Name, func(t *testing.T) {
			dir := t.TempDir()
			if sc.File != nil {
				write(t, dir, "planner.json", *sc.File)
			}
			if sc.Backup != nil {
				write(t, dir, "planner.json.bak", *sc.Backup)
			}
			clock := sc.Clock
			cfg := &fakeConfig{cfg: contract.AppConfig{Groups: sc.Groups}}
			cfg.cfg.Settings.PlannerNotify = sc.Notify
			store, err := Open(dir)
			if err != nil {
				t.Fatal(err)
			}
			changed := 0
			var reminders []contract.ReminderFire
			svc := NewService(store, cfg, Options{
				Wall:       func() int64 { return clock },
				NewID:      idSeq(),
				OnChanged:  func(contract.PlannerSnapshot) { changed++ },
				OnReminder: func(r contract.ReminderFire) { reminders = append(reminders, r) },
			})

			for i, st := range sc.Steps {
				switch {
				case st.Clock != nil:
					clock = *st.Clock
					continue
				case st.Groups != nil:
					cfg.cfg.Groups = st.Groups
					continue
				case st.Notify != nil:
					cfg.cfg.Settings.PlannerNotify = *st.Notify
					continue
				}
				changed, reminders = 0, nil
				where := fmt.Sprintf("第 %d 步 %s(%s)", i, st.Op, joinArgs(st.Args))
				res, err := call(svc, st.Op, st.Args)

				if st.Error != nil {
					if err == nil || err.Error() != *st.Error {
						t.Fatalf("%s：原版抛错 %q，Go 得到 %v", where, *st.Error, err)
					}
				} else {
					if err != nil {
						t.Fatalf("%s：原版成功，Go 报错 %v", where, err)
					}
					if sc.Lite && res != nil {
						res = liteResult(res)
					}
					if ok, got := jsonEqual(t, res, st.Result); !ok {
						t.Fatalf("%s 返回值不同\n Go   %s\n 原版 %s", where, got, st.Result)
					}
				}
				if len(st.Snapshot) > 0 {
					if ok, got := jsonEqual(t, svc.Snapshot(), st.Snapshot); !ok {
						t.Fatalf("%s 快照不同\n Go   %s\n 原版 %s", where, got, st.Snapshot)
					}
				}
				if changed != st.Changed {
					t.Fatalf("%s：changed 事件原版 %d 次，Go %d 次", where, st.Changed, changed)
				}
				if reminders == nil {
					reminders = []contract.ReminderFire{}
				}
				if ok, got := jsonEqual(t, reminders, st.Reminders); !ok {
					t.Fatalf("%s 提醒不同\n Go   %s\n 原版 %s", where, got, st.Reminders)
				}
			}

			// 磁盘：主文件按 JSON 语义比较（键顺序随结构体），坏文件与 .bak 原文比较
			checkDisk(t, dir, "planner.json", sc.Disk)
			if sc.Name == "read-only" {
				checkDisk(t, dir, "planner.json.bak", sc.DiskBackup)
			}
		})
	}
	for _, op := range []string{"addBoard", "editBoard", "reassignBoard", "removeBoard", "reorderBoards",
		"addTask", "editTask", "removeTask", "reorderTasks", "addSchedule", "editSchedule", "removeSchedule",
		"completeScheduleTask", "dismissMissed", "clearMissed", "pauseSchedulesOfGroup", "tick"} {
		if ops[op] == 0 {
			t.Errorf("没有用例覆盖 %s", op)
		}
	}
}

func liteResult(res any) any {
	b, _ := json.Marshal(res)
	var m map[string]any
	if json.Unmarshal(b, &m) != nil {
		return res
	}
	return map[string]any{"id": m["id"]}
}

func joinArgs(a []json.RawMessage) string {
	parts := make([]string, len(a))
	for i, x := range a {
		s := string(x)
		if len(s) > 60 {
			s = s[:60] + "..."
		}
		parts[i] = s
	}
	return strings.Join(parts, ", ")
}

func checkDisk(t *testing.T, dir, name string, want *string) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, name))
	if want == nil {
		if err == nil {
			t.Errorf("%s：原版没写这个文件，Go 写了", name)
		}
		return
	}
	if err != nil {
		t.Errorf("%s：原版有这个文件，Go 没有", name)
		return
	}
	var a, w any
	if json.Unmarshal(b, &a) != nil || json.Unmarshal([]byte(*want), &w) != nil {
		if string(b) != *want {
			t.Errorf("%s 原文不同\n Go   %q\n 原版 %q", name, b, *want)
		}
		return
	}
	if !reflect.DeepEqual(a, w) {
		t.Errorf("%s 内容不同\n Go   %s\n 原版 %s", name, b, *want)
	}
}

// TestDevOverridesMatchOriginal：MILE_PLANNER_TICK_MS / MILE_PLANNER_NOW 的解析与原版一致，
// 打包后（Dev=false）两个变量都不生效。legacy 是 V8 的非标准日期写法，Go 只认 ISO 8601，期望 NaN 回落到墙钟。
func TestDevOverridesMatchOriginal(t *testing.T) {
	f := loadServiceCases(t)
	if len(f.Dev) < 40 {
		t.Fatalf("开发钩子用例太少：%d", len(f.Dev))
	}
	for _, c := range f.Dev {
		env := map[string]string{}
		if c.Tick != nil {
			env["MILE_PLANNER_TICK_MS"] = *c.Tick
		}
		if c.Now != nil {
			env["MILE_PLANNER_NOW"] = *c.Now
		}
		svc := NewService(nil, nil, Options{
			Dev:    !c.Packaged,
			Getenv: func(k string) string { return env[k] },
			Wall:   func() int64 { return c.Wall },
		})
		label := fmt.Sprintf("packaged=%v tick=%v now=%v", c.Packaged, deref(c.Tick), deref(c.Now))
		if svc.TickMs() != c.TickMs {
			t.Errorf("%s：间隔原版 %v，Go %v", label, c.TickMs, svc.TickMs())
		}
		want := c.NowResult
		if c.Legacy {
			want = float64(c.Wall)
		} else {
			want = math.Floor(want)
		}
		if got := float64(svc.Now()); got != want {
			t.Errorf("%s：now 原版 %v（legacy=%v），Go %v", label, c.NowResult, c.Legacy, got)
		}
	}
}

func deref(p *string) string {
	if p == nil {
		return "<unset>"
	}
	return fmt.Sprintf("%q", *p)
}
