//go:build windows

// win32 实现对操作系统的全部依赖收在 sysDeps 里：环境变量、当前目录、文件探测、起进程、时钟。
// 生产用 realSys()；测试换成假的，断言 argv / Dir / 超时，不真起进程、不真弹窗口。

package win32

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"syscall"
	"time"
)

type sysDeps struct {
	// getenv 即 process.env[key]：ok 为 false 是 undefined，空串照样算有值（`??` 只挡 undefined）。
	getenv func(key string) (string, bool)
	// getwd 即 process.cwd()。
	getwd func() string
	// exists 即 fs.existsSync：stat 成功才算在。应用执行别名（wt.exe）stat 报 EACCES，这里认不出。
	exists func(path string) bool
	// lstat 即 fs.lstatSync 不抛：重解析点本身也算在。
	lstat func(path string) bool
	// run 即 execFile：等进程结束，收集 stdout / stderr；stdout 超过 maxBuffer 时结束进程并报错。
	run func(ctx context.Context, file string, args []string, maxBuffer int) (stdout, stderr []byte, err error)
	// start 即 spawn + unref：只拉起不等待，stdio 全部丢弃。
	start func(ctx context.Context, file string, args []string, dir string) error
	// now 即 Date.now()。
	now func() int64
}

func realSys() sysDeps {
	return sysDeps{
		getenv: os.LookupEnv,
		getwd: func() string {
			wd, _ := os.Getwd()
			return wd
		},
		exists: func(p string) bool {
			_, err := os.Stat(p)
			return err == nil
		},
		lstat: func(p string) bool {
			_, err := os.Lstat(p)
			return err == nil
		},
		run:   runHidden,
		start: startHidden,
		now:   func() int64 { return time.Now().UnixMilli() },
	}
}

// errMaxBuffer 与 node execFile 超出 maxBuffer 时的报错文案一致。
var errMaxBuffer = errors.New("stdout maxBuffer length exceeded")

// cappedBuffer 超过上限时取消 ctx：exec.CommandContext 随即结束子进程，不会卡在写满的管道上。
type cappedBuffer struct {
	buf    bytes.Buffer
	max    int
	cancel context.CancelCauseFunc
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	if c.buf.Len()+len(p) > c.max {
		c.cancel(errMaxBuffer)
		return 0, errMaxBuffer
	}
	return c.buf.Write(p)
}

// runHidden 对应 execFile(file, args, { windowsHide: true, maxBuffer, timeout })。超时由调用方给 ctx 设。
func runHidden(ctx context.Context, file string, args []string, maxBuffer int) ([]byte, []byte, error) {
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	cmd := exec.CommandContext(ctx, file, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out := &cappedBuffer{max: maxBuffer, cancel: cancel}
	var errBuf bytes.Buffer
	cmd.Stdout = out
	cmd.Stderr = &errBuf
	err := cmd.Run()
	if cause := context.Cause(ctx); errors.Is(cause, errMaxBuffer) {
		err = errMaxBuffer
	}
	return out.buf.Bytes(), errBuf.Bytes(), err
}

// startHidden 对应 spawn(file, args, { cwd, windowsHide: true, stdio: 'ignore' }) + unref()。
// 调用方传入的 ctx 应已脱离取消（context.WithoutCancel）：拉起的是外部终端的启动器，绑定调用返回后它还要活着。
func startHidden(ctx context.Context, file string, args []string, dir string) error {
	cmd := exec.CommandContext(ctx, file, args...)
	cmd.Dir = dir
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	// 回收进程句柄；结果没人要，与原版 unref 后不再关心一致
	go func() { _ = cmd.Wait() }()
	return nil
}
