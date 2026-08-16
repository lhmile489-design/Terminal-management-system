/**
 * 夹具：只绑一个地址族的服务器，用来复现「同一端口被两个进程分别用 IPv4/IPv6 占住」。
 *
 * 真实现场是 Vite（vite.config 里 host: '0.0.0.0'）与 Next（Node 默认绑 ::）
 * 撞在 3000 上，两边都 bind 成功，谁都没打印端口回退告警。
 * 夹具不猜端口、不回退：绑不上就直接退出并报错，免得把「绑失败」伪装成成功。
 */
const net = require('node:net')

const family = process.argv[2] === '6' ? 6 : 4
const port = Number(process.env.MILE_DUAL_PORT ?? 39100)

const server = net.createServer((s) => s.end())

server.on('error', (err) => {
  process.stdout.write(`MILE_BIND_FAILED family=${family} ${err.message}\r\n`)
  process.exit(1)
})

const options =
  family === 6 ? { host: '::', port, ipv6Only: true } : { host: '0.0.0.0', port }

server.listen(options, () => {
  // 打印成 Vite 的 Local 行形状，让 capturePort 走的是真实那条路径
  process.stdout.write(`  ➜  Local:   http://localhost:${port}/\r\n`)
  process.stdout.write(`MILE_BOUND family=${family} port=${port} pid=${process.pid}\r\n`)
})
