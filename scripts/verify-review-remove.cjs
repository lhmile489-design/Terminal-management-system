/**
 * 删除运行中的条目不留幽灵运行态（2026-10-28 复审修复）。
 *
 * EntryService.remove() 先删运行态再让会话异步退出，会话退出时 onSessionExit 又用
 * setRuntime 把已删除条目的运行态写回内存并广播，界面上多出一条没有对应条目的记录。
 *
 * 做法：启动夹具服务 → 运行中删除 → 等会话真的退出 → 查运行态表和删除后的广播。
 *
 *   npm run build
 *   npx electron scripts/verify-review-remove.cjs
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const FIX = join(ROOT, 'scripts', 'fixture').replace(/\\/g, '/')
const SANDBOX = join(tmpdir(), `mile-review-remove-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)

writeFileSync(
  join(SANDBOX, 'mile-terminal', 'config.json'),
  JSON.stringify({
    version: 1,
    entries: [{
      id: 'ghost', kind: 'service', name: '幽灵探针', path: FIX, framework: 'node', packageManager: 'npm',
      script: 'dev', scripts: { dev: 'node server.cjs' }, env: {}, registerOnly: false, pinned: false, order: 0, createdAt: Date.now()
    }],
    ignoredListeners: [],
    settings: { scanIntervalMs: 2000, theme: 'light', externalTerminal: 'wt', terminalFontSize: 13, scrollback: 5000, killOwnedOnQuit: true, closeToTray: false }
  }, null, 2),
  'utf8'
)

require(join(ROOT, 'out', 'main', 'index.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(name, ok, detail) {
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? ` — ${detail}` : ''}`)
}

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  const js = (code) => win.webContents.executeJavaScript(code, true)

  // 记录主进程推给窗口的运行态广播
  const pushed = []
  const realSend = win.webContents.send.bind(win.webContents)
  win.webContents.send = (channel, ...args) => {
    if (channel === 'entry:runtimeChanged' || channel === 'entry:runtime-changed') pushed.push({ at: pushed.length, runtime: args[0] })
    return realSend(channel, ...args)
  }

  const runtimes = () => js(`window.mile.entry.runtimes()`)

  console.log('\n=== 1. 前提：服务在运行 ===')
  await js(`window.mile.entry.start('ghost')`)
  let status = ''
  for (let i = 0; i < 60; i++) {
    status = ((await runtimes()).find((r) => r.entryId === 'ghost') || {}).status || ''
    if (status === 'running') break
    await sleep(250)
  }
  check('前提：服务已运行', status === 'running', status)
  const runtimeChannelSeen = pushed.length > 0
  check('前提：探针看得到运行态广播', runtimeChannelSeen, `${pushed.length} 条`)

  console.log('\n=== 2. 运行中删除条目 ===')
  const before = pushed.length
  const sid = ((await runtimes()).find((r) => r.entryId === 'ghost') || {}).sessionId
  check('前提：拿到了会话 id', !!sid, String(sid))
  await js(`window.mile.entry.remove('ghost')`)
  // 轮询到会话真的退出再量；固定 sleep 会把「还没退出」误判成「没有幽灵」
  let sess = 'timeout'
  for (let i = 0; i < 60; i++) {
    const l = await js(`window.mile.session.list()`)
    const m = l.find((x) => x.id === sid)
    sess = m ? m.status : 'gone'
    if (sess === 'stopped' || sess === 'crashed' || sess === 'gone') break
    await sleep(250)
  }
  check('前提：会话已退出', sess === 'stopped' || sess === 'crashed' || sess === 'gone', sess)
  await sleep(800)

  const after = await runtimes()
  const ghost = after.find((r) => r.entryId === 'ghost')
  check('运行态表里没有已删除条目的记录', !ghost, ghost ? JSON.stringify(ghost) : '无')
  const late = pushed.slice(before).filter((p) => p.runtime && p.runtime.entryId === 'ghost' && p.runtime.status !== 'idle')
  check('删除之后没有再广播它的运行态', late.length === 0, late.map((p) => p.runtime.status).join(',') || '无')
  const list = await js(`window.mile.entry.list()`)
  check('条目确实已删除', !list.some((e) => e.id === 'ghost'))

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`)
  }
  app.exit(fail === 0 ? 0 : 1)
})
