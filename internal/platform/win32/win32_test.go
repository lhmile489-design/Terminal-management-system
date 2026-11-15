//go:build windows

// S08 对拍：pathKey、环境相关列表、默认 shell、runPowerShell、killTree、常量表。
// 期望值来自 testdata/win32_platform_cases.json（原版 index.ts / powershell.ts，child_process 与 fs 换成桩）。

package win32

import (
	"encoding/json"
	"errors"
	"reflect"
	"slices"
	"testing"
	"time"

	"mile-console/internal/contract"
	"mile-console/internal/platform"
)

func TestPathKeyMatchesOriginal(t *testing.T) {
	type tc struct {
		Cwd string             `json:"cwd"`
		Env map[string]*string `json:"env"`
		P   string             `json:"p"`
		Key string             `json:"key"`
	}
	cases := section[tc](t, loadPlatform(t), "pathKey", 100)
	for _, c := range cases {
		w := newWith(scenarioIn{Env: c.Env, Cwd: c.Cwd}.fake().deps())
		if got := w.PathKey(c.P); got != c.Key {
			t.Errorf("cwd=%q env=%v pathKey(%q)：Go %q，原版 %q", c.Cwd, c.Env, c.P, got, c.Key)
		}
	}
	t.Logf("%d 组 pathKey 与原版一致", len(cases))
}

func TestEnvDependentListsMatchOriginal(t *testing.T) {
	type tc struct {
		Env       map[string]*string `json:"env"`
		WrapBatch struct {
			File string   `json:"file"`
			Args []string `json:"args"`
		} `json:"wrapBatch"`
		HBuilderX []string `json:"hbuilderx"`
	}
	cases := section[tc](t, loadPlatform(t), "env", 5)
	for i, c := range cases {
		w := newWith(scenarioIn{Env: c.Env}.fake().deps())
		file, args := w.WrapBatch(`C:\p\npm.cmd`, []string{"run", "dev", "a b", "&|"})
		if file != c.WrapBatch.File || !slices.Equal(args, c.WrapBatch.Args) {
			t.Errorf("第 %d 组 wrapBatch：Go %q %q，原版 %q %q", i, file, args, c.WrapBatch.File, c.WrapBatch.Args)
		}
		if got := w.HBuilderXCandidates(); !slices.Equal(got, c.HBuilderX) {
			t.Errorf("第 %d 组 hbuilderx：Go %q，原版 %q", i, got, c.HBuilderX)
		}
	}
}

func TestDefaultShellMatchesOriginal(t *testing.T) {
	type shell struct {
		File  string `json:"file"`
		Title string `json:"title"`
	}
	type tc struct {
		scenarioIn
		First  shell    `json:"first"`
		Second shell    `json:"second"`
		Args   []string `json:"args"`
		Init   *string  `json:"init"`
	}
	cases := section[tc](t, loadPlatform(t), "shell", 5)
	for i, c := range cases {
		f := c.scenarioIn.fake()
		w := newWith(f.deps())
		first := w.DefaultShell()
		f.exists = map[string]bool{} // 缓存后磁盘变化不影响结果
		second := w.DefaultShell()
		if first != (platform.Shell(c.First)) || second != (platform.Shell(c.Second)) {
			t.Errorf("第 %d 组：Go %+v / %+v，原版 %+v / %+v", i, first, second, c.First, c.Second)
		}
		checkShellArgsInit(t, w, first.File, c.Args, c.Init)
	}
}

func checkShellArgsInit(t *testing.T, w *Win32, file string, wantArgs []string, wantInit *string) {
	t.Helper()
	if got := w.ShellArgs(file); !slices.Equal(got, wantArgs) || got == nil {
		t.Errorf("shellArgs(%q)：Go %q，原版 %q", file, got, wantArgs)
	}
	init, ok := w.ShellInit(file)
	switch {
	case wantInit == nil && ok:
		t.Errorf("shellInit(%q)：Go %q，原版 null", file, init)
	case wantInit != nil && (!ok || init != *wantInit):
		t.Errorf("shellInit(%q)：Go %q,%v，原版 %q", file, init, ok, *wantInit)
	}
}

func TestIsPowerShellMatchesOriginal(t *testing.T) {
	type tc struct {
		File string   `json:"file"`
		Args []string `json:"args"`
		Init *string  `json:"init"`
	}
	cases := section[tc](t, loadPlatform(t), "isPowerShell", 10)
	w := newWith((&fakeSys{}).deps())
	for _, c := range cases {
		checkShellArgsInit(t, w, c.File, c.Args, c.Init)
	}
}

