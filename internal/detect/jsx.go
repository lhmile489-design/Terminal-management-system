// JS 语义的字符串与路径函数，逐字复制自 internal/platform/win32/jsx.go（那边有对拍：
// testdata/win32_text_cases.json、win32_platform_cases.json），外加 node path.win32 的 basename / extname。
// detect 包不带 windows 构建标签（识别逻辑是纯文件读取），所以复制而不是引用 win32 包里的未导出函数。
//
// 对应原版 DetectService.ts 用到的：readFile(..., 'utf8')、String.prototype.trim / toLowerCase、
// node:path 的 join / resolve / basename / extname / sep（Windows 上即 path.win32）。

package detect

import (
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"
)

// jsDecodeUTF8 即 Buffer.toString('utf8')：每个「最长非法子序列」替换成一个 U+FFFD（WHATWG Encoding 标准）。
// 不能用 strings.ToValidUTF8（连续非法字节只换一个），也不能逐字节换（截断的多字节序列会多出替换符）。
func jsDecodeUTF8(b []byte) string {
	var sb strings.Builder
	sb.Grow(len(b))
	n := len(b)
	for i := 0; i < n; {
		c := b[i]
		if c < 0x80 {
			sb.WriteByte(c)
			i++
			continue
		}
		need := 0
		lower, upper := byte(0x80), byte(0xBF)
		switch {
		case c >= 0xC2 && c <= 0xDF:
			need = 1
		case c >= 0xE0 && c <= 0xEF:
			need = 2
			if c == 0xE0 {
				lower = 0xA0
			}
			if c == 0xED {
				upper = 0x9F
			}
		case c >= 0xF0 && c <= 0xF4:
			need = 3
			if c == 0xF0 {
				lower = 0x90
			}
			if c == 0xF4 {
				upper = 0x8F
			}
		default:
			sb.WriteRune(utf8.RuneError)
			i++
			continue
		}
		j := i + 1
		ok := true
		for k := 0; k < need; k++ {
			if j >= n || b[j] < lower || b[j] > upper {
				ok = false
				break
			}
			lower, upper = 0x80, 0xBF
			j++
		}
		if !ok {
			// 已吃掉的前导字节与合法的后续字节算一个非法子序列；出错的那个字节留给下一轮重新判断
			sb.WriteRune(utf8.RuneError)
			i = j
			continue
		}
		sb.Write(b[i:j])
		i = j
	}
	return sb.String()
}

// jsIsSpace 即 JS 的 WhiteSpace + LineTerminator：trim 与正则 \s 用的是同一个集合。
// 写成十六进制码点而不是转义字面量，避免编辑工具把它们换成不可见字符。
func jsIsSpace(r rune) bool {
	switch r {
	case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0x2028, 0x2029, 0xFEFF:
		return true
	}
	return unicode.Is(unicode.Zs, r)
}

func jsTrim(s string) string {
	return strings.TrimFunc(s, jsIsSpace)
}

// jsToLower 即 String.prototype.toLowerCase：逐码点映射，外加两条上下文规则——
//   - U+0130 展开成 i + U+0307
//   - U+03A3（Σ）按 Final_Sigma 规则：往前跳过可忽略大小写的字符后紧邻有大小写的字母、往后跳过之后没有，
//     就变成词尾形式 U+03C2（ς），否则 U+03C3（σ）。跳过时先判可忽略（与 V8 / ICU 一致：
//     ʰ 这类既有大小写又可忽略的字符一律跳过）
//
// 逐码点映射与 node 全表对拍见 TestJSToLowerTable；两个字符集合与 node 的行为推导结果对拍见 TestFinalSigmaSets。
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

// isCased 即 Unicode 派生属性 Cased：Lu | Ll | Lt | Other_Lowercase | Other_Uppercase。
func isCased(r rune) bool {
	return unicode.In(r, unicode.Lu, unicode.Ll, unicode.Lt, unicode.Other_Lowercase, unicode.Other_Uppercase)
}

// isCaseIgnorable 即 Unicode 派生属性 Case_Ignorable：Mn | Me | Cf | Lm | Sk，
// 加 Word_Break 为 MidLetter / MidNumLet / Single_Quote 的字符（Go 没有 Word_Break 表，这里列出）。
func isCaseIgnorable(r rune) bool {
	switch r {
	case 0x27, // Single_Quote
		0x2E, 0x2018, 0x2019, 0x2024, 0xFE52, 0xFF07, 0xFF0E, // MidNumLet
		0x3A, 0xB7, 0x387, 0x55F, 0x5F4, 0x2027, 0xFE13, 0xFE55, 0xFF1A: // MidLetter
		return true
	}
	return unicode.In(r, unicode.Mn, unicode.Me, unicode.Cf, unicode.Lm, unicode.Sk)
}

