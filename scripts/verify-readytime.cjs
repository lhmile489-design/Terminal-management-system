/**
 * 启动耗时（PRD-FEATURE-UPGRADE P1-2）。
 *
 *   1. 夹具延迟 3 秒才打印监听地址：耗时落在 3–7 秒（npm 链条起步约 1 秒），来源为端口。
 *   2. 再启动一次：历史有 2 条，新会话开始时清掉上次的 readyMs，不把旧数字挂在新运行上。
 *   3. 开了健康检查的条目：来源为健康检查，且不早于端口打印时刻。
 *   4. 不打印端口的夹具：运行中也没有耗时记录（不从别处猜就绪时刻）。
 *   5. 详情概览页显示「上次 Ns（来源：端口）」。
 *   6. 只在内存：配置文件里没有耗时。
 *
 *   npm run build
 *   npx electron scripts/verify-readytime.cjs
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const CONFIG_VERSION = Number(/CONFIG_VERSION = (\d+)/.exec(readFileSync(join(ROOT, 'src/shared/types.ts'), 'utf8'))[1])
const SANDBOX = join(tmpdir(), `mile-verify-readytime-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)
const CONFIG = join(SANDBOX, 'mile-terminal', 'config.json')

const PORT_SLOW = 39301
const PORT_HEALTH = 39302

function project(name, lines) {
  const dir = join(SANDBOX, name)
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  writeFileSync(join(dir, 'main.cjs'), lines.join('\n'), 'utf8')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', scripts: { dev: 'node main.cjs' } }), 'utf8')
  return dir.replace(/\\/g, '/')
}
/** 延迟 delayMs 才 listen 并打印地址 */
const server = (port, delayMs) => [
  "const http = require('http')",
  `setTimeout(() => http.createServer((q, s) => s.end('ok')).listen(${port}, '127.0.0.1', () => console.log('listening on ${port}')), ${delayMs})`
]

const base = (id, name, path, extra) => ({
  id, kind: 'service', name, path, framework: 'node', packageManager: 'npm',
  script: 'dev', scripts: { dev: 'node main.cjs' }, env: {}, registerOnly: false, pinned: false,
  order: 0, createdAt: Date.now(), ...extra
})

