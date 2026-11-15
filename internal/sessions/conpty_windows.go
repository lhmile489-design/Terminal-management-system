// 对应 src/main/services/SessionService.ts 里 node-pty（useConpty: true）的职责。
// D1 定案：直接调用 kernel32 的 CreatePseudoConsole 系列 API，不引入第三方库。
// 实现思路参考 mygo v0.8.3 plugins/terminal/internal/pty/pty_windows.go（该包在 internal 下，
// 无法 import，所以这里自己写一份；只依赖标准库 syscall，go.mod 不新增依赖）。

package sessions

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

var (
	kernel32                              = syscall.NewLazyDLL("kernel32.dll")
	procCreatePseudoConsole               = kernel32.NewProc("CreatePseudoConsole")
	procResizePseudoConsole               = kernel32.NewProc("ResizePseudoConsole")
	procClosePseudoConsole                = kernel32.NewProc("ClosePseudoConsole")
	procInitializeProcThreadAttributeList = kernel32.NewProc("InitializeProcThreadAttributeList")
	procUpdateProcThreadAttribute         = kernel32.NewProc("UpdateProcThreadAttribute")
	procDeleteProcThreadAttributeList     = kernel32.NewProc("DeleteProcThreadAttributeList")
)

const (
	procThreadAttributePseudoConsole = 0x00020016
	extendedStartupInfoPresent       = 0x00080000
	createUnicodeEnvironment         = 0x00000400
)

// ErrPTYClosed 在 Close 之后写入或调整尺寸时返回。
var ErrPTYClosed = errors.New("conpty: closed")

type startupInfoEx struct {
	syscall.StartupInfo
	attributes uintptr
}

// PTY 是跑在 ConPTY 里的一个进程：Read 读输出，Write 敲输入。
type PTY struct {
	mu      sync.Mutex
	console uintptr // HPCON，关闭后为 0
	in      *os.File
	out     *os.File
	process syscall.Handle
	pid     int
	exited  chan struct{}
	code    int
	waitErr error
}

// StartPTY 启动进程。
func StartPTY(o PTYOptions) (*PTY, error) {
	if o.Cols <= 0 || o.Rows <= 0 {
		o.Cols, o.Rows = 80, 24
	}
	if len(o.Args) == 0 {
		o.Args = []string{o.Path}
	}
	if err := procCreatePseudoConsole.Find(); err != nil {
		return nil, errors.New("conpty: 需要 Windows 10 1809 或更新版本")
	}
	var inR, inW, outR, outW syscall.Handle
	if err := syscall.CreatePipe(&inR, &inW, nil, 0); err != nil {
		return nil, fmt.Errorf("conpty: %w", err)
	}
	if err := syscall.CreatePipe(&outR, &outW, nil, 0); err != nil {
		syscall.CloseHandle(inR)
		syscall.CloseHandle(inW)
		return nil, fmt.Errorf("conpty: %w", err)
	}
	var console uintptr
	r, _, _ := procCreatePseudoConsole.Call(coord(o.Cols, o.Rows), uintptr(inR), uintptr(outW), 0, uintptr(unsafe.Pointer(&console)))
	// 伪控制台持有自己的一份句柄，这里的副本关掉
	syscall.CloseHandle(inR)
	syscall.CloseHandle(outW)
	if r != 0 {
		syscall.CloseHandle(inW)
		syscall.CloseHandle(outR)
		return nil, fmt.Errorf("conpty: CreatePseudoConsole: %w", syscall.Errno(r&0xFFFF))
	}
	p := &PTY{console: console, exited: make(chan struct{})}
	p.in = os.NewFile(uintptr(inW), "conpty-in")
	p.out = os.NewFile(uintptr(outR), "conpty-out")
	if err := p.spawn(o); err != nil {
		p.Close()
		p.out.Close()
		return nil, err
	}
	go func() {
		p.code, p.waitErr = p.wait()
		close(p.exited)
	}()
	return p, nil
}

