// JSON.parse 的 Go 移植（V8 12.4，node 22）：值的语义与报错文案都照原样。
//
// 原版 DetectService.detect 把 `JSON.parse(await readFile(pkgPath, 'utf8'))` 的异常文案直接拼进警告
// （`package.json 解析失败：${err.message}`），用户在新建向导里看得到，所以文案要一字不差。
// 逐段对应 V8 src/json/json-parser.cc：ParseJsonValue、ParseJsonNumber、ScanJsonString、ScanLiteral、
// ReportUnexpectedToken / ReportUnexpectedCharacter / GetErrorMessageWithEllipses / CalculateFileLocation；
// 文案模板取自 src/common/message-template.h 的 JsonParse* 条目。
//
// 位置、长度、上下文截取都按 UTF-16 码元算（JS 字符串的单位）。
// 对象键顺序按 JS 规则（数组下标键在前、升序，其余按插入顺序；重复键位置不动、值取最后一次）。
// 已知差异：字符串里转义出来的孤立代理（"\ud800"）在 Go 里变成 U+FFFD；报错文案里截到半个代理对时同样变成 U+FFFD。

package detect

import (
	"math"
	"strconv"
	"strings"
	"unicode/utf16"

	"mile-console/internal/contract"
)

type jsKind int

const (
	jsNull jsKind = iota
	jsBool
	jsNumber
	jsString
	jsArray
	jsObject
)

// jsValue JSON.parse 的结果。对象的键按 JS 顺序存在 keys 里。
type jsValue struct {
	kind  jsKind
	b     bool
	n     float64
	s     string
	keys  []string
	props map[string]*jsValue
	elems []*jsValue
}

// truthy 即 JS 的 ToBoolean。
func (v *jsValue) truthy() bool {
	switch v.kind {
	case jsNull:
		return false
	case jsBool:
		return v.b
	case jsNumber:
		return v.n != 0 && !math.IsNaN(v.n)
	case jsString:
		return v.s != ""
	}
	return true
}

// get 即 obj[key]：只有对象有自有属性；数组、字符串等原始值上读 name / scripts 这类键都是 undefined。
func (v *jsValue) get(key string) *jsValue {
	if v == nil || v.kind != jsObject {
		return nil
	}
	return v.props[key]
}

type jsonToken int

const (
	tokEOS jsonToken = iota
	tokNumber
	tokString
	tokLBrace
	tokRBrace
	tokLBrack
	tokRBrack
	tokTrue
	tokFalse
	tokNull
	tokWhitespace
	tokColon
	tokComma
	tokIllegal
)

// oneCharToken 即 V8 的 GetOneCharJsonToken；超过 0xFF 的码元一律 ILLEGAL。
func oneCharToken(c int) jsonToken {
	switch {
	case c < 0:
		return tokEOS
	case c == '"':
		return tokString
	case c >= '0' && c <= '9', c == '-':
		return tokNumber
	case c == '[':
		return tokLBrack
	case c == '{':
		return tokLBrace
	case c == ']':
		return tokRBrack
	case c == '}':
		return tokRBrace
	case c == 't':
		return tokTrue
	case c == 'f':
		return tokFalse
	case c == 'n':
		return tokNull
	case c == ' ', c == '\t', c == '\r', c == '\n':
		return tokWhitespace
	case c == ':':
		return tokColon
	case c == ',':
		return tokComma
	}
	return tokIllegal
}

