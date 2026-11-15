// S04：Patch 三态的 JSON 往返、LaunchEntry 与原版 JSON 往返、OrderGroups 与原版排序一致。

package contract

import (
	"encoding/json"
	"reflect"
	"slices"
	"testing"
)

func sameJSON(t *testing.T, got []byte, want string) {
	t.Helper()
	var a, b any
	if err := json.Unmarshal(got, &a); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(want), &b); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(a, b) {
		t.Errorf("\n got: %s\nwant: %s", got, want)
	}
}

func TestPatchTriState(t *testing.T) {
	in := `{"name":"api","expectedPort":null,"outputDir":"dist","env":{"A":"1","B":null},"startAfter":[],"healthCheck":{"path":"/health","enabled":true},"script":null}`
	var e EntryEdit
	if err := json.Unmarshal([]byte(in), &e); err != nil {
		t.Fatal(err)
	}
	switch {
	case e.Name == nil || *e.Name != "api":
		t.Error("name 应设值")
	case !e.ExpectedPort.IsNull():
		t.Error("expectedPort:null 应为显式清空")
	case !e.OutputDir.Set || e.OutputDir.Value == nil || *e.OutputDir.Value != "dist":
		t.Error("outputDir 应设值 dist")
	case e.Category.Set || e.JarPath.Set || e.ImageID.Set:
		t.Error("没提的键不应 Set")
	case e.Env["A"] == nil || *e.Env["A"] != "1":
		t.Error("env.A 应为 1")
	case e.Env["B"] != nil:
		t.Error("env.B:null 应为删除")
	case !e.StartAfter.Set || e.StartAfter.Value == nil || len(*e.StartAfter.Value) != 0:
		t.Error("startAfter:[] 应设为空数组，不等于 null")
	case !e.Script.IsNull():
		t.Error("script:null 应为显式清空")
	}
	out, err := json.Marshal(e)
	if err != nil {
		t.Fatal(err)
	}
	sameJSON(t, out, in)

	empty, _ := json.Marshal(EntryEdit{})
	if string(empty) != "{}" {
		t.Errorf("空补丁应序列化为 {}，得到 %s", empty)
	}
	p, _ := json.Marshal(PlannerSchedulePatch{SnoozeUntil: PatchNull[int64](), TaskID: PatchOf("t1")})
	sameJSON(t, p, `{"taskId":"t1","snoozeUntil":null}`)
}

func TestLaunchEntryRoundTrip(t *testing.T) {
	// 原版 config.json 里一条典型条目：script 为 null 要写出来，空的 startAfter 原样保留，没有的可选键不冒出来。
	in := `{"id":"e1","kind":"service","name":"web","path":"D:\\p","framework":"vue-vite","packageManager":"pnpm","script":null,"scripts":{"dev":"vite"},"env":{"PORT":""},"expectedPort":0,"registerOnly":false,"pinned":true,"order":2,"createdAt":1731500000000,"lastExitCode":0,"startAfter":[],"autoRestart":false}`
	var e LaunchEntry
	if err := json.Unmarshal([]byte(in), &e); err != nil {
		t.Fatal(err)
	}
	out, err := json.Marshal(e)
	if err != nil {
		t.Fatal(err)
	}
	sameJSON(t, out, in)
}

func pinned(b bool) *bool { return &b }

func TestOrderGroups(t *testing.T) {
	// 期望顺序按原版比较器手算：置顶在前（b 先于 c，order 1 < 3），其余按 order；order 相同保持原序（x 先于 y）。
	in := []ProjectGroup{
		{ID: "a", Order: 0},
		{ID: "c", Order: 3, Pinned: pinned(true)},
		{ID: "x", Order: 5},
		{ID: "b", Order: 1, Pinned: pinned(true)},
		{ID: "y", Order: 5, Pinned: pinned(false)},
	}
	before := slices.Clone(in)
	var got []string
	for _, g := range OrderGroups(in) {
		got = append(got, g.ID)
	}
	if want := []string{"b", "c", "a", "x", "y"}; !slices.Equal(got, want) {
		t.Errorf("go %v want %v", got, want)
	}
	if !reflect.DeepEqual(in, before) {
		t.Error("OrderGroups 不应改动入参")
	}
	if out := OrderGroups(nil); out == nil || len(out) != 0 {
		t.Errorf("nil 入参应返回空切片，得到 %#v", out)
	}
}

func TestIsWebFramework(t *testing.T) {
	if !IsWebFramework(FrameworkVueVite) || !IsWebFramework(FrameworkStatic) {
		t.Error("vue-vite / static 应是网站生态")
	}
	if IsWebFramework(FrameworkGo) || IsWebFramework(FrameworkSpringBoot) || IsWebFramework(FrameworkElectron) {
		t.Error("go / spring-boot / electron 不应是网站生态")
	}
}