func (p *PTY) spawn(o PTYOptions) error {
	var size uintptr
	procInitializeProcThreadAttributeList.Call(0, 1, 0, uintptr(unsafe.Pointer(&size)))
	list := make([]byte, size)
	if r, _, err := procInitializeProcThreadAttributeList.Call(uintptr(unsafe.Pointer(&list[0])), 1, 0, uintptr(unsafe.Pointer(&size))); r == 0 {
		return fmt.Errorf("conpty: InitializeProcThreadAttributeList: %w", err)
	}
	defer procDeleteProcThreadAttributeList.Call(uintptr(unsafe.Pointer(&list[0])))
	if r, _, err := procUpdateProcThreadAttribute.Call(uintptr(unsafe.Pointer(&list[0])), 0, procThreadAttributePseudoConsole, p.console, unsafe.Sizeof(p.console), 0, 0); r == 0 {
		return fmt.Errorf("conpty: UpdateProcThreadAttribute: %w", err)
	}
	si := startupInfoEx{attributes: uintptr(unsafe.Pointer(&list[0]))}
	si.Cb = uint32(unsafe.Sizeof(si))
	// 标准句柄置为无效，子进程用伪控制台自己的；否则父进程输出被重定向时子进程会写到那里
	si.Flags = syscall.STARTF_USESTDHANDLES
	si.StdInput, si.StdOutput, si.StdErr = syscall.InvalidHandle, syscall.InvalidHandle, syscall.InvalidHandle

	cmdline, err := syscall.UTF16PtrFromString(commandLine(o.Path, o.Args))
	if err != nil {
		return err
	}
	var dir *uint16
	if o.Dir != "" {
		if dir, err = syscall.UTF16PtrFromString(o.Dir); err != nil {
			return err
		}
	}
	var env *uint16
	if o.Env != nil {
		block := environmentBlock(o.Env)
		env = &block[0]
	}
	var pi syscall.ProcessInformation
	err = syscall.CreateProcess(nil, cmdline, nil, nil, false, extendedStartupInfoPresent|createUnicodeEnvironment, env, dir, &si.StartupInfo, &pi)
	if err != nil {
		return fmt.Errorf("conpty: 启动 %s: %w", o.Path, err)
	}
	syscall.CloseHandle(pi.Thread)
	p.process, p.pid = pi.Process, int(pi.ProcessId)
	return nil
}

func (p *PTY) wait() (int, error) {
	if _, err := syscall.WaitForSingleObject(p.process, syscall.INFINITE); err != nil {
		return 0, err
	}
	var code uint32
	err := syscall.GetExitCodeProcess(p.process, &code)
	syscall.CloseHandle(p.process)
	return int(code), err
}

// Pid 返回进程 ID。
func (p *PTY) Pid() int { return p.pid }

// Read 读进程输出；Close 之后输出读完会返回 io.EOF。
func (p *PTY) Read(b []byte) (int, error) { return p.out.Read(b) }

// Write 把 b 当作键盘输入敲进终端（UTF-8）。
func (p *PTY) Write(b []byte) (int, error) {
	n, err := p.in.Write(b)
	if errors.Is(err, os.ErrClosed) {
		err = ErrPTYClosed
	}
	return n, err
}

// Resize 调整终端尺寸（单元格）。
func (p *PTY) Resize(cols, rows int) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.console == 0 {
		return ErrPTYClosed
	}
	if r, _, _ := procResizePseudoConsole.Call(p.console, coord(cols, rows)); r != 0 {
		return fmt.Errorf("conpty: ResizePseudoConsole: %w", syscall.Errno(r&0xFFFF))
	}
	return nil
}

// Close 关闭伪控制台，挂在它上面的进程随之结束。
// 24H2 之前的 Windows 上 ClosePseudoConsole 会等输出被读完，所以放到 goroutine 里，
// 调用方继续 Read 直到 EOF。
func (p *PTY) Close() error {
	p.mu.Lock()
	console := p.console
	p.console = 0
	p.mu.Unlock()
	if console == 0 {
		return nil
	}
	p.in.Close()
	go func() {
		procClosePseudoConsole.Call(console)
		p.out.Close()
	}()
	return nil
}

// Kill 只结束根进程；整树终止由归属层的 killTree 负责。
func (p *PTY) Kill() error { return syscall.TerminateProcess(p.process, 1) }

// Wait 等进程退出并返回退出码。
func (p *PTY) Wait() (int, error) {
	<-p.exited
	return p.code, p.waitErr
}

// Exited 在进程退出时关闭。
func (p *PTY) Exited() <-chan struct{} { return p.exited }

// coord 把 COORD 按值打包。
func coord(cols, rows int) uintptr {
	return uintptr(uint16(max(1, min(cols, 0x7FFF)))) | uintptr(uint16(max(1, min(rows, 0x7FFF))))<<16
}

// commandLine 按 C 运行时规则拼命令行；args[0] 是程序名。
func commandLine(path string, args []string) string {
	parts := []string{syscall.EscapeArg(path)}
	if len(args) > 1 {
		for _, a := range args[1:] {
			parts = append(parts, syscall.EscapeArg(a))
		}
	}
	return strings.Join(parts, " ")
}

// environmentBlock 编码成 CreateProcess 要的格式：以 NUL 结尾的 UTF-16 串，最后再一个 NUL。
func environmentBlock(env []string) []uint16 {
	var b []uint16
	for _, kv := range env {
		b = append(b, utf16.Encode([]rune(kv))...)
		b = append(b, 0)
	}
	if len(b) == 0 {
		b = append(b, 0)
	}
	return append(b, 0)
}

// SpawnConPTY 是 Service 在 Windows 上的默认伪终端启动函数。
func SpawnConPTY(o PTYOptions) (PTYProc, error) {
	p, err := StartPTY(o)
	if err != nil {
		return nil, err
	}
	return p, nil
}
