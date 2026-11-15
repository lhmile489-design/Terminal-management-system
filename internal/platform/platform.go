// 对应 src/main/platform/types.ts：平台适配层的数据结构与接口（docs/MACOS-PORTING.md §4）。
//
// 只有这一层知道 netstat / lsof、taskkill / 进程组、cmd.exe 包装这些平台细节；
// 服务层依赖 Platform 接口，不再直接调用任何平台命令。判定逻辑（归属三重凭据、
// 预检、命令白名单）留在服务层，两个平台共用一份。
//
// 本次只实现 win32（internal/platform/win32），darwin 不迁（D5），接口保留。
// 选哪个实现由组装处（main / App 初始化）决定：platform 包不 import win32，避免循环依赖。

package platform

import (
	"context"

	"mile-console/internal/contract"
)

// ProcessRow 一个进程的元数据。可选字段用指针，nil 即原版的 undefined。
type ProcessRow struct {
	Pid         int
	Ppid        int
	Name        string
	ExecPath    *string
	CommandLine *string
	// StartedAt Unix ms，用于识别 PID 复用。
	StartedAt *int64
}

// ListenRow 一条监听记录。
type ListenRow struct {
	Port int
	Pid  int
	// Families 该 (pid, port) 实际绑定的地址族（4 / 6）。同一进程双栈监听时两族都在，仍只算一行，
	// 下游按 pid:port 计数的逻辑不受影响。解析不出族（lsof 的 `*:P`）时为空。
	// 只给健康检查选回环地址用，不参与归属判定。
	Families []int
}

// ProcessMeta 进程元数据快照。
type ProcessMeta struct {
	ByPid map[int]ProcessRow
	// Mine 当前用户的所有 PID（Windows：登录会话关联；macOS：uid 相同）。
	Mine map[int]struct{}
	At   int64
}

// ProcessTable 元数据加监听表。
type ProcessTable struct {
	ProcessMeta
	Listens []ListenRow
}

// BinaryName 主进程按名字查 PATH 的可执行文件。名字是常量，用户不能指定。
type BinaryName string

const (
	BinaryNpm    BinaryName = "npm"
	BinaryPnpm   BinaryName = "pnpm"
	BinaryYarn   BinaryName = "yarn"
	BinaryBun    BinaryName = "bun"
	BinaryJava   BinaryName = "java"
	BinaryMvn    BinaryName = "mvn"
	BinaryGradle BinaryName = "gradle"
	BinaryPython BinaryName = "python"
	BinaryGo     BinaryName = "go"
	BinaryCargo  BinaryName = "cargo"
)

// BinaryNames 与 TS 的 BinaryName 联合类型同序（PackageManager 展开在前）。
var BinaryNames = []BinaryName{
	BinaryNpm, BinaryPnpm, BinaryYarn, BinaryBun, BinaryJava, BinaryMvn, BinaryGradle, BinaryPython, BinaryGo, BinaryCargo,
}

// SourceNames 按进程名推断启动来源的一组规则。
type SourceNames struct {
	Source contract.LaunchSource
	Names  []string
}

// SourceNeedles 按命令行子串推断启动来源的一组规则。
type SourceNeedles struct {
	Source  contract.LaunchSource
	Needles []string
}

// AttributionTables 启动来源推断用的进程名表，只用于展示，绝不参与终止授权（红线 2）。
type AttributionTables struct {
	// Transparent 上溯时跳过的中间层：shell、包管理器、运行时包装。
	Transparent  map[string]bool
	SourceByName []SourceNames
	SourceByCmd  []SourceNeedles
	// DevRuntime 监听端口时默认归「我的服务」的开发运行时。
	DevRuntime map[string]bool
	// SystemDirs 执行路径落在这些目录下的进程默认归后台（小写比较）。
	SystemDirs []string
}

// WrapperFiles 项目自带的构建 wrapper 文件名。
type WrapperFiles struct {
	Maven  string
	Gradle string
}

// Shell 自建终端用的 shell 与界面上的默认标题。
type Shell struct {
	File  string
	Title string
}

// Platform 即原版 Platform 接口。原版 readListenPorts / readProcessMeta 的 timeoutMs 参数
// 在所有调用点都没传，这里固定用原版默认值，取消走 ctx。
type Platform interface {
	ID() string

	// ── 进程采集 ──
	ReadListenPorts(ctx context.Context) ([]ListenRow, error)
	ReadProcessMeta(ctx context.Context) (ProcessMeta, error)
	// KillTree 终止会话进程树；返回时信号已发完并确认结束（或到达上限）。
	KillTree(ctx context.Context, rootPid int)

	// ── 命令构造 ──
	Binaries() map[BinaryName][]string
	WrapperFile() WrapperFiles
	// WrapBatch 批处理类可执行文件（npm.cmd、mvnw.cmd）的包装。Windows 必须经 `cmd /d /s /c` 转发，
	// macOS 原样返回。参数始终是数组，不拼字符串（红线 3）。
	WrapBatch(file string, args []string) (string, []string)
	// UnsupportedLaunchModes 这些启动方式在本平台首版不支持，条目只能「仅登记」。
	UnsupportedLaunchModes() map[contract.LaunchMode]bool
	// RequiresExecBit 项目内可执行文件（wrapper）是否要求执行位。
	RequiresExecBit() bool
	// HBuilderXCandidates HBuilderX 命令行的探测位置；空表示本平台不支持。
	HBuilderXCandidates() []string

	// ── 终端 ──
	DefaultShell() Shell
	// ShellArgs 拉起这个 shell 的固定参数（PowerShell：-NoLogo -NoExit；zsh / bash：-l）。
	ShellArgs(file string) []string
	// ShellInit 新会话启动后先写入的初始化命令；没有时 ok 为 false（原版返回 null）。
	ShellInit(file string) (cmd string, ok bool)
	TerminalKinds() []contract.ExternalTerminal
	DefaultTerminal() contract.ExternalTerminal
	OpenExternalTerminal(ctx context.Context, kind contract.ExternalTerminal, cwd string) error

	// ── 路径与环境 ──
	// PathKey 路径比较键：Windows 不区分大小写，macOS 保留大小写。
	PathKey(p string) string
	// PreparePath 启动时补全 PATH（macOS GUI 应用拿不到 shell 里的 PATH）；Windows 不做任何事。
	PreparePath(loginShellPath bool)

	Attribution() AttributionTables

	// ── 外壳 ──
	GlobalHotkey() string
}
