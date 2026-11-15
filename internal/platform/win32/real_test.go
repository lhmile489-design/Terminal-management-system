//go:build windows

// S08 真机冒烟：跑真实的 netstat.exe 与 CIM 查询（都只读），确认在本机上拿得到东西。
// 默认跳过（CIM 一次约 3.5s），设 MILE_REAL_PLATFORM=1 才跑：
//
//	MILE_REAL_PLATFORM=1 go test -run TestReal -v ./internal/platform/win32/

package win32

import (
	"net"
	"os"
	"strings"
	"testing"
	"unicode/utf8"
)

func requireReal(t *testing.T) {
	t.Helper()
	if os.Getenv("MILE_REAL_PLATFORM") != "1" {
		t.Skip("设 MILE_REAL_PLATFORM=1 才跑真机冒烟")
	}
}

func TestRealReadListenPortsSeesOwnListener(t *testing.T) {
	requireReal(t)
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port
	rows, err := New().ReadListenPorts(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) == 0 {
		t.Fatal("监听表为空")
	}
	for _, r := range rows {
		if r.Port == port && r.Pid == os.Getpid() {
			t.Logf("监听表 %d 行，含本测试进程 %d 监听的 127.0.0.1:%d（families %v）", len(rows), r.Pid, port, r.Families)
			return
		}
	}
	t.Errorf("监听表 %d 行里没有本进程 %d 的 :%d", len(rows), os.Getpid(), port)
}

func TestRealReadProcessMetaSeesSelf(t *testing.T) {
	requireReal(t)
	meta, err := New().ReadProcessMeta(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	self, ok := meta.ByPid[os.Getpid()]
	if !ok {
		t.Fatalf("进程表 %d 行里没有本进程 %d", len(meta.ByPid), os.Getpid())
	}
	if _, mine := meta.Mine[os.Getpid()]; !mine {
		t.Errorf("本进程 %d 不在当前用户 PID 集合里（%d 个）", os.Getpid(), len(meta.Mine))
	}
	if self.StartedAt == nil || self.CommandLine == nil {
		t.Errorf("本进程缺启动时间或命令行：%+v", self)
	}
	t.Logf("进程表 %d 行，当前用户 %d 个 PID；本进程 %s ppid=%d startedAt=%v", len(meta.ByPid), len(meta.Mine), self.Name, self.Ppid, *self.StartedAt)

	// 已知原版问题 I3 的现场计数：含 U+FFFD 的命令行 / 路径条数（只记录，不断言，取决于本机有没有非 ASCII 路径）
	bad := 0
	for _, r := range meta.ByPid {
		for _, s := range []*string{r.CommandLine, r.ExecPath} {
			if s != nil && strings.ContainsRune(*s, utf8.RuneError) {
				bad++
				break
			}
		}
	}
	t.Logf("I3：%d 行的命令行或路径含 U+FFFD", bad)
}
