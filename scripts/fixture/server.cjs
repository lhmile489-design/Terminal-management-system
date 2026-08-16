// 端口捕获与进程树终止的测试夹具：绑 IPv4，输出 Vite 风格的 Local: 行
const http = require('node:http')

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('mile fixture\n')
})

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address()
  console.log(`  [32m➜  [m[1mLocal[22m:   [36mhttp://localhost:[1m${port}[22m/`)
})
