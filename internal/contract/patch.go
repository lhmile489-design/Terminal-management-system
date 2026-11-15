// 对应 src/shared/types.ts 与 src/shared/planner.ts 里「null = 显式清空」的补丁语义。
//
// 原版的 EntryEdit / GroupPatch / PlannerBoardPatch / PlannerTaskPatch / PlannerSchedulePatch
// 用 null 表示「清空这个字段」，用「不带这个键」表示「不改」——IPC 结构化克隆会丢掉 undefined，
// 所以只有 null 能跨边界表达清空。Go 的指针只能区分「有值 / 无值」，分不出「没提」和「null」，
// 因此用 Patch[T] 记三态：
//
//	没带这个键   Set=false
//	键值为 null  Set=true, Value=nil
//	键值为 v     Set=true, Value=&v
//
// 结构体字段要配 `json:"x,omitzero"`，序列化时「没提」才会被省掉。
// 风险登记：mygo generate 对泛型类型与自定义 JSON 方法的处理在 S24/S25 再核对。

package contract

import (
	"bytes"
	"encoding/json"
)

// Patch 是补丁里可被显式清空的字段。
type Patch[T any] struct {
	Set   bool
	Value *T
}

// PatchOf 构造一个设值的补丁字段。
func PatchOf[T any](v T) Patch[T] { return Patch[T]{Set: true, Value: &v} }

// PatchNull 构造一个显式清空的补丁字段。
func PatchNull[T any]() Patch[T] { return Patch[T]{Set: true} }

// IsNull 报告该字段是否被显式置为 null。
func (p Patch[T]) IsNull() bool { return p.Set && p.Value == nil }

// IsZero 供 omitzero 使用：没提到的字段不输出。
func (p Patch[T]) IsZero() bool { return !p.Set }

// UnmarshalJSON 只要键出现就记 Set；null 记为清空。
func (p *Patch[T]) UnmarshalJSON(b []byte) error {
	p.Set = true
	if bytes.Equal(bytes.TrimSpace(b), []byte("null")) {
		p.Value = nil
		return nil
	}
	var v T
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	p.Value = &v
	return nil
}

// MarshalJSON 输出值或 null；配合 omitzero，未设置的字段不会走到这里。
func (p Patch[T]) MarshalJSON() ([]byte, error) {
	if p.Value == nil {
		return []byte("null"), nil
	}
	return json.Marshal(*p.Value)
}
