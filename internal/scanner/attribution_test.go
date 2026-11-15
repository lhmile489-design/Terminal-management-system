//go:build windows

// S13 对拍：testdata/attribution_cases.json 由 scripts/gen-attribution-cases.mjs 跑原版 attribution.ts 生成。
// 进程名表用 win32 实现的那一份（原版的 platform.attribution 在 Windows 上也是 win32 的表）。

package scanner

import (
	"encoding/json"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"mile-console/internal/contract"
	"mile-console/internal/platform"
	"mile-console/internal/platform/win32"
)

var tables = win32.New().Attribution()

type jsRow struct {
	Pid         int     `json:"pid"`
	Ppid        int     `json:"ppid"`
	Name        string  `json:"name"`
	ExecPath    *string `json:"execPath"`
	CommandLine *string `json:"commandLine"`
}

func (r jsRow) row() platform.ProcessRow {
	return platform.ProcessRow{Pid: r.Pid, Ppid: r.Ppid, Name: r.Name, ExecPath: r.ExecPath, CommandLine: r.CommandLine}
}

type traceCase struct {
	Label  string                `json:"label"`
	Rows   []jsRow               `json:"rows"`
	Pid    int                   `json:"pid"`
	Owned  bool                  `json:"owned"`
	Result contract.LaunchSource `json:"result"`
}

type cases struct {
	MaxAscent int         `json:"maxAscent"`
	Named     []traceCase `json:"named"`
	Random    []traceCase `json:"random"`
	Groups    []struct {
		Row       *jsRow                 `json:"row"`
		Ownership contract.Ownership     `json:"ownership"`
		EntryID   *string                `json:"entryId"`
		Result    contract.ListenerGroup `json:"result"`
	} `json:"groups"`
}

