// S15 用到的 JS 语义小工具：String.prototype.trim / slice / length（按 UTF-16 码元）、Math.round、
// node path.win32.basename / path.posix.basename。toLowerCase 用 attribution.go 的 jsToLower。

package scanner

import (
	"math"
	"strings"
	"unicode"
)

// jsIsSpace 即 JS 的 WhiteSpace + LineTerminator：trim 与正则 \s 用的是同一个集合。
// 写成十六进制码点而不是转义字面量，避免编辑工具把它们换成不可见字符。
func jsIsSpace(r rune) bool {
	switch r {
	case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0x2028, 0x2029, 0xFEFF:
		return true
	}
	return unicode.Is(unicode.Zs, r)
}

func jsTrim(s string) string { return strings.TrimFunc(s, jsIsSpace) }

// utf16Len 即 s.length。
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// utf16Prefix 即 s.slice(0, n)。切在代理对中间时 JS 留下孤立的高位代理，Go 字符串装不下，
// 这里丢掉那半个字符（见 docs/MIGRATION-PLAN.md §6「孤立代理」）。
func utf16Prefix(s string, n int) string {
	if n <= 0 {
		return ""
	}
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

// jsRound 即 Math.round：取最接近的整数，正好一半时朝 +∞。math.Round 对负数的一半朝 -∞，不一样。
func jsRound(x float64) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return x
	}
	r := math.Floor(x)
	if x-r >= 0.5 {
		r++
	}
	return r
}

// basenameWin32 逐行对应 node lib/path.js 的 win32.basename(path)（不带 ext 参数）。
func basenameWin32(p string) string {
	start, end := 0, -1
	matchedSlash := true
	if len(p) >= 2 && isDriveLetter(p[0]) && p[1] == ':' {
		start = 2
	}
	for i := len(p) - 1; i >= start; i-- {
		if p[i] == '\\' || p[i] == '/' {
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

// basenamePosix 逐行对应 node lib/path.js 的 posix.basename(path)。
func basenamePosix(p string) string {
	start, end := 0, -1
	matchedSlash := true
	for i := len(p) - 1; i >= 0; i-- {
		if p[i] == '/' {
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

func isDriveLetter(c byte) bool { return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') }