func isPathSep(c byte) bool { return c == '/' || c == '\\' }

func isDeviceRoot(c byte) bool { return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') }

// jsResolve 逐行移植 node lib/path.js 的 win32.resolve（node 22）。
// cwd 即 process.cwd()；env 查 `=C:` 这类驱动器当前目录变量（Windows 下 process.env 不区分大小写）。
// 索引按字节走：比较的都是 ASCII 分隔符与盘符，UTF-8 的多字节序列不会误中，结果与按 UTF-16 码元走一致。
func jsResolve(cwd func() string, env func(string) (string, bool), args ...string) string {
	resolvedDevice := ""
	resolvedTail := ""
	resolvedAbsolute := false

	for i := len(args) - 1; i >= -1; i-- {
		var path string
		if i >= 0 {
			path = args[i]
			if path == "" {
				continue
			}
		} else if resolvedDevice == "" {
			path = cwd()
			if len(args) == 0 || (len(args) == 1 && (args[0] == "" || args[0] == ".") && path != "" && isPathSep(path[0])) {
				return path
			}
		} else {
			v, ok := env("=" + resolvedDevice)
			if ok && v != "" {
				path = v
			} else {
				path = cwd()
			}
			// JS：slice(0, 2) 不等且 charCodeAt(2) 是反斜杠才退回盘根；路径不足 3 个字符时 charCodeAt(2) 是 NaN，不退回
			if len(path) > 2 && path[2] == '\\' && !strings.EqualFold(path[:2], resolvedDevice) {
				path = resolvedDevice + "\\"
			}
		}

		n := len(path)
		rootEnd := 0
		device := ""
		isAbsolute := false
		code := byte(0)
		if n > 0 {
			code = path[0]
		}

		if n == 1 {
			if isPathSep(code) {
				rootEnd = 1
				isAbsolute = true
			}
		} else if n > 1 && isPathSep(code) {
			isAbsolute = true
			if isPathSep(path[1]) {
				j := 2
				last := j
				for j < n && !isPathSep(path[j]) {
					j++
				}
				if j < n && j != last {
					firstPart := path[last:j]
					last = j
					for j < n && isPathSep(path[j]) {
						j++
					}
					if j < n && j != last {
						last = j
						for j < n && !isPathSep(path[j]) {
							j++
						}
						if j == n || j != last {
							if firstPart != "." && firstPart != "?" {
								device = "\\\\" + firstPart + "\\" + path[last:j]
								rootEnd = j
							} else {
								device = "\\\\" + firstPart
								rootEnd = 4
							}
						}
					}
				}
			} else {
				rootEnd = 1
			}
		} else if n > 1 && isDeviceRoot(code) && path[1] == ':' {
			device = path[:2]
			rootEnd = 2
			if n > 2 && isPathSep(path[2]) {
				isAbsolute = true
				rootEnd = 3
			}
		}

		if device != "" {
			if resolvedDevice != "" {
				if !strings.EqualFold(device, resolvedDevice) {
					continue
				}
			} else {
				resolvedDevice = device
			}
		}

		if resolvedAbsolute {
			if resolvedDevice != "" {
				break
			}
		} else {
			resolvedTail = path[rootEnd:] + "\\" + resolvedTail
			resolvedAbsolute = isAbsolute
			if isAbsolute && resolvedDevice != "" {
				break
			}
		}
	}

	resolvedTail = normalizeString(resolvedTail, !resolvedAbsolute, '\\')

	if resolvedAbsolute {
		return resolvedDevice + "\\" + resolvedTail
	}
	if s := resolvedDevice + resolvedTail; s != "" {
		return s
	}
	return "."
}

// windowsReservedNames 即 node lib/path.js 的 WINDOWS_RESERVED_NAMES（末六项是上标 1 2 3：U+00B9 U+00B2 U+00B3）。
var windowsReservedNames = map[string]bool{
	"CON": true, "PRN": true, "AUX": true, "NUL": true,
	"COM1": true, "COM2": true, "COM3": true, "COM4": true, "COM5": true, "COM6": true, "COM7": true, "COM8": true, "COM9": true,
	"LPT1": true, "LPT2": true, "LPT3": true, "LPT4": true, "LPT5": true, "LPT6": true, "LPT7": true, "LPT8": true, "LPT9": true,
	"COM" + string(rune(0xB9)): true, "COM" + string(rune(0xB2)): true, "COM" + string(rune(0xB3)): true,
	"LPT" + string(rune(0xB9)): true, "LPT" + string(rune(0xB2)): true, "LPT" + string(rune(0xB3)): true,
}

// isWindowsReservedName 即 node 的同名函数。colonIndex 为 -1 时 JS 的 slice(0, -1) 去掉最后一个字符。
// 大写用 strings.ToUpper：与 JS toUpperCase 只在多码点展开（ß → SS 等）上不同，展开结果都不可能落进上面的名单。
func isWindowsReservedName(path string, colonIndex int) bool {
	var part string
	if colonIndex >= 0 {
		part = path[:colonIndex]
	} else {
		u := utf16.Encode([]rune(path))
		if len(u) == 0 {
			return false
		}
		part = string(utf16.Decode(u[:len(u)-1]))
	}
	return windowsReservedNames[strings.ToUpper(part)]
}

// jsNormalize 逐行移植 node lib/path.js 的 win32.normalize（node 22）。
func jsNormalize(path string) string {
	n := len(path)
	if n == 0 {
		return "."
	}
	rootEnd := 0
	device := ""
	hasDevice := false
	isAbsolute := false
	code := path[0]

	if n == 1 {
		if code == '/' {
			return "\\"
		}
		return path
	}
	if isPathSep(code) {
		isAbsolute = true
		if isPathSep(path[1]) {
			j := 2
			last := j
			for j < n && !isPathSep(path[j]) {
				j++
			}
			if j < n && j != last {
				firstPart := path[last:j]
				last = j
				for j < n && isPathSep(path[j]) {
					j++
				}
				if j < n && j != last {
					last = j
					for j < n && !isPathSep(path[j]) {
						j++
					}
					if j == n || j != last {
						if firstPart == "." || firstPart == "?" {
							device = "\\\\" + firstPart
							hasDevice = true
							rootEnd = 4
							colonIndex := strings.IndexByte(path, ':')
							possibleDevice := jsSliceBytes(path, 4, colonIndex+1)
							if isWindowsReservedName(possibleDevice, len(possibleDevice)-1) {
								device = "\\\\?\\" + possibleDevice
								rootEnd = 4 + len(possibleDevice)
							}
						} else if j == n {
							return "\\\\" + firstPart + "\\" + path[last:] + "\\"
						} else {
							device = "\\\\" + firstPart + "\\" + path[last:j]
							hasDevice = true
							rootEnd = j
						}
					}
				}
			}
		} else {
			rootEnd = 1
		}
	} else {
		colonIndex := strings.IndexByte(path, ':')
		if colonIndex > 0 {
			if isDeviceRoot(code) && colonIndex == 1 {
				device = path[:2]
				hasDevice = true
				rootEnd = 2
				if n > 2 && isPathSep(path[2]) {
					isAbsolute = true
					rootEnd = 3
				}
			} else if isWindowsReservedName(path, colonIndex) {
				device = path[:colonIndex+1]
				hasDevice = true
				rootEnd = colonIndex + 1
			}
		}
	}

	tail := ""
	if rootEnd < n {
		tail = normalizeString(path[rootEnd:], !isAbsolute, '\\')
	}
	if tail == "" && !isAbsolute {
		tail = "."
	}
	if tail != "" && isPathSep(path[n-1]) {
		tail += "\\"
	}
	if !isAbsolute && !hasDevice && strings.Contains(path, ":") {
		if len(tail) >= 2 && isDeviceRoot(tail[0]) && tail[1] == ':' {
			return ".\\" + tail
		}
		for index := strings.IndexByte(path, ':'); index != -1; {
			if index == n-1 || isPathSep(path[index+1]) {
				return ".\\" + tail
			}
			next := strings.IndexByte(path[index+1:], ':')
			if next == -1 {
				break
			}
			index += 1 + next
		}
	}
	if isWindowsReservedName(path, strings.IndexByte(path, ':')) {
		return ".\\" + device + tail
	}
	if !hasDevice {
		if isAbsolute {
			return "\\" + tail
		}
		return tail
	}
	if isAbsolute {
		return device + "\\" + tail
	}
	return device + tail
}

// jsSliceBytes 即 String.prototype.slice(start, end) 的非负 / 负数下标规则，按字节下标（调用处只有 ASCII 前缀）。
func jsSliceBytes(s string, start, end int) string {
	n := len(s)
	if end < 0 {
		end += n
	}
	start = min(max(start, 0), n)
	end = min(max(end, 0), n)
	if start >= end {
		return ""
	}
	return s[start:end]
}

// jsJoin 逐行移植 node lib/path.js 的 win32.join（node 22）。
func jsJoin(args ...string) string {
	var parts []string
	for _, a := range args {
		if a != "" {
			parts = append(parts, a)
		}
	}
	if len(parts) == 0 {
		return "."
	}
	firstPart := parts[0]
	joined := strings.Join(parts, "\\")
	needsReplace := true
	slashCount := 0
	if isPathSep(firstPart[0]) {
		slashCount++
		if len(firstPart) > 1 && isPathSep(firstPart[1]) {
			slashCount++
			if len(firstPart) > 2 {
				if isPathSep(firstPart[2]) {
					slashCount++
				} else {
					needsReplace = false
				}
			}
		}
	}
	if needsReplace {
		for slashCount < len(joined) && isPathSep(joined[slashCount]) {
			slashCount++
		}
		if slashCount >= 2 {
			joined = "\\" + joined[slashCount:]
		}
	}
	for _, p := range strings.FieldsFunc(joined, func(r rune) bool { return r == '\\' }) {
		if c := strings.IndexByte(p, ':'); c != -1 && isWindowsReservedName(p, c) {
			return strings.ReplaceAll(joined, "/", "\\")
		}
	}
	return jsNormalize(joined)
}

// normalizeString 逐行移植 node lib/path.js 的同名函数（win32 分隔符）。
func normalizeString(path string, allowAboveRoot bool, separator byte) string {
	res := ""
	lastSegmentLength := 0
	lastSlash := -1
	dots := 0
	code := byte(0)
	for i := 0; i <= len(path); i++ {
		if i < len(path) {
			code = path[i]
		} else if isPathSep(code) {
			break
		} else {
			code = '/'
		}

		if isPathSep(code) {
			if lastSlash == i-1 || dots == 1 {
				// NOOP
			} else if dots == 2 {
				if len(res) < 2 || lastSegmentLength != 2 || res[len(res)-1] != '.' || res[len(res)-2] != '.' {
					if len(res) > 2 {
						lastSlashIndex := len(res) - lastSegmentLength - 1
						if lastSlashIndex == -1 {
							res = ""
							lastSegmentLength = 0
						} else {
							res = res[:lastSlashIndex]
							lastSegmentLength = len(res) - 1 - strings.LastIndexByte(res, separator)
						}
						lastSlash = i
						dots = 0
						continue
					} else if len(res) != 0 {
						res = ""
						lastSegmentLength = 0
						lastSlash = i
						dots = 0
						continue
					}
				}
				if allowAboveRoot {
					if len(res) > 0 {
						res += string(separator) + ".."
					} else {
						res = ".."
					}
					lastSegmentLength = 2
				}
			} else {
				if len(res) > 0 {
					res += string(separator) + path[lastSlash+1:i]
				} else {
					res = path[lastSlash+1 : i]
				}
				lastSegmentLength = i - lastSlash - 1
			}
			lastSlash = i
			dots = 0
		} else if code == '.' && dots != -1 {
			dots++
		} else {
			dots = -1
		}
	}
	return res
}

// jsBasename 逐行对应 node lib/path.js 的 win32.basename(path)（不带 ext 参数），同 internal/scanner/jsstr.go 的 basenameWin32。
func jsBasename(p string) string {
	start, end := 0, -1
	matchedSlash := true
	if len(p) >= 2 && isDeviceRoot(p[0]) && p[1] == ':' {
		start = 2
	}
	for i := len(p) - 1; i >= start; i-- {
		if isPathSep(p[i]) {
			if !matchedSlash {
				start = i + 1
				break
			}
		} else if end == -1 {
			matchedSlash = false
			end = i + 1
		}
	}
	if end == -1 {
		return ""
	}
	return p[start:end]
}

// jsExtname 逐行对应 node lib/path.js 的 win32.extname（node 22）。
func jsExtname(path string) string {
	start := 0
	startDot := -1
	startPart := 0
	end := -1
	matchedSlash := true
	preDotState := 0
	if len(path) >= 2 && path[1] == ':' && isDeviceRoot(path[0]) {
		start = 2
		startPart = 2
	}
	for i := len(path) - 1; i >= start; i-- {
		code := path[i]
		if isPathSep(code) {
			if !matchedSlash {
				startPart = i + 1
				break
			}
			continue
		}
		if end == -1 {
			matchedSlash = false
			end = i + 1
		}
		if code == '.' {
			if startDot == -1 {
				startDot = i
			} else if preDotState != 1 {
				preDotState = 1
			}
		} else if startDot != -1 {
			preDotState = -1
		}
	}
	if startDot == -1 || end == -1 || preDotState == 0 ||
		(preDotState == 1 && startDot == end-1 && startDot == startPart+1) {
		return ""
	}
	return path[startDot:end]
}