// 文案模板（message-template.h）。% 依次换成位置、行、列。
const (
	msgUnexpectedEOS          = "Unexpected end of JSON input"
	msgUnexpectedNumber       = "Unexpected number in JSON at position % (line % column %)"
	msgUnexpectedString       = "Unexpected string in JSON at position % (line % column %)"
	msgUnterminatedString     = "Unterminated string in JSON at position % (line % column %)"
	msgPropNameOrRBrace       = "Expected property name or '}' in JSON at position % (line % column %)"
	msgCommaOrRBrack          = "Expected ',' or ']' after array element in JSON at position % (line % column %)"
	msgCommaOrRBrace          = "Expected ',' or '}' after property value in JSON at position % (line % column %)"
	msgDoubleQuotedPropName   = "Expected double-quoted property name in JSON at position % (line % column %)"
	msgExponentMissingNumber  = "Exponent part is missing a number in JSON at position % (line % column %)"
	msgColonAfterPropName     = "Expected ':' after property name in JSON at position % (line % column %)"
	msgUnterminatedFractional = "Unterminated fractional number in JSON at position % (line % column %)"
	msgNonWhiteSpaceAfter     = "Unexpected non-whitespace character after JSON at position % (line % column %)"
	msgBadEscapedCharacter    = "Bad escaped character in JSON at position % (line % column %)"
	msgBadControlCharacter    = "Bad control character in string literal in JSON at position % (line % column %)"
	msgBadUnicodeEscape       = "Bad Unicode escape in JSON at position % (line % column %)"
	msgNoNumberAfterMinus     = "No number after minus sign in JSON at position % (line % column %)"
)

const (
	kMaxContextCharacters              = 10
	kMinOriginalSourceLengthForContext = kMaxContextCharacters*2 + 1
)

type jsonParser struct {
	u      []uint16
	cur    int
	next   jsonToken
	failed bool
	msg    string
}

// jsonParse 即 JSON.parse(text)。失败时 err 是 SyntaxError 的 message，v 为 nil。
func jsonParse(text string) (v *jsValue, err string) {
	p := &jsonParser{u: utf16.Encode([]rune(text))}
	v = p.parseValue()
	if !p.failed && !p.check(tokEOS) {
		p.report(p.next, msgNonWhiteSpaceAfter)
	}
	if p.failed {
		return nil, p.msg
	}
	return v, ""
}

func (p *jsonParser) atEnd() bool { return p.cur >= len(p.u) }

// current 即 CurrentCharacter：末尾返回 -1（kEndOfString）。
func (p *jsonParser) current() int {
	if p.atEnd() {
		return -1
	}
	return int(p.u[p.cur])
}

func (p *jsonParser) nextChar() int {
	p.cur++
	return p.current()
}

func (p *jsonParser) skipWhitespace() {
	p.next = tokEOS
	for !p.atEnd() {
		t := oneCharToken(int(p.u[p.cur]))
		if t != tokWhitespace {
			p.next = t
			return
		}
		p.cur++
	}
}

func (p *jsonParser) check(t jsonToken) bool {
	p.skipWhitespace()
	if p.next != t {
		return false
	}
	p.cur++
	return true
}

func (p *jsonParser) expect(t jsonToken, msg string) {
	if p.next == t {
		p.cur++
		return
	}
	p.report(p.next, msg)
}

func (p *jsonParser) expectNext(t jsonToken, msg string) {
	p.skipWhitespace()
	p.expect(t, msg)
}

func (p *jsonParser) reportChar(c int) {
	t := tokIllegal
	if c < 0 {
		t = tokEOS
	} else if c <= 0xFF {
		t = oneCharToken(c)
	}
	p.report(t, "")
}

// report 即 ReportUnexpectedToken：只记第一次（V8 之后的报告因已有异常直接返回）。msg 为空时按 token 查文案。
func (p *jsonParser) report(t jsonToken, msg string) {
	if p.failed {
		return
	}
	p.failed = true
	pos := p.cur
	line, col := p.location()
	if msg == "" {
		switch t {
		case tokEOS:
			msg = msgUnexpectedEOS
		case tokNumber:
			msg = msgUnexpectedNumber
		case tokString:
			msg = msgUnexpectedString
		default:
			p.msg = p.contextMessage(pos)
			p.cur = len(p.u)
			return
		}
	}
	for _, n := range []int{pos, line, col} {
		msg = strings.Replace(msg, "%", strconv.Itoa(n), 1)
	}
	p.msg = msg
	p.cur = len(p.u)
}

