// 对应 src/main/lib/semver.ts：engines.node 比对，只做 PRD §5.1 第 5 项需要的子集。
//
// 不引入 semver 依赖：这里只需要判断当前 Node 是否满足 range，且结果只出 warn。
// 支持 >=x、>x、<=x、<x、^x、~x、x.y.z、x || y 与空白分隔的交集。无法解析时 known 为 false
// （即原版的 null），由调用方按「不阻止」处理。
//
// JS 与 Go 的口径差异已逐条对齐，期望值由 scripts/gen-semver-cases.mjs 跑原版生成：
//   - 切分与 trim 用 JS 的空白集合（含 U+FEFF、不含 U+0085），不用 unicode.IsSpace。
//   - 数字用 float64，与 JS Number 一致：超过 2^53 丢精度，超过 1e308 为 Infinity。
//     段号直接 Number(m[2])，Infinity 不回退；次版本与修订号经 numOr，Infinity 回退为 0。
//   - 原版 clause 正则里的 \s* 省略：子句已按 JS 空白切开，里面不会再出现空白字符。

package precheck

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// version3 是 [主, 次, 修订]，对应原版的 Version 元组。
type version3 [3]float64

var (
	versionRE = regexp.MustCompile(`^v?(\d+)\.(\d+)\.(\d+)`)
	clauseRE  = regexp.MustCompile(`^(>=|<=|>|<|\^|~|=)?v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?`)
)

// Satisfies 判断 version 是否满足 rng。
// 返回 (ok, known)：known 为 false 时对应原版的 null，此时 ok 无意义。
func Satisfies(version, rng string) (ok, known bool) {
	target, parsed := parseVersion(version)
	if !parsed {
		return false, false
	}
	var alternatives []string
	for _, r := range strings.Split(rng, "||") {
		if r = strings.TrimFunc(r, jsIsSpace); r != "" {
			alternatives = append(alternatives, r)
		}
	}
	if len(alternatives) == 0 {
		return false, false
	}
	parsedAny := false
	for _, alt := range alternatives {
		all, anyClause := true, false
		for _, clause := range strings.FieldsFunc(alt, jsIsSpace) {
			res, clauseKnown := matchClause(target, clause)
			if !clauseKnown {
				continue
			}
			anyClause = true
			if !res {
				all = false
			}
		}
		if !anyClause {
			continue
		}
		parsedAny = true
		if all {
			return true, true
		}
	}
	return false, parsedAny
}

func matchClause(target version3, clause string) (ok, known bool) {
	if clause == "*" || clause == "x" {
		return true, true
	}
	m := clauseRE.FindStringSubmatch(clause)
	if m == nil {
		return false, false
	}
	op := m[1]
	if op == "" {
		op = "="
	}
	base := version3{jsNumber(m[2]), numOr(m[3], 0), numOr(m[4], 0)}
	switch op {
	case ">=":
		return compareVersion(target, base) >= 0, true
	case ">":
		return compareVersion(target, base) > 0, true
	case "<=":
		return compareVersion(target, base) <= 0, true
	case "<":
		return compareVersion(target, base) < 0, true
	case "^":
		// ^0.x 锁次版本，^x.y 锁主版本
		if base[0] == 0 {
			return target[0] == 0 && target[1] == base[1] && compareVersion(target, base) >= 0, true
		}
		return target[0] == base[0] && compareVersion(target, base) >= 0, true
	case "~":
		return target[0] == base[0] && target[1] == base[1] && compareVersion(target, base) >= 0, true
	}
	// 其余为 "="。省略的段视为通配：22 匹配任意 22.x.x
	if m[3] == "" || m[3] == "x" || m[3] == "*" {
		return target[0] == base[0], true
	}
	if m[4] == "" || m[4] == "x" || m[4] == "*" {
		return target[0] == base[0] && target[1] == base[1], true
	}
	return compareVersion(target, base) == 0, true
}

func parseVersion(s string) (version3, bool) {
	m := versionRE.FindStringSubmatch(strings.TrimFunc(s, jsIsSpace))
	if m == nil {
		return version3{}, false
	}
	return version3{jsNumber(m[1]), jsNumber(m[2]), jsNumber(m[3])}, true
}

func compareVersion(a, b version3) float64 {
	for i := 0; i < 3; i++ {
		if a[i] != b[i] {
			return a[i] - b[i]
		}
	}
	return 0
}

// jsNumber 等同于 JS 的 Number(digits)。ParseFloat 只会因溢出返回 ErrRange，此时值已是 ±Inf，与 JS 一致。
func jsNumber(s string) float64 {
	f, _ := strconv.ParseFloat(s, 64)
	return f
}

// numOr 对应原版 numOr：省略、x、* 取回退值；非有限数也取回退值（Number.isFinite）。
func numOr(v string, fallback float64) float64 {
	if v == "" || v == "x" || v == "*" {
		return fallback
	}
	n := jsNumber(v)
	if math.IsInf(n, 0) || math.IsNaN(n) {
		return fallback
	}
	return n
}

// jsIsSpace 是 JS 正则 \s 与 String.prototype.trim 认的空白：WhiteSpace + LineTerminator。
// 与 logs/outputtext.go 的 jsIsSpace 同义，两包各留一份，避免为一个函数引入共享包。
func jsIsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', '\u2028', '\u2029', '\ufeff':
		return true
	}
	return unicode.Is(unicode.Zs, r)
}
