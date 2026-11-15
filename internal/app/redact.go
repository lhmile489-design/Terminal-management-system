// 对应原版 src/main/index.ts 的 redactEntry / redactList（第 292–296 行）。
//
// 条目出 Go 进程前抹掉环境变量的值，只留键名（值恒为空串）。页面拿不到密钥：
// 编辑时用合并补丁（字符串覆盖、null 删除、没提的键保持原值），见 entries.ApplyEdit。
//
// 所有把 LaunchEntry 交给页面的出口都必须过这里：EntryService 的返回值、entryChanged 事件。

package app

import "mile-console/internal/contract"

// RedactEntry 返回 env 只剩键名的副本，不改入参。
func RedactEntry(e contract.LaunchEntry) contract.LaunchEntry {
	if e.Env == nil {
		// 原版 `Object.keys(e.env ?? {})` 得到 {}：页面拿到的永远是对象，不是 null
		e.Env = map[string]string{}
		return e
	}
	env := make(map[string]string, len(e.Env))
	for k := range e.Env {
		env[k] = ""
	}
	e.Env = env
	return e
}

// RedactList 逐个 RedactEntry，保持顺序。
func RedactList(list []contract.LaunchEntry) []contract.LaunchEntry {
	out := make([]contract.LaunchEntry, len(list))
	for i, e := range list {
		out[i] = RedactEntry(e)
	}
	return out
}
