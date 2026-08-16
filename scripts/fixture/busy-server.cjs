/*
 * 端口回退夹具：复刻 Next.js 在预期端口被占时的真实输出形状。
 *
 * 实测 Next 16 打印
 *   ⚠ Port 3000 is in use by process 14944, using available port 3001 instead.
 *   ▲ Next.js 16.2.6 (Turbopack)
 *   - Local:  http://localhost:3001
 * 告警行里的端口是它没抢到的那个。夹具先占住一个端口再让自己回退到下一个，
 * 这样「告警端口」与「实听端口」必然不同，捕获到哪个一验即知。
 */
const http = require('node:http')

const WANTED = Number(process.env.MILE_FIXTURE_PORT ?? 45870)

const blocker = http.createServer((_q, s) => s.end('blocker\n'))

blocker.listen(WANTED, '127.0.0.1', () => {
  const real = http.createServer((_q, s) => {
    s.writeHead(200, { 'content-type': 'text/plain' })
    s.end('mile fixture fallback\n')
  })

  real.listen(0, '127.0.0.1', () => {
    const { port } = real.address()
    process.stdout.write(
      `\x1b[33m\x1b[1m⚠\x1b[m Port ${WANTED} is in use by process ${process.pid}, using available port ${port} instead.\r\n`
    )
    process.stdout.write(
      `\x1b[32m➜\x1b[m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m${port}\x1b[22m/\r\n`
    )
    process.stdout.write(`MILE_REAL_PORT=${port}\r\n`)
  })
})
