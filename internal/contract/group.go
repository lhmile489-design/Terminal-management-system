// 对应 src/shared/types.ts 第 283–326 行：工作组（PRD-WORKGROUPS §2）与 orderGroups。

package contract

import "slices"

// GroupEnvironment 工作组运行环境。
//   - dev：无提示，正常启动
//   - sandbox：黄色警示横幅，用户确认后启动
//   - prod：红色强提示横幅
type GroupEnvironment string

const (
	GroupEnvDev     GroupEnvironment = "dev"
	GroupEnvSandbox GroupEnvironment = "sandbox"
	GroupEnvProd    GroupEnvironment = "prod"
)

// GroupEnvironments 与 TS 联合类型同序。
var GroupEnvironments = []GroupEnvironment{GroupEnvDev, GroupEnvSandbox, GroupEnvProd}

// GroupEnvLabel 逐字照搬原版 GROUP_ENV_LABEL。
var GroupEnvLabel = map[GroupEnvironment]string{
	GroupEnvDev:     "开发",
	GroupEnvSandbox: "沙箱",
	GroupEnvProd:    "生产",
}

// ProjectGroup 用户定义的项目工作组。条目通过 LaunchEntry.GroupID 关联。
type ProjectGroup struct {
	ID string `json:"id"`
	// Name 最长 40 字。
	Name string `json:"name"`
	// Description 最长 120 字。
	Description string           `json:"description,omitempty"`
	Env         GroupEnvironment `json:"env"`
	CreatedAt   int64            `json:"createdAt"`
	Order       int              `json:"order"`
	// Pinned 置顶，v15 起。
	Pinned *bool `json:"pinned,omitempty"`
}

// IsPinned 对应 TS 的 !!pinned。
func (g ProjectGroup) IsPinned() bool { return g.Pinned != nil && *g.Pinned }

// OrderGroups 工作组的显示顺序：置顶的在前，各自内部按 order。
// 原版：[...groups].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || a.order - b.order)。
// Array.prototype.sort 自 ES2019 起是稳定排序，这里用 SortStableFunc 对齐；不改动入参。
func OrderGroups(groups []ProjectGroup) []ProjectGroup {
	out := slices.Clone(groups)
	if out == nil {
		out = []ProjectGroup{}
	}
	slices.SortStableFunc(out, func(a, b ProjectGroup) int {
		if d := boolInt(b.IsPinned()) - boolInt(a.IsPinned()); d != 0 {
			return d
		}
		return a.Order - b.Order
	})
	return out
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// NewProjectGroup 新建工作组的入参。
type NewProjectGroup struct {
	Name        string           `json:"name"`
	Description string           `json:"description,omitempty"`
	Env         GroupEnvironment `json:"env,omitempty"`
}

// GroupPatch 工作组补丁。TS 是 Partial<Pick<...>>，不含 null；原版 GroupService 用空串清掉 description。
// Order 用 float64：原版对数字做 Math.trunc，整数解码会把 1.5 直接拒掉，与原版不同。
type GroupPatch struct {
	Name        *string           `json:"name,omitempty"`
	Description *string           `json:"description,omitempty"`
	Env         *GroupEnvironment `json:"env,omitempty"`
	Order       *float64          `json:"order,omitempty"`
	Pinned      *bool             `json:"pinned,omitempty"`
}