// contextMessage 即 LookUpErrorMessageForJsonToken 的 default 分支：IsSpecialString 与 GetErrorMessageWithEllipses。
func (p *jsonParser) contextMessage(pos int) string {
	src := string(utf16.Decode(p.u))
	switch src {
	case "[object Object]", "undefined", "Infinity", "NaN":
		return `"` + src + `" is not valid JSON`
	}
	tok := string(utf16.Decode(p.u[pos : pos+1]))
	n := len(p.u)
	if n < kMinOriginalSourceLengthForContext {
		return "Unexpected token '" + tok + "', \"" + src + "\" is not valid JSON"
	}
	sub := func(a, b int) string { return string(utf16.Decode(p.u[a:b])) }
	switch {
	case pos < kMaxContextCharacters:
		return "Unexpected token '" + tok + "', \"" + sub(0, pos+kMaxContextCharacters) + "\"... is not valid JSON"
	case pos < n-kMaxContextCharacters:
		return "Unexpected token '" + tok + "', ...\"" + sub(pos-kMaxContextCharacters, pos+kMaxContextCharacters) + "\"... is not valid JSON"
	default:
		return "Unexpected token '" + tok + "', ...\"" + sub(pos-kMaxContextCharacters, n) + "\" is not valid JSON"
	}
}

// location 即 CalculateFileLocation：只认 \r 与 \n，\r\n 算一次。
func (p *jsonParser) location() (line, col int) {
	line = 1
	last := 0
	i := 0
	for ; i < p.cur; i++ {
		if p.u[i] == '\r' && i < p.cur-1 && p.u[i+1] == '\n' {
			i++
		}
		if p.u[i] == '\r' || p.u[i] == '\n' {
			line++
			last = i + 1
		}
	}
	return line, 1 + i - last
}

// parseValue 即 ParseJsonValue（V8 用显式栈，这里用递归，报错顺序相同：失败后立即返回，V8 也只报第一处）。
func (p *jsonParser) parseValue() *jsValue {
	p.skipWhitespace()
	switch p.next {
	case tokString:
		p.cur++
		s, ok := p.scanString()
		if !ok {
			return nil
		}
		return &jsValue{kind: jsString, s: s}
	case tokNumber:
		n, ok := p.parseNumber()
		if !ok {
			return nil
		}
		return &jsValue{kind: jsNumber, n: n}
	case tokLBrace:
		p.cur++
		obj := &jsValue{kind: jsObject, props: map[string]*jsValue{}}
		if p.check(tokRBrace) {
			return obj
		}
		p.expectNext(tokString, msgPropNameOrRBrace)
		for {
			if p.failed {
				return nil
			}
			key, ok := p.scanString()
			if !ok {
				return nil
			}
			p.expectNext(tokColon, msgColonAfterPropName)
			if p.failed {
				return nil
			}
			val := p.parseValue()
			if p.failed {
				return nil
			}
			if _, dup := obj.props[key]; !dup {
				obj.keys = contract.InsertJSKey(obj.keys, key)
			}
			obj.props[key] = val
			if !p.check(tokComma) {
				p.expect(tokRBrace, msgCommaOrRBrace)
				if p.failed {
					return nil
				}
				return obj
			}
			p.expectNext(tokString, msgDoubleQuotedPropName)
		}
	case tokLBrack:
		p.cur++
		arr := &jsValue{kind: jsArray}
		if p.check(tokRBrack) {
			return arr
		}
		for {
			val := p.parseValue()
			if p.failed {
				return nil
			}
			arr.elems = append(arr.elems, val)
			if !p.check(tokComma) {
				p.expect(tokRBrack, msgCommaOrRBrack)
				if p.failed {
					return nil
				}
				return arr
			}
		}
	case tokTrue:
		if p.scanLiteral("true") {
			return &jsValue{kind: jsBool, b: true}
		}
		return nil
	case tokFalse:
		if p.scanLiteral("false") {
			return &jsValue{kind: jsBool}
		}
		return nil
	case tokNull:
		if p.scanLiteral("null") {
			return &jsValue{kind: jsNull}
		}
		return nil
	}
	p.reportChar(p.current())
	return nil
}

// scanLiteral 即 ScanLiteral：首字符已由 token 判过。
func (p *jsonParser) scanLiteral(s string) bool {
	remaining := len(p.u) - p.cur
	if remaining >= len(s) {
		ok := true
		for i := 1; i < len(s); i++ {
			if int(p.u[p.cur+i]) != int(s[i]) {
				ok = false
				break
			}
		}
		if ok {
			p.cur += len(s)
			return true
		}
	}
	p.cur++
	for i := 0; i < min(len(s)-1, remaining-1); i++ {
		if int(s[1+i]) != int(p.u[p.cur]) {
			p.reportChar(int(p.u[p.cur]))
			return false
		}
		p.cur++
	}
	p.report(tokEOS, "")
	return false
}

