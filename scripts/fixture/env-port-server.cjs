const http = require('node:http')

const value = process.env.MILE_TEST_PORT ?? process.env.PORT
const port = Number(value)

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('MILE_TEST_PORT or PORT must contain a valid port number')
}

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('env port fixture\n')
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`MILE_REAL_PORT=${port}\r\n`)
  process.stdout.write(`Local: http://localhost:${port}/\r\n`)
})
