//go:build windows

// 对应 src/main/platform/win32/index.ts：Windows 实现。行为与原版 2.5.1 一致：
// 进程采集走 netstat + CIM，终止走 taskkill /T /F，批处理经 cmd /d /s /c 转发。

package win32

import (
	"context"
	"strings"
	"sync"
	"time"

	"mile-console/internal/contract"
	"mile-console/internal/platform"
)

// Win32 实现 platform.Platform。状态只有两个惰性缓存（默认 shell、PowerShell 路径），加锁。
type Win32 struct {
	sys          sysDeps
	shellCands   []string
	psCandidates []string

	mu          sync.Mutex
	cachedShell string
	psPath      string
}

var _ platform.Platform = (*Win32)(nil)

// New 用真实的系统依赖构造。SHELL_CANDIDATES / PS_CANDIDATES 与原版一样在构造时（模块加载时）读一次 SystemRoot。
func New() *Win32 { return newWith(realSys()) }

func newWith(sys sysDeps) *Win32 {
	return &Win32{sys: sys, shellCands: shellCandidates(sys.getenv), psCandidates: psCandidates(sys.getenv)}
}

// shellCandidates 即原版 SHELL_CANDIDATES。
func shellCandidates(getenv func(string) (string, bool)) []string {
	root, ok := getenv("SystemRoot")
	if !ok {
		root = `C:\Windows`
	}
	return []string{
		`C:\Program Files\PowerShell\7\pwsh.exe`,
		root + `\System32\WindowsPowerShell\v1.0\powershell.exe`,
	}
}

// isPowerShell 即原版 /powershell\.exe$|pwsh\.exe$/i。
func isPowerShell(file string) bool {
	return jsHasSuffixFold(file, "powershell.exe") || jsHasSuffixFold(file, "pwsh.exe")
}

// binaries 即原版 BINARIES：包管理器与运行时的可执行文件候选名，经 whichAny 在 PATH 里定位，用户不能指定。
var binaries = map[platform.BinaryName][]string{
	platform.BinaryNpm:    {"npm.cmd", "npm.exe"},
	platform.BinaryPnpm:   {"pnpm.cmd", "pnpm.exe"},
	platform.BinaryYarn:   {"yarn.cmd", "yarn.exe"},
	platform.BinaryBun:    {"bun.exe"},
	platform.BinaryJava:   {"java.exe"},
	platform.BinaryMvn:    {"mvn.cmd", "mvn.bat", "mvn"},
	platform.BinaryGradle: {"gradle.cmd", "gradle.bat", "gradle"},
	platform.BinaryPython: {"python.exe", "python3.exe", "py.exe", "python", "python3"},
	platform.BinaryGo:     {"go.exe", "go"},
	platform.BinaryCargo:  {"cargo.exe", "cargo"},
}

func set(names ...string) map[string]bool {
	m := make(map[string]bool, len(names))
	for _, n := range names {
		m[n] = true
	}
	return m
}

