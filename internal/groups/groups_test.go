// S11 校形与排序的覆盖：SAFE_GROUP_NAME 边界、OrderGroups 与原版排序口径一致、
// 各 Sanitize* 的错误分支、RemoveGroup 清条目的 groupId、ReorderGroups 兜底追加。

package groups

import (
	"strings"
	"testing"

	"mile-console/internal/contract"
)

func TestGroupNameValidation(t *testing.T) {
	valid := []string{
		"前端",
		"后端服务",
		"backend-api",
		"backend_api",
		"project A",
		"全角空格\u3000也合法",
		"１２３全角数字",
		"，。！全角标点",
		"a",
		strings.Repeat("x", 40), // 边界：恰好 40 字
		strings.Repeat("好", 40), // 中文 40 字
		"  padded  ",            // trim 后合法
	}
	for _, s := range valid {
		if !ValidateGroupName(s) {
			t.Errorf("应通过：%q", s)
		}
	}

	invalid := []string{
		"",
		"   ",
		strings.Repeat("x", 41), // 超 40
		strings.Repeat("好", 41),
		"含\n换行",
		"含\t制表",
		"含\x00控制",
		"含\x7f删除",
		"emoji\U0001F389", // 不在白名单（U+1F389，按项目约定源码里不写字面 emoji）
		"特殊@字符",
		"特殊#字符",
		"特殊$字符",
		"特殊!字符",
		"半角?问号",
	}
	for _, s := range invalid {
		if ValidateGroupName(s) {
			t.Errorf("应拒绝：%q", s)
		}
	}
}

func TestSanitizeName(t *testing.T) {
	if got, err := SanitizeName("  前端  "); err != nil || got != "前端" {
		t.Errorf("trim 后期望 '前端'，得到 %q err %v", got, err)
	}
	if _, err := SanitizeName(""); err == nil {
		t.Error("空串应报错")
	}
	if _, err := SanitizeName(strings.Repeat("x", 41)); err == nil {
		t.Error("41 字应报错")
	}
	if _, err := SanitizeName("bad@name"); err == nil {
		t.Error("含 @ 应报错")
	}
}

func TestSanitizeDesc(t *testing.T) {
	if got, err := SanitizeDesc(strings.Repeat("x", 130)); err != nil || len([]rune(got)) != 120 {
		t.Errorf("超 120 应截断，得到 %d 字符 err %v", len([]rune(got)), err)
	}
	if got, err := SanitizeDesc(strings.Repeat("好", 130)); err != nil || len([]rune(got)) != 120 {
		t.Errorf("中文超 120 应截断，得到 %d 字符 err %v", len([]rune(got)), err)
	}
	if _, err := SanitizeDesc("含\n控制"); err == nil {
		t.Error("含控制字符应报错")
	}
	if got, err := SanitizeDesc("正常描述"); err != nil || got != "正常描述" {
		t.Errorf("正常描述应原样返回，得到 %q err %v", got, err)
	}
}

func TestSanitizeEnv(t *testing.T) {
	for _, e := range []contract.GroupEnvironment{contract.GroupEnvDev, contract.GroupEnvSandbox, contract.GroupEnvProd} {
		if got, err := SanitizeEnv(e); err != nil || got != e {
			t.Errorf("%s 应通过", e)
		}
	}
	for _, e := range []contract.GroupEnvironment{"", "DEV", "staging", "test"} {
		if _, err := SanitizeEnv(e); err == nil {
			t.Errorf("%q 应拒绝", e)
		}
	}
}

func TestOrderGroupsPinnedFirst(t *testing.T) {
	pinTrue1, pinTrue2, pinFalse := true, true, false
	in := []contract.ProjectGroup{
		{ID: "a", Order: 0},
		{ID: "b", Order: 1, Pinned: &pinTrue1},
		{ID: "c", Order: 2},
		{ID: "d", Order: 3, Pinned: &pinTrue2},
		{ID: "e", Order: 4, Pinned: &pinFalse}, // 显式 false 与非 nil 不同：原版 !!pinned === false
	}
	got := OrderGroups(in)
	var ids []string
	for _, g := range got {
		ids = append(ids, g.ID)
	}
	// 期望：pinned=true 的 b、d 在前，按 order 升序（b 1 < d 3）；
	// 其余按 order：a 0, c 2, e 4（e 的 Pinned 是 &false 而非 nil，IsPinned() === false）。
	want := []string{"b", "d", "a", "c", "e"}
	if len(ids) != len(want) {
		t.Fatalf("长度不同 got %v want %v", ids, want)
	}
	for i := range want {
		if ids[i] != want[i] {
			t.Errorf("位置 %d 期望 %s 得到 %s（整体 %v）", i, want[i], ids[i], ids)
		}
	}
}

func TestOrderGroupsStable(t *testing.T) {
	// order 相同保持原相对顺序（ES2019 起 sort 稳定；Go 用 SortStableFunc 对齐）。
	in := []contract.ProjectGroup{
		{ID: "x", Order: 5},
		{ID: "a", Order: 1},
		{ID: "y", Order: 5},
		{ID: "b", Order: 1},
	}
	got := OrderGroups(in)
	var ids []string
	for _, g := range got {
		ids = append(ids, g.ID)
	}
	want := []string{"a", "b", "x", "y"}
	for i := range want {
		if ids[i] != want[i] {
			t.Fatalf("稳定性破坏 got %v want %v", ids, want)
		}
	}
}

