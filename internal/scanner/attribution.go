// 对应 src/main/lib/attribution.ts：启动来源推断与默认分组。
//
// 进程名表（中间层、来源、开发运行时、系统目录）按平台不同，放在 platform 层（AttributionTables），
// 这里只留判定逻辑。原版从模块级的 platform.attribution 取表，Go 由调用方传入。
//
// 来源识别**仅用于展示**，PRD §5.3：进程名是进程自己可以随便起的，当不了凭据。
// 停不停得了一个进程只看 ownership 包的三重凭据，与这里的结论无关。ownership 包不得 import 本文件。

package scanner

import (
	"slices"
	"strings"
	"unicode"

	"mile-console/internal/contract"
	"mile-console/internal/platform"
)

// MaxAscent 与 OwnershipService 一致的上溯上限，PRD §5.3。
const MaxAscent = 12

func sourceOf(t platform.AttributionTables, row platform.ProcessRow) (contract.LaunchSource, bool) {
	name := jsToLower(row.Name)
	for _, rule := range t.SourceByName {
		if slices.Contains(rule.Names, name) {
			return rule.Source, true
		}
	}
	// 原版 row.commandLine?.toLowerCase() 后 if (cmd)：undefined 与空串都跳过
	if row.CommandLine != nil && *row.CommandLine != "" {
		cmd := jsToLower(*row.CommandLine)
		for _, rule := range t.SourceByCmd {
			for _, n := range rule.Needles {
				if strings.Contains(cmd, n) {
					return rule.Source, true
				}
			}
		}
	}
	return "", false
}

// TraceLaunchSource 沿父链最多 12 层找启动来源，PRD §5.3。
//
// 本应用启动的进程直接判为 mile —— 这一层已经由归属判定确认过，不必再猜。
// 上溯途中撞到中间层（shell、包管理器）就继续往上；撞到认得的应用就停。
// 不跳过中间层的话所有 npm 启动的服务来源都是「终端」。
func TraceLaunchSource(t platform.AttributionTables, pid int, byPid map[int]platform.ProcessRow, owned bool) contract.LaunchSource {
	if owned {
		return contract.LaunchSourceMile
	}

	cursor := pid
	for hop := range MaxAscent {
		row, ok := byPid[cursor]
		if !ok {
			return contract.LaunchSourceUnknown
		}

		// 起点自身不算来源：一个 node 进程的来源是拉起它的东西，不是它自己
		if hop > 0 && !t.Transparent[jsToLower(row.Name)] {
			if hit, ok := sourceOf(t, row); ok {
				return hit
			}
		}

		// Windows 的 0 / 4 是 System Idle / System，macOS 的 1 是 launchd，都到顶了
		if row.Ppid <= 4 || row.Ppid == cursor {
			return contract.LaunchSourceUnknown
		}
		cursor = row.Ppid
	}
	return contract.LaunchSourceUnknown
}

// ClassifyGroup 分组推断，PRD §5.2。row 为 nil 即原版的 undefined；entryID 空串即原版的 undefined（两者都是假值）。
//
// 判据只用于「默认排在哪一组」，不影响能否停止 —— 那由归属判定决定。
// 用户手动提升或移回的结论优先于这里的一切推断。
func ClassifyGroup(t platform.AttributionTables, row *platform.ProcessRow, ownership contract.Ownership, entryID string) contract.ListenerGroup {
	// 本应用启动的、或已关联启动台条目的，一定是用户在开发的东西
	if ownership == contract.OwnershipOwned || entryID != "" {
		return contract.ListenerGroupMine
	}
	if row == nil {
		return contract.ListenerGroupBackground
	}

	// 系统目录下的进程归后台：装在这里的东西不是用户此刻在开发的项目
	exec := ""
	if row.ExecPath != nil {
		exec = jsToLower(*row.ExecPath)
	}
	for _, d := range t.SystemDirs {
		if strings.Contains(exec, d) {
			return contract.ListenerGroupBackground
		}
	}
	if t.DevRuntime[jsToLower(row.Name)] {
		return contract.ListenerGroupMine
	}
	return contract.ListenerGroupBackground
}

// jsToLower 即 String.prototype.toLowerCase，逐字复制自 internal/platform/win32/jsx.go（那边有全码点对拍）。
// 与 strings.ToLower 的差别只有两处：U+0130 展开成 i + U+0307（Go 给 i），Σ 按 Final_Sigma 规则选 ς / σ。
// 第一处会改变匹配结果：原版 `İDEA64.EXE` 认不出 JetBrains，strings.ToLower 会认出来。
func jsToLower(s string) string {
	rs := []rune(s)
	var sb strings.Builder
	sb.Grow(len(s))
	for i, r := range rs {
		switch r {
		case 0x130:
			sb.WriteRune('i')
			sb.WriteRune(0x307)
		case 0x3A3:
			if isFinalSigma(rs, i) {
				sb.WriteRune(0x3C2)
			} else {
				sb.WriteRune(0x3C3)
			}
		default:
			sb.WriteRune(unicode.ToLower(r))
		}
	}
	return sb.String()
}

func isFinalSigma(rs []rune, i int) bool {
	before := false
	for j := i - 1; j >= 0; j-- {
		if isCaseIgnorable(rs[j]) {
			continue
		}
		before = isCased(rs[j])
		break
	}
	if !before {
		return false
	}
	for k := i + 1; k < len(rs); k++ {
		if isCaseIgnorable(rs[k]) {
			continue
		}
		return !isCased(rs[k])
	}
	return true
}

func isCased(r rune) bool {
	return unicode.In(r, unicode.Lu, unicode.Ll, unicode.Lt, unicode.Other_Lowercase, unicode.Other_Uppercase)
}

func isCaseIgnorable(r rune) bool {
	switch r {
	case 0x27,
		0x2E, 0x2018, 0x2019, 0x2024, 0xFE52, 0xFF07, 0xFF0E,
		0x3A, 0xB7, 0x387, 0x55F, 0x5F4, 0x2027, 0xFE13, 0xFE55, 0xFF1A:
		return true
	}
	return unicode.In(r, unicode.Mn, unicode.Me, unicode.Cf, unicode.Lm, unicode.Sk)
}
