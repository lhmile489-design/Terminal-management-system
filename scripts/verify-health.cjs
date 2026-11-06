/**
 * 本机 HTTP 健康检查（PRD-FEATURE-UPGRADE P0-1）。
 *
 *   1. 服务返回 200：状态 ok，带状态码与延迟，请求路径就是配置的路径。
 *   2. 服务改返回 500：状态变 fail。
 *   3. 服务无限写响应体：探测读到 4KB 就关掉 socket（夹具记录到 close 事件）。
 *   4. 路径校形：//evil、http://x、含空白的路径被拒，磁盘配置不变。
 *   5. 双绑：别的进程占 127.0.0.1:P，本条目占 [::]:P（ipv6Only）。先用真实 netstat 确认
 *      两个 PID 都在，再断言请求打到了本条目自己的进程，没打到别人那里。
 *   6. 服务行显示健康图标；停止后状态转 off。
 *
 *   npm run build
 *   npx electron scripts/verify-health.cjs
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
// 版本号从源码读，不写死：迁移会丢掉 v14 之前出现的 healthCheck
const CONFIG_VERSION = Number(/CONFIG_VERSION = (\d+)/.exec(readFileSync(join(ROOT, 'src/shared/types.ts'), 'utf8'))[1])
const SANDBOX = join(tmpdir(), `mile-verify-health-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)
const CONFIG = join(SANDBOX, 'mile-terminal', 'config.json')

const PORT_MAIN = 39211
const PORT_DUAL = 39212

/** 夹具 HTTP 服务：每次请求记一行 url；mode.txt 决定返回 200 / 500 / 无限响应体 */
function serverCode(listenExpr, port) {
  return [
    "const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path')",
    "const MODE = path.join(__dirname, 'mode.txt'); const HITS = path.join(__dirname, 'hits.txt'); const CLOSED = path.join(__dirname, 'closed.txt')",
    'const srv = http.createServer((req, res) => {',
    "  fs.appendFileSync(HITS, req.url + '\\n')",
    "  const mode = fs.existsSync(MODE) ? fs.readFileSync(MODE, 'utf8').trim() : 'ok'",
    "  if (mode === '500') { res.writeHead(500); return res.end('no') }",
    "  if (mode === 'big') {",
    '    res.writeHead(200)',
    "    const t = setInterval(() => res.write('x'.repeat(1024)), 5)",
    "    res.on('close', () => { clearInterval(t); fs.appendFileSync(CLOSED, 'closed\\n') })",
    '    return',
    '  }',
    '  res.writeHead(200); res.end(String(process.pid))',
    '})',
    `srv.listen(${listenExpr}, () => console.log('listening on ${port}'))`
  ].join('\n')
}

function project(name, code) {
  const dir = join(SANDBOX, name)
  // node_modules 要在，否则预检拦下
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  writeFileSync(join(dir, 'main.cjs'), code, 'utf8')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', scripts: { dev: 'node main.cjs' } }), 'utf8')
  return dir
}

const MAIN_DIR = project('health-main', serverCode(`${PORT_MAIN}, '127.0.0.1'`, PORT_MAIN))
const DUAL_DIR = project('health-dual', serverCode(`{ port: ${PORT_DUAL}, host: '::', ipv6Only: true }`, PORT_DUAL))
// 「别人」的服务放在登记目录之外：按命令行推目录时不能被归到条目名下
const OTHER_DIR = join(SANDBOX, 'outside-other')
mkdirSync(OTHER_DIR, { recursive: true })
writeFileSync(join(OTHER_DIR, 'other.cjs'), serverCode(`${PORT_DUAL}, '127.0.0.1'`, PORT_DUAL), 'utf8')

const base = (id, name, path, extra) => ({
  id, kind: 'service', name, path: path.replace(/\\/g, '/'), framework: 'node', packageManager: 'npm',
  script: 'dev', scripts: { dev: 'node main.cjs' }, env: {}, registerOnly: false, pinned: false,
  order: 0, createdAt: Date.now(), ...extra
})

