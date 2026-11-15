// JSON.parse 对拍：testdata/jsonparse_cases.json 由 scripts/gen-jsonparse-cases.mjs 跑 node 的 JSON.parse 生成。

package detect

import (
	"encoding/json"
	"math"
	"os"
	"slices"
	"strconv"
	"testing"
)

type jsDesc struct {
	T     string   `json:"t"`
	B     bool     `json:"b"`
	N     string   `json:"n"`
	S     string   `json:"s"`
	Keys  []string `json:"keys"`
	Props []jsDesc `json:"props"`
	Elems []jsDesc `json:"elems"`
}

func describeGo(v *jsValue) jsDesc {
	switch v.kind {
	case jsNull:
		return jsDesc{T: "null"}
	case jsBool:
		return jsDesc{T: "bool", B: v.b}
	case jsNumber:
		return jsDesc{T: "number", N: jsNumberString(v.n)}
	case jsString:
		return jsDesc{T: "string", S: v.s}
	case jsArray:
		d := jsDesc{T: "array", Elems: []jsDesc{}}
		for _, e := range v.elems {
			d.Elems = append(d.Elems, describeGo(e))
		}
		return d
	}
	d := jsDesc{T: "object", Keys: slices.Clone(v.keys), Props: []jsDesc{}}
	if d.Keys == nil {
		d.Keys = []string{}
	}
	for _, k := range v.keys {
		d.Props = append(d.Props, describeGo(v.props[k]))
	}
	return d
}

// jsNumberString 即 String(number)，测试里只用到整数、小数、指数与 Infinity 几种形状。
func jsNumberString(f float64) string {
	switch {
	case f == 0 && 1/f < 0:
		return "-0"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	}
	s := strconv.FormatFloat(f, 'g', -1, 64)
	if a := max(f, -f); a >= 1e-7 && a < 1e21 {
		s = strconv.FormatFloat(f, 'f', -1, 64)
	} else if e := slices.Index([]byte(s), 'e'); e >= 0 {
		// Go 写 1e+21 / 1e-07，JS 写 1e+21 / 1e-7
		exp := s[e+2:]
		for len(exp) > 1 && exp[0] == '0' {
			exp = exp[1:]
		}
		s = s[:e+2] + exp
	}
	return s
}

func TestJSONParseMatchesV8(t *testing.T) {
	raw, err := os.ReadFile("testdata/jsonparse_cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Cases []struct {
			Input string  `json:"input"`
			Value *jsDesc `json:"value"`
			Error string  `json:"error"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	if len(file.Cases) < 100 {
		t.Fatalf("only %d cases", len(file.Cases))
	}
	errs := 0
	for _, c := range file.Cases {
		v, msg := jsonParse(c.Input)
		if c.Error != "" {
			errs++
			if msg != c.Error {
				t.Errorf("%q\n got  %q\n want %q", c.Input, msg, c.Error)
			}
			continue
		}
		if msg != "" {
			t.Errorf("%q: unexpected error %q", c.Input, msg)
			continue
		}
		got, _ := json.Marshal(describeGo(v))
		want, _ := json.Marshal(c.Value)
		if string(got) != string(want) {
			t.Errorf("%q\n got  %s\n want %s", c.Input, got, want)
		}
	}
	if errs < 50 {
		t.Fatalf("only %d error cases", errs)
	}
}
