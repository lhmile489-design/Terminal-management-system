// 对应 src/main/services/SessionService.ts 里对 node-pty 的使用面：spawn / onData / onExit / write / resize / kill。
// 具体的 ConPTY 实现在 conpty_windows.go（D1 定案：直接调 kernel32）；这里只放平台无关的类型，
// 让 Service 能用假伪终端做单测。

package sessions

// PTYOptions 描述要在伪终端里启动的进程。
type PTYOptions struct {
	Path       string   // 可执行文件
	Args       []string // Args[0] 是程序名，之后是参数；为空则只有 Path
	Dir        string   // 工作目录
	Env        []string // "KEY=value"；nil 表示继承当前进程环境
	Cols, Rows int
}

// PTYProc 是 Service 对一个伪终端会话的全部需求，*PTY 满足它。
type PTYProc interface {
	Pid() int
	// Read 读伪终端输出；Close 之后返回错误（EOF 或管道已关闭）。
	Read(b []byte) (int, error)
	Write(b []byte) (int, error)
	Resize(cols, rows int) error
	// Close 关闭伪终端；之后 Read 必须返回错误。
	Close() error
	// Kill 只结束根进程，整树由 platform.KillTree 负责。
	Kill() error
	// Wait 等根进程退出并返回退出码。
	Wait() (int, error)
	// Exited 在根进程退出时关闭。
	Exited() <-chan struct{}
}

// Spawner 启动一个伪终端进程。
type Spawner func(PTYOptions) (PTYProc, error)