func TestRunPowerShellMatchesOriginal(t *testing.T) {
	type tc struct {
		scenarioIn
		Script string `json:"script"`
		Reply  struct {
			Err    *struct{ Message string } `json:"err"`
			Stdout string                    `json:"stdout"`
			Stderr string                    `json:"stderr"`
		} `json:"reply"`
		Result *string `json:"result"`
		Error  *string `json:"error"`
		Call   struct {
			File        string   `json:"file"`
			Args        []string `json:"args"`
			Timeout     int      `json:"timeout"`
			MaxBuffer   int      `json:"maxBuffer"`
			WindowsHide bool     `json:"windowsHide"`
			Encoding    string   `json:"encoding"`
		} `json:"call"`
	}
	cases := section[tc](t, loadPlatform(t), "runPowerShell", 40)
	for i, c := range cases {
		f := c.scenarioIn.fake()
		f.reply = reply{stdout: c.Reply.Stdout, stderr: c.Reply.Stderr}
		if c.Reply.Err != nil {
			f.reply.err = errors.New(c.Reply.Err.Message)
		}
		w := newWith(f.deps())
		got, err := w.runPowerShell(t.Context(), c.Script, runPowerShellTimeout)
		switch {
		case c.Error != nil && (err == nil || err.Error() != *c.Error):
			t.Errorf("第 %d 组：Go err=%v，原版 %q", i, err, *c.Error)
		case c.Result != nil && (err != nil || got != *c.Result):
			t.Errorf("第 %d 组：Go %q,%v，原版 %q", i, got, err, *c.Result)
		}
		if len(f.calls) != 1 {
			t.Fatalf("第 %d 组：调用 %d 次", i, len(f.calls))
		}
		k := f.calls[0]
		if k.file != c.Call.File || !slices.Equal(k.args, c.Call.Args) {
			t.Errorf("第 %d 组 argv：Go %s %q，原版 %s %q", i, k.file, k.args, c.Call.File, c.Call.Args)
		}
		if !k.hasTimout || k.timeout != time.Duration(c.Call.Timeout)*time.Millisecond || k.maxBuffer != c.Call.MaxBuffer {
			t.Errorf("第 %d 组：超时 %v 上限 %d，原版 %dms %d", i, k.timeout, k.maxBuffer, c.Call.Timeout, c.Call.MaxBuffer)
		}
		if !c.Call.WindowsHide || c.Call.Encoding != "utf8" {
			t.Errorf("第 %d 组：原版选项变了 %+v", i, c.Call)
		}
	}
}

