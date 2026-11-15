// S07：FindFreePort 的范围逻辑（假探测函数，确定性）与真实试绑（占住端口后和原版 node 实现对拍）。
//
// 已知原版问题 I2，见 docs/MIGRATION-PLAN.md：TestFreePortI2IPv6HolderNotDetected 固定「IPv6 占用查不出」的行为，
// 修 I2 时这条测试要一起改。

package platform

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
)

func TestFindFreePortRange(t *testing.T) {
	ctx := context.Background()
	var probed []int
	freeAt := func(want ...int) func(context.Context, int) bool {
		probed = probed[:0]
		set := map[int]bool{}
		for _, p := range want {
			set[p] = true
		}
		return func(_ context.Context, p int) bool { probed = append(probed, p); return set[p] }
	}
	cases := []struct {
		name         string
		start, tries int
		free         []int
		want         int
		ok           bool
		probes       []int
	}{
		{"返回第一个空闲", 3000, 20, []int{3002, 3005}, 3002, true, []int{3000, 3001, 3002}},
		{"起点低于 1024 从 1024 起", 80, 3, []int{1025}, 1025, true, []int{1024, 1025}},
		{"负数起点也从 1024 起", -5, 1, nil, 0, false, []int{1024}},
		{"全满返回未找到", 4000, 3, nil, 0, false, []int{4000, 4001, 4002}},
		{"窗口外的空闲端口不算", 4000, 2, []int{4002}, 0, false, []int{4000, 4001}},
		{"上限截到 65535", 65534, 20, nil, 0, false, []int{65534, 65535}},
		{"65535 本身可用", 65535, 20, []int{65535}, 65535, true, []int{65535}},
		{"maxTries 为 0 不探测", 3000, 0, []int{3000}, 0, false, []int{}},
		{"起点超过 65535 不探测", 70000, 5, []int{70000}, 0, false, []int{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := findFreePort(ctx, c.start, c.tries, freeAt(c.free...))
			if got != c.want || ok != c.ok {
				t.Errorf("findFreePort(%d, %d) = %d,%v，期望 %d,%v", c.start, c.tries, got, ok, c.want, c.ok)
			}
			if len(probed) != len(c.probes) {
				t.Fatalf("探测了 %v，期望 %v", probed, c.probes)
			}
			for i := range probed {
				if probed[i] != c.probes[i] {
					t.Fatalf("探测了 %v，期望 %v", probed, c.probes)
				}
			}
		})
	}
}

func TestFindFreePortCanceled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	n := 0
	if _, ok := findFreePort(ctx, 3000, 20, func(context.Context, int) bool { n++; return true }); ok || n != 0 {
		t.Errorf("ctx 已取消仍探测了 %d 次，ok=%v", n, ok)
	}
}

// holdLoopback 在 127.0.0.1 上占一个系统分配的端口，测试结束时释放。
func holdLoopback(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	return ln.Addr().(*net.TCPAddr).Port
}

// originalFindFreePort 跑原版 portScanner.ts 的 findFreePort，返回它的判断。读不到原版或没有 node 时跳过。
func originalFindFreePort(t *testing.T, start, tries int) (int, bool) {
	t.Helper()
	script := filepath.Join("..", "..", "scripts", "probe-freeport.mjs")
	original := filepath.Join("..", "..", "..", "..", "mile-terminal-management", "src", "main", "lib", "portScanner.ts")
	if _, err := os.Stat(original); err != nil {
		t.Skipf("读不到原版 portScanner.ts：%v", err)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("没有 node，跳过与原版的对拍")
	}
	out, err := exec.CommandContext(t.Context(), node, script, strconv.Itoa(start), strconv.Itoa(tries)).Output()
	if err != nil {
		t.Fatalf("跑原版探针失败：%v", err)
	}
	var r struct {
		Port *int `json:"port"`
	}
	if err := json.Unmarshal(out, &r); err != nil {
		t.Fatalf("原版探针输出解析失败：%v，原文 %q", err, out)
	}
	if r.Port == nil {
		return 0, false
	}
	return *r.Port, true
}

func TestFreePortSkipsHeldPortLikeOriginal(t *testing.T) {
	held := holdLoopback(t)
	if held < 1024 || held > 65535-5 {
		t.Skipf("系统分配的端口 %d 不在可测区间", held)
	}
	got, ok := FindFreePortN(t.Context(), held, 5)
	if !ok || got <= held {
		t.Fatalf("占住 %d 后 FindFreePortN 返回 %d,%v，应返回它之后的端口", held, got, ok)
	}
	want, wantOK := originalFindFreePort(t, held, 5)
	if got != want || ok != wantOK {
		t.Errorf("占住 %d：Go 返回 %d,%v，原版 %d,%v", held, got, ok, want, wantOK)
	}
	t.Logf("占住 %d，Go 与原版都返回 %d", held, got)
}

func TestFreePortAllHeldLikeOriginal(t *testing.T) {
	held := holdLoopback(t)
	if held < 1024 {
		t.Skipf("系统分配的端口 %d 低于 1024", held)
	}
	if got, ok := FindFreePortN(t.Context(), held, 1); ok {
		t.Fatalf("窗口内唯一端口 %d 已被占，却返回 %d", held, got)
	}
	if want, ok := originalFindFreePort(t, held, 1); ok {
		t.Errorf("原版在同一情形返回 %d，与 Go 的「未找到」不一致", want)
	}
}

// 已知原版问题 I2，见 docs/MIGRATION-PLAN.md：端口只被 IPv6 监听占住时，只测 127.0.0.1 的探测仍报空闲。
// 用 [::1] 而不是 [::]：监听所有地址会弹 Windows 防火墙询问；[::1] 走的是同一条缺陷路径（只测 IPv4）。
func TestFreePortI2IPv6HolderNotDetected(t *testing.T) {
	ln, err := net.Listen("tcp6", "[::1]:0")
	if err != nil {
		t.Skipf("本机不能监听 IPv6 回环：%v", err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port
	if port < 1024 {
		t.Skipf("系统分配的端口 %d 低于 1024", port)
	}
	// 前提：这个端口确实被占着。否则下面的「报空闲」只是因为它本来就空闲，断言会假绿。
	if c, err := net.Dial("tcp6", net.JoinHostPort("::1", strconv.Itoa(port))); err != nil {
		t.Fatalf("前提不成立：[::1]:%d 连不上：%v", port, err)
	} else {
		c.Close()
	}
	got, ok := FindFreePortN(t.Context(), port, 1)
	if !ok || got != port {
		t.Fatalf("I2 行为变了：[::1]:%d 被占时 FindFreePortN 返回 %d,%v；原版报空闲。修 I2 时同步改这条测试", port, got, ok)
	}
	if want, wantOK := originalFindFreePort(t, port, 1); !wantOK || want != port {
		t.Errorf("原版在同一情形返回 %d,%v，与「报空闲」不一致，I2 的描述需要复核", want, wantOK)
	}
	t.Logf("I2 已固定：[::1]:%d 被占，Go 与原版都报它空闲", port)
}
