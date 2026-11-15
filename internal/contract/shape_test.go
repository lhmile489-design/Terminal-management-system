// S04 对拍：常量、标签表、外链表与原版逐字一致；每个结构体的 JSON 字段名与原版接口字段同名同序。

package contract

import (
	"fmt"
	"maps"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func TestConstantsMatchOriginal(t *testing.T) {
	types := readOriginal(t, "types.ts")
	planner := readOriginal(t, "planner.ts")
	if ConfigVersion != 16 || PlannerVersion != 1 {
		t.Fatalf("ConfigVersion=%d PlannerVersion=%d，应为 16 / 1", ConfigVersion, PlannerVersion)
	}
	cases := []struct {
		src, name string
		got       int
	}{
		{types, "CONFIG_VERSION", ConfigVersion},
		{planner, "PLANNER_VERSION", PlannerVersion},
		{planner, "MAX_TASKS_PER_BOARD", MaxTasksPerBoard},
		{planner, "MAX_BOARDS", MaxBoards},
		{planner, "TASK_TITLE_MAX", TaskTitleMax},
		{planner, "NOTE_MAX", NoteMax},
		{planner, "SCHEDULE_TITLE_MAX", ScheduleTitleMax},
		{planner, "MAX_SCHEDULES_PER_BOARD", MaxSchedulesPerBoard},
		{planner, "SOON_DAYS", SoonDays},
	}
	for _, c := range cases {
		if want := tsConst(t, c.src, c.name); fmt.Sprint(c.got) != want {
			t.Errorf("%s go %d ts %s", c.name, c.got, want)
		}
	}
}

func asStringMap[K ~string](m map[K]string) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[string(k)] = v
	}
	return out
}

func TestLabelsMatchOriginal(t *testing.T) {
	types := readOriginal(t, "types.ts")
	planner := readOriginal(t, "planner.ts")
	cases := []struct {
		src, name string
		got       map[string]string
	}{
		{types, "GROUP_ENV_LABEL", asStringMap(GroupEnvLabel)},
		{types, "PROJECT_LINKS", asStringMap(ProjectLinks)},
		{planner, "TASK_STATUS_LABEL", asStringMap(TaskStatusLabel)},
		{planner, "REPEAT_LABEL", asStringMap(RepeatLabel)},
	}
	for _, c := range cases {
		if want := tsRecord(t, c.src, c.name); !maps.Equal(c.got, want) {
			t.Errorf("%s\n go: %v\n ts: %v", c.name, c.got, want)
		}
	}
	if got, want := strs(ProjectLinkKeys), slices.Sorted(maps.Keys(asStringMap(ProjectLinks))); !slices.Equal(slices.Sorted(slices.Values(got)), want) {
		t.Errorf("ProjectLinkKeys %v 与 ProjectLinks 键 %v 不一致", got, want)
	}
}

func jsonNames(v any) []string {
	rt := reflect.TypeOf(v)
	var out []string
	for i := range rt.NumField() {
		name, _, _ := strings.Cut(rt.Field(i).Tag.Get("json"), ",")
		out = append(out, name)
	}
	return out
}

