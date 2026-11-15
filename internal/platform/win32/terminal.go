//go:build windows

// 对应 src/main/platform/win32/terminal.ts。

package win32

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"mile-console/internal/contract"
)

// winTerminals 即原版 WIN_TERMINALS，顺序照搬。
var winTerminals = []contract.ExternalTerminal{
	contract.TerminalWT, contract.TerminalPwsh, contract.TerminalPowerShell, contract.TerminalCmd, contract.TerminalGitBash,
}

// terminalLabel 即原版 LABEL。
var terminalLabel = map[contract.ExternalTerminal]string{
	contract.TerminalWT:         "Windows Terminal",
	contract.TerminalPwsh:       "PowerShell 7",
	contract.TerminalPowerShell: "PowerShell",
	contract.TerminalCmd:        "CMD",
	contract.TerminalGitBash:    "Git Bash",
}

// ExternalTerminalTitle 新窗口的标题，即原版 EXTERNAL_TERMINAL_TITLE（D3 定案后再定是否改名）。
// 含空格是有意的：Go 的 exec 与 Node 一样会给它加引号，start 才把它当标题而不是程序名。
const ExternalTerminalTitle = "Mile Terminal"

// terminalCandidates 即原版 candidates(kind)。env 在调用时读（原版每次调用都读 process.env）。
func (w *Win32) terminalCandidates(kind contract.ExternalTerminal) []string {
	root, ok := w.sys.getenv("SystemRoot")
	if !ok {
		root = `C:\Windows`
	}
	local, ok := w.sys.getenv("LOCALAPPDATA")
	if !ok {
		local = ""
	}
	switch kind {
	case contract.TerminalWT:
		// 应用执行别名是重解析点，Stat 认不出（实测报 EACCES），下面用 Lstat 判
		if local == "" {
			return nil
		}
		return []string{jsJoin(local, "Microsoft", "WindowsApps", "wt.exe")}
	case contract.TerminalPwsh:
		list := []string{`C:\Program Files\PowerShell\7\pwsh.exe`}
		if local != "" {
			list = append(list, jsJoin(local, "Microsoft", "WindowsApps", "pwsh.exe"))
		}
		return list
	case contract.TerminalPowerShell:
		return []string{jsJoin(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")}
	case contract.TerminalCmd:
		if comspec, ok := w.sys.getenv("ComSpec"); ok {
			return []string{comspec}
		}
		return []string{jsJoin(root, "System32", "cmd.exe")}
	case contract.TerminalGitBash:
		list := []string{`C:\Program Files\Git\git-bash.exe`, `C:\Program Files (x86)\Git\git-bash.exe`}
		if local != "" {
			list = append(list, jsJoin(local, "Programs", "Git", "git-bash.exe"))
		}
		return list
	}
	return nil
}

// terminalFixedArgs 即原版 fixedArgs。**目录从不出现在参数里**，一律经 cmd.Dir 传：
// wt 用 `-d .`、Git Bash 用 `--cd-to-here` 表示「就在当前目录」。
// 把路径塞进参数会有两个坑：wt 把 `;` 当子命令分隔符，cmd 会解释 `&` `|` 这类字符。
func terminalFixedArgs(kind contract.ExternalTerminal) []string {
	switch kind {
	case contract.TerminalWT:
		return []string{"-d", "."}
	case contract.TerminalPwsh, contract.TerminalPowerShell:
		return []string{"-NoLogo", "-NoExit"}
	case contract.TerminalCmd:
		return []string{"/K"}
	case contract.TerminalGitBash:
		return []string{"--cd-to-here"}
	}
	return nil
}

func isWinKind(kind contract.ExternalTerminal) bool { return slices.Contains(winTerminals, kind) }

// OpenExternalTerminal 用设置里选的外部终端打开一个目录。cwd 必须是调用方已按登记条目解析并校验过的目录。
//
// 经 `cmd /d /c start "标题" <终端> <固定参数>` 拉起：直接起控制台程序拿不到自己的
// 控制台窗口，stdin 一关就退出（实测 PowerShell / CMD 都是 3 秒内消失）。命令行上的每一段
// 都是代码里的常量，没有任何来自条目或用户的字符串。
//
// 原版 spawn 失败（child 'error' 事件）被吞掉、不报给调用方；这里同样只返回同步阶段的校验错误，
// 起进程失败不往上抛。
func (w *Win32) OpenExternalTerminal(ctx context.Context, kind contract.ExternalTerminal, cwd string) error {
	if !isWinKind(kind) {
		return fmt.Errorf("外部终端设置非法：%s", string(kind))
	}
	// cmd 不能把 UNC 路径当工作目录，会静默退回 C:\Windows，用户会以为开对了地方。
	// 先 resolve：手改配置写成 //server/share 的正斜杠形式也会被规范成 \\server\share
	if strings.HasPrefix(w.resolve(cwd), `\\`) {
		return fmt.Errorf("外部终端不支持网络路径")
	}
	exe := ""
	for _, p := range w.terminalCandidates(kind) {
		if w.sys.lstat(p) {
			exe = p
			break
		}
	}
	if exe == "" {
		return fmt.Errorf("未找到 %s，可在设置里换一个外部终端", terminalLabel[kind])
	}
	comspec, ok := w.sys.getenv("ComSpec")
	if !ok {
		comspec = "cmd.exe"
	}
	args := append([]string{"/d", "/c", "start", ExternalTerminalTitle, exe}, terminalFixedArgs(kind)...)
	// 外部终端要活过这次绑定调用：脱离调用方的取消，只留值
	_ = w.sys.start(context.WithoutCancel(ctx), comspec, args, cwd)
	return nil
}
