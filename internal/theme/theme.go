// 对应 src/main/services/ThemeService.ts。
//
// 原版 ThemeService 很薄：包一层 Electron nativeTheme，把 ThemePreference
// 同步给系统并把解析后的 ResolvedTheme 广播给渲染层。mygo 侧对应 API 是
// mygo.Theme.SetSource（必须在建窗前调用，S24/S32 装配），本包只负责校形与
// 状态持有；SetSource 的真实调用与 'updated' 监听在绑定层完成。

package theme

import (
	"errors"

	"mile-console/internal/contract"
)

// SAFE_THEME_PREFS 即原版 ThemePreference 联合：'light' | 'dark' | 'system'。
// 其它值（空串、大小写变体、null）一律拒绝。
var SAFE_THEME_PREFS = map[contract.ThemePreference]struct{}{
	contract.ThemeLight:  {},
	contract.ThemeDark:   {},
	contract.ThemeSystem: {},
}

// Validate 校形用户输入的 ThemePreference。
// 原版靠 TS 类型系统在编译期挡住非法值；Go 侧从绑定层进来的是字符串，需要运行期校形。
func Validate(p contract.ThemePreference) (contract.ThemePreference, error) {
	if _, ok := SAFE_THEME_PREFS[p]; ok {
		return p, nil
	}
	return "", errors.New("主题偏好只接受 light / dark / system")
}

// State 计算当前的 ThemeState。
// resolved 由平台层（mygo.Theme / 系统主题查询）给出；本函数只做装配。
func State(preference contract.ThemePreference, resolved contract.ResolvedTheme) contract.ThemeState {
	return contract.ThemeState{Preference: preference, Resolved: resolved}
}
