// S04 对拍工具：直接读原版 src/shared/types.ts 与 planner.ts，把联合类型、常量数组、标签表、
// 接口字段名抽出来，和 Go 侧对照。期望值来自原文件本身，不靠手抄。

package contract

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// originalShared 原版 src/shared 目录（相对本包目录）。
var originalShared = filepath.Join("..", "..", "..", "..", "mile-terminal-management", "src", "shared")

func readOriginal(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(originalShared, name))
	if err != nil {
		t.Skipf("读不到原版 %s（%v），对拍跳过；迁移期间原项目必须在工作区里", name, err)
	}
	return strings.ReplaceAll(string(b), "\r\n", "\n")
}

var (
	reBlockComment = regexp.MustCompile(`(?s)/\*.*?\*/`)
	reLineComment  = regexp.MustCompile(`//[^\n]*`)
	reQuoted       = regexp.MustCompile(`'([^']*)'`)
	reNumber       = regexp.MustCompile(`\b\d+\b`)
	reUnionIdent   = regexp.MustCompile(`(?:^|\|)\s*([A-Z]\w*)\s*(?:\||$)`)
)

func stripComments(s string) string {
	return reLineComment.ReplaceAllString(reBlockComment.ReplaceAllString(s, ""), "")
}

// tsUnion 抽出 `export type Name = 'a' | 'b' ...` 的字面量；引用其他联合类型的按原位展开。
func tsUnion(t *testing.T, src, name string) []string {
	t.Helper()
	head := "export type " + name + " ="
	i := strings.Index(src, head)
	if i < 0 {
		t.Fatalf("原版里找不到 %s", head)
	}
	lines := strings.Split(src[i+len(head):], "\n")
	body := []string{lines[0]}
	for _, l := range lines[1:] {
		if l == "" || (l[0] != ' ' && l[0] != '\t') {
			break
		}
		body = append(body, l)
	}
	text := stripComments(strings.Join(body, "\n"))
	var out []string
	for _, part := range strings.Split(text, "|") {
		part = strings.TrimSpace(part)
		if m := reQuoted.FindStringSubmatch(part); m != nil {
			out = append(out, m[1])
		} else if reUnionIdent.MatchString("|" + part + "|") {
			out = append(out, tsUnion(t, src, part)...)
		} else if part != "" {
			t.Fatalf("%s 里有认不出的成员 %q", name, part)
		}
	}
	if len(out) == 0 {
		t.Fatalf("%s 抽出 0 个成员", name)
	}
	return out
}

// tsArray 抽出 `export const NAME ... = [ ... ]` 的元素（字符串或数字）。
func tsArray(t *testing.T, src, name string) []string {
	t.Helper()
	i := strings.Index(src, "export const "+name)
	if i < 0 {
		t.Fatalf("原版里找不到 export const %s", name)
	}
	rest := src[i:]
	eq := strings.Index(rest, "=")
	open := eq + strings.Index(rest[eq:], "[")
	end := open + strings.Index(rest[open:], "]")
	body := stripComments(rest[open+1 : end])
	var out []string
	if q := reQuoted.FindAllStringSubmatch(body, -1); len(q) > 0 {
		for _, m := range q {
			out = append(out, m[1])
		}
	} else {
		out = reNumber.FindAllString(body, -1)
	}
	if len(out) == 0 {
		t.Fatalf("%s 抽出 0 个元素", name)
	}
	return out
}

// tsRecord 抽出 `export const NAME ... = { key: 'value', ... }`。
func tsRecord(t *testing.T, src, name string) map[string]string {
	t.Helper()
	i := strings.Index(src, "export const "+name)
	if i < 0 {
		t.Fatalf("原版里找不到 export const %s", name)
	}
	rest := src[i:]
	open := strings.Index(rest, "{")
	end := strings.Index(rest, "\n}")
	out := map[string]string{}
	for _, m := range regexp.MustCompile(`(\w+):\s*'([^']*)'`).FindAllStringSubmatch(rest[open:end], -1) {
		out[m[1]] = m[2]
	}
	if len(out) == 0 {
		t.Fatalf("%s 抽出 0 个键", name)
	}
	return out
}

// tsConst 抽出 `export const NAME = 123`。
func tsConst(t *testing.T, src, name string) string {
	t.Helper()
	m := regexp.MustCompile(`export const ` + name + ` = (\d+)\n`).FindStringSubmatch(src)
	if m == nil {
		t.Fatalf("原版里找不到数字常量 %s", name)
	}
	return m[1]
}

func tsInterfaceBody(t *testing.T, src, name string) string {
	t.Helper()
	m := regexp.MustCompile(`export interface ` + name + `\s*\{`).FindStringIndex(src)
	if m == nil {
		t.Fatalf("原版里找不到 interface %s", name)
	}
	end := strings.Index(src[m[1]:], "\n}")
	return src[m[1] : m[1]+end]
}

// tsFields 抽出接口第一层字段名（两格缩进），按原文顺序。
func tsFields(t *testing.T, src, name string) []string {
	t.Helper()
	var out []string
	for _, m := range regexp.MustCompile(`(?m)^  (\w+)\??:`).FindAllStringSubmatch(tsInterfaceBody(t, src, name), -1) {
		out = append(out, m[1])
	}
	if len(out) == 0 {
		t.Fatalf("interface %s 抽出 0 个字段", name)
	}
	return out
}

// tsFieldUnion 抽出接口内某字段的内联字面量联合（字符串或数字）。
func tsFieldUnion(t *testing.T, src, iface, field string) []string {
	t.Helper()
	m := regexp.MustCompile(`(?m)^  ` + field + `\??: (.+)$`).FindStringSubmatch(tsInterfaceBody(t, src, iface))
	if m == nil {
		t.Fatalf("%s.%s 找不到", iface, field)
	}
	var out []string
	if q := reQuoted.FindAllStringSubmatch(m[1], -1); len(q) > 0 {
		for _, x := range q {
			out = append(out, x[1])
		}
	} else {
		out = reNumber.FindAllString(m[1], -1)
	}
	if len(out) == 0 {
		t.Fatalf("%s.%s 抽出 0 个成员", iface, field)
	}
	return out
}