writeFileSync(CONFIG, JSON.stringify({
  version: CONFIG_VERSION,
  entries: [
    base('slow', '慢启动探针', project('slow', server(PORT_SLOW, 3000)), { order: 0 }),
    base('hc', '健康就绪探针', project('hc', server(PORT_HEALTH, 500)), { order: 1, healthCheck: { path: '/', enabled: true } }),
    base('silent', '不报端口探针', project('silent', ["console.log('up')", 'setInterval(() => {}, 1000)']), { order: 2 })
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

app.whenReady().then(async () => {
  const guard = setTimeout(() => { console.log('  FAIL  超时'); console.log(`\n结果：${pass} 通过，${fail + 1} 失败`); app.exit(1) }, 240000)
  const win = BrowserWindow.getAllWindows()[0]
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const rt = async (id) => (await js(`window.mile.entry.runtimes()`)).find((r) => r.entryId === id) || {}
  const waitRt = async (id, pred, ms) => {
    for (let t = 0; t < ms; t += 300) { const r = await rt(id); if (pred(r)) return r; await sleep(300) }
    return rt(id)
  }
  const waitFor = async (code, ms = 10000) => {
    for (let t = 0; t < ms; t += 200) { if (await js(code)) return true; await sleep(200) }
    return false
  }
  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r))
    win.setBounds({ width: 1500, height: 940 })
    await waitFor(`!!document.querySelector('nav[aria-label="主导航"]')`, 30000)

    console.log('\n=== 1. 延迟 3 秒打印端口 → 来源端口 ===')
    await js(`window.mile.entry.start('slow')`)
    const r1 = await waitRt('slow', (r) => r.readyMs != null, 30000)
    check('记下了启动耗时', r1.readyMs != null, r1.readyMs)
    check('耗时在 3–7 秒', r1.readyMs >= 3000 && r1.readyMs <= 7000, `${r1.readyMs} ms`)
    check('来源为端口', r1.readySource === 'port', r1.readySource)
    check('历史 1 条', (r1.readyHistory || []).length === 1, JSON.stringify(r1.readyHistory))

    console.log('\n=== 2. 再启动一次 ===')
    await js(`window.mile.entry.stop('slow')`)
    await waitRt('slow', (r) => r.status === 'stopped' || r.status === 'crashed', 15000)
    await sleep(800)
    await js(`window.mile.entry.start('slow')`)
    const starting = await waitRt('slow', (r) => r.status === 'starting', 10000)
    check('新会话开始时清掉上次的耗时', starting.status === 'starting' && starting.readyMs == null, JSON.stringify({ status: starting.status, readyMs: starting.readyMs }))
    check('启动中仍能看到旧历史', (starting.readyHistory || []).length === 1, JSON.stringify(starting.readyHistory))
    const r2 = await waitRt('slow', (r) => r.readyMs != null, 30000)
    check('第二次也记下了', r2.readyMs >= 3000 && r2.readyMs <= 7000, `${r2.readyMs} ms`)
    check('历史 2 条', (r2.readyHistory || []).length === 2, JSON.stringify(r2.readyHistory))

    console.log('\n=== 3. 开了健康检查 → 来源健康检查 ===')
    await js(`window.mile.entry.start('hc')`)
    const portAt = await waitRt('hc', (r) => r.status === 'running' && r.port === PORT_HEALTH, 30000)
    check('前提：端口已捕获', portAt.port === PORT_HEALTH)
    check('端口捕获时还没记耗时（在等健康检查）', portAt.readyMs == null, portAt.readyMs)
    const r3 = await waitRt('hc', (r) => r.readyMs != null, 60000)
    check('首次 ok 后记下耗时', r3.readyMs != null, `${r3.readyMs} ms`)
    check('来源为健康检查', r3.readySource === 'health', r3.readySource)
    check('健康检查的耗时不早于端口（> 500 ms）', r3.readyMs > 500, `${r3.readyMs} ms`)
    await sleep(16000)
    const r3b = await rt('hc')
    check('之后的 ok 不再追加历史', (r3b.readyHistory || []).length === 1, JSON.stringify(r3b.readyHistory))

    console.log('\n=== 4. 不打印端口 → 不记 ===')
    await js(`window.mile.entry.start('silent')`)
    await waitRt('silent', (r) => r.status === 'starting', 10000)
    await sleep(8000)
    const r4 = await rt('silent')
    check('前提：还在跑', r4.status === 'starting' || r4.status === 'running', r4.status)
    check('没有耗时记录', r4.readyMs == null && !(r4.readyHistory || []).length, JSON.stringify({ readyMs: r4.readyMs, h: r4.readyHistory }))

    console.log('\n=== 5. 概览页显示 ===')
    await js(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'2',ctrlKey:true,bubbles:true,cancelable:true}));true`)
    await waitFor(`(document.querySelector('main h1')||{}).textContent==='服务'`)
    await js(`document.querySelector('.svc-row[data-entry-id="slow"]').click();true`)
    check('概览页有启动耗时', await waitFor(`/上次 \\d+s（来源：端口）/.test((document.querySelector('[data-ready-time]')||{textContent:''}).textContent)`, 8000),
      await js(`(document.querySelector('[data-ready-time]')||{textContent:''}).textContent`))
    check('两次以上时画出历史曲线', await js(`!!document.querySelector('[data-ready-time] svg path')`))

    console.log('\n=== 6. 只在内存 ===')
    const disk = readFileSync(CONFIG, 'utf8')
    check('配置文件里没有耗时字段', !/readyMs|readyHistory|readySource/.test(disk))
  } catch (err) {
    console.log('HARNESS ERROR', err)
    fail++
  }
  // app.exit 不走 before-quit 的清理，常驻夹具自己停
  try {
    await js(`Promise.all(['slow','hc','silent'].map(id=>window.mile.entry.stop(id).catch(()=>null)))`)
    await sleep(3500)
  } catch { /* 停不掉也不影响判定 */ }
  clearTimeout(guard)
  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`) }
  app.exit(fail === 0 ? 0 : 1)
})
