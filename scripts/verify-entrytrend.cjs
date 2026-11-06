/**
 * 按条目的 CPU / 内存趋势（PRD-FEATURE-UPGRADE P1-3）。
 *
 *   1. 夹具监听端口后占住约 200MB 内存：快照里该条目的内存 > 150MB，另一个条目 < 120MB。
 *      先验前提：两个条目都已在监听表里归到自己名下，否则后面的对比全是空过。
 *   2. 概览页画出该条目的内存与 CPU 曲线。
 *   3. 条目停止后曲线消失（缓冲清空）。
 *
 *   npm run build
 *   npx electron scripts/verify-entrytrend.cjs
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const CONFIG_VERSION = Number(/CONFIG_VERSION = (\d+)/.exec(readFileSync(join(ROOT, 'src/shared/types.ts'), 'utf8'))[1])
const SANDBOX = join(tmpdir(), `mile-verify-entrytrend-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)
const CONFIG = join(SANDBOX, 'mile-terminal', 'config.json')

const PORT_BIG = 39311
const PORT_SMALL = 39312
const MB = 1024 * 1024

function project(name, lines) {
  const dir = join(SANDBOX, name)
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  writeFileSync(join(dir, 'main.cjs'), lines.join('\n'), 'utf8')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', scripts: { dev: 'node main.cjs' } }), 'utf8')
  return dir.replace(/\\/g, '/')
}
const listen = (port) => `require('http').createServer((q, s) => s.end('ok')).listen(${port}, '127.0.0.1', () => console.log('listening on ${port}'))`

const base = (id, name, path, extra) => ({
  id, kind: 'service', name, path, framework: 'node', packageManager: 'npm',
  script: 'dev', scripts: { dev: 'node main.cjs' }, env: {}, registerOnly: false, pinned: false,
  order: 0, createdAt: Date.now(), ...extra
})

writeFileSync(CONFIG, JSON.stringify({
  version: CONFIG_VERSION,
  entries: [
    // Buffer.alloc 会清零，页面真的被写过，工作集里算得到
    base('big', '大内存探针', project('big', ['globalThis.hold = Buffer.alloc(200 * 1024 * 1024, 1)', listen(PORT_BIG)]), { order: 0 }),
    base('small', '小内存探针', project('small', [listen(PORT_SMALL)]), { order: 1 })
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
  const guard = setTimeout(() => { console.log('  FAIL  超时'); console.log(`\n结果：${pass} 通过，${fail + 1} 失败`); app.exit(1) }, 180000)
  const win = BrowserWindow.getAllWindows()[0]
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const waitFor = async (code, ms = 10000) => {
    for (let t = 0; t < ms; t += 300) { if (await js(code)) return true; await sleep(300) }
    return false
  }
  /** 快照里某条目全部监听进程的内存和（同一 PID 只算一次） */
  const memOf = async (id) => {
    const snap = await js(`window.mile.scanner.snapshot()`)
    const seen = new Set()
    let sum = 0
    for (const l of (snap && snap.listeners) || []) {
      if (l.entryId !== id || seen.has(l.pid)) continue
      seen.add(l.pid)
      sum += l.memory
    }
    return { pids: seen.size, mb: Math.round(sum / MB) }
  }
  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r))
    win.setBounds({ width: 1500, height: 940 })
    await waitFor(`!!document.querySelector('nav[aria-label="主导航"]')`, 30000)

    console.log('\n=== 1. 按条目汇总内存 ===')
    await js(`Promise.all([window.mile.entry.start('big'), window.mile.entry.start('small')])`)
    // 新 PID 进监听表并归到条目名下实测约 12 秒，轮询到两边都有再量
    let big = { pids: 0, mb: 0 }
    let small = { pids: 0, mb: 0 }
    for (let t = 0; t < 60000; t += 1000) {
      big = await memOf('big')
      small = await memOf('small')
      if (big.pids > 0 && small.pids > 0 && big.mb > 0) break
      await sleep(1000)
    }
    check('前提：大内存探针已归到条目名下', big.pids > 0, `${big.pids} 个进程`)
    check('前提：小内存探针已归到条目名下', small.pids > 0, `${small.pids} 个进程`)
    check('大内存探针 > 150MB', big.mb > 150, `${big.mb} MB`)
    check('小内存探针 < 120MB（不受影响）', small.pids > 0 && small.mb < 120, `${small.mb} MB`)

    console.log('\n=== 2. 概览页曲线 ===')
    await js(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'2',ctrlKey:true,bubbles:true,cancelable:true}));true`)
    await waitFor(`(document.querySelector('main h1')||{}).textContent==='服务'`)
    await js(`document.querySelector('.svc-row[data-entry-id="big"]').click();true`)
    check('有趋势区块', await waitFor(`!!document.querySelector('[data-entry-trend]')`, 8000))
    // 曲线要两个点：再等两轮采集
    check('画出内存曲线', await waitFor(`!!document.querySelector('[data-trend="memory"] svg path')`, 15000))
    check('画出 CPU 曲线', await js(`!!document.querySelector('[data-trend="cpu"] svg path')`))
    check('注明只统计监听端口的进程', await js(`/只统计监听端口的进程/.test(document.querySelector('[data-entry-trend]').textContent)`))

    console.log('\n=== 3. 停止后清空 ===')
    await js(`window.mile.entry.stop('big')`)
    check('停止后曲线消失', await waitFor(`!document.querySelector('[data-trend="memory"] svg path')`, 30000))
  } catch (err) {
    console.log('HARNESS ERROR', err)
    fail++
  }
  try {
    await js(`Promise.all(['big','small'].map(id=>window.mile.entry.stop(id).catch(()=>null)))`)
    await sleep(3500)
  } catch { /* 停不掉也不影响判定 */ }
  clearTimeout(guard)
  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`) }
  app.exit(fail === 0 ? 0 : 1)
})
