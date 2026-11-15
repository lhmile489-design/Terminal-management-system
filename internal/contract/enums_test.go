// S04 对拍：每个联合类型 / 常量数组的 Go 列表与原版 TS 字面量逐项、同序一致。

package contract

import (
	"fmt"
	"slices"
	"testing"
)

func strs[T ~string](xs []T) []string {
	out := make([]string, len(xs))
	for i, x := range xs {
		out[i] = string(x)
	}
	return out
}

func ints[T ~int](xs []T) []string {
	out := make([]string, len(xs))
	for i, x := range xs {
		out[i] = fmt.Sprint(int(x))
	}
	return out
}

func TestUnionsMatchTypesTS(t *testing.T) {
	src := readOriginal(t, "types.ts")
	cases := []struct {
		name string
		got  []string
	}{
		{"SessionKind", strs(SessionKinds)},
		{"SessionStatus", strs(SessionStatuses)},
		{"LogLevel", strs(LogLevels)},
		{"Ownership", strs(Ownerships)},
		{"CredentialResult", strs(CredentialResults)},
		{"ListenerGroup", strs(ListenerGroups)},
		{"LaunchSource", strs(LaunchSources)},
		{"ThemePreference", strs(ThemePreferences)},
		{"ResolvedTheme", strs(ResolvedThemes)},
		{"GroupEnvironment", strs(GroupEnvironments)},
		{"Framework", strs(Frameworks)},
		{"PackageManager", strs(PackageManagers)},
		{"SpringBootLaunchMode", strs(SpringBootLaunchModes)},
		{"MavenGoal", strs(MavenGoals)},
		{"LaunchMode", strs(LaunchModes)},
		{"EntryKind", strs(EntryKinds)},
		{"PrecheckLevel", strs(PrecheckLevels)},
		{"PrecheckFixAction", strs(PrecheckFixActions)},
		{"EntryStatus", strs(EntryStatuses)},
		{"EditableEntryField", strs(EditableEntryFields)},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			want := tsUnion(t, src, c.name)
			if !slices.Equal(c.got, want) {
				t.Errorf("%s\n go: %v\n ts: %v", c.name, c.got, want)
			}
		})
	}
}

func TestArraysMatchTypesTS(t *testing.T) {
	src := readOriginal(t, "types.ts")
	if got, want := strs(WebFrameworks), tsArray(t, src, "WEB_FRAMEWORKS"); !slices.Equal(got, want) {
		t.Errorf("WEB_FRAMEWORKS go %v ts %v", got, want)
	}
	if got, want := strs(ServiceIconIDs), tsArray(t, src, "SERVICE_ICON_IDS"); !slices.Equal(got, want) {
		t.Errorf("SERVICE_ICON_IDS go %v ts %v", got, want)
	}
}

func TestInlineUnionsMatchTypesTS(t *testing.T) {
	src := readOriginal(t, "types.ts")
	cases := []struct {
		iface, field string
		got          []string
	}{
		{"Settings", "scanIntervalMs", func() []string {
			out := make([]string, len(ScanIntervals))
			for i, v := range ScanIntervals {
				out[i] = fmt.Sprint(v)
			}
			return out
		}()},
		{"Settings", "externalTerminal", strs(ExternalTerminals)},
		{"FocusEntryRequest", "tab", strs(FocusTabs)},
		{"PlannerFocusRequest", "tab", strs(PlannerTabs)},
		{"EntryHealth", "state", strs(HealthStates)},
		{"EntryRuntime", "readySource", strs(ReadySources)},
	}
	for _, c := range cases {
		t.Run(c.iface+"."+c.field, func(t *testing.T) {
			want := tsFieldUnion(t, src, c.iface, c.field)
			if !slices.Equal(c.got, want) {
				t.Errorf("go %v ts %v", c.got, want)
			}
		})
	}
}

func TestUnionsMatchPlannerTS(t *testing.T) {
	src := readOriginal(t, "planner.ts")
	cases := []struct {
		name string
		got  []string
	}{
		{"PlannerTaskStatus", strs(TaskStatuses)},
		{"BoardTone", strs(BoardTones)},
		{"TaskDueTone", strs(TaskDueTones)},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if want := tsUnion(t, src, c.name); !slices.Equal(c.got, want) {
				t.Errorf("go %v ts %v", c.got, want)
			}
		})
	}
	arrays := []struct {
		name string
		got  []string
	}{
		{"TASK_STATUSES", strs(TaskStatuses)},
		{"REPEAT_KINDS", strs(RepeatKinds)},
		{"LEAD_MINUTES", ints(LeadMinutesList)},
		{"WEEKDAY_LABEL", WeekdayLabel},
	}
	for _, c := range arrays {
		t.Run(c.name, func(t *testing.T) {
			if want := tsArray(t, src, c.name); !slices.Equal(c.got, want) {
				t.Errorf("go %v ts %v", c.got, want)
			}
		})
	}
}
