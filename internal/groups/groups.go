// 对应 src/main/services/GroupService.ts。
//
// 工作组 CRUD 的纯函数层：校形、查重、排序、按 id 改 / 删 / 重排。
// 与原版一致，本包只算「下一个 groups 数组应该长什么样」；落盘、'.bak' 轮转、
// 事件广播全部交给 internal/config 与绑定层，这里不做 I/O。

package groups

import (
	"errors"
	"regexp"
	"strings"
	"unicode/utf8"

	"mile-console/internal/contract"
)

// SAFE_GROUP_NAME 逐字照搬原版：允许中文 / 英文 / 数字 / 空格 / 连字符 / 下划线，1-40 字。
//
// 原正则字符类（原文是字面字符，这里按码点写）：
//
//   - w              JS 不带 u 标志时是 ASCII [0-9A-Za-z_]，Go 的 w 同为 ASCII，对齐
//   - U+4E00-U+9FA5   CJK 统一表意文字
//   - U+3000-U+303F   CJK 符号与标点（含全角空格 U+3000）
//   - U+FF00-U+FFEF   半角全角形式
//   - 空格、_、- 显式列出（_ 已在 \w 内，- 在字符类末尾表字面）
//
// JS 的 {1,40} 按 UTF-16 码元计数，Go 的 regexp 按 rune 计；
// BMP 内的字符两边一致，都在白名单内，无 surrogate 偏差。
var SAFE_GROUP_NAME = regexp.MustCompile(`^[\w\x{4e00}-\x{9fa5}\x{3000}-\x{303f}\x{ff00}-\x{ffef} _-]{1,40}$`)

// VALID_ENVS 即原版 VALID_ENVS：dev / sandbox / prod。
var VALID_ENVS = map[contract.GroupEnvironment]struct{}{
	contract.GroupEnvDev:     {},
	contract.GroupEnvSandbox: {},
	contract.GroupEnvProd:    {},
}

// controlCharRE 即原版 validateGroupDesc 里的 /[\x00-\x1f\x7f]/。
var controlCharRE = regexp.MustCompile(`[\x00-\x1f\x7f]`)

// ValidateGroupName 工作组名是否合法（trim 后 1-40 字且过白名单）。
// 与原版 sanitizeGroupName 同口径，但只返回 bool —— 调用方在校形失败时给固定文案。
func ValidateGroupName(name string) bool {
	return SAFE_GROUP_NAME.MatchString(strings.TrimSpace(name))
}

// SanitizeName 即原版 sanitizeGroupName：trim + 长度 + 白名单，失败给中文错。
func SanitizeName(name string) (string, error) {
	n := strings.TrimSpace(name)
	// 原版 n.length > 40 按 UTF-16 码元；这里按 rune 计数，BMP 内一致，
	// 同时正则的 {1,40} 也是同一尺度，两条检查保持同源。
	if utf8.RuneCountInString(n) == 0 || utf8.RuneCountInString(n) > 40 {
		return "", errors.New("工作组名称须为 1-40 字")
	}
	if !SAFE_GROUP_NAME.MatchString(n) {
		return "", errors.New("工作组名称包含非法字符")
	}
	return n, nil
}

// SanitizeDesc 即原版 validateGroupDesc：截到 120 字、拒绝控制字符。
// 原版用 slice(0, 120) 按 UTF-16 码元截；中文 BMP 内 1 码元 = 1 rune，等价。
// 描述允许空串（上层把它当 undefined 处理，存 omitempty）。
func SanitizeDesc(desc string) (string, error) {
	runes := []rune(desc)
	if len(runes) > 120 {
		runes = runes[:120]
	}
	cleaned := string(runes)
	if controlCharRE.MatchString(cleaned) {
		return "", errors.New("工作组描述包含非法控制字符")
	}
	return cleaned, nil
}

// SanitizeEnv 即原版 sanitizeGroupEnv：只接受 dev / sandbox / prod。
func SanitizeEnv(env contract.GroupEnvironment) (contract.GroupEnvironment, error) {
	if _, ok := VALID_ENVS[env]; ok {
		return env, nil
	}
	return "", errors.New("环境值只接受 dev / sandbox / prod")
}

// SanitizePatch 即原版 sanitizePatch：把 GroupPatch 里的字段逐个校形。
// Order 走 Math.trunc 同款的 float64 → int 截断，并 clamp 到 ≥0。
// Description 空串视为「清除」（原版 ?? undefined，落库时 omitempty 不写）。
func SanitizePatch(p contract.GroupPatch) (contract.GroupPatch, error) {
	out := contract.GroupPatch{}
	if p.Name != nil {
		n, err := SanitizeName(*p.Name)
		if err != nil {
			return contract.GroupPatch{}, err
		}
		out.Name = &n
	}
	if p.Description != nil {
		if *p.Description == "" {
			// 原版 patch.description === '' → undefined；这里写 &"" 由上层判断为清除。
			empty := ""
			out.Description = &empty
		} else {
			d, err := SanitizeDesc(*p.Description)
			if err != nil {
				return contract.GroupPatch{}, err
			}
			out.Description = &d
		}
	}
	if p.Env != nil {
		e, err := SanitizeEnv(*p.Env)
		if err != nil {
			return contract.GroupPatch{}, err
		}
		out.Env = &e
	}
	if p.Order != nil {
		// Math.max(0, Math.trunc(order))；Go 的 int(f) 对正数等价 trunc。
		truncated := int(*p.Order)
		truncated = max(0, truncated)
		f := float64(truncated)
		out.Order = &f
	}
	if p.Pinned != nil {
		out.Pinned = p.Pinned
	}
	return out, nil
}

