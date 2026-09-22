import { createServer } from 'node:net'

/**
 * 从 startPort 开始依次探测，找到第一个在本机可绑定（空闲）的端口。
 *
 * 安全约束：
 * - 只在主进程执行，不下发给渲染层
 * - 只做 bind 测试（`listen` + 立即 `close`），不保持监听
 * - 最多扫描 maxTries 个端口，超出范围返回 null
 * - 1024 以下端口（系统保留）直接跳过
 */
export async function findFreePort(
  startPort: number,
  maxTries = 20
): Promise<number | null> {
  const begin = Math.max(startPort, 1024)
  const end = Math.min(begin + maxTries - 1, 65535)

  for (let port = begin; port <= end; port++) {
    if (await isPortFree(port)) return port
  }
  return null
}

/** 尝试在 localhost 上绑定指定端口，成功即空闲，失败（EADDRINUSE）即占用 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, '127.0.0.1')
  })
}
