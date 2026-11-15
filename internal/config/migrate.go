// 对应 src/main/services/ConfigStore.ts 的 DEFAULTS 与 migrate()。
//
// 显式、幂等的 schema 迁移，PRD §8。
// 不靠 `{...DEFAULTS, ...raw}` 兜底就完事：那样 v1 的文件会被当成 v2 用，
// 版本号永远停在 1，下一次真需要区分新旧结构时就没有依据了。每一版单独一步，
// 重复跑同一步不改变结果。
//
// 原版先把 raw 整个铺进 out 再逐步修；Go 用结构体（已接受偏差，见 loose.go 文件头），
// 「删掉某个键」对应把该字段置零值（omitempty / omitzero 让它不出现在 JSON 里）。

package config

import (
	"encoding/json"
	"slices"
	"strings"
	"unicode/utf16"

	"mile-console/internal/contract"
)

// MaxIgnoredListeners 「忽略此监听」列表上限：每条都在每个采集周期参与匹配，不让它无限增长。
const MaxIgnoredListeners = 500

// TerminalPlatform 迁移里唯一的平台相关取值：外部终端的合法集合与默认值（原版 platform.terminalKinds / defaultTerminal）。
type TerminalPlatform interface {
	TerminalKinds() []contract.ExternalTerminal
	DefaultTerminal() contract.ExternalTerminal
}

// Defaults 即原版 DEFAULTS。每次调用返回新值（原版 structuredClone(DEFAULTS)）。
func Defaults(p TerminalPlatform) contract.AppConfig {
	return contract.AppConfig{
		Version:          contract.ConfigVersion,
		Entries:          []contract.LaunchEntry{},
		Groups:           []contract.ProjectGroup{},
		IgnoredListeners: []contract.IgnoredListener{},
		GroupOverrides:   []contract.GroupOverride{},
		WatchedKeywords:  []string{},
		Settings: contract.Settings{
			ScanIntervalMs: 2000,
			// UI 重构 Q16：先打磨浅色，新配置默认浅色。已保存的偏好由 {...DEFAULTS.settings, ...raw.settings} 保留
			Theme:                    contract.ThemeLight,
			ExternalTerminal:         p.DefaultTerminal(),
			TerminalFontSize:         13,
			Scrollback:               5000,
			KillOwnedOnQuit:          true,
			CloseToTray:              false,
			NotifyOnTaskDone:         true,
			HideFromTaskbar:          false,
			NotifyOnCrash:            true,
			NotifyOnlyWhenBackground: true,
			GlobalHotkey:             true,
			LoginShellPath:           false,
			// 进度与日程 P2：日程提醒与声音，默认都开（用户 2026-11-06 选定）
			PlannerNotify: true,
			PlannerSound:  true,
		},
	}
}

// rawConfig 只解出迁移要判断「键是否存在 / 是不是数组」的那几项，其余字段走宽松解码。
type rawConfig struct {
	Version          json.RawMessage `json:"version"`
	Entries          json.RawMessage `json:"entries"`
	Groups           json.RawMessage `json:"groups"`
	IgnoredListeners json.RawMessage `json:"ignoredListeners"`
	GroupOverrides   json.RawMessage `json:"groupOverrides"`
	WatchedKeywords  json.RawMessage `json:"watchedKeywords"`
	Settings         json.RawMessage `json:"settings"`
}

