//go:build windows

// S08 对拍（文本与解析类）：期望值来自 testdata/win32_text_cases.json，
// 由 scripts/gen-win32-text-cases.mjs 跑原版 process.ts 与 node 内置函数生成。

package win32

import (
	"encoding/hex"
	"encoding/json"
	"math"
	"os"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"
	"unicode/utf8"

	"mile-console/internal/platform"
)

type textCases struct {
	Netstat []struct {
		Input *string `json:"input"`
		Hex   *string `json:"hex"`
		Rows  []struct {
			Port     float64 `json:"port"`
			Pid      float64 `json:"pid"`
			Families []int   `json:"families"`
		} `json:"rows"`
	} `json:"netstat"`
	Meta []struct {
		Stdout string `json:"stdout"`
		OK     bool   `json:"ok"`
		Error  string `json:"error"`
		Rows   []struct {
			Pid         int     `json:"pid"`
			Ppid        int     `json:"ppid"`
			Name        string  `json:"name"`
			ExecPath    *string `json:"execPath"`
			CommandLine *string `json:"commandLine"`
			StartedAt   *int64  `json:"startedAt"`
		} `json:"rows"`
		Mine []int `json:"mine"`
	} `json:"meta"`
	Decode []struct {
		Hex  string `json:"hex"`
		Text string `json:"text"`
	} `json:"decode"`
	Number []struct {
		S     string          `json:"s"`
		N     json.RawMessage `json:"n"`
		IsInt bool            `json:"isInt"`
	} `json:"number"`
	Lower  [][2]json.RawMessage `json:"lower"`
	Space  []rune               `json:"space"`
	SigmaX []rune               `json:"sigmaX"`
	SigmaY []rune               `json:"sigmaY"`
}

// Final_Sigma 的两个字符集合（Cased、Case_Ignorable）与 node 逐码点对拍，口径见生成器注释。
func TestFinalSigmaSets(t *testing.T) {
	c := loadText(t)
	if len(c.SigmaX) < 1000 || len(c.SigmaY) < 1000 {
		t.Fatalf("集合太小：X %d，Y %d", len(c.SigmaX), len(c.SigmaY))
	}
	inX, inY := map[rune]bool{}, map[rune]bool{}
	for _, r := range c.SigmaX {
		inX[r] = true
	}
	for _, r := range c.SigmaY {
		inY[r] = true
	}
	final := string(rune(0x3C2))
	sigma := string(rune(0x3A3))
	bad := 0
	for r := rune(0); r <= utf8.MaxRune; r++ {
		if (r >= 0xD800 && r <= 0xDFFF) || r == 0x3A3 {
			continue
		}
		x := strings.HasSuffix(jsToLower("A"+string(r)+sigma), final)
		y := strings.HasSuffix(jsToLower("1"+string(r)+sigma), final)
		if x != inX[r] || y != inY[r] {
			bad++
			if bad <= 10 {
				t.Errorf("U+%04X：Go X=%v Y=%v，node X=%v Y=%v", r, x, y, inX[r], inY[r])
			}
		}
	}
	if bad > 0 {
		t.Errorf("共 %d 个码点不一致", bad)
	}
}