// CreateGroup 即原版 GroupService.add：用传入的 id 与 createdAt 造一条新组。
// id 由上层用 crypto/rand UUID 生成；本函数只做校形与字段装配，返回追加后的新切片。
// groups 是当前的 groups；新组 order 取 len(groups)。
func CreateGroup(groups []contract.ProjectGroup, id string, createdAt int64, in contract.NewProjectGroup) (contract.ProjectGroup, []contract.ProjectGroup, error) {
	name, err := SanitizeName(in.Name)
	if err != nil {
		return contract.ProjectGroup{}, nil, err
	}
	var desc string
	if in.Description != "" {
		d, err := SanitizeDesc(in.Description)
		if err != nil {
			return contract.ProjectGroup{}, nil, err
		}
		desc = d
	}
	env := contract.GroupEnvDev
	if in.Env != "" {
		e, err := SanitizeEnv(in.Env)
		if err != nil {
			return contract.ProjectGroup{}, nil, err
		}
		env = e
	}
	g := contract.ProjectGroup{
		ID:          id,
		Name:        name,
		Description: desc,
		Env:         env,
		CreatedAt:   createdAt,
		Order:       len(groups),
	}
	next := append(append([]contract.ProjectGroup{}, groups...), g)
	return g, next, nil
}

// EditGroup 即原版 GroupService.patch：找到 id、把校形过的补丁 merge 上去。
// Description 接到空串指针时清空（原版 → undefined，JSON 序列化时 omitempty 丢字段）。
func EditGroup(groups []contract.ProjectGroup, id string, raw contract.GroupPatch) (contract.ProjectGroup, []contract.ProjectGroup, error) {
	idx := -1
	for i, g := range groups {
		if g.ID == id {
			idx = i
			break
		}
	}
	if idx < 0 {
		return contract.ProjectGroup{}, nil, errors.New("工作组不存在")
	}
	p, err := SanitizePatch(raw)
	if err != nil {
		return contract.ProjectGroup{}, nil, err
	}
	updated := groups[idx]
	if p.Name != nil {
		updated.Name = *p.Name
	}
	if p.Description != nil {
		updated.Description = *p.Description // 空串即清除（omitempty 不落字段）
	}
	if p.Env != nil {
		updated.Env = *p.Env
	}
	if p.Order != nil {
		updated.Order = int(*p.Order)
	}
	if p.Pinned != nil {
		updated.Pinned = p.Pinned
	}
	next := append([]contract.ProjectGroup{}, groups...)
	next[idx] = updated
	return updated, next, nil
}

// RemoveGroup 即原版 GroupService.remove：删组 + 清掉所有条目的 groupId。
// 返回新的 groups 与「清掉 groupId 后的 entries」；调用方写 config 时一并落盘。
func RemoveGroup(groups []contract.ProjectGroup, entries []contract.LaunchEntry, id string) ([]contract.ProjectGroup, []contract.LaunchEntry) {
	nextGroups := make([]contract.ProjectGroup, 0, len(groups))
	for _, g := range groups {
		if g.ID != id {
			nextGroups = append(nextGroups, g)
		}
	}
	nextEntries := make([]contract.LaunchEntry, len(entries))
	for i, e := range entries {
		if e.GroupID == id {
			e.GroupID = ""
		}
		nextEntries[i] = e
	}
	return nextGroups, nextEntries
}

// ReorderGroups 即原版 GroupService.reorder：按 ids 顺序重排，
// 未传入的组追加在末尾（保证不丢），order 字段连续重赋。
func ReorderGroups(groups []contract.ProjectGroup, ids []string) []contract.ProjectGroup {
	byID := make(map[string]contract.ProjectGroup, len(groups))
	for _, g := range groups {
		byID[g.ID] = g
	}
	inSet := make(map[string]struct{}, len(ids))
	next := make([]contract.ProjectGroup, 0, len(groups))
	order := 0
	for _, id := range ids {
		if _, dup := inSet[id]; dup {
			continue // 原版 Set 不查重，但同一 id 出现两次会拿到同一引用——这里去重避免重复条目
		}
		inSet[id] = struct{}{}
		if g, ok := byID[id]; ok {
			g.Order = order
			order++
			next = append(next, g)
		}
	}
	for _, g := range groups {
		if _, listed := inSet[g.ID]; !listed {
			g.Order = order
			order++
			next = append(next, g)
		}
	}
	return next
}

// OrderGroups 显示顺序：置顶在前，各自内部按 order。
// 直接调 S04 搬好的 contract.OrderGroups，不重复实现。
func OrderGroups(groups []contract.ProjectGroup) []contract.ProjectGroup {
	return contract.OrderGroups(groups)
}