func TestCollectTimeoutsMatchOriginal(t *testing.T) {
	type tc struct {
		File      string   `json:"file"`
		Args      []string `json:"args"`
		Timeout   int      `json:"timeout"`
		MaxBuffer int      `json:"maxBuffer"`
	}
	want := section[tc](t, loadPlatform(t), "collect", 2)
	f := &fakeSys{reply: reply{stdout: `{"procs":[],"mine":[]}`}}
	w := newWith(f.deps())
	if _, err := w.ReadProcessMeta(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := w.ReadListenPorts(t.Context()); err != nil {
		t.Fatal(err)
	}
	if len(f.calls) != len(want) {
		t.Fatalf("调用 %d 次，原版 %d 次", len(f.calls), len(want))
	}
	for i, c := range want {
		k := f.calls[i]
		args := k.args
		if len(args) > 5 && args[0] == "-NoProfile" {
			args = args[:5]
		}
		if k.file != c.File || !slices.Equal(args, c.Args) || k.timeout != time.Duration(c.Timeout)*time.Millisecond || k.maxBuffer != c.MaxBuffer {
			t.Errorf("第 %d 次：Go %s %q %v %d，原版 %s %q %dms %d", i, k.file, args, k.timeout, k.maxBuffer, c.File, c.Args, c.Timeout, c.MaxBuffer)
		}
	}
}

func TestKillTreeMatchesOriginal(t *testing.T) {
	type tc struct {
		Pid     int      `json:"pid"`
		File    string   `json:"file"`
		Args    []string `json:"args"`
		Timeout int      `json:"timeout"`
	}
	cases := section[tc](t, loadPlatform(t), "killTree", 3)
	for _, c := range cases {
		f := &fakeSys{reply: reply{err: errors.New("taskkill 失败也不报")}}
		w := newWith(f.deps())
		w.KillTree(t.Context(), c.Pid)
		k := f.calls[0]
		if k.file != c.File || !slices.Equal(k.args, c.Args) || k.timeout != time.Duration(c.Timeout)*time.Millisecond {
			t.Errorf("pid %d：Go %s %q %v，原版 %s %q %dms", c.Pid, k.file, k.args, k.timeout, c.File, c.Args, c.Timeout)
		}
	}
}

func TestConstantsMatchOriginal(t *testing.T) {
	var c struct {
		ID                     string                           `json:"id"`
		Binaries               map[platform.BinaryName][]string `json:"binaries"`
		WrapperFile            struct{ Maven, Gradle string }   `json:"wrapperFile"`
		UnsupportedLaunchModes []string                         `json:"unsupportedLaunchModes"`
		RequiresExecBit        bool                             `json:"requiresExecBit"`
		TerminalKinds          []contract.ExternalTerminal      `json:"terminalKinds"`
		DefaultTerminal        contract.ExternalTerminal        `json:"defaultTerminal"`
		GlobalHotkey           string                           `json:"globalHotkey"`
		ExternalTerminalTitle  string                           `json:"externalTerminalTitle"`
		MetaScript             string                           `json:"metaScript"`
		Attribution            struct {
			Transparent  []string                 `json:"transparent"`
			SourceByName []platform.SourceNames   `json:"sourceByName"`
			SourceByCmd  []platform.SourceNeedles `json:"sourceByCmd"`
			DevRuntime   []string                 `json:"devRuntime"`
			SystemDirs   []string                 `json:"systemDirs"`
		} `json:"attribution"`
	}
	if err := json.Unmarshal(loadPlatform(t)["constants"], &c); err != nil {
		t.Fatal(err)
	}
	w := New()
	check := func(name string, got, want any) {
		t.Helper()
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s：Go %v，原版 %v", name, got, want)
		}
	}
	check("id", w.ID(), c.ID)
	check("binaries", w.Binaries(), c.Binaries)
	if len(w.Binaries()) != len(platform.BinaryNames) {
		t.Errorf("binaries 有 %d 项，BinaryNames 有 %d 项", len(w.Binaries()), len(platform.BinaryNames))
	}
	check("wrapperFile", w.WrapperFile(), platform.WrapperFiles{Maven: c.WrapperFile.Maven, Gradle: c.WrapperFile.Gradle})
	check("unsupportedLaunchModes", len(w.UnsupportedLaunchModes()), len(c.UnsupportedLaunchModes))
	check("requiresExecBit", w.RequiresExecBit(), c.RequiresExecBit)
	check("terminalKinds", w.TerminalKinds(), c.TerminalKinds)
	check("defaultTerminal", w.DefaultTerminal(), c.DefaultTerminal)
	check("globalHotkey", w.GlobalHotkey(), c.GlobalHotkey)
	check("EXTERNAL_TERMINAL_TITLE", ExternalTerminalTitle, c.ExternalTerminalTitle)
	if metaScript != c.MetaScript || len(c.MetaScript) < 500 {
		t.Errorf("META_SCRIPT 与原版不是逐字相同（Go %d 字节，原版 %d 字节）", len(metaScript), len(c.MetaScript))
	}
	a := w.Attribution()
	check("transparent", sortedKeys(a.Transparent), sortedStrings(c.Attribution.Transparent))
	check("sourceByName", a.SourceByName, c.Attribution.SourceByName)
	check("sourceByCmd", a.SourceByCmd, c.Attribution.SourceByCmd)
	check("devRuntime", sortedKeys(a.DevRuntime), sortedStrings(c.Attribution.DevRuntime))
	check("systemDirs", a.SystemDirs, c.Attribution.SystemDirs)
	if len(c.Attribution.Transparent) != len(a.Transparent) {
		t.Errorf("transparent 有重复项？Go %d，原版 %d", len(a.Transparent), len(c.Attribution.Transparent))
	}
}

func sortedKeys(m map[string]bool) []string {
	var xs []string
	for k := range m {
		xs = append(xs, k)
	}
	slices.Sort(xs)
	return xs
}

func sortedStrings(xs []string) []string {
	ys := append([]string(nil), xs...)
	slices.Sort(ys)
	return ys
}

// encodeCommand 与 Buffer.from(s, 'utf16le').toString('base64') 一致：runPowerShell 的对拍已逐条比过 argv，
// 这里另断言一个含代理对的样本，防止 utf16 编码被换成 UTF-8。
func TestEncodeCommandUTF16LE(t *testing.T) {
	if got := encodeCommand("A" + string(rune(0x1F600))); got != "QQA92ADe" {
		t.Errorf("encodeCommand = %q", got)
	}
}