func loadText(t *testing.T) textCases {
	t.Helper()
	b, err := os.ReadFile("testdata/win32_text_cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var c textCases
	if err := json.Unmarshal(b, &c); err != nil {
		t.Fatal(err)
	}
	return c
}

func TestParseNetstatMatchesOriginal(t *testing.T) {
	c := loadText(t)
	if len(c.Netstat) < 10 {
		t.Fatalf("用例只有 %d 组", len(c.Netstat))
	}
	total := 0
	for i, k := range c.Netstat {
		var input string
		switch {
		case k.Input != nil:
			input = *k.Input
		case k.Hex != nil:
			raw, err := hex.DecodeString(*k.Hex)
			if err != nil {
				t.Fatal(err)
			}
			input = jsDecodeUTF8(raw)
		}
		got := parseNetstat(input)
		want := make([]platform.ListenRow, 0, len(k.Rows))
		for _, r := range k.Rows {
			want = append(want, platform.ListenRow{Port: toInt(r.Port), Pid: toInt(r.Pid), Families: r.Families})
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("第 %d 组：Go %+v，原版 %+v", i, got, want)
		}
		total += len(want)
	}
	t.Logf("%d 组 netstat 输入、共 %d 行与原版一致（含一份本机真实 netstat 原始字节）", len(c.Netstat), total)
}

// 验收硬性要求：同端口两个 PID（0.0.0.0:P 与 [::]:P）不得合并；同 PID 双栈合并成一行。
func TestParseNetstatSamePortTwoPids(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  []platform.ListenRow
	}{
		{
			"两个 PID 各占一族",
			"  TCP    0.0.0.0:3000    0.0.0.0:0    LISTENING    100\r\n  TCP    [::]:3000    [::]:0    LISTENING    200\r\n",
			[]platform.ListenRow{{Port: 3000, Pid: 100, Families: []int{4}}, {Port: 3000, Pid: 200, Families: []int{6}}},
		},
		{
			"同 PID 双栈合并",
			"  TCP    0.0.0.0:5173    0.0.0.0:0    LISTENING    300\r\n  TCP    [::]:5173    [::]:0    LISTENING    300\r\n",
			[]platform.ListenRow{{Port: 5173, Pid: 300, Families: []int{4, 6}}},
		},
		{
			"同 PID 两个 IPv4 地址不重复记族",
			"  TCP 0.0.0.0:80 x LISTENING 9\n  TCP 127.0.0.1:80 x LISTENING 9\n",
			[]platform.ListenRow{{Port: 80, Pid: 9, Families: []int{4}}},
		},
		{
			"PID 4 与 0 丢弃",
			"  TCP 0.0.0.0:445 x LISTENING 4\n  TCP 0.0.0.0:135 x LISTENING 0\n",
			[]platform.ListenRow{},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := parseNetstat(c.input); !reflect.DeepEqual(got, c.want) {
				t.Errorf("得到 %+v，期望 %+v", got, c.want)
			}
		})
	}
}

func TestParseProcessMetaMatchesOriginal(t *testing.T) {
	c := loadText(t)
	if len(c.Meta) < 10 {
		t.Fatalf("用例只有 %d 组", len(c.Meta))
	}
	// 已登记的偏差（process.go ReadProcessMeta 注释）：原版不校验元素类型，procs 里的非对象元素照收成 pid 为 undefined 的行；
	// Go 按声明类型解码并报错。META_SCRIPT 的输出字段经 [int] / [long] 强转，不会出现这种输入。
	deviation := map[string]bool{`{"procs":[1]}`: true}
	hit := 0
	for i, k := range c.Meta {
		got, err := parseProcessMeta(k.Stdout, 42)
		if deviation[k.Stdout] {
			hit++
			if err == nil || !k.OK {
				t.Errorf("第 %d 组 %q：登记的偏差变了（原版 ok=%v，Go err=%v），复核注释", i, k.Stdout, k.OK, err)
			}
			continue
		}
		if !k.OK {
			if err == nil {
				t.Errorf("第 %d 组 %q：原版报错，Go 成功 %+v", i, k.Stdout, got)
			} else if k.Error != "" && err.Error() != k.Error {
				t.Errorf("第 %d 组：错误文案 %q，原版 %q", i, err, k.Error)
			}
			continue
		}
		if err != nil {
			t.Errorf("第 %d 组 %q：原版成功，Go 报错 %v", i, k.Stdout, err)
			continue
		}
		if got.At != 42 {
			t.Errorf("第 %d 组：At = %d", i, got.At)
		}
		var rows []platform.ProcessRow
		for _, r := range got.ByPid {
			rows = append(rows, r)
		}
		slices.SortFunc(rows, func(a, b platform.ProcessRow) int { return a.Pid - b.Pid })
		var want []platform.ProcessRow
		for _, r := range k.Rows {
			want = append(want, platform.ProcessRow{Pid: r.Pid, Ppid: r.Ppid, Name: r.Name, ExecPath: r.ExecPath, CommandLine: r.CommandLine, StartedAt: r.StartedAt})
		}
		if !reflect.DeepEqual(rows, want) {
			t.Errorf("第 %d 组 byPid：Go %+v，原版 %+v", i, rows, want)
		}
		mine := make([]int, 0, len(got.Mine))
		for p := range got.Mine {
			mine = append(mine, p)
		}
		slices.Sort(mine)
		if !slices.Equal(mine, k.Mine) && !(len(mine) == 0 && len(k.Mine) == 0) {
			t.Errorf("第 %d 组 mine：Go %v，原版 %v", i, mine, k.Mine)
		}
	}
	if hit != len(deviation) {
		t.Errorf("偏差用例命中 %d / %d，生成器里的输入变了", hit, len(deviation))
	}
}