func TestCreateGroup(t *testing.T) {
	existing := []contract.ProjectGroup{
		{ID: "g0", Name: "已有", Order: 0, Env: contract.GroupEnvDev},
	}
	g, next, err := CreateGroup(existing, "g1", 1700000000000, contract.NewProjectGroup{
		Name:        "新组",
		Description: "描述",
		Env:         contract.GroupEnvSandbox,
	})
	if err != nil {
		t.Fatalf("不应报错 %v", err)
	}
	if g.ID != "g1" || g.Name != "新组" || g.Description != "描述" || g.Env != contract.GroupEnvSandbox {
		t.Errorf("字段不对 %+v", g)
	}
	if g.Order != 1 {
		t.Errorf("Order 应取 len(groups)=1，得到 %d", g.Order)
	}
	if g.CreatedAt != 1700000000000 {
		t.Errorf("CreatedAt 不对 %d", g.CreatedAt)
	}
	if len(next) != 2 || next[0].ID != "g0" || next[1].ID != "g1" {
		t.Errorf("next 顺序不对 %+v", next)
	}
	// 不入 Env 时默认 dev
	g2, _, err := CreateGroup(nil, "g2", 0, contract.NewProjectGroup{Name: "默认"})
	if err != nil || g2.Env != contract.GroupEnvDev {
		t.Errorf("默认 env 应为 dev %+v err %v", g2, err)
	}
	// 名字非法
	if _, _, err := CreateGroup(nil, "x", 0, contract.NewProjectGroup{Name: "bad@name"}); err == nil {
		t.Error("非法名应报错")
	}
	// Env 非法
	if _, _, err := CreateGroup(nil, "x", 0, contract.NewProjectGroup{Name: "ok", Env: "staging"}); err == nil {
		t.Error("非法 env 应报错")
	}
}

func TestEditGroup(t *testing.T) {
	existing := []contract.ProjectGroup{
		{ID: "g0", Name: "旧名", Order: 0, Env: contract.GroupEnvDev, Description: "旧描述"},
	}
	// 改 name + 清空 description + 置顶
	newName := "新名"
	empty := ""
	pin := true
	updated, next, err := EditGroup(existing, "g0", contract.GroupPatch{
		Name:        &newName,
		Description: &empty,
		Pinned:      &pin,
	})
	if err != nil {
		t.Fatalf("不应报错 %v", err)
	}
	if updated.Name != "新名" || updated.Description != "" || !updated.IsPinned() {
		t.Errorf("字段未生效 %+v", updated)
	}
	if next[0].Name != "新名" || existing[0].Name != "旧名" {
		t.Error("next 应是新切片、existing 不应被改")
	}
	// id 不存在
	if _, _, err := EditGroup(existing, "missing", contract.GroupPatch{}); err == nil {
		t.Error("不存在的 id 应报错")
	}
	// 非法字段
	bad := "bad@x"
	if _, _, err := EditGroup(existing, "g0", contract.GroupPatch{Name: &bad}); err == nil {
		t.Error("非法 name 应报错")
	}
}

func TestRemoveGroupClearsEntries(t *testing.T) {
	groups := []contract.ProjectGroup{
		{ID: "g0", Name: "保留", Order: 0},
		{ID: "g1", Name: "删掉", Order: 1},
	}
	entries := []contract.LaunchEntry{
		{ID: "e0", GroupID: "g1"},
		{ID: "e1", GroupID: "g0"},
		{ID: "e2", GroupID: ""},
		{ID: "e3", GroupID: "g1"},
	}
	nextGroups, nextEntries := RemoveGroup(groups, entries, "g1")
	if len(nextGroups) != 1 || nextGroups[0].ID != "g0" {
		t.Fatalf("应只剩 g0 %+v", nextGroups)
	}
	for _, e := range nextEntries {
		if e.GroupID == "g1" {
			t.Errorf("条目 %s 的 groupId 未清空", e.ID)
		}
	}
	if nextEntries[1].GroupID != "g0" {
		t.Error("未删组的条目 groupId 应保留")
	}
	// 原切片不被改
	if entries[0].GroupID != "g1" {
		t.Error("RemoveGroup 不应改入参")
	}
}

func TestReorderGroups(t *testing.T) {
	groups := []contract.ProjectGroup{
		{ID: "a", Order: 0},
		{ID: "b", Order: 1},
		{ID: "c", Order: 2},
		{ID: "d", Order: 3},
	}
	next := ReorderGroups(groups, []string{"c", "a"})
	var ids []string
	for _, g := range next {
		ids = append(ids, g.ID)
	}
	// c 0, a 1；未列入的 b、d 按原顺序追加 2、3
	want := []string{"c", "a", "b", "d"}
	for i := range want {
		if ids[i] != want[i] {
			t.Fatalf("顺序错 got %v want %v", ids, want)
		}
	}
	for i, g := range next {
		if g.Order != i {
			t.Errorf("order 应连续重赋 g=%s got %d want %d", g.ID, g.Order, i)
		}
	}
	// 传入未知 id 不丢组
	next2 := ReorderGroups(groups, []string{"ghost", "b"})
	if len(next2) != 4 {
		t.Errorf("未知 id 不应让组丢失 %+v", next2)
	}
}