// Migrate 即原版 migrate(raw)。raw 必须是 JSON 对象（read() 已挡掉数组、null、标量）。
func Migrate(raw json.RawMessage, p TerminalPlatform) contract.AppConfig {
	defaults := Defaults(p)
	var r rawConfig
	_ = decodeLoose(raw, &r)

	// const from = typeof raw.version === 'number' ? raw.version : 1
	from := 1.0
	if rawKind(r.Version) == '0' {
		if f, ok := jsNumber(r.Version); ok {
			from = f
		}
	}

	// out = { ...DEFAULTS, ...raw, version: CONFIG_VERSION, settings: { ...DEFAULTS.settings, ...raw.settings } }
	out := defaults
	out.Version = contract.ConfigVersion
	// 原版铺开后数组字段可能是任何类型；迁移末尾的校形把非数组换成 []。这里先记下「原值是不是数组」
	entriesIsArray := decodeArray(r.Entries, &out.Entries)
	groupsIsArray := decodeArray(r.Groups, &out.Groups)
	decodeArray(r.IgnoredListeners, &out.IgnoredListeners)
	decodeArray(r.GroupOverrides, &out.GroupOverrides)
	decodeArray(r.WatchedKeywords, &out.WatchedKeywords)
	// settings 铺开：原值是对象时逐字段覆盖默认值；数组 / 标量 / null 铺开后没有自有键，等于全取默认
	if rawKind(r.Settings) == '{' {
		_ = decodeLoose(r.Settings, &out.Settings)
	}
	rawEntries := rawElements(r.Entries)
	rawGroups := rawElements(r.Groups)

	// v1 → v2：分组覆盖与关注关键字是新增的，老文件里没有
	if from < 2 {
		out.GroupOverrides = []contract.GroupOverride{}
		out.WatchedKeywords = []string{}
	}

	// v2 → v3：任务完成通知。老用户默认开着 —— 这是个提示而非行为变更，
	// 且默认关掉会让「加了通知功能」在升级后看起来毫无变化
	if from < 3 {
		out.Settings.NotifyOnTaskDone = true
	}

	// v3 -> v4：此前没有受支持的自定义服务图标。丢弃手工塞入的旧字段，
	// 让升级后的条目回退到自动框架字标，而不是信任未经白名单校验的数据。
	if from < 4 && entriesIsArray {
		for i := range out.Entries {
			out.Entries[i].Icon = ""
		}
	}

	// v4 -> v5: category is optional. Entries without it render under the
	// unclassified panel; malformed legacy values are discarded on upgrade.
	if from < 5 && entriesIsArray {
		for i := range out.Entries {
			out.Entries[i].Category = migrateCategory(rawField(rawEntries[i], "category"))
		}
	}

	// v5 -> v6：从任务栏隐藏（仅托盘）。默认关，行为对现有用户保持不变
	if from < 6 {
		out.Settings.HideFromTaskbar = defaults.Settings.HideFromTaskbar
	}

	// v6 -> v7：LaunchEntry 新增可选的 launchMode / jarPath（仅 Spring Boot 用）。仅推进版本号，不回填。
	// v7 -> v8：LaunchEntry 新增可选的 imageId。仅推进版本号，不回填。

	// v8 -> v9：AppConfig 新增 groups 字段（工作组列表）；LaunchEntry 新增可选 groupId。
	// 老条目无 groupId，保持缺省即可；groups 数组初始化为空，用户自行创建。
	// （groups 不是数组时末尾校形同样换成 []，这一步在 Go 里没有额外效果）

	// v9 -> v10：崩溃通知两个开关。默认都开：窗口收起时服务挂了本来就该知道，
	// 且只在后台弹，前台使用时行为与升级前一致
	if from < 10 {
		out.Settings.NotifyOnCrash = defaults.Settings.NotifyOnCrash
		out.Settings.NotifyOnlyWhenBackground = defaults.Settings.NotifyOnlyWhenBackground
	}

	// v10 -> v11：全局快捷键。默认开，用户选定的行为；组合键被占用时只提示不报错
	if from < 11 {
		out.Settings.GlobalHotkey = defaults.Settings.GlobalHotkey
	}

	// v11 -> v12：条目新增可选 startAfter。老条目没有即「不等待」，不回填；这一步只推进版本号

	// v12 -> v13：macOS 适配。新增 loginShellPath（默认关）。
	if from < 13 {
		out.Settings.LoginShellPath = defaults.Settings.LoginShellPath
	}
	// 外部终端取值按平台收：配置从另一个平台带过来（导入、同步盘）时回落到本平台默认值。
	// 每次都做，不只在迁移时：这是平台相关的取值，不是 schema
	if !slices.Contains(p.TerminalKinds(), out.Settings.ExternalTerminal) {
		out.Settings.ExternalTerminal = p.DefaultTerminal()
	}

	// v13 -> v14：条目新增可选 healthCheck / autoRestart / alertKeywords / alertOnErrors。
	// 都不回填：缺省即「关」。v14 之前不可能合法地出现这几个键，手工塞进去的一律丢掉，
	// 与 v4 丢弃未经白名单的 icon 同一个口径 —— 尤其 autoRestart，不能因为一份手改的
	// 旧配置就让条目在无人值守时被自动拉起
	if from < 14 && entriesIsArray {
		for i := range out.Entries {
			out.Entries[i].HealthCheck = nil
			out.Entries[i].AutoRestart = nil
			out.Entries[i].AlertKeywords = nil
			out.Entries[i].AlertOnErrors = nil
		}
	}

	// v14 -> v15：工作组新增可选 pinned（置顶）。不回填，缺省即不置顶；
	// 值不是布尔的（手改）直接丢掉，免得排序比较出怪结果
	// （宽松解码已把非布尔的 pinned 丢掉；null 在原版里也会被丢掉，这里同样置 nil）
	if from < 15 && groupsIsArray {
		for i := range out.Groups {
			k := rawKind(rawField(rawGroups[i], "pinned"))
			if k != 't' && k != 'f' {
				out.Groups[i].Pinned = nil
			}
		}
	}

	// v15 -> v16：日程提醒两个开关（进度与日程 P2）。默认都开，与 PRD-PLANNER §9 决策 2 一致
	if from < 16 {
		out.Settings.PlannerNotify = defaults.Settings.PlannerNotify
		out.Settings.PlannerSound = defaults.Settings.PlannerSound
	}

	// 迁移后仍要校形：数组字段被手改成对象会让下游 .some / .filter 直接抛（decodeArray 已换成 []）
	// 元素结构不对（手改、旧版本 IPC 未校形时写进去的）会让 ScannerService 的匹配静默失效
	out.IgnoredListeners = filterIgnored(rawElements(r.IgnoredListeners), out.IgnoredListeners)
	// 主题值手改坏了，ThemeService 构造时赋给 nativeTheme.themeSource 会直接抛，应用起不来
	if !slices.Contains(contract.ThemePreferences, out.Settings.Theme) {
		out.Settings.Theme = defaults.Settings.Theme
	}

	return out
}

