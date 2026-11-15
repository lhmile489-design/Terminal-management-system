// 对应 src/main/services/ScannerService.ts 的 matchWatched：关注进程，PRD §5.5。

package scanner

import (
	"slices"
	"strings"

	"mile-console/internal/contract"
	"mile-console/internal/platform"
)

// matchWatched 只在当前用户的进程里匹配 —— 与监听表同一条边界，不能因为「只是看一眼」就把别人的进程列出来。
// 本应用自己的进程排除掉：关键字写 `node` 时整个本应用进程树都会命中，那不是用户想观察的东西。
// 调用方持有 s.mu（Verify 用的是 ownership 自己的锁，不会嵌套到 s.mu）。
//
// 遍历顺序：原版按 table.mine 这个 Set 的插入顺序（CIM 返回顺序）走，满 50 个就停，最后按 pid 排序。
// Go 的 map 无序，这里先按 pid 升序遍历再截断。命中不超过 50 个时结果与原版完全相同；超过时原版取的是
// 「CIM 顺序里的前 50 个」，Go 取「pid 最小的 50 个」—— 见 docs/MIGRATION-PLAN.md §6。
func (s *Service) matchWatched(table platform.ProcessTable, cfg contract.AppConfig) []contract.WatchedProcess {
	keywords := normalizeKeywords(cfg.WatchedKeywords)
	if len(keywords) == 0 {
		return []contract.WatchedProcess{}
	}

	pids := make([]int, 0, len(table.Mine))
	for pid := range table.Mine {
		pids = append(pids, pid)
	}
	slices.Sort(pids)

	out := []contract.WatchedProcess{}
	for _, pid := range pids {
		if len(out) >= MaxWatched {
			break
		}
		if pid == s.opts.SelfPid {
			continue
		}
		row, ok := table.ByPid[pid]
		if !ok {
			continue
		}
		if s.ownership.Verify(pid, table.ProcessMeta).Ownership == contract.OwnershipOwned {
			continue
		}

		cmd := ""
		if row.CommandLine != nil {
			cmd = *row.CommandLine
		}
		haystack := jsToLower(row.Name + " " + cmd)
		keyword := ""
		for _, k := range keywords {
			if strings.Contains(haystack, k) {
				keyword = k
				break
			}
		}
		if keyword == "" {
			continue
		}
		out = append(out, contract.WatchedProcess{
			Pid:         pid,
			ProcessName: row.Name,
			Keyword:     keyword,
			CommandLine: truncate(cmd, WatchedCmdMax),
			CPU:         nil,
			Memory:      0,
			StartedAt:   row.StartedAt,
		})
	}
	return out
}
