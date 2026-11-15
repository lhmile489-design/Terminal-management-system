//go:build windows

// S08 对拍：外部终端（verify-review-extterm 的口径）。拦截起进程，只断言 argv 与 Dir，不真弹窗口。
// 期望值来自 testdata/win32_platform_cases.json（原版 terminal.ts，spawn 换成桩）。

package win32

import (
	"slices"
	"strings"
	"testing"

	"mile-console/internal/contract"
)

func TestOpenExternalTerminalMatchesOriginal(t *testing.T) {
	type spawn struct {
		File        string   `json:"file"`
		Args        []string `json:"args"`
		Cwd         string   `json:"cwd"`
		WindowsHide bool     `json:"windowsHide"`
		Stdio       string   `json:"stdio"`
	}
	type tc struct {
		scenarioIn
		Kind   string  `json:"kind"`
		Cwd    string  `json:"cwd"`
		Error  *string `json:"error"`
		Spawns []spawn `json:"spawns"`
	}
	cases := section[tc](t, loadPlatform(t), "terminal", 300)
	spawned, rejected := 0, 0
	for i, c := range cases {
		f := c.scenarioIn.fake()
		w := newWith(f.deps())
		err := w.OpenExternalTerminal(t.Context(), contract.ExternalTerminal(c.Kind), c.Cwd)
		if c.Error != nil {
			rejected++
			if err == nil || err.Error() != *c.Error {
				t.Errorf("第 %d 组 %s %q：Go err=%v，原版 %q", i, c.Kind, c.Cwd, err, *c.Error)
			}
			if len(f.calls) != 0 {
				t.Errorf("第 %d 组：报错时不该起进程，却记录了 %+v", i, f.calls)
			}
			continue
		}
		if err != nil {
			t.Errorf("第 %d 组 %s %q：原版成功，Go 报错 %v", i, c.Kind, c.Cwd, err)
			continue
		}
		if len(f.calls) != len(c.Spawns) {
			t.Errorf("第 %d 组：起进程 %d 次，原版 %d 次", i, len(f.calls), len(c.Spawns))
			continue
		}
		for j, s := range c.Spawns {
			got := f.calls[j]
			spawned++
			if got.fn != "spawn" || got.file != s.File || !slices.Equal(got.args, s.Args) || got.dir != s.Cwd {
				t.Errorf("第 %d 组：Go %s %q dir=%q，原版 %s %q cwd=%q", i, got.file, got.args, got.dir, s.File, s.Args, s.Cwd)
			}
			// 原版选项固定 windowsHide + stdio ignore，startHidden 照做；这里核对数据里确实是这两个值
			if !s.WindowsHide || s.Stdio != "ignore" {
				t.Errorf("第 %d 组：原版选项变了 windowsHide=%v stdio=%q", i, s.WindowsHide, s.Stdio)
			}
		}
	}
	if spawned == 0 || rejected == 0 {
		t.Fatalf("用例不全：起进程 %d 次、拒绝 %d 次", spawned, rejected)
	}
	t.Logf("%d 组场景与原版一致：拉起 %d 次（argv 与 Dir 逐项相同），拒绝 %d 次（文案相同）", len(cases), spawned, rejected)
}

// 红线：目录从不进命令行，只走 Dir；wt 只在 lstat 里认得时也要找得到。
func TestOpenExternalTerminalRedLines(t *testing.T) {
	local := `C:\Users\u\AppData\Local`
	wt := local + `\Microsoft\WindowsApps\wt.exe`
	cwd := `E:\proj\a & b; c | d`
	f := &fakeSys{
		env:    map[string]string{"LOCALAPPDATA": local, "ComSpec": `C:\WINDOWS\system32\cmd.exe`},
		lstat:  map[string]bool{wt: true},
		exists: map[string]bool{},
	}
	w := newWith(f.deps())
	if err := w.OpenExternalTerminal(t.Context(), contract.TerminalWT, cwd); err != nil {
		t.Fatalf("wt 只在 Lstat 下可见时应能找到：%v", err)
	}
	if len(f.calls) != 1 {
		t.Fatalf("应起 1 次进程，实际 %d 次", len(f.calls))
	}
	c := f.calls[0]
	want := []string{"/d", "/c", "start", "Mile Terminal", wt, "-d", "."}
	if !slices.Equal(c.args, want) || c.dir != cwd {
		t.Errorf("argv %q dir %q，期望 %q dir %q", c.args, c.dir, want, cwd)
	}
	for _, a := range c.args {
		if strings.Contains(a, "proj") {
			t.Errorf("目录进了命令行：%q", c.args)
		}
	}
}
