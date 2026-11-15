//go:build windows

// S02 / D1：ConPTY 最小验证。
// 起 Windows PowerShell 5.1，读提示符，chcp 65001 后写入中文并读回，
// 调整到 120x40 并用 $Host.UI.RawUI.WindowSize 核对，关闭后确认整棵子进程树退出。

package sessions

import (
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

type collector struct {
	mu  sync.Mutex
	buf strings.Builder
}

func (c *collector) pump(p *PTY) {
	b := make([]byte, 4096)
	for {
		n, err := p.Read(b)
		if n > 0 {
			c.mu.Lock()
			c.buf.Write(b[:n])
			c.mu.Unlock()
		}
		if err != nil {
			return
		}
	}
}

func (c *collector) text() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.buf.String()
}

func (c *collector) waitFor(t *testing.T, sub string, d time.Duration) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if strings.Contains(c.text(), sub) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("等待 %q 超时，已收到: %q", sub, c.text())
}

func pidAlive(pid int) bool {
	h, err := syscall.OpenProcess(0x1000, false, uint32(pid)) // PROCESS_QUERY_LIMITED_INFORMATION
	if err != nil {
		return false
	}
	defer syscall.CloseHandle(h)
	var code uint32
	if err := syscall.GetExitCodeProcess(h, &code); err != nil {
		return false
	}
	return code == 259 // STILL_ACTIVE
}

func TestConPTYSpike(t *testing.T) {
	p, err := StartPTY(PTYOptions{
		Path: `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
		Args: []string{"powershell.exe", "-NoLogo", "-NoProfile"},
		Cols: 80, Rows: 24,
	})
	if err != nil {
		t.Fatal(err)
	}
	c := &collector{}
	go c.pump(p)

	// 1. 收到提示符
	c.waitFor(t, "PS ", 15*time.Second)

	// 2. 编码与中文往返。输入行里中文被拆成 "中文"+"测试"，只有输出行才有连续的「中文测试」
	if _, err := p.Write([]byte("chcp 65001\r")); err != nil {
		t.Fatal(err)
	}
	c.waitFor(t, "65001", 10*time.Second)
	if _, err := p.Write([]byte("Write-Output (\"中文\"+\"测试\")\r")); err != nil {
		t.Fatal(err)
	}
	c.waitFor(t, "中文测试", 10*time.Second)

	// 3. 调整到 120x40，并让 shell 自己报告
	if err := p.Resize(120, 40); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	if _, err := p.Write([]byte("$s=$Host.UI.RawUI.WindowSize; Write-Output (\"SIZE=\"+$s.Width+\"x\"+$s.Height)\r")); err != nil {
		t.Fatal(err)
	}
	c.waitFor(t, "SIZE=120x40", 10*time.Second)

	// 4. 起一个孙进程（ping 60 秒），记下它的 PID。
	// 标记拆成两段拼接：PSReadLine 回显的命令行里不会出现完整标记，否则会先匹配到回显（曾因此偶发失败）
	if _, err := p.Write([]byte("Start-Process -FilePath ping.exe -ArgumentList '-n','60','127.0.0.1' -NoNewWindow\r")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(1500 * time.Millisecond)
	if _, err := p.Write([]byte("Write-Output (\"PING\"+\"PID=\"+(Get-Process ping | Select-Object -First 1).Id+\"=E\"+\"ND\")\r")); err != nil {
		t.Fatal(err)
	}
	c.waitFor(t, "=END", 10*time.Second)
	out := c.text()
	i := strings.LastIndex(out, "PINGPID=")
	j := strings.LastIndex(out, "=END")
	if i < 0 || j < i {
		t.Fatalf("没取到 ping PID: %q", out)
	}
	var grandchild int
	for _, ch := range out[i+len("PINGPID=") : j] {
		if ch < '0' || ch > '9' {
			break
		}
		grandchild = grandchild*10 + int(ch-'0')
	}
	if grandchild == 0 {
		t.Fatalf("PID 解析为 0: %q", out[i:j+4])
	}
	root := p.Pid()
	if !pidAlive(root) || !pidAlive(grandchild) {
		t.Fatalf("关闭前进程应存活 root=%d(%v) child=%d(%v)", root, pidAlive(root), grandchild, pidAlive(grandchild))
	}

	// 5. 关闭伪控制台，整棵树应退出
	p.Close()
	select {
	case <-p.Exited():
	case <-time.After(10 * time.Second):
		t.Fatal("Close 后根进程 10 秒内没有退出")
	}
	deadline := time.Now().Add(10 * time.Second)
	for pidAlive(grandchild) && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
	}
	t.Logf("root=%d child(ping)=%d  root存活=%v child存活=%v", root, grandchild, pidAlive(root), pidAlive(grandchild))
	if pidAlive(grandchild) {
		t.Errorf("孙进程 ping(%d) 在 Close 后仍存活：ConPTY 关闭不会带走独立启动的孙进程，需要 killTree", grandchild)
	}
}
