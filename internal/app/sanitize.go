// 对应 src/main/index.ts 的 sanitizeSettings 与 sanitizeLogQuery 两个校形函数。
//
// 它们排在服务层之前：绑定方法的入参先过这里，白名单外的键静默丢弃，非法值直接报错
// 且不落盘（原版 CLAUDE.md「新增 IPC 一律在 index.ts 里写 sanitize* 校形函数」）。

package app

import (
	"errors"
	"fmt"
	"strings"

	"mile-console/internal/contract"
)

// themes 即原版 THEMES。
var themes = map[contract.ThemePreference]bool{
	contract.ThemeLight: true, contract.ThemeDark: true, contract.ThemeSystem: true,
}

// logLevels 即原版 LOG_LEVELS。
var logLevels = map[contract.LogLevel]bool{
	contract.LogLevelInfo: true, contract.LogLevelWarn: true, contract.LogLevelError: true,
}

// maxLogQueryText 即原版 `raw.text.slice(0, 200)`。
const maxLogQueryText = 200

// SanitizeSettings 即原版 sanitizeSettings：只认认识的键与类型，逐字段校验。
// prev 是当前设置，补丁里没出现的字段保持原值。
func SanitizeSettings(prev contract.Settings, patch contract.SettingsPatch) (contract.Settings, error) {
	out := prev

	if patch.ScanIntervalMs != nil {
		ok := false
		allowed := make([]string, 0, len(contract.ScanIntervals))
		for _, v := range contract.ScanIntervals {
			allowed = append(allowed, itoa(v))
			if v == *patch.ScanIntervalMs {
				ok = true
			}
		}
		if !ok {
			return out, fmt.Errorf("采集周期只接受 %s 毫秒", strings.Join(allowed, " / "))
		}
		out.ScanIntervalMs = *patch.ScanIntervalMs
	}
	if patch.Theme != nil {
		if !themes[*patch.Theme] {
			return out, errors.New("主题只接受 light / dark / system")
		}
		out.Theme = *patch.Theme
	}
	if patch.ExternalTerminal != nil {
		ok := false
		for _, t := range contract.ExternalTerminals {
			if t == *patch.ExternalTerminal {
				ok = true
				break
			}
		}
		if !ok {
			names := make([]string, 0, len(contract.ExternalTerminals))
			for _, t := range contract.ExternalTerminals {
				names = append(names, string(t))
			}
			return out, fmt.Errorf("外部终端只接受 %s", strings.Join(names, " / "))
		}
		out.ExternalTerminal = *patch.ExternalTerminal
	}
	if patch.TerminalFontSize != nil {
		if v := *patch.TerminalFontSize; v < 10 || v > 22 {
			return out, errors.New("终端字号只接受 10–22 的整数")
		}
		out.TerminalFontSize = *patch.TerminalFontSize
	}
	if patch.Scrollback != nil {
		if v := *patch.Scrollback; v < 1000 || v > 50_000 {
			return out, errors.New("回滚行数只接受 1000–50000 的整数")
		}
		out.Scrollback = *patch.Scrollback
	}

	// 布尔项：没带的不动，带了就照抄
	if patch.KillOwnedOnQuit != nil {
		out.KillOwnedOnQuit = *patch.KillOwnedOnQuit
	}
	if patch.CloseToTray != nil {
		out.CloseToTray = *patch.CloseToTray
	}
	if patch.NotifyOnTaskDone != nil {
		out.NotifyOnTaskDone = *patch.NotifyOnTaskDone
	}
	if patch.HideFromTaskbar != nil {
		out.HideFromTaskbar = *patch.HideFromTaskbar
	}
	if patch.NotifyOnCrash != nil {
		out.NotifyOnCrash = *patch.NotifyOnCrash
	}
	if patch.LoginShellPath != nil {
		out.LoginShellPath = *patch.LoginShellPath
	}
	if patch.GlobalHotkey != nil {
		out.GlobalHotkey = *patch.GlobalHotkey
	}
	if patch.NotifyOnlyWhenBackground != nil {
		out.NotifyOnlyWhenBackground = *patch.NotifyOnlyWhenBackground
	}
	if patch.PlannerNotify != nil {
		out.PlannerNotify = *patch.PlannerNotify
	}
	if patch.PlannerSound != nil {
		out.PlannerSound = *patch.PlannerSound
	}

	return out, nil
}

// SanitizeLogQuery 即原版 sanitizeLogQuery：只放行认识的键与类型；
// limit 的上下限由日志中心自己再收一次。
func SanitizeLogQuery(q contract.LogQuery) (contract.LogQuery, error) {
	out := contract.LogQuery{}
	if q.SessionID != nil {
		out.SessionID = q.SessionID
	}
	if q.EntryID != nil {
		out.EntryID = q.EntryID
	}
	if q.Level != nil {
		if !logLevels[*q.Level] {
			return out, errors.New("日志级别只接受 info / warn / error")
		}
		out.Level = q.Level
	}
	// 关键字只做纯文本包含匹配，不构造正则 —— 用户输入 `(` 不该让查询抛异常
	if q.Text != nil {
		text := truncateUnits(*q.Text, maxLogQueryText)
		out.Text = &text
	}
	if q.Limit != nil {
		out.Limit = q.Limit
	}
	return out, nil
}

func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var b []byte
	for v > 0 {
		b = append([]byte{byte('0' + v%10)}, b...)
		v /= 10
	}
	if neg {
		return "-" + string(b)
	}
	return string(b)
}

// truncateUnits 即原版 `s.slice(0, n)`：按 UTF-16 码元截断。
func truncateUnits(s string, n int) string {
	units := 0
	for i, r := range s {
		w := 1
		if r >= 0x10000 {
			w = 2
		}
		if units+w > n {
			return s[:i]
		}
		units += w
	}
	return s
}
