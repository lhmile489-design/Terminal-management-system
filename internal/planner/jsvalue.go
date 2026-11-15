// 对应 src/main/services/PlannerService.ts 入口处对 unknown 入参的 JS 语义判断。
//
// 原版每个入口收 unknown，用 typeof / Array.isArray / Number() / String.prototype.trim /
// s.length 校形。Go 侧入参保持 json.RawMessage（未解码的原始 JSON），在这里按 JS 的规则逐条复现：
//   - 键不存在 = undefined（RawMessage 为 nil），键为 null = null；
//   - s.length 按 UTF-16 码元计（utf16Len）；
//   - trim 认 JS 的 WhiteSpace + LineTerminator（含 U+FEFF，不含 U+0085）；
//   - Number(v) 对 JSON 能出现的每种值（null / 布尔 / 字符串 / 数组 / 对象）给出与 V8 相同的结果。
// 已知差异：JSON 里的孤立代理项（如 "\ud800"）Go 解码成 U+FFFD，JS 原样保留，只影响长度计数。

package planner

import (
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

type jsKind int

const (
	kindUndefined jsKind = iota
	kindNull
	kindBool
	kindNumber
	kindString
	kindArray
	kindObject
)

// kindOf 即 typeof + Array.isArray + null 判断。raw 为空表示键不存在（undefined）。
func kindOf(raw json.RawMessage) jsKind {
	switch rawKind(raw) {
	case 0:
		return kindUndefined
	case 'n':
		return kindNull
	case 't', 'f':
		return kindBool
	case '"':
		return kindString
	case '[':
		return kindArray
	case '{':
		return kindObject
	}
	return kindNumber
}

// asObject 只在 raw 是 JSON 对象时返回键表（即原版 `!x || typeof x !== 'object' || Array.isArray(x)` 的反面）。
func asObject(raw json.RawMessage) (map[string]json.RawMessage, bool) {
	if kindOf(raw) != kindObject {
		return nil, false
	}
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil || m == nil {
		return nil, false
	}
	return m, true
}

// asArray 只在 raw 是 JSON 数组时返回元素。
func asArray(raw json.RawMessage) ([]json.RawMessage, bool) {
	if kindOf(raw) != kindArray {
		return nil, false
	}
	var a []json.RawMessage
	if json.Unmarshal(raw, &a) != nil {
		return nil, false
	}
	return a, true
}

// jsStr 只在 raw 是 JSON 字符串时返回值（typeof v === 'string'）。
func jsStr(raw json.RawMessage) (string, bool) {
	if kindOf(raw) != kindString {
		return "", false
	}
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return "", false
	}
	return s, true
}

// jsBool 只在 raw 是 JSON 布尔时返回值（typeof v === 'boolean'）。
func jsBool(raw json.RawMessage) (bool, bool) {
	if kindOf(raw) != kindBool {
		return false, false
	}
	var b bool
	if json.Unmarshal(raw, &b) != nil {
		return false, false
	}
	return b, true
}

// jsNum 只在 raw 是 JSON 数字时返回值（typeof v === 'number'）。
// 与 JSON.parse 一致：超出范围得 ±Infinity，不算错。
func jsNum(raw json.RawMessage) (float64, bool) {
	if kindOf(raw) != kindNumber {
		return 0, false
	}
	f, err := strconv.ParseFloat(strings.TrimSpace(string(raw)), 64)
	if err != nil {
		if ne, ok := err.(*strconv.NumError); ok && ne.Err == strconv.ErrRange {
			return f, true
		}
		return 0, false
	}
	return f, true
}

// jsNumber 即全局 Number(v)，v 是一个 JSON 值或 undefined。
func jsNumber(raw json.RawMessage) float64 {
	switch kindOf(raw) {
	case kindUndefined:
		return math.NaN()
	case kindNull:
		return 0
	case kindBool:
		if b, _ := jsBool(raw); b {
			return 1
		}
		return 0
	case kindNumber:
		f, _ := jsNum(raw)
		return f
	case kindString:
		s, _ := jsStr(raw)
		return jsStringToNumber(s)
	case kindArray:
		// 数组先转字符串（Array.prototype.join(',')），再按字符串转数字
		return jsStringToNumber(jsArrayString(raw))
	}
	return math.NaN() // 对象：String({}) 是 "[object Object]"
}

// jsArrayString 即 String(array)：元素逐个转字符串后用逗号连接，null / undefined 元素是空串。
func jsArrayString(raw json.RawMessage) string {
	items, _ := asArray(raw)
	parts := make([]string, len(items))
	for i, it := range items {
		switch kindOf(it) {
		case kindNull, kindUndefined:
			parts[i] = ""
		case kindBool:
			if b, _ := jsBool(it); b {
				parts[i] = "true"
			} else {
				parts[i] = "false"
			}
		case kindNumber:
			// 只用于再转回数字，取 JSON 原文即可（Number(String(n)) === n）
			parts[i] = strings.TrimSpace(string(it))
		case kindString:
			parts[i], _ = jsStr(it)
		case kindArray:
			parts[i] = jsArrayString(it)
		default:
			parts[i] = "[object Object]"
		}
	}
	return strings.Join(parts, ",")
}

var decimalLiteral = regexp.MustCompile(`^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$`)

// jsStringToNumber 即 Number(string)：trim 后空串是 0；认十进制、Infinity、0x / 0o / 0b 前缀；其余是 NaN。
func jsStringToNumber(s string) float64 {
	t := jsTrim(s)
	switch t {
	case "":
		return 0
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	if len(t) > 2 && t[0] == '0' {
		base := 0
		switch t[1] {
		case 'x', 'X':
			base = 16
		case 'o', 'O':
			base = 8
		case 'b', 'B':
			base = 2
		}
		if base != 0 {
			f := 0.0
			for _, c := range t[2:] {
				d, err := strconv.ParseInt(string(c), base, 64)
				if err != nil {
					return math.NaN()
				}
				f = f*float64(base) + float64(d)
			}
			return f
		}
	}
	if !decimalLiteral.MatchString(t) {
		return math.NaN()
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil {
		if ne, ok := err.(*strconv.NumError); ok && ne.Err == strconv.ErrRange {
			return f
		}
		return math.NaN()
	}
	return f
}

// isInteger 即 Number.isInteger。
func isInteger(f float64) bool {
	return !math.IsInf(f, 0) && !math.IsNaN(f) && f == math.Trunc(f)
}

// utf16Len 即 JS 的 s.length。
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

// jsIsSpace 即 JS 的 WhiteSpace + LineTerminator：trim 与正则 \s 用的是同一个集合。
// 写成十六进制码点而不是转义字面量，避免编辑工具把它们换成不可见字符。
// 与 platform/win32/jsx.go 同义，两包各留一份，避免为一个函数引入共享包。
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
