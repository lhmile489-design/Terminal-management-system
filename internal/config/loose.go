// 宽松解码：把 config.json 里的值按 contract 结构体读进来，类型不对的字段单独跳过、不影响其余字段。
//
// 原版读配置是 JSON.parse 后直接当对象用，字段类型从不校验；Go 用结构体读写，做不到原样保留。
// 用户 2026-11-14 选定的口径（已接受偏差，见 docs/MIGRATION-PLAN.md §6）：
//   - 未知键在下一次写盘时丢掉
//   - 类型不对的字段回落到「解码前的值」：顶层与 settings 是默认值，条目内是零值
//   - 数组里结构不对的元素（null、数字当条目）直接丢掉
//
// 与 encoding/json 的差异都是为了贴近 JS：
//   - 键名区分大小写（encoding/json 不区分，`"Version"` 会被当成 version）
//   - 整数字段接受 80.0、8e1 这类数值上是整数的写法（JS 里它们就是 80）

package config

import (
	"bytes"
	"encoding/json"
	"math"
	"reflect"
	"strconv"
	"strings"

	"mile-console/internal/contract"
)

// decodeLoose 把 raw 解进 v（指针）。返回 false 表示 raw 的类型对不上，v 保持原值。
func decodeLoose(raw json.RawMessage, v any) bool {
	return looseInto(raw, reflect.ValueOf(v).Elem())
}

// rawKind 返回 JSON 值的类别：'{' '[' '"' 'n'(null) 't'/'f'(bool) '0'(number)，空或非法为 0。
func rawKind(raw json.RawMessage) byte {
	t := bytes.TrimLeft(raw, " \t\r\n")
	if len(t) == 0 {
		return 0
	}
	switch c := t[0]; c {
	case '{', '[', '"', 'n', 't', 'f':
		return c
	case '-':
		return '0'
	default:
		if c >= '0' && c <= '9' {
			return '0'
		}
	}
	return 0
}

var (
	rawMessageType = reflect.TypeFor[json.RawMessage]()
	scriptsType    = reflect.TypeFor[contract.Scripts]()
)

// looseScripts 读 scripts 对象：保留原文的键顺序（JS 规则，见 contract.Scripts），
// 值不是字符串的键单独丢掉，与普通 map 字段的口径相同。
func looseScripts(raw json.RawMessage, v reflect.Value) bool {
	if rawKind(raw) != '{' || !json.Valid(raw) {
		return false
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	if _, err := dec.Token(); err != nil {
		return false
	}
	out := contract.NewScripts()
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return false
		}
		var it json.RawMessage
		if dec.Decode(&it) != nil {
			return false
		}
		var s string
		if rawKind(it) == '"' && json.Unmarshal(it, &s) == nil {
			out.Set(kt.(string), s)
		}
	}
	v.Set(reflect.ValueOf(out))
	return true
}

func looseInto(raw json.RawMessage, v reflect.Value) bool {
	k := rawKind(raw)
	// json.RawMessage 本身是 []byte：原文照收，不当成数组解
	if v.Type() == rawMessageType {
		v.SetBytes(append(json.RawMessage(nil), raw...))
		return true
	}
	if v.Type() == scriptsType {
		return looseScripts(raw, v)
	}
	switch v.Kind() {
	case reflect.Pointer:
		if k == 'n' {
			v.SetZero()
			return true
		}
		p := reflect.New(v.Type().Elem())
		if !looseInto(raw, p.Elem()) {
			return false
		}
		v.Set(p)
		return true

	case reflect.Struct:
		if k != '{' {
			return false
		}
		var obj map[string]json.RawMessage
		if json.Unmarshal(raw, &obj) != nil {
			return false
		}
		t := v.Type()
		for i := range t.NumField() {
			name := jsonName(t.Field(i))
			if name == "" {
				continue
			}
			if fv, ok := obj[name]; ok {
				looseInto(fv, v.Field(i))
			}
		}
		return true

	case reflect.Slice:
		if k != '[' {
			return false
		}
		var items []json.RawMessage
		if json.Unmarshal(raw, &items) != nil {
			return false
		}
		out := reflect.MakeSlice(v.Type(), 0, len(items))
		for _, it := range items {
			// 结构体元素只收对象：null、数字当条目一律丢掉
			if v.Type().Elem().Kind() == reflect.Struct && rawKind(it) != '{' {
				continue
			}
			e := reflect.New(v.Type().Elem()).Elem()
			if looseInto(it, e) {
				out = reflect.Append(out, e)
			}
		}
		v.Set(out)
		return true

	case reflect.Map:
		if k != '{' {
			return false
		}
		var obj map[string]json.RawMessage
		if json.Unmarshal(raw, &obj) != nil {
			return false
		}
		out := reflect.MakeMapWithSize(v.Type(), len(obj))
		for key, it := range obj {
			e := reflect.New(v.Type().Elem()).Elem()
			if looseInto(it, e) {
				out.SetMapIndex(reflect.ValueOf(key).Convert(v.Type().Key()), e)
			}
		}
		v.Set(out)
		return true

	case reflect.String:
		if k == 'n' {
			return true // JSON null 进标量：与 encoding/json 一致，不改值
		}
		if k != '"' {
			return false
		}
		var s string
		if json.Unmarshal(raw, &s) != nil {
			return false
		}
		v.SetString(s)
		return true

	case reflect.Bool:
		if k == 'n' {
			return true
		}
		if k != 't' && k != 'f' {
			return false
		}
		var b bool
		if json.Unmarshal(raw, &b) != nil {
			return false
		}
		v.SetBool(b)
		return true

	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		if k == 'n' {
			return true
		}
		if k != '0' {
			return false
		}
		f, ok := jsNumber(raw)
		if !ok || math.Trunc(f) != f || math.IsInf(f, 0) {
			return false
		}
		n := int64(f)
		if float64(n) != f || v.OverflowInt(n) {
			return false
		}
		v.SetInt(n)
		return true

	case reflect.Float32, reflect.Float64:
		if k == 'n' {
			return true
		}
		if k != '0' {
			return false
		}
		f, ok := jsNumber(raw)
		if !ok {
			return false
		}
		v.SetFloat(f)
		return true
	}
	return false
}

// jsNumber 把 JSON 数值文本解成 float64，与 JSON.parse 一致：超出范围得 ±Infinity 或 0，不算错。
func jsNumber(raw json.RawMessage) (float64, bool) {
	s := strings.TrimSpace(string(raw))
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		if ne, ok := err.(*strconv.NumError); ok && ne.Err == strconv.ErrRange {
			return f, true
		}
		return 0, false
	}
	return f, true
}

func jsonName(f reflect.StructField) string {
	if !f.IsExported() {
		return ""
	}
	tag := f.Tag.Get("json")
	if tag == "-" {
		return ""
	}
	name, _, _ := strings.Cut(tag, ",")
	if name == "" {
		return f.Name
	}
	return name
}
