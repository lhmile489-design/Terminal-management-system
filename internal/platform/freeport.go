// 对应 src/main/lib/portScanner.ts：从 startPort 开始依次探测，找到第一个在本机可绑定（空闲）的端口。
//
// 安全约束（照搬原版）：
//   - 只在 Go 侧执行，不下发给页面
//   - 只做 bind 测试（Listen + 立即 Close），不保持监听
//   - 最多扫描 maxTries 个端口，超出范围返回未找到
//   - 1024 以下端口（系统保留）直接跳过
//
// 已知原版问题 I2，见 docs/MIGRATION-PLAN.md：只在 127.0.0.1 上试绑，端口被 [::]:P 独占时仍报告空闲。
// 照原样搬，不静默修；freeport_test.go 有一条测试固定这个行为。
//
// 与原版的一处差异：ctx 取消后不再继续探测，直接返回未找到（原版没有取消入口）。

package platform

import (
	"context"
	"net"
	"strconv"
)

// DefaultFreePortTries 是原版 findFreePort 的 maxTries 默认值。
const DefaultFreePortTries = 20

// FindFreePort 即原版 findFreePort(startPort)。找不到时 ok 为 false（原版返回 null）。
func FindFreePort(ctx context.Context, startPort int) (port int, ok bool) {
	return FindFreePortN(ctx, startPort, DefaultFreePortTries)
}

// FindFreePortN 即原版 findFreePort(startPort, maxTries)。
func FindFreePortN(ctx context.Context, startPort, maxTries int) (port int, ok bool) {
	return findFreePort(ctx, startPort, maxTries, isPortFree)
}

func findFreePort(ctx context.Context, startPort, maxTries int, free func(context.Context, int) bool) (int, bool) {
	begin := max(startPort, 1024)
	end := min(begin+maxTries-1, 65535)
	for p := begin; p <= end; p++ {
		if ctx.Err() != nil {
			return 0, false
		}
		if free(ctx, p) {
			return p, true
		}
	}
	return 0, false
}

// isPortFree 尝试在 127.0.0.1 上绑定指定端口：成功即空闲，任何失败都算占用（原版 once('error') 不区分错误码）。
// 已知原版问题 I2：只测 IPv4 回环。
func isPortFree(ctx context.Context, port int) bool {
	var lc net.ListenConfig
	ln, err := lc.Listen(ctx, "tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return false
	}
	return ln.Close() == nil
}