func load(t *testing.T) cases {
	t.Helper()
	b, err := os.ReadFile("testdata/attribution_cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var c cases
	if err := json.Unmarshal(b, &c); err != nil {
		t.Fatal(err)
	}
	return c
}

func runTrace(c traceCase) contract.LaunchSource {
	byPid := make(map[int]platform.ProcessRow, len(c.Rows))
	for _, r := range c.Rows {
		byPid[r.Pid] = r.row()
	}
	return TraceLaunchSource(tables, c.Pid, byPid, c.Owned)
}

func TestTraceLaunchSourceMatchesOriginal(t *testing.T) {
	c := load(t)
	if c.MaxAscent != MaxAscent {
		t.Fatalf("MAX_ASCENT：Go %d，原版 %d", MaxAscent, c.MaxAscent)
	}
	if len(c.Named) < 40 || len(c.Random) < 500 {
		t.Fatalf("用例不全：场景 %d，随机 %d", len(c.Named), len(c.Random))
	}
	seen := map[contract.LaunchSource]int{}
	for _, k := range c.Named {
		seen[k.Result]++
		if got := runTrace(k); got != k.Result {
			t.Errorf("%s：Go %q，原版 %q", k.Label, got, k.Result)
		}
	}
	for i, k := range c.Random {
		seen[k.Result]++
		if got := runTrace(k); got != k.Result {
			t.Errorf("随机第 %d 组（pid %d，owned %v）：Go %q，原版 %q", i, k.Pid, k.Owned, got, k.Result)
		}
	}
	// 每个来源取值都要在用例里出现过，否则某条规则没被对拍到
	for _, s := range contract.LaunchSources {
		if seen[s] == 0 {
			t.Errorf("来源 %q 没有用例覆盖", s)
		}
	}
	t.Logf("%d 组场景 + %d 组随机进程表与原版一致", len(c.Named), len(c.Random))
}

// 验收硬项，独立于对拍数据再断言一遍：正常父链、成环、超过 12 层截断、父进程已退出。
func TestTraceLaunchSourceKeySteps(t *testing.T) {
	str := func(s string) *string { return &s }
	table := func(rows ...platform.ProcessRow) map[int]platform.ProcessRow {
		m := map[int]platform.ProcessRow{}
		for _, r := range rows {
			m[r.Pid] = r
		}
		return m
	}
	r := func(pid, ppid int, name string) platform.ProcessRow {
		return platform.ProcessRow{Pid: pid, Ppid: ppid, Name: name}
	}

	chain := table(r(500, 400, "node.exe"), r(400, 300, "npm.cmd"), r(300, 200, "cmd.exe"), r(200, 100, "Code.exe"))
	if got := TraceLaunchSource(tables, 500, chain, false); got != contract.LaunchSourceVSCode {
		t.Errorf("正常父链应跳过中间层到 vscode：%q", got)
	}
	if got := TraceLaunchSource(tables, 500, chain, true); got != contract.LaunchSourceMile {
		t.Errorf("owned 应直接判 mile：%q", got)
	}
	cycle := table(r(10, 20, "node.exe"), r(20, 30, "cmd.exe"), r(30, 10, "foo.exe"))
	if got := TraceLaunchSource(tables, 10, cycle, false); got != contract.LaunchSourceUnknown {
		t.Errorf("成环且无来源应在 12 层后停：%q", got)
	}
	gone := table(r(500, 400, "node.exe"), r(400, 300, "cmd.exe"))
	if got := TraceLaunchSource(tables, 500, gone, false); got != contract.LaunchSourceUnknown {
		t.Errorf("父进程已退出应为 unknown：%q", got)
	}
	// 来源恰好在第 11 层能找到，第 12 层找不到（hop 从 0 到 11）
	deep := func(k int) map[int]platform.ProcessRow {
		m := map[int]platform.ProcessRow{}
		for i := range k {
			m[1000+i] = r(1000+i, 1000+i+1, "foo.exe")
		}
		m[1000+k] = r(1000+k, 8, "cursor.exe")
		return m
	}
	if got := TraceLaunchSource(tables, 1000, deep(11), false); got != contract.LaunchSourceCursor {
		t.Errorf("第 11 层的来源应找得到：%q", got)
	}
	if got := TraceLaunchSource(tables, 1000, deep(12), false); got != contract.LaunchSourceUnknown {
		t.Errorf("第 12 层的来源超出上溯上限：%q", got)
	}
	// 命令行只在非中间层上看
	viaCmd := table(r(500, 400, "node.exe"), platform.ProcessRow{Pid: 400, Ppid: 8, Name: "node.exe", CommandLine: str("claude-code")})
	if got := TraceLaunchSource(tables, 500, viaCmd, false); got != contract.LaunchSourceUnknown {
		t.Errorf("中间层 node 的命令行不该参与判定：%q", got)
	}
}

func TestClassifyGroupMatchesOriginal(t *testing.T) {
	c := load(t)
	if len(c.Groups) < 200 {
		t.Fatalf("分组用例只有 %d 组", len(c.Groups))
	}
	mine := 0
	for i, k := range c.Groups {
		var row *platform.ProcessRow
		if k.Row != nil {
			r := k.Row.row()
			row = &r
		}
		entry := ""
		if k.EntryID != nil {
			entry = *k.EntryID
		}
		if got := ClassifyGroup(tables, row, k.Ownership, entry); got != k.Result {
			t.Errorf("第 %d 组（row %+v，ownership %q，entryId %v）：Go %q，原版 %q", i, k.Row, k.Ownership, k.EntryID, got, k.Result)
		}
		if k.Result == contract.ListenerGroupMine {
			mine++
		}
	}
	if mine == 0 || mine == len(c.Groups) {
		t.Fatalf("用例不全：mine %d / %d", mine, len(c.Groups))
	}
}

// 红线 2：ownership 包不得依赖本包（来源与分组只用于展示，不参与 kill 授权）。
// ownership 包还没迁（S14）时这条测试跳过目录不存在的情况，迁过来之后自动生效。
func TestOwnershipDoesNotImportScanner(t *testing.T) {
	dir := filepath.Join("..", "ownership")
	ents, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		t.Skip("internal/ownership 尚未迁移（S14）")
	}
	if err != nil {
		t.Fatal(err)
	}
	checked := 0
	for _, e := range ents {
		if !strings.HasSuffix(e.Name(), ".go") {
			continue
		}
		f, err := parser.ParseFile(token.NewFileSet(), filepath.Join(dir, e.Name()), nil, parser.ImportsOnly)
		if err != nil {
			t.Fatal(err)
		}
		checked++
		for _, im := range f.Imports {
			p, _ := strconv.Unquote(im.Path.Value)
			if p == "mile-console/internal/scanner" {
				t.Errorf("%s import 了 scanner：归属判定不得依赖启动来源推断", e.Name())
			}
		}
	}
	if checked == 0 {
		t.Fatal("ownership 目录里没有 .go 文件，检查没有生效")
	}
}
