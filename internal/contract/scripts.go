// 对应 src/shared/types.ts 里 package.json scripts 的 Record<string, string>
// （LaunchEntry.scripts、NewLaunchEntry.scripts、EntryEdit.scripts、DetectResult.scripts）。
//
// 原版的对象键顺序就是界面上脚本下拉、配置面板列出脚本的顺序。JS 对象的键顺序规则：
//   - 「数组下标」键（"0" 到 "4294967294" 的规范十进制串，"01"、"-1"、"4294967295" 不算）排最前，按数值升序
//   - 其余键按首次插入的顺序
//   - 同一个键再次写入：位置不动，值取最后一次
//
// Go 的 map 无序，encoding/json 写 map 还会按键排序，所以单独做一个保序类型（用户 2026-11-15 选定）。
// JSON 形状仍是对象，与原版的 config.json、导出文件互通。
//
// mygo tsgen 对实现了 json.Marshaler 的类型生成 unknown（docs/BINDINGS-CONTRACT.md §1.3 第 7 条「Scripts」），
// src/lib/mile.ts 负责把它还原成 Record<string, string>。
//
// 与 map 一样是引用语义：复制出来的值共享同一份底层数据，要改之前先 Clone。

package contract

import (
	"bytes"
	"encoding/json"
	"errors"
	"maps"
	"slices"
	"strconv"
)

// Scripts 保序的「脚本名 → 命令」表。零值表示「没有这个字段」（JSON null / 缺省），NewScripts 是空对象。
type Scripts struct {
	keys []string
	vals map[string]string
}

// NewScripts 空表（JSON `{}`）。
func NewScripts() Scripts { return Scripts{vals: map[string]string{}} }

// ScriptsOf 按给定顺序逐个 Set，kv 是键值交替的列表。测试与常量构造用。
func ScriptsOf(kv ...string) Scripts {
	s := NewScripts()
	for i := 0; i+1 < len(kv); i += 2 {
		s.Set(kv[i], kv[i+1])
	}
	return s
}

// IsZero 供 omitzero 使用：只有零值（没提这个字段）算零，空对象不算。
func (s Scripts) IsZero() bool { return s.vals == nil }

// Len 键的个数，即 Object.keys(scripts).length。
func (s Scripts) Len() int { return len(s.keys) }

// Get 即 scripts[k]，ok 为 false 表示 undefined。
func (s Scripts) Get(k string) (string, bool) {
	v, ok := s.vals[k]
	return v, ok
}

// Keys 即 Object.keys(scripts)，返回副本。
func (s Scripts) Keys() []string { return slices.Clone(s.keys) }

// Set 即 scripts[k] = v，键的位置按 JS 规则决定。
func (s *Scripts) Set(k, v string) {
	if s.vals == nil {
		s.vals = map[string]string{}
	}
	if _, ok := s.vals[k]; !ok {
		s.keys = InsertJSKey(s.keys, k)
	}
	s.vals[k] = v
}

// Clone 深拷贝；零值得零值。
func (s Scripts) Clone() Scripts {
	if s.vals == nil {
		return Scripts{}
	}
	out := Scripts{keys: slices.Clone(s.keys), vals: make(map[string]string, len(s.vals))}
	maps.Copy(out.vals, s.vals)
	return out
}

// Equal 内容与顺序都相同。零值只等于零值。
func (s Scripts) Equal(o Scripts) bool {
	if (s.vals == nil) != (o.vals == nil) || !slices.Equal(s.keys, o.keys) {
		return false
	}
	for k, v := range s.vals {
		if ov, ok := o.vals[k]; !ok || ov != v {
			return false
		}
	}
	return true
}

// IsArrayIndex 即 ECMA-262 的 array index：规范十进制、不超过 2^32 - 2。
func IsArrayIndex(k string) (uint32, bool) {
	if k == "" || len(k) > 10 || (len(k) > 1 && k[0] == '0') {
		return 0, false
	}
	for i := 0; i < len(k); i++ {
		if k[i] < '0' || k[i] > '9' {
			return 0, false
		}
	}
	n, err := strconv.ParseUint(k, 10, 64)
	if err != nil || n > 4294967294 {
		return 0, false
	}
	return uint32(n), true
}

// InsertJSKey 把一个新键插进 JS 对象的键序列：下标键按数值插到下标区，其余追加到末尾。
// keys 必须已经满足 JS 顺序且不含 k。总是返回新切片，不改动 keys 的底层数组。
func InsertJSKey(keys []string, k string) []string {
	n, isIdx := IsArrayIndex(k)
	if !isIdx {
		return append(slices.Clip(keys), k)
	}
	i := 0
	for i < len(keys) {
		m, ok := IsArrayIndex(keys[i])
		if !ok || m > n {
			break
		}
		i++
	}
	return slices.Insert(slices.Clip(keys), i, k)
}

// MarshalJSON 按键顺序写对象；零值写 null（与原先 map 为 nil 时一致）。
// 字符串转义交给 encoding/json，但关掉 HTML 转义：外层编码器开着 HTML 转义时会自己再转一遍
// （json.Marshal 的默认行为），关着时（config.json 的写盘）保持原文，两种情况都与 map[string]string 相同。
func (s Scripts) MarshalJSON() ([]byte, error) {
	if s.vals == nil {
		return []byte("null"), nil
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	out := []byte{'{'}
	for i, k := range s.keys {
		if i > 0 {
			out = append(out, ',')
		}
		for _, str := range [2]string{k, s.vals[k]} {
			buf.Reset()
			if err := enc.Encode(str); err != nil {
				return nil, err
			}
			out = append(out, bytes.TrimSuffix(buf.Bytes(), []byte{'\n'})...)
			if str == k {
				out = append(out, ':')
			}
		}
	}
	return append(out, '}'), nil
}

var (
	errScriptsNotObject = errors.New("脚本表必须是对象")
	errScriptsNotString = errors.New("脚本表的值必须是字符串")
)

// UnmarshalJSON 严格解码：只收对象，值必须全是字符串；重复键按 JS 规则合并。
// JSON null 按 encoding/json 惯例不改值（零值 = 没提这个字段）。
// 错误文案取自原版 sanitizeEdit 的 scripts 分支；原版对数组的放行（typeof [] === 'object'）留给 S18 的 sanitize 处理。
func (s *Scripts) UnmarshalJSON(b []byte) error {
	dec := json.NewDecoder(bytes.NewReader(b))
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	if tok == nil {
		return nil
	}
	if tok != json.Delim('{') {
		return errScriptsNotObject
	}
	out := NewScripts()
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return err
		}
		vt, err := dec.Token()
		if err != nil {
			return err
		}
		v, ok := vt.(string)
		if !ok {
			return errScriptsNotString
		}
		out.Set(kt.(string), v)
	}
	if _, err := dec.Token(); err != nil {
		return err
	}
	*s = out
	return nil
}