writeFileSync(CONFIG, JSON.stringify({
  version: CONFIG_VERSION,
  entries: [
    base('h', '健康探针', MAIN_DIR, { healthCheck: { path: '/health?probe=1', enabled: true } }),
    base('dual', '双绑探针', DUAL_DIR, { healthCheck: { path: '/dual', enabled: true }, order: 1 })
  ],
  groups: [], ignoredListeners: [], groupOverrides: [], watchedKeywords: [],
  settings: {
    scanIntervalMs: 2000, theme: 'light', externalTerminal: 'wt', terminalFontSize: 13, scrollback: 5000,
    killOwnedOnQuit: true, closeToTray: false, notifyOnTaskDone: false, hideFromTaskbar: false,
    notifyOnCrash: false, notifyOnlyWhenBackground: true, globalHotkey: false, loginShellPath: false
  }
}, null, 2), 'utf8')

require(join(ROOT, 'out', 'main', 'index.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(name, ok, detail) {
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? ` — ${detail}` : ''}`)
}
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
const diskEntry = (id) => JSON.parse(readFileSync(CONFIG, 'utf8')).entries.find((e) => e.id === id)

/** 真实 netstat 里监听某端口的 PID 集合 */
function listenPids(port) {
  const out = execFileSync('netstat.exe', ['-ano'], { encoding: 'utf8', windowsHide: true })
  const pids = new Set()
  for (const line of out.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue
    const f = line.trim().split(/\s+/)
    if (f.length < 4) continue
    if (Number(f[1].slice(f[1].lastIndexOf(':') + 1)) === port) pids.add(Number(f[f.length - 1]))
  }
  return pids
}

let other = null

app.whenReady().then(async () => {
  const guard = setTimeout(() => { console.log('  FAIL  超时'); console.log(`\n结果：${pass} 通过，${fail + 1} 失败`); other?.kill(); app.exit(1) }, 400000)
  const win = BrowserWindow.getAllWindows()[0]
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const health = async (id) => (await js(`window.mile.entry.healthList()`)).find((h) => h.entryId === id)
  const waitHealth = async (id, pred, ms) => {
    for (let t = 0; t < ms; t += 500) {
      const h = await health(id)
      if (h && pred(h)) return h
      await sleep(500)
    }
    return health(id)
  }
  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r))
    win.setBounds({ width: 1500, height: 940 })
    const waitFor = async (code, ms = 10000) => {
      for (let t = 0; t < ms; t += 200) { if (await js(code)) return true; await sleep(200) }
      return false
    }
    await waitFor(`!!document.querySelector('nav[aria-label="主导航"]')`, 30000)

    console.log('\n=== 1. 200 → ok ===')
    await js(`window.mile.entry.start('h')`)
    const ok = await waitHealth('h', (h) => h.state === 'ok', 40000)
    check('状态 ok', ok && ok.state === 'ok', JSON.stringify(ok))
    check('带状态码 200', ok && ok.statusCode === 200)
    check('带延迟', ok && Number.isFinite(ok.latencyMs) && ok.latencyMs >= 0, ok && ok.latencyMs)
    const hits = read(join(MAIN_DIR, 'hits.txt')).split('\n').filter(Boolean)
    check('请求路径是配置的路径', hits.length > 0 && hits.every((u) => u === '/health?probe=1'), JSON.stringify(hits.slice(0, 3)))

    console.log('\n=== 2. 500 → fail ===')
    writeFileSync(join(MAIN_DIR, 'mode.txt'), '500', 'utf8')
    const bad = await waitHealth('h', (h) => h.state === 'fail', 70000)
    check('状态 fail', bad && bad.state === 'fail', JSON.stringify(bad))
    check('fail 带状态码 500', bad && bad.statusCode === 500)

    console.log('\n=== 3. 无限响应体 → 读满 4KB 关 socket ===')
    writeFileSync(join(MAIN_DIR, 'mode.txt'), 'big', 'utf8')
    let closed = false
    for (let t = 0; t < 70000 && !closed; t += 500) { closed = read(join(MAIN_DIR, 'closed.txt')).includes('closed'); if (!closed) await sleep(500) }
    check('夹具记录到连接被关闭', closed)
    writeFileSync(join(MAIN_DIR, 'mode.txt'), 'ok', 'utf8')

    console.log('\n=== 4. 路径校形 ===')
    const before = JSON.stringify(diskEntry('h').healthCheck)
    for (const p of ['//evil', 'http://x', '/a b', 'health', '/a\\\\b', '/a@b']) {
      const r = await js(`window.mile.entry.edit('h',{healthCheck:{path:${JSON.stringify(p)},enabled:true}}).then(()=>'ok',e=>String(e))`)
      check(`拒绝 ${JSON.stringify(p)}`, r !== 'ok', r)
    }
    const extra = await js(`window.mile.entry.edit('h',{healthCheck:{path:'/ok',enabled:true,host:'evil.com',port:80}}).then(e=>JSON.stringify(e.healthCheck),e=>String(e))`)
    check('多余的 host / port 键被丢掉', extra === '{"path":"/ok","enabled":true}', extra)
    await js(`window.mile.entry.edit('h',{healthCheck:${before}})`)
    check('非法编辑后磁盘配置不变', JSON.stringify(diskEntry('h').healthCheck) === before, JSON.stringify(diskEntry('h').healthCheck))

    console.log('\n=== 5. 双绑：只探本条目自己的进程 ===')
    other = spawn(process.execPath, [join(OTHER_DIR, 'other.cjs')], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore', windowsHide: true
    })
    await sleep(800)
    await js(`window.mile.entry.start('dual')`)
    let pids = new Set()
    for (let t = 0; t < 15000; t += 500) { pids = listenPids(PORT_DUAL); if (pids.size >= 2) break; await sleep(500) }
    check('前提：netstat 里 :39212 有两个 PID', pids.size >= 2, [...pids].join(','))
    const dual = await waitHealth('dual', (h) => h.state === 'ok', 40000)
    check('双绑条目状态 ok', dual && dual.state === 'ok', JSON.stringify(dual))
    const mine = read(join(DUAL_DIR, 'hits.txt')).split('\n').filter(Boolean)
    const theirs = read(join(OTHER_DIR, 'hits.txt')).split('\n').filter(Boolean)
    check('请求打到了本条目自己的进程', mine.length > 0, `${mine.length} 次`)
    check('没有打到别人的进程', theirs.length === 0, `${theirs.length} 次`)

    console.log('\n=== 6. 服务行图标与停止转 off ===')
    await js(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'2',ctrlKey:true,bubbles:true,cancelable:true}));true`)
    await waitFor(`(document.querySelector('main h1')||{}).textContent==='服务'`)
    check('服务行有健康图标', await waitFor(`!!document.querySelector('.svc-row[data-entry-id="dual"] .svc-health[data-health="ok"]')`, 8000))
    const label = await js(`(document.querySelector('.svc-row[data-entry-id="dual"] .svc-health')||{getAttribute:()=>''}).getAttribute('aria-label')||''`)
    check('图标有 aria-label', /健康检查通过/.test(label), label)
    await js(`window.mile.entry.stop('dual')`)
    const off = await waitHealth('dual', (h) => h.state === 'off', 15000)
    check('停止后转 off', off && off.state === 'off', JSON.stringify(off))
    check('停止后图标消失', await waitFor(`!document.querySelector('.svc-row[data-entry-id="dual"] .svc-health')`, 5000))

    console.log('\n=== 7. 只在内存 ===')
    check('配置文件里没有健康结果', !/latencyMs|statusCode/.test(readFileSync(CONFIG, 'utf8')))
  } catch (err) {
    console.log('HARNESS ERROR', err)
    fail++
  }
  // app.exit 不走 before-quit 的清理，常驻的夹具进程要自己停掉
  try {
    await js(`Promise.all(['h','dual'].map(id=>window.mile.entry.stop(id).catch(()=>null)))`)
    await sleep(3500)
  } catch { /* 停不掉也不影响判定 */ }
  try { other?.kill() } catch { /* ignore */ }
  clearTimeout(guard)
  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`) }
  app.exit(fail === 0 ? 0 : 1)
})