func TestJSDecodeUTF8MatchesBuffer(t *testing.T) {
	c := loadText(t)
	if len(c.Decode) < 30 {
		t.Fatalf("用例只有 %d 组", len(c.Decode))
	}
	for _, k := range c.Decode {
		b, _ := hex.DecodeString(k.Hex)
		if got := jsDecodeUTF8(b); got != k.Text {
			t.Errorf("%s：Go %q，Buffer %q", k.Hex, got, k.Text)
		}
	}
}

func TestJSToNumberMatchesNumber(t *testing.T) {
	c := loadText(t)
	if len(c.Number) < 40 {
		t.Fatalf("用例只有 %d 组", len(c.Number))
	}
	for _, k := range c.Number {
		got := jsToNumber(k.S)
		var want float64
		var s string
		if json.Unmarshal(k.N, &s) == nil {
			switch s {
			case "NaN":
				want = math.NaN()
			case "Infinity":
				want = math.Inf(1)
			case "-Infinity":
				want = math.Inf(-1)
			default:
				t.Fatalf("未知特殊值 %q", s)
			}
		} else if err := json.Unmarshal(k.N, &want); err != nil {
			t.Fatal(err)
		}
		same := got == want || (math.IsNaN(got) && math.IsNaN(want))
		if !same {
			t.Errorf("Number(%q)：Go %v，node %v", k.S, got, want)
		}
		if jsIsInteger(got) != k.IsInt {
			t.Errorf("Number.isInteger(Number(%q))：Go %v，node %v", k.S, jsIsInteger(got), k.IsInt)
		}
	}
}

// jsToLower 逐码点与 node 的 toLowerCase 全表比对（node 只列出与自身不同的码点）。
func TestJSToLowerTable(t *testing.T) {
	c := loadText(t)
	if len(c.Lower) < 1000 {
		t.Fatalf("映射表只有 %d 项", len(c.Lower))
	}
	changed := map[rune]string{}
	for _, p := range c.Lower {
		var cpv rune
		var lo string
		if err := json.Unmarshal(p[0], &cpv); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(p[1], &lo); err != nil {
			t.Fatal(err)
		}
		changed[cpv] = lo
	}
	bad := 0
	for r := rune(0); r <= utf8.MaxRune; r++ {
		if r >= 0xD800 && r <= 0xDFFF {
			continue
		}
		want, ok := changed[r]
		if !ok {
			want = string(r)
		}
		if got := jsToLower(string(r)); got != want {
			bad++
			if bad <= 10 {
				t.Errorf("U+%04X：Go %q，node %q", r, got, want)
			}
		}
	}
	if bad > 0 {
		t.Errorf("共 %d 个码点不一致", bad)
	}
}

func TestJSIsSpaceTable(t *testing.T) {
	c := loadText(t)
	if len(c.Space) < 20 {
		t.Fatalf("空白表只有 %d 项", len(c.Space))
	}
	want := map[rune]bool{}
	for _, r := range c.Space {
		want[r] = true
	}
	for r := rune(0); r <= utf8.MaxRune; r++ {
		if r >= 0xD800 && r <= 0xDFFF {
			continue
		}
		if jsIsSpace(r) != want[r] {
			t.Errorf("U+%04X：Go %v，node /\\s/ %v", r, jsIsSpace(r), want[r])
		}
	}
}

func TestJSNumberKey(t *testing.T) {
	for _, c := range []struct {
		f    float64
		want string
	}{{1234, "1234"}, {0, "0"}, {9007199254740992, "9007199254740992"}, {1e20, "100000000000000000000"}, {1e21, "1e+21"}} {
		if got := jsNumberKey(c.f); got != c.want {
			t.Errorf("jsNumberKey(%v) = %q，期望 %q", c.f, got, c.want)
		}
	}
	_ = strconv.Itoa
}
