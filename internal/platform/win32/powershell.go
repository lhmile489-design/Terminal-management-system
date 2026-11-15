//go:build windows

// 对应 src/main/platform/win32/powershell.ts。
//
// 原版的 runPowerShellJson 在 src/main 里没有调用点，不迁。

package win32

import (
	"context"
	"encoding/base64"
	"errors"
	"time"
	"unicode/utf16"
)

const (
	// runPowerShellTimeout 即原版 runPowerShell 的默认 timeoutMs。
	runPowerShellTimeout = 8000 * time.Millisecond
	// runPowerShellMaxBuffer 即原版的 maxBuffer: 8 * 1024 * 1024。
	runPowerShellMaxBuffer = 8 * 1024 * 1024
)

// psCandidates 即原版 PS_CANDIDATES。SystemRoot 在模块加载时读一次，这里在 New 时读一次。
func psCandidates(getenv func(string) (string, bool)) []string {
	root, ok := getenv("SystemRoot")
	if !ok {
		root = `C:\Windows`
	}
	return []string{
		`C:\Program Files\PowerShell\7\pwsh.exe`,
		root + `\System32\WindowsPowerShell\v1.0\powershell.exe`,
	}
}

// powershell 即原版 powershell()：第一个存在的候选，否则 'powershell.exe'，结果缓存。
func (w *Win32) powershell() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.psPath != "" {
		return w.psPath
	}
	w.psPath = "powershell.exe"
	for _, p := range w.psCandidates {
		if w.sys.exists(p) {
			w.psPath = p
			break
		}
	}
	return w.psPath
}

// encodeCommand 把脚本编成 -EncodedCommand 要的 UTF-16LE base64，即 Buffer.from(script, 'utf16le').toString('base64')。
func encodeCommand(script string) string {
	units := utf16.Encode([]rune(script))
	b := make([]byte, 0, len(units)*2)
	for _, u := range units {
		b = append(b, byte(u), byte(u>>8))
	}
	return base64.StdEncoding.EncodeToString(b)
}

// runPowerShell 即原版 runPowerShell(script, timeoutMs)。
//
// -EncodedCommand 收 UTF-16LE base64，脚本里的引号与换行不再经过命令行解析，
// 因此不存在拼接注入面。脚本必须是代码内常量，调用方不得插入外部字符串。
//
// 已知原版问题 I3，见 docs/MIGRATION-PLAN.md：Windows PowerShell 5.1 管道输出按控制台代码页（中文系统 936）编码，
// 原版按 UTF-8 解码，非 ASCII 字符变成 U+FFFD。照原样搬，不静默修。
func (w *Win32) runPowerShell(ctx context.Context, script string, timeout time.Duration) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	args := []string{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodeCommand(script)}
	stdout, stderr, err := w.sys.run(ctx, w.powershell(), args, runPowerShellMaxBuffer)
	if err != nil {
		if msg := jsTrim(jsDecodeUTF8(stderr)); msg != "" {
			return "", errors.New(msg)
		}
		return "", err
	}
	return jsDecodeUTF8(stdout), nil
}
