// 对应 src/main/services/SessionService.ts 里隐含的 JS 字符串语义：
//   - node-pty 交出的是已解码的字符串，Go 这边读到的是字节流，要在会话层自己按 UTF-8 解码；
//   - buffer 的 .slice(-MAX_BUFFER_CHARS) 按 UTF-16 码元计数；
//   - title.trim().slice(0, 80) 同样按 UTF-16 码元。

package sessions

import (
	"strings"
	"unicode/utf8"
)

// isJSSpace 即 ECMAScript 的 WhiteSpace + LineTerminator（String.prototype.trim 去掉的那一批）。
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

func jsTrim(s string) string { return strings.TrimFunc(s, isJSSpace) }

func runeUnits(r rune) int {
	if r >= 0x10000 {
		return 2
	}
	return 1
}

// truncateTail 即 s.slice(-max)：保留末尾 max 个 UTF-16 码元。
// JS 允许从代理对中间切开留下孤立代理；Go 字符串装不下孤立代理，切点落在一个字符中间时整个字符丢掉（少 1 个码元）。
func truncateTail(s string, max int) string {
	if len(s) <= max { // UTF-8 字节数 >= UTF-16 码元数，字节都放得下则码元一定放得下
		return s
	}
	units, i := 0, len(s)
	for i > 0 {
		r, size := utf8.DecodeLastRuneInString(s[:i])
		u := runeUnits(r)
		if units+u > max {
			break
		}
		units += u
		i -= size
	}
	if i == 0 {
		return s
	}
	return s[i:]
}

// truncateHead 即 s.slice(0, max)：保留开头 max 个 UTF-16 码元，规则同上。
func truncateHead(s string, max int) string {
	if len(s) <= max {
		return s
	}
	units := 0
	for i, r := range s {
		u := runeUnits(r)
		if units+u > max {
			return s[:i]
		}
		units += u
	}
	return s
}

// heldTail 返回 data 末尾应留到下一次读取再解码的字节数：一个被截断的多字节字符的前缀（最多 3 字节）。
func heldTail(data []byte) int {
	for i := 1; i <= 3 && i <= len(data); i++ {
		if utf8.RuneStart(data[len(data)-i]) {
			if utf8.FullRune(data[len(data)-i:]) {
				return 0
			}
			return i
		}
	}
	return 0
}

// toValidString 把字节按 UTF-8 解码，每个非法字节换成一个 U+FFFD（node-pty 的 StringDecoder 同样逐字节替换）。
func toValidString(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	var sb strings.Builder
	sb.Grow(len(b) + 8)
	for len(b) > 0 {
		r, size := utf8.DecodeRune(b)
		if r == utf8.RuneError && size == 1 {
			sb.WriteRune(utf8.RuneError)
		} else {
			sb.Write(b[:size])
		}
		b = b[size:]
	}
	return sb.String()
}

// splitChunks 把字符串按不超过 maxBytes 的字节数切段，不切断字符。
func splitChunks(s string, maxBytes int) []string {
	if len(s) <= maxBytes {
		return []string{s}
	}
	var out []string
	for len(s) > maxBytes {
		cut := maxBytes
		for cut > 0 && !utf8.RuneStart(s[cut]) {
			cut--
		}
		if cut == 0 {
			cut = maxBytes
		}
		out = append(out, s[:cut])
		s = s[cut:]
	}
	return append(out, s)
}
