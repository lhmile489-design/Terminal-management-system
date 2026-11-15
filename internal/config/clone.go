// AppConfig 的深拷贝。原版 get() 直接返回缓存对象（JS 单线程，调用方约定不改）；
// Go 侧多个 goroutine 同时读，Get 返回副本，免得有人改了切片或 map 造成数据竞争。

package config

import (
	"maps"
	"slices"

	"mile-console/internal/contract"
)

// Clone 深拷贝一份配置：切片、map、指针都复制，nil 保持 nil。
func Clone(c contract.AppConfig) contract.AppConfig {
	out := c
	out.Entries = cloneSlice(c.Entries, cloneEntry)
	out.Groups = cloneSlice(c.Groups, func(g contract.ProjectGroup) contract.ProjectGroup {
		g.Pinned = clonePtr(g.Pinned)
		return g
	})
	out.IgnoredListeners = slices.Clone(c.IgnoredListeners)
	out.GroupOverrides = slices.Clone(c.GroupOverrides)
	out.WatchedKeywords = slices.Clone(c.WatchedKeywords)
	return out
}

func cloneEntry(e contract.LaunchEntry) contract.LaunchEntry {
	e.Script = clonePtr(e.Script)
	e.Scripts = e.Scripts.Clone()
	e.Env = maps.Clone(e.Env)
	e.ExpectedPort = clonePtr(e.ExpectedPort)
	e.LastStartedAt = clonePtr(e.LastStartedAt)
	e.LastExitCode = clonePtr(e.LastExitCode)
	e.StartAfter = slices.Clone(e.StartAfter)
	e.HealthCheck = clonePtr(e.HealthCheck)
	e.AutoRestart = clonePtr(e.AutoRestart)
	e.AlertKeywords = slices.Clone(e.AlertKeywords)
	e.AlertOnErrors = clonePtr(e.AlertOnErrors)
	return e
}

func cloneSlice[T any](xs []T, f func(T) T) []T {
	if xs == nil {
		return nil
	}
	out := make([]T, len(xs))
	for i, x := range xs {
		out[i] = f(x)
	}
	return out
}

func clonePtr[T any](p *T) *T {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}