// attribution 即原版 ATTRIBUTION。
var attribution = platform.AttributionTables{
	// 不跳过的话所有 npm 启动的服务来源都是「终端」——
	// 链条是 VS Code → cmd.exe → npm.cmd → node → vite，真正有信息量的是最上面那一层
	Transparent: set(
		"cmd.exe", "powershell.exe", "pwsh.exe", "bash.exe", "sh.exe", "zsh.exe", "conhost.exe",
		"openconsole.exe", "node.exe", "npm.cmd", "npm.exe", "pnpm.exe", "pnpm.cmd", "yarn.exe",
		"yarn.cmd", "bun.exe", "npx.cmd", "py.exe", "python.exe", "python3.exe",
	),
	SourceByName: []platform.SourceNames{
		{Source: contract.LaunchSourceVSCode, Names: []string{"code.exe", "code - insiders.exe", "codium.exe"}},
		{Source: contract.LaunchSourceCursor, Names: []string{"cursor.exe"}},
		{
			Source: contract.LaunchSourceJetBrains,
			Names:  []string{"webstorm64.exe", "webstorm.exe", "idea64.exe", "idea.exe", "pycharm64.exe", "pycharm.exe"},
		},
		{Source: contract.LaunchSourceClaude, Names: []string{"claude.exe"}},
		{Source: contract.LaunchSourceCodex, Names: []string{"codex.exe"}},
		{
			Source: contract.LaunchSourceTerminal,
			Names:  []string{"windowsterminal.exe", "wt.exe", "alacritty.exe", "wezterm-gui.exe", "mintty.exe"},
		},
		{Source: contract.LaunchSourceExplorer, Names: []string{"explorer.exe"}},
		{Source: contract.LaunchSourceService, Names: []string{"services.exe", "svchost.exe", "wininit.exe"}},
	},
	SourceByCmd: []platform.SourceNeedles{
		{Source: contract.LaunchSourceClaude, Needles: []string{"claude-code", "anthropic"}},
		{Source: contract.LaunchSourceCodex, Needles: []string{"codex-cli"}},
		{Source: contract.LaunchSourceVSCode, Needles: []string{`\.vscode\`, `\.vscode-server\`}},
		{Source: contract.LaunchSourceCursor, Needles: []string{`\.cursor\`}},
	},
	DevRuntime: set(
		"node.exe", "bun.exe", "deno.exe", "python.exe", "python3.exe", "pythonw.exe", "java.exe",
		"dotnet.exe", "go.exe", "ruby.exe", "php.exe", "nginx.exe", "httpd.exe", "caddy.exe",
		"mysqld.exe", "postgres.exe", "redis-server.exe", "mongod.exe", "esbuild.exe", "vite.exe",
		"cargo.exe", "hugo.exe",
	),
	// 系统目录下的进程归后台：装在这里的东西不是用户此刻在开发的项目
	SystemDirs: []string{`c:\windows\`, `c:\program files\windowsapps\`, `\microsoft\windowsapps\`},
}

func (w *Win32) ID() string { return "win32" }

// killTreeTimeout 即原版 taskkill 的 timeout: 5000。
const killTreeTimeout = 5000 * time.Millisecond

// KillTree Vite/webpack 会拉起子进程，结束 conhost 根进程不够，必须带树终止。
// 等 taskkill 返回再返回：退出清理靠这一步确认进程树已结束。taskkill 的成败都不报（原版回调里不看 err）。
func (w *Win32) KillTree(ctx context.Context, rootPid int) {
	ctx, cancel := context.WithTimeout(ctx, killTreeTimeout)
	defer cancel()
	_, _, _ = w.sys.run(ctx, "taskkill.exe", []string{"/PID", jsNumberKey(float64(rootPid)), "/T", "/F"}, 1024*1024)
}

// Binaries 返回副本，调用方改不到包级表。
func (w *Win32) Binaries() map[platform.BinaryName][]string {
	out := make(map[platform.BinaryName][]string, len(binaries))
	for k, v := range binaries {
		out[k] = append([]string(nil), v...)
	}
	return out
}

func (w *Win32) WrapperFile() platform.WrapperFiles {
	return platform.WrapperFiles{Maven: "mvnw.cmd", Gradle: "gradlew.bat"}
}

// WrapBatch npm.cmd / mvnw.cmd 是批处理文件，CreateProcess 不能直接执行，必须经 cmd.exe。
// 参数仍以数组传入，脚本名另有白名单，不做字符串拼接。
//
// 已知原版问题 I1，见 docs/MIGRATION-PLAN.md：file 是含空格的绝对路径时 cmd /s 重新解析会拆断。照原样搬。
func (w *Win32) WrapBatch(file string, args []string) (string, []string) {
	comspec, ok := w.sys.getenv("ComSpec")
	if !ok {
		comspec = "cmd.exe"
	}
	return comspec, append([]string{"/d", "/s", "/c", file}, args...)
}

func (w *Win32) UnsupportedLaunchModes() map[contract.LaunchMode]bool {
	return map[contract.LaunchMode]bool{}
}

func (w *Win32) RequiresExecBit() bool { return false }

// HBuilderXCandidates 它不在 PATH，所以按绝对路径探测，顺序即优先级。测试可用 MILE_HBUILDERX_CLI 指向夹具里的假 cli。
func (w *Win32) HBuilderXCandidates() []string {
	// 原版 `if (override)`：空串不算覆盖
	if override, _ := w.sys.getenv("MILE_HBUILDERX_CLI"); override != "" {
		return []string{override}
	}
	list := []string{
		`D:\HBuilderX\cli.exe`,
		`C:\Program Files\HBuilderX\cli.exe`,
		`D:\Program Files\HBuilderX\cli.exe`,
		`C:\HBuilderX\cli.exe`,
	}
	if local, _ := w.sys.getenv("LOCALAPPDATA"); local != "" {
		list = append(list, jsJoin(local, "HBuilderX", "cli.exe"))
	}
	return list
}

// DefaultShell 第一个存在的 SHELL_CANDIDATE，否则 ComSpec，否则 cmd.exe；结果缓存。
func (w *Win32) DefaultShell() platform.Shell {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.cachedShell == "" {
		for _, p := range w.shellCands {
			if w.sys.exists(p) {
				w.cachedShell = p
				break
			}
		}
		if w.cachedShell == "" {
			if comspec, ok := w.sys.getenv("ComSpec"); ok {
				w.cachedShell = comspec
			} else {
				w.cachedShell = "cmd.exe"
			}
		}
	}
	return platform.Shell{File: w.cachedShell, Title: "PowerShell"}
}

func (w *Win32) ShellArgs(file string) []string {
	if isPowerShell(file) {
		return []string{"-NoLogo", "-NoExit"}
	}
	return []string{}
}

// shellInitPowerShell ConPTY 默认代码页 936，中文与进度条会乱码。原文照搬，末尾是 \r。
const shellInitPowerShell = "chcp 65001 > $null; [Console]::OutputEncoding = [Text.Encoding]::UTF8; Clear-Host\r"

func (w *Win32) ShellInit(file string) (string, bool) {
	if isPowerShell(file) {
		return shellInitPowerShell, true
	}
	return "", false
}

func (w *Win32) TerminalKinds() []contract.ExternalTerminal {
	return append([]contract.ExternalTerminal(nil), winTerminals...)
}

func (w *Win32) DefaultTerminal() contract.ExternalTerminal { return contract.TerminalWT }

// resolve 即 path.resolve(p)（win32），当前目录与驱动器当前目录取自 sys。
func (w *Win32) resolve(p string) string {
	return jsResolve(w.sys.getwd, w.sys.getenv, p)
}

// PathKey 大小写不敏感，且要消掉 `a\b\..\b` 这类等价写法。
func (w *Win32) PathKey(p string) string {
	return jsToLower(strings.TrimRight(w.resolve(p), `\/`))
}

// PreparePath Windows 的 GUI 应用继承完整的用户 PATH，不需要补。
func (w *Win32) PreparePath(bool) {}

func (w *Win32) Attribution() platform.AttributionTables { return attribution }

func (w *Win32) GlobalHotkey() string { return "Ctrl+Alt+M" }