func isDecimal(c int) bool { return c >= '0' && c <= '9' }

// isNumberPart 即 character_json_scan_flags 的 NumberPart 位。
func isNumberPart(c int) bool {
	return isDecimal(c) || c == '.' || c == 'e' || c == 'E' || c == '-' || c == '+'
}

func (p *jsonParser) advanceToNonDecimal() {
	for !p.atEnd() && isDecimal(int(p.u[p.cur])) {
		p.cur++
	}
}

// parseNumber 即 ParseJsonNumber。
func (p *jsonParser) parseNumber() (float64, bool) {
	start := p.cur
	c := p.current()
	sign := 1
	if c == '-' {
		sign = -1
		c = p.nextChar()
	}
	if c == '0' {
		c = p.nextChar()
		if isNumberPart(c) {
			if isDecimal(c) {
				p.report(tokNumber, "")
				return 0, false
			}
		} else if sign > 0 {
			return 0, true
		}
	} else {
		digits := 0
		for !p.atEnd() && digits < 9 && isDecimal(int(p.u[p.cur])) {
			p.cur++
			digits++
		}
		if digits == 0 {
			p.report(tokIllegal, msgNoNumberAfterMinus)
			return 0, false
		}
		if !isNumberPart(p.current()) {
			return p.toFloat(start), true
		}
		p.advanceToNonDecimal()
	}
	if p.current() == '.' {
		if !isDecimal(p.nextChar()) {
			p.report(tokIllegal, msgUnterminatedFractional)
			return 0, false
		}
		p.advanceToNonDecimal()
	}
	if c := p.current(); c == 'e' || c == 'E' {
		c = p.nextChar()
		if c == '-' || c == '+' {
			c = p.nextChar()
		}
		if !isDecimal(c) {
			p.report(tokIllegal, msgExponentMissingNumber)
			return 0, false
		}
		p.advanceToNonDecimal()
	}
	return p.toFloat(start), true
}

// toFloat 即 StringToDouble：文本已经是合法的 JSON 数，只剩溢出（±Infinity）与下溢（0）两种边界。
func (p *jsonParser) toFloat(start int) float64 {
	b := make([]byte, p.cur-start)
	for i := range b {
		b[i] = byte(p.u[start+i])
	}
	f, _ := strconv.ParseFloat(string(b), 64)
	return f
}

func hexValue(c int) int {
	switch {
	case c >= '0' && c <= '9':
		return c - '0'
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10
	}
	return -1
}

// scanString 即 ScanJsonString：开头的引号已消费。
func (p *jsonParser) scanString() (string, bool) {
	var out []uint16
	for {
		for !p.atEnd() {
			c := p.u[p.cur]
			if c <= 0xFF && (c < 0x20 || c == '"' || c == '\\') {
				break
			}
			out = append(out, c)
			p.cur++
		}
		if p.atEnd() {
			p.report(tokIllegal, msgUnterminatedString)
			return "", false
		}
		switch c := p.u[p.cur]; {
		case c == '"':
			p.cur++
			return string(utf16.Decode(out)), true
		case c == '\\':
			e := p.nextChar()
			if e < 0 || e > 0xFF {
				p.reportChar(e)
				return "", false
			}
			switch e {
			case '"', '\\', '/':
				out = append(out, uint16(e))
			case 'b':
				out = append(out, 0x08)
			case 't':
				out = append(out, 0x09)
			case 'n':
				out = append(out, 0x0A)
			case 'f':
				out = append(out, 0x0C)
			case 'r':
				out = append(out, 0x0D)
			case 'u':
				v := 0
				for range 4 {
					d := hexValue(p.nextChar())
					if d < 0 {
						p.report(tokIllegal, msgBadUnicodeEscape)
						return "", false
					}
					v = v*16 + d
				}
				out = append(out, uint16(v))
			default:
				p.report(tokIllegal, msgBadEscapedCharacter)
				return "", false
			}
			p.cur++
		default:
			p.report(tokIllegal, msgBadControlCharacter)
			return "", false
		}
	}
}
