// 对应 src/main/lib/outputText.ts：会话输出的文本处理，日志中心与诊断共用一套规则（原版 2.3.0）。
//
// 五个正则逐字照搬原版。转义序列一律写成 \x1b 这种可见形式，不敲字面 ESC 字节。
//
// JS 与 Go 的语义差异在这里抹平，期望值由 scripts/gen-outputtext-cases.mjs 跑原版 TS 生成，
// 见 outputtext_test.go：
//   - 原版正则不带 u 标志，i 只在 ASCII 字母之间折叠；Go 的 (?i) 按 Unicode 折叠，s 还会命中
//     U+017F、k 还会命中 U+212A。匹配前用 jsFoldSafe 把这两个字符换掉。
//   - JS 的 trim / trimEnd / \s 认的空白集合与 Go 的 unicode.IsSpace、RE2 的 \s 都不同（JS 含
//     U+FEFF、不含 U+0085；RE2 的 \s 连 \v 和 U+3000 都不含），这里用 jsIsSpace 与 jsSpaceClass。
//   - String.prototype.slice 按 UTF-16 码元计数，jsSlice 照此截断；截在代理对中间时，原版得到孤立
//     代理项（经 IPC / JSON 到页面显示为替换字符），这里直接给 U+FFFD。
//   - Array.prototype.slice(-limit) 在 limit 为 0 时返回全部、为负时从头丢掉 |limit| 项，jsTail 照搬。
//
// 入参应是合法 UTF-8（原版拿到的是 node-pty 解码好的 JS 字符串）；字节流解码由 S18 会话层负责。

package logs

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