// decodeArray 原值是数组时宽松解码进 dst 并返回 true；否则 dst 置空数组（原版末尾校形）。
func decodeArray[T any](raw json.RawMessage, dst *[]T) bool {
	if rawKind(raw) != '[' {
		*dst = []T{}
		return false
	}
	*dst = []T{}
	_ = decodeLoose(raw, dst)
	return true
}

// rawElements 取数组里「会被宽松解码收下」的那些元素的原文，与 decodeArray 的结果一一对应。
func rawElements(raw json.RawMessage) []json.RawMessage {
	if rawKind(raw) != '[' {
		return nil
	}
	var items []json.RawMessage
	if json.Unmarshal(raw, &items) != nil {
		return nil
	}
	out := items[:0]
	for _, it := range items {
		if rawKind(it) == '{' {
			out = append(out, it)
		}
	}
	return out
}

func rawField(obj json.RawMessage, key string) json.RawMessage {
	var m map[string]json.RawMessage
	if json.Unmarshal(obj, &m) != nil {
		return nil
	}
	return m[key]
}

// migrateCategory 即 v4→v5 的分类规整：字符串 trim 后非空、不超过 40 个 UTF-16 码元、不含 C0 控制符与 DEL 才保留。
func migrateCategory(raw json.RawMessage) string {
	if rawKind(raw) != '"' {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return ""
	}
	c := strings.TrimFunc(s, jsIsSpace)
	if c == "" || len(utf16.Encode([]rune(c))) > 40 {
		return ""
	}
	for _, r := range c {
		if r <= 0x1F || r == 0x7F {
			return ""
		}
	}
	return c
}

// filterIgnored 即迁移末尾 ignoredListeners 的过滤 + slice(0, 500)。
// processName 必须是非空字符串、长度不超过 260 个 UTF-16 码元；port 必须是 1..65535 的整数。
// 用原文判断「是不是字符串 / 是不是整数」，因为宽松解码会把类型不对的字段变成零值，零值本身也会被这里拒掉。
func filterIgnored(raws []json.RawMessage, decoded []contract.IgnoredListener) []contract.IgnoredListener {
	out := []contract.IgnoredListener{}
	for i, d := range decoded {
		if i >= len(raws) {
			break
		}
		if rawKind(rawField(raws[i], "processName")) != '"' {
			continue
		}
		n := len(utf16.Encode([]rune(d.ProcessName)))
		if n == 0 || n > 260 || d.Port < 1 || d.Port > 65535 {
			continue
		}
		if !isIntegerRaw(rawField(raws[i], "port")) {
			continue
		}
		out = append(out, d)
	}
	if len(out) > MaxIgnoredListeners {
		out = out[:MaxIgnoredListeners]
	}
	return out
}

func isIntegerRaw(raw json.RawMessage) bool {
	if rawKind(raw) != '0' {
		return false
	}
	f, ok := jsNumber(raw)
	return ok && f == float64(int64(f))
}

// jsIsSpace 即 JS trim 的空白集合（含 U+FEFF，不含 U+0085）。写成码点，避免编辑工具把转义换成不可见字符。
func jsIsSpace(r rune) bool {
	switch r {
	case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}