func TestStructFieldsMatchInterfaces(t *testing.T) {
	types := readOriginal(t, "types.ts")
	planner := readOriginal(t, "planner.ts")
	cases := []struct {
		src, iface string
		v          any
	}{
		{types, "SessionMeta", SessionMeta{}},
		{types, "CreateShellSessionInput", CreateShellSessionInput{}},
		{types, "CreateSessionInput", CreateSessionInput{}},
		{types, "SessionDataEvent", SessionDataEvent{}},
		{types, "SessionExitEvent", SessionExitEvent{}},
		{types, "LogLine", LogLine{}},
		{types, "LogQuery", LogQuery{}},
		{types, "LogResult", LogResult{}},
		{types, "OwnershipVerdict", OwnershipVerdict{}},
		{types, "ListenerSnapshot", ListenerSnapshot{}},
		{types, "WatchedProcess", WatchedProcess{}},
		{types, "SystemLoad", SystemLoad{}},
		{types, "UnmanagedListener", UnmanagedListener{}},
		{types, "ScanSnapshot", ScanSnapshot{}},
		{types, "ScanDiff", ScanDiff{}},
		{types, "ThemeState", ThemeState{}},
		{types, "Settings", Settings{}},
		{types, "FocusEntryRequest", FocusEntryRequest{}},
		{types, "PlannerFocusRequest", PlannerFocusRequest{}},
		{types, "GroupOverride", GroupOverride{}},
		{types, "ProjectGroup", ProjectGroup{}},
		{types, "AppConfig", AppConfig{}},
		{types, "LaunchEntry", LaunchEntry{}},
		{types, "HealthCheckConfig", HealthCheckConfig{}},
		{types, "EntryHealth", EntryHealth{}},
		{types, "AutoRestartPending", AutoRestartPending{}},
		{types, "OutputAlert", OutputAlert{}},
		{types, "DetectResult", DetectResult{}},
		{types, "PrecheckItem", PrecheckItem{}},
		{types, "PrecheckResult", PrecheckResult{}},
		{types, "EntryRuntime", EntryRuntime{}},
		{types, "EntryStartResult", EntryStartResult{}},
		{types, "ConfigExportResult", ConfigExportResult{}},
		{types, "ConfigImportResult", ConfigImportResult{}},
		{types, "OrderedStartResult", OrderedStartResult{}},
		{types, "PortHolder", PortHolder{}},
		{types, "EntryDiagnosis", EntryDiagnosis{}},
		{planner, "PlannerSchedule", PlannerSchedule{}},
		{planner, "MissedReminder", MissedReminder{}},
		{planner, "PlannerTask", PlannerTask{}},
		{planner, "PlannerBoard", PlannerBoard{}},
		{planner, "PlannerData", PlannerData{}},
		{planner, "PlannerSnapshot", PlannerSnapshot{}},
		{planner, "PlannerBoardPatch", PlannerBoardPatch{}},
		{planner, "PlannerTaskInput", PlannerTaskInput{}},
		{planner, "PlannerTaskPatch", PlannerTaskPatch{}},
		{planner, "PlannerScheduleInput", PlannerScheduleInput{}},
		{planner, "ReminderFire", ReminderFire{}},
		{planner, "BoardProgress", BoardProgress{}},
		{planner, "BoardStatus", BoardStatus{}},
		{planner, "PendingFire", PendingFire{}},
	}
	for _, c := range cases {
		t.Run(c.iface, func(t *testing.T) {
			iface := c.iface
			if iface == "PlannerTaskPatch" {
				iface = "PlannerTaskInput" // Partial<PlannerTaskInput>
			}
			if got, want := jsonNames(c.v), tsFields(t, c.src, iface); !slices.Equal(got, want) {
				t.Errorf("\n go: %v\n ts: %v", got, want)
			}
		})
	}
}

// 由类型运算派生的结构体：按派生规则从原接口算出期望字段集合。
func TestDerivedStructFields(t *testing.T) {
	types := readOriginal(t, "types.ts")
	planner := readOriginal(t, "planner.ts")

	if got, want := jsonNames(EntryEdit{}), strs(EditableEntryFields); !slices.Equal(got, want) {
		t.Errorf("EntryEdit\n go: %v\n ts: %v", got, want)
	}
	if got, want := jsonNames(GroupPatch{}), []string{"name", "description", "env", "order", "pinned"}; !slices.Equal(got, want) {
		t.Errorf("GroupPatch go %v ts %v", got, want)
	}
	if got, want := jsonNames(NewProjectGroup{}), []string{"name", "description", "env"}; !slices.Equal(got, want) {
		t.Errorf("NewProjectGroup go %v ts %v", got, want)
	}
	var newEntry []string
	for _, f := range tsFields(t, types, "LaunchEntry") {
		if f != "id" && f != "order" && f != "createdAt" {
			newEntry = append(newEntry, f)
		}
	}
	if got := jsonNames(NewLaunchEntry{}); !slices.Equal(got, newEntry) {
		t.Errorf("NewLaunchEntry\n go: %v\n ts: %v", got, newEntry)
	}
	schedPatch := append(tsFields(t, planner, "PlannerScheduleInput"), "snoozeUntil")
	if got := jsonNames(PlannerSchedulePatch{}); !slices.Equal(got, schedPatch) {
		t.Errorf("PlannerSchedulePatch\n go: %v\n ts: %v", got, schedPatch)
	}
	if got, want := jsonNames(ScheduleRepeat{}), []string{"kind", "days", "day"}; !slices.Equal(got, want) {
		t.Errorf("ScheduleRepeat go %v want %v", got, want)
	}
}