var (
	// ansiRE 是原版 ANSI：CSI（颜色与光标移动）与 OSC（设置窗口标题，以 BEL 或 ST 收尾）。
	ansiRE = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)`)
	// controlRE 是原版 CONTROL：剩下的裸控制字符（退格、响铃…），留着会在界面上显示成方块。
	controlRE = regexp.MustCompile(`[\x00-\x08\x0b-\x1f]`)
	// cursorToCol1RE 是原版 CURSOR_TO_COL1。ConPTY 换行不一定发 \n，常用绝对光标定位跳到下一行行首
	// （实测 \x1b[5;1H）。只认回到第 1 列，定位到其他列是同一行内的重绘。
	cursorToCol1RE = regexp.MustCompile(`\x1b\[[0-9]+;1[Hf]`)
	// errorRE 是原版 ERROR_RE。只认明确的词形，拿不准就不算。
	errorRE = regexp.MustCompile(`(?i)\b(error|err!|failed|failure|exception|cannot find|not found|ELIFECYCLE|ENOENT|EADDRINUSE|BUILD FAILURE|APPLICATION FAILED TO START)\b|[A-Za-z]+(?:Exception|Error)\b|错误|失败`)
	// warnRE 是原版 WARN_RE。
	warnRE = regexp.MustCompile(`(?i)\b(warn|warning|deprecated|deprecation)\b|警告`)
	// pmTrailerRE 是原版 pickLastError 里的内联正则 /^\s*(npm|pnpm|yarn)( ERR!| error|:)|ELIFECYCLE/i，
	// \s 换成 JS 的空白集合。
	pmTrailerRE = regexp.MustCompile(`(?i)^` + jsSpaceClass + `*(npm|pnpm|yarn)( ERR!| error|:)|ELIFECYCLE`)
)

// jsSpaceClass 是 JS 正则 \s 的集合：WhiteSpace（TAB、VT、FF、ZWNBSP、Zs）+ LineTerminator（LF、CR、LS、PS）。
const jsSpaceClass = `[\t\n\v\f\r\x{2028}\x{2029}\x{feff}\p{Zs}]`

// DefaultTailMaxChars 是原版 visibleTail 的 maxChars 默认值。
const DefaultTailMaxChars = 300

// StripAnsi 去掉 CSI / OSC 转义序列。
func StripAnsi(text string) string { return ansiRE.ReplaceAllString(text, "") }

// CursorToNewline 把「回到第 1 列」的绝对光标定位换成 \n，即原版 raw.replace(CURSOR_TO_COL1, '\n')。
func CursorToNewline(raw string) string { return cursorToCol1RE.ReplaceAllString(raw, "\n") }

// IsErrorLine 即原版 isErrorLine / ERROR_RE.test。
func IsErrorLine(text string) bool { return errorRE.MatchString(jsFoldSafe(text)) }

// IsWarnLine 即原版 WARN_RE.test。
func IsWarnLine(text string) bool { return warnRE.MatchString(jsFoldSafe(text)) }

// LastVisiblePaint 取这一行最后一次「画出了东西」的重绘结果。进度条用裸 \r 原地重写同一行，要取最后一段；
// 但 ConPTY 在输出末尾还会补 \r + 擦除序列，那一段清理完是空的，所以从后往前找第一个有内容的段。
func LastVisiblePaint(raw string) string {
	paints := strings.Split(raw, "\r")
	for i := len(paints) - 1; i >= 0; i-- {
		text := controlRE.ReplaceAllString(ansiRE.ReplaceAllString(paints[i], ""), "")
		text = strings.TrimRightFunc(text, jsIsSpace)
		if strings.TrimFunc(text, jsIsSpace) != "" {
			return text
		}
	}
	return ""
}

// VisibleTail 即原版 visibleTail(raw, limit)：一段原始终端输出切成可见行（去 ANSI、去进度条重绘、去空行），
// 只留最后 limit 行，每行最多 DefaultTailMaxChars 个 UTF-16 码元。
func VisibleTail(raw string, limit int) []string {
	return VisibleTailMax(raw, limit, DefaultTailMaxChars)
}

// VisibleTailMax 即原版 visibleTail(raw, limit, maxChars)。返回值非 nil。
func VisibleTailMax(raw string, limit, maxChars int) []string {
	lines := []string{}
	for _, part := range splitLines(CursorToNewline(raw)) {
		if text := LastVisiblePaint(part); text != "" {
			lines = append(lines, jsSlice(text, maxChars))
		}
	}
	return jsTail(lines, limit)
}

// PickLastError 从可见行里挑「最后一个错误行」。npm / pnpm 在脚本失败后自己追加的 `npm error …` 收尾块
// 只说明「脚本以非零码退出」，真正的原因在它前面；有别的错误行时优先用别的。
// 原版返回 undefined 的情形这里返回 ("", false)。
func PickLastError(lines []string) (string, bool) {
	var errs, real []string
	for _, l := range lines {
		if !IsErrorLine(l) {
			continue
		}
		errs = append(errs, l)
		if !pmTrailerRE.MatchString(jsFoldSafe(l)) {
			real = append(real, l)
		}
	}
	pick := errs
	if len(real) > 0 {
		pick = real
	}
	if len(pick) == 0 {
		return "", false
	}
	return pick[len(pick)-1], true
}

const (
	longS  = '\u017f' // LATIN SMALL LETTER LONG S，Go (?i) 下与 s 折叠
	kelvin = '\u212a' // KELVIN SIGN，Go (?i) 下与 k 折叠
	// foldBlocker 不是单词字符、不是字母、不是空白，换上去之后任何规则都不会因它命中。
	foldBlocker = '\u0080'
)

// jsFoldSafe 让 Go 的 (?i) 只在 ASCII 字母之间折叠，与不带 u 标志的 JS 正则一致。只用于匹配。
func jsFoldSafe(s string) string {
	return strings.Map(func(r rune) rune {
		if r == longS || r == kelvin {
			return foldBlocker
		}
		return r
	}, s)
}

// jsIsSpace 是 JS String.prototype.trim 认的空白：WhiteSpace + LineTerminator。
func jsIsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', '\u2028', '\u2029', '\ufeff':
		return true
	}
	return unicode.Is(unicode.Zs, r)
}

// splitLines 即 JS 的 s.split(/\r?\n/)。
func splitLines(s string) []string {
	parts := strings.Split(s, "\n")
	for i := 0; i < len(parts)-1; i++ {
		parts[i] = strings.TrimSuffix(parts[i], "\r")
	}
	return parts
}

// jsSlice 即 JS 的 s.slice(0, end)，按 UTF-16 码元计数。
func jsSlice(s string, end int) string {
	if end < 0 {
		end = max(utf16Len(s)+end, 0)
	}
	units := 0
	for i, r := range s {
		w := utf16Width(r)
		if units+w > end {
			if w == 2 && units+1 == end {
				return s[:i] + string(utf8.RuneError)
			}
			return s[:i]
		}
		units += w
	}
	return s
}

func utf16Width(r rune) int {
	if r >= 0x10000 {
		return 2
	}
	return 1
}

func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		n += utf16Width(r)
	}
	return n
}

// jsTail 即 JS 的 lines.slice(-limit)：limit 为 0 时返回全部，为负时从头丢掉 |limit| 项。
func jsTail(lines []string, limit int) []string {
	start := -limit
	if start < 0 {
		start = max(len(lines)+start, 0)
	} else {
		start = min(start, len(lines))
	}
	return lines[start:]
}
