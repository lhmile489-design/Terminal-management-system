// contract.Scripts 的键顺序与 JSON 读写。期望值来自 node 22.23.4 实测（V8 12.4）：
//
//	JSON.parse('{"b":"1","2":"x","a":"y","1":"z","b":"last","10":"t","-1":"m","01":"lead",
//	            "4294967295":"big","4294967294":"max"}')
//	Object.keys → ['1','2','10','4294967294','b','a','-1','01','4294967295']，b 的值是 'last'

package contract

import (
	"encoding/json"
	"slices"
	"testing"
)

const jsOrderInput = `{"b":"1","2":"x","a":"y","1":"z","b":"last","10":"t","-1":"m","01":"lead","4294967295":"big","4294967294":"max"}`

func TestScriptsJSKeyOrder(t *testing.T) {
	var s Scripts
	if err := json.Unmarshal([]byte(jsOrderInput), &s); err != nil {
		t.Fatal(err)
	}
	want := []string{"1", "2", "10", "4294967294", "b", "a", "-1", "01", "4294967295"}
	if got := s.Keys(); !slices.Equal(got, want) {
		t.Fatalf("keys %q, want %q", got, want)
	}
	if v, _ := s.Get("b"); v != "last" {
		t.Fatalf("b = %q, want last", v)
	}
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	const wantJSON = `{"1":"z","2":"x","10":"t","4294967294":"max","b":"last","a":"y","-1":"m","01":"lead","4294967295":"big"}`
	if string(b) != wantJSON {
		t.Fatalf("marshal %s\nwant    %s", b, wantJSON)
	}
}

func TestScriptsZeroAndEmpty(t *testing.T) {
	var zero Scripts
	if !zero.IsZero() {
		t.Fatal("zero value must be IsZero")
	}
	if b, _ := json.Marshal(zero); string(b) != "null" {
		t.Fatalf("zero marshals to %s", b)
	}
	if b, _ := json.Marshal(NewScripts()); string(b) != "{}" {
		t.Fatalf("empty marshals to %s", b)
	}
	if NewScripts().IsZero() {
		t.Fatal("empty object is not zero")
	}
	var s = ScriptsOf("dev", "vite")
	if err := json.Unmarshal([]byte("null"), &s); err != nil || s.Len() != 1 {
		t.Fatalf("null must leave value untouched: %v %d", err, s.Len())
	}
}

func TestScriptsUnmarshalRejects(t *testing.T) {
	for _, in := range []string{`[]`, `"x"`, `1`, `{"a":1}`, `{"a":null}`, `{"a":{}}`} {
		var s Scripts
		if err := json.Unmarshal([]byte(in), &s); err == nil {
			t.Errorf("%s: want error", in)
		}
	}
}

func TestScriptsEscaping(t *testing.T) {
	s := ScriptsOf("a<b", "x && y", "u", "\u2028")
	b, _ := json.Marshal(s)
	// json.Marshal 外层开着 HTML 转义，结果与 map[string]string 相同
	m, _ := json.Marshal(map[string]string{"a<b": "x && y", "u": "\u2028"})
	if string(b) != string(m) {
		t.Fatalf("got %s want %s", b, m)
	}
}

func TestScriptsCloneIndependent(t *testing.T) {
	a := ScriptsOf("dev", "vite")
	b := a.Clone()
	b.Set("build", "tsc")
	if a.Len() != 1 || b.Len() != 2 || !a.Equal(ScriptsOf("dev", "vite")) {
		t.Fatalf("clone shares data: %v %v", a.Keys(), b.Keys())
	}
	if (Scripts{}).Clone().IsZero() != true {
		t.Fatal("clone of zero must be zero")
	}
}

func TestIsArrayIndex(t *testing.T) {
	yes := []string{"0", "1", "10", "4294967294"}
	no := []string{"", "01", "-1", "4294967295", "1e3", " 1", "1.0", "99999999999"}
	for _, k := range yes {
		if _, ok := IsArrayIndex(k); !ok {
			t.Errorf("%q should be index", k)
		}
	}
	for _, k := range no {
		if _, ok := IsArrayIndex(k); ok {
			t.Errorf("%q should not be index", k)
		}
	}
}
