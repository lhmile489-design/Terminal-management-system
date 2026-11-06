/**
 * 端口占用历史（PRD-FEATURE-UPGRADE P1-4）。
 *
 *   1. 应用启动之后才开始的监听记一条「开始监听」，停掉后记一条「停止监听」。
 *   2. 新的在前；端口号与 PID 与监听表一致。
 *   3. 历史只读：区块里没有任何按钮（不给终止入口，红线 2）。
 *   4. 只在内存：配置文件里没有历史。
 *
 * 新 PID 进监听表实测约 12 秒，一律轮询，不用固定 sleep。
 *
 *   npm run build
 *   npx electron scripts/verify-porthistory.cjs
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const CONFIG_VERSION = Number(/CONFIG_VERSION = (\d+)/.exec(readFileSync(join(ROOT, 'src/shared/types.ts'), 'utf8'))[1])
const SANDBOX = join(tmpdir(), `mile-verify-porthistory-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)
const CONFIG = join(SANDBOX, 'mile-terminal', 'config.json')
const PORT = 39301

const PROJ = join(SANDBOX, 'ph-proj')
mkdirSync(join(PROJ, 'node_modules'), { recursive: true })
writeFileSync(join(PROJ, 'main.cjs'), [
  "const http = require('http')",
  `http.createServer((q, s) => s.end('ok')).listen(${PORT}, '127.0.0.1', () => console.log('listening on ${PORT}'))`
].join('\n'), 'utf8')
writeFileSync(join(PROJ, 'package.json'), JSON.stringify({ name: 'ph-proj', version: '1.0.0', scripts: { dev: 'node main.cjs' } }), 'utf8')

writeFileSync(CONFIG, JSON.stringify({
  version: CONFIG_VERSION,
  entries: [{
    id: 'ph', kind: 'service', name: '端口历史探针', path: PROJ.replace(/\\/g, '/'), framework: 'node', packageManager: 'npm',
    script: 'dev', scripts: { dev: 'node main.cjs' }, env: {}, registerOnly: false, pinned: false, order: 0, createdAt: Date.now()
  }],
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
  const guard = setTimeout(() => { console.log('  FAIL  超时'); console.log(`\n结果：${pass} 通过，${fail + 1} 失败`); app.exit(1) }, 180000)
  const win = BrowserWindow.getAllWindows()[0]
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const waitFor = async (code, ms = 10000) => {
    for (let t = 0; t < ms; t += 300) { if (await js(code)) return true; await sleep(300) }
    return false
  }
  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r))
    win.setBounds({ width: 1500, height: 940 })
    await waitFor(`!!document.querySelector('nav[aria-label="主导航"]')`, 30000)
    await js(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'1',ctrlKey:true,bubbles:true,cancelable:true}));true`)
    check('前提：在总览页', await waitFor(`!!document.querySelector('#listeners-heading')`, 8000))

    console.log('\n=== 1. 历史页签与空状态 ===')
    const tab = `[...document.querySelectorAll('[role="radio"]')].find(b=>b.textContent.includes('历史'))`
    check('有「历史」页签', await js(`!!${tab}`))
    await js(`${tab}.click();true`)
    check('启动前历史为空（首个快照不进历史）', await waitFor(`!!document.querySelector('[data-port-history-empty]')`, 3000))

    console.log('\n=== 2. 开始监听 ===')
    await js(`window.mile.entry.start('ph')`)
    const startSel = `[data-port-event="start"][data-port="${PORT}"]`
    check('出现「开始监听」事件', await waitFor(`!!document.querySelector('${startSel}')`, 40000))
    const snap = await js(`window.mile.scanner.snapshot()`)
    const holder = (snap?.listeners ?? []).find((l) => l.ports.includes(PORT))
    check('前提：监听表里有这个端口', !!holder, holder && holder.pid)
    const startPid = await js(`(document.querySelector('${startSel}')||{}).dataset?.pid`)
    check('事件 PID 与监听表一致', !!holder && String(holder.pid) === startPid, `${startPid} vs ${holder && holder.pid}`)
    check('事件写明归属条目', await js(`/端口历史探针/.test((document.querySelector('${startSel}')||{}).textContent||'')`))

    console.log('\n=== 3. 停止监听 ===')
    await js(`window.mile.entry.stop('ph')`)
    const stopSel = `[data-port-event="stop"][data-port="${PORT}"]`
    check('出现「停止监听」事件', await waitFor(`!!document.querySelector('${stopSel}')`, 30000))
    const order = await js(`[...document.querySelectorAll('[data-port="${PORT}"]')].map(r=>r.dataset.portEvent)`)
    check('新的在前：先停止、后开始', order.length >= 2 && order[0] === 'stop' && order[order.length - 1] === 'start', JSON.stringify(order))
    const stopPid = await js(`(document.querySelector('${stopSel}')||{}).dataset?.pid`)
    check('停止事件 PID 与开始事件一致', stopPid === startPid, `${stopPid} vs ${startPid}`)

    console.log('\n=== 4. 只读 ===')
    const rows = await js(`document.querySelectorAll('[data-port-history] [data-port-event]').length`)
    check('历史有行', rows >= 2, `${rows} 行`)
    check('历史区块里没有任何按钮', await js(`document.querySelectorAll('[data-port-history] button').length === 0`))

    console.log('\n=== 5. 切回「当前」 ===')
    await js(`[...document.querySelectorAll('[role="radio"]')].find(b=>b.textContent.includes('当前')).click();true`)
    check('切回后历史区块消失', await waitFor(`!document.querySelector('[data-port-history]')`, 3000))

    console.log('\n=== 6. 只在内存 ===')
    check('配置文件里没有历史', !/port-history|portHistory|开始监听/.test(readFileSync(CONFIG, 'utf8')))
  } catch (err) {
    console.log('HARNESS ERROR', err)
    fail++
  }
  try { await js(`window.mile.entry.stop('ph').catch(()=>null)`); await sleep(2000) } catch { /* 停不掉也不影响判定 */ }
  clearTimeout(guard)
  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`) }
  app.exit(fail === 0 ? 0 : 1)
})
