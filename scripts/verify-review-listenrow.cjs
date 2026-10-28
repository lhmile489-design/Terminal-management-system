/**
 * 监听端口表的行操作（2.2.0）。
 *
 * 以前总览的端口表只能看：行点不动，想知道这个端口是哪个服务、想复制 PID 都得手抄。
 * 现在每行有「⋯」菜单：
 *   1. 本应用条目的行有「查看服务」，点了切到服务页并选中该服务。
 *   2. 「复制端口」「复制 PID」「复制目录」写进剪贴板的是这一行的值。
 *   3. 「打开目录」只发出这一行的工作目录（主进程 knownPath 白名单把关）。
 *   4. 菜单里没有任何终止进程的入口（外部进程不给终止，红线 2）。
 *
 *   npm run build
 *   npx electron scripts/verify-review-listenrow.cjs
 */
const { app, BrowserWindow, clipboard } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const FIX = join(ROOT, 'scripts', 'fixture').replace(/\\/g, '/')
const SANDBOX = join(tmpdir(), `mile-review-listenrow-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)
writeFileSync(
  join(SANDBOX, 'mile-terminal', 'config.json'),
  JSON.stringify({
    version: 9,
    entries: [{
      id: 'svc', kind: 'service', name: '端口表探针', path: FIX, framework: 'node', packageManager: 'npm',
      script: 'dev', scripts: { dev: 'node server.cjs' }, env: {}, registerOnly: false, pinned: false, order: 0, createdAt: Date.now()
    }],
    groups: [],
    ignoredListeners: [],
    settings: { scanIntervalMs: 2000, theme: 'light', externalTerminal: 'wt', terminalFontSize: 13, scrollback: 5000, killOwnedOnQuit: true, closeToTray: false }
  }, null, 2),
  'utf8'
)

// 拦下「打开目录」：只记录请求的路径，不真的打开资源管理器
const OPENED = []
{
  const { ipcMain } = require('electron')
  const on = ipcMain.on.bind(ipcMain)
  ipcMain.on = (ch, fn) => (ch === 'shell:openPath' ? on(ch, (_e, p) => OPENED.push(p)) : on(ch, fn))
}
require(join(ROOT, 'out', 'main', 'index.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(name, ok, detail) {
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? ` — ${detail}` : ''}`)
}
// 前提不成立时后面的取值会抛错；不兜底的话进程永远不退出，只能等外层超时
process.on('unhandledRejection', (e) => {
  console.log(`  FAIL  脚本中途出错 — ${String(e)}`)
  console.log(`\n结果：${pass} 通过，${fail + 1} 失败`)
  app.exit(1)
})
const same = (a, b) => String(a || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === String(b || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  win.setBounds({ width: 1500, height: 940 })
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const waitFor = async (code, ms = 10000) => {
    for (let t = 0; t < ms; t += 200) { if (await js(code)) return true; await sleep(200) }
    return false
  }
  const goDash = async () => {
    await js(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'1',ctrlKey:true,bubbles:true,cancelable:true}));true`)
    await waitFor(`(document.querySelector('main h1')||{}).textContent==='总览'`)
  }
  await waitFor(`!!document.querySelector('nav[aria-label="主导航"]')`, 30000)

  console.log('\n=== 0. 前提：服务在跑，端口表里有它的行 ===')
  await js(`window.mile.entry.start('svc')`)
  check('服务已运行', await waitFor(`window.mile.entry.runtimes().then(r=>(r.find(x=>x.entryId==='svc')||{}).status==='running')`, 30000))
  const rt = await js(`window.mile.entry.runtimes().then(r=>r.find(x=>x.entryId==='svc'))`)
  await goDash()
  const row = `[...document.querySelectorAll('[data-listener-pid]')].find(r=>r.dataset.entryId==='svc')`
  check('端口表里出现该服务的行', await waitFor(`!!(${row})`, 40000))
  const info = await js(`(()=>{const r=${row};return r?{pid:r.dataset.listenerPid}:null})()`)
  const snap = await js(`window.mile.scanner.snapshot().then(s=>s&&s.listeners.find(l=>l.entryId==='svc'))`)
  check('前提：采集里有这一行的端口与目录', !!snap && snap.ports.length > 0 && !!snap.cwd, JSON.stringify(snap && { ports: snap.ports, cwd: snap.cwd }))

  const openMenu = () => js(`(()=>{const r=${row};const b=r&&r.querySelector('button[aria-haspopup="menu"]');if(!b)return false;b.click();return true})()`)
  const menuItems = () => js(`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map(x=>x.textContent.trim())`)
  const pick = (label) => js(`(()=>{const b=[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find(x=>x.textContent.trim()===${JSON.stringify(label)});if(!b)return false;b.click();return true})()`)

  console.log('\n=== 1. 行菜单 ===')
  check('行上有「⋯」菜单', await openMenu())
  await waitFor(`!!document.querySelector('[role="menu"]')`, 3000)
  const items = await menuItems()
  for (const l of ['查看服务', '复制端口', '复制 PID', '复制目录', '打开目录']) check(`菜单含「${l}」`, items.includes(l), items.join('、'))
  check('菜单里没有终止进程的入口', !items.some((l) => /停止|终止|结束|kill/i.test(l)), items.join('、'))

  console.log('\n=== 2. 复制 ===')
  clipboard.writeText('')
  await pick('复制端口')
  check('剪贴板是端口', await (async () => { for (let i = 0; i < 20; i++) { if (clipboard.readText() === String(snap.ports[0])) return true; await sleep(100) } return false })(), clipboard.readText())
  await openMenu(); await waitFor(`!!document.querySelector('[role="menu"]')`, 3000)
  await pick('复制 PID')
  check('剪贴板是 PID', await (async () => { for (let i = 0; i < 20; i++) { if (clipboard.readText() === String(info.pid)) return true; await sleep(100) } return false })(), clipboard.readText())
  await openMenu(); await waitFor(`!!document.querySelector('[role="menu"]')`, 3000)
  await pick('复制目录')
  check('剪贴板是目录', await (async () => { for (let i = 0; i < 20; i++) { if (same(clipboard.readText(), snap.cwd)) return true; await sleep(100) } return false })(), clipboard.readText())

  console.log('\n=== 3. 打开目录 ===')
  const n = OPENED.length
  await openMenu(); await waitFor(`!!document.querySelector('[role="menu"]')`, 3000)
  await pick('打开目录')
  // 轮询到 IPC 落地：主进程忙时 300ms 不一定够
  for (let i = 0; i < 30 && OPENED.length <= n; i++) await sleep(100)
  check('只发出这一行的目录', OPENED.length === n + 1 && same(OPENED[OPENED.length - 1], snap.cwd), OPENED.slice(n).join(' | '))

  console.log('\n=== 4. 查看服务 ===')
  await openMenu(); await waitFor(`!!document.querySelector('[role="menu"]')`, 3000)
  check('点「查看服务」', await pick('查看服务'))
  check('切到服务页并选中该服务', await waitFor(`(document.querySelector('main h1')||{}).textContent==='服务' && (document.querySelector('.svc-row[data-entry-id="svc"]')||{getAttribute:()=>null}).getAttribute('aria-selected')==='true'`))
  void rt

  await js(`window.mile.entry.stop('svc').catch(()=>null)`)
  await sleep(1500)
  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`) }
  app.exit(fail === 0 ? 0 : 1)
})
