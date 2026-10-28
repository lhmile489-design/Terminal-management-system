/**
 * 服务崩溃 / 预检被拦的系统通知（2.1.0 第一批）。
 *
 * 以前只有任务完成会弹系统通知；服务崩溃、启动被预检拦下只在渲染层弹 toast，
 * 窗口收起到托盘后完全看不到。这里验：
 *   1. 新设置 notifyOnCrash / notifyOnlyWhenBackground 有默认值（从 v9 配置迁移上来）且校验布尔。
 *   2. 窗口在前台时不重复打扰；窗口收起时崩溃与被拦都会弹通知。
 *   3. 点击通知只把窗口带回前台，并让渲染层定位到出问题的服务（崩溃 → 输出，被拦 → 诊断）。
 *   4. 关掉开关后不再弹；用户自己点停止不算崩溃，不弹。
 *
 * 通知用 Module._load 拦截（同 verify-m10.cjs），在 require 主进程包之前装好。
 *
 *   npm run build
 *   npx electron scripts/verify-review-notify.cjs
 */
const Module = require('node:module')

const toasts = []
class ProbeNotification {
  constructor(options) {
    this.options = options
    this.handlers = {}
  }
  on(ev, fn) {
    this.handlers[ev] = fn
    return this
  }
  show() {
    toasts.push({ title: this.options.title, body: this.options.body, n: this })
  }
  static isSupported() {
    return true
  }
}
const realLoad = Module._load
Module._load = function (request, ...rest) {
  const loaded = realLoad.call(this, request, ...rest)
  if (request !== 'electron') return loaded
  return new Proxy(loaded, {
    get: (target, key) => (key === 'Notification' ? ProbeNotification : target[key]),
    has: (target, key) => key in target
  })
}

const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const FIX = join(__dirname, 'fixture')
const SANDBOX = join(tmpdir(), `mile-review-notify-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)

// 崩溃项目：dev 脚本以退出码 3 结束，node_modules 目录存在，预检能过
const CRASH = join(SANDBOX, 'crash-proj')
mkdirSync(join(CRASH, 'node_modules'), { recursive: true })
writeFileSync(join(CRASH, 'package.json'),
  JSON.stringify({ name: 'crash-proj', version: '1.0.0', scripts: { dev: 'node -e "process.exit(3)"' } }), 'utf8')
// 被拦项目：声明了依赖却没有 node_modules，预检必 fail
const BLOCK = join(SANDBOX, 'block-proj')
mkdirSync(BLOCK, { recursive: true })
writeFileSync(join(BLOCK, 'package.json'),
  JSON.stringify({ name: 'block-proj', version: '1.0.0', dependencies: { 'left-pad': '1.3.0' }, scripts: { dev: 'node -e "0"' } }), 'utf8')

const now = Date.now()
const mk = (id, name, path, order) => ({
  id, kind: 'service', name, path: path.replace(/\\/g, '/'), framework: 'node', packageManager: 'npm',
  script: 'dev', scripts: { dev: 'x' }, env: {}, registerOnly: false, pinned: false, order, createdAt: now
})
const crashEntry = mk('crash', '崩溃探针', CRASH, 0)
crashEntry.scripts = { dev: 'node -e "process.exit(3)"' }
const blockEntry = mk('block', '被拦探针', BLOCK, 1)
blockEntry.scripts = { dev: 'node -e "0"' }
const okEntry = mk('ok', '正常探针', FIX, 2)
okEntry.scripts = { dev: 'node server.cjs' }

writeFileSync(
  join(SANDBOX, 'mile-terminal', 'config.json'),
  JSON.stringify({
    // 版本 9 且 settings 里没有新键：验迁移会补默认值
    version: 9,
    entries: [crashEntry, blockEntry, okEntry],
    groups: [],
    ignoredListeners: [],
    settings: { scanIntervalMs: 2000, theme: 'light', externalTerminal: 'wt', terminalFontSize: 13, scrollback: 5000, killOwnedOnQuit: true, closeToTray: false, notifyOnTaskDone: true, hideFromTaskbar: false }
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

  // 记录主进程推给渲染层的「定位到服务」指令
  const focusSends = []
  const realSend = win.webContents.send.bind(win.webContents)
  win.webContents.send = (channel, ...args) => {
    if (channel === 'app:focusEntry') focusSends.push(args[0])
    return realSend(channel, ...args)
  }

  const statusOf = async (id) =>
    ((await js(`window.mile.entry.runtimes()`)).find((r) => r.entryId === id) || {}).status || ''
  const waitStatus = async (id, want, ms = 20000) => {
    let s = ''
    for (let t = 0; t < ms; t += 250) {
      s = await statusOf(id)
      if (want.includes(s)) return s
      await sleep(250)
    }
    return s
  }
  const waitToasts = async (n, ms = 6000) => {
    for (let t = 0; t < ms && toasts.length < n; t += 100) await sleep(100)
    return toasts.length >= n
  }

  console.log('\n=== 1. 设置：默认值与校验 ===')
  const st = await js(`window.mile.settings.get()`)
  check('迁移补上 notifyOnCrash 默认开', st.notifyOnCrash === true, String(st.notifyOnCrash))
  check('迁移补上 notifyOnlyWhenBackground 默认开', st.notifyOnlyWhenBackground === true, String(st.notifyOnlyWhenBackground))
  for (const key of ['notifyOnCrash', 'notifyOnlyWhenBackground']) {
    const r = await js(`window.mile.settings.patch({ ${key}: 'yes' }).then(() => '通过了', (e) => String(e.message || e))`)
    check(`拒绝非布尔的 ${key}`, r !== '通过了', r)
  }

  console.log('\n=== 2. 窗口在前台：不重复打扰 ===')
  win.show()
  win.focus()
  await sleep(500)
  if (win.isFocused()) {
    await js(`window.mile.entry.start('crash')`)
    check('前提：服务崩溃了', (await waitStatus('crash', ['crashed'])) === 'crashed')
    await sleep(1200)
    check('前台崩溃不弹系统通知', toasts.length === 0, `${toasts.length} 条`)
  } else {
    console.log('  SKIP  本环境窗口拿不到焦点，前台抑制未覆盖')
  }

  console.log('\n=== 3. 窗口收起：崩溃弹通知，点击定位到输出 ===')
  win.hide()
  await sleep(300)
  const before = toasts.length
  await js(`window.mile.entry.start('crash')`)
  check('前提：服务崩溃了', (await waitStatus('crash', ['crashed'])) === 'crashed')
  check('收到一条通知', await waitToasts(before + 1), `${toasts.length - before} 条`)
  const t1 = toasts[toasts.length - 1]
  check('标题带服务名', !!t1 && t1.title.includes('崩溃探针'), t1 && t1.title)
  check('正文带退出码', !!t1 && t1.body.includes('3'), t1 && t1.body)
  check('通知挂了点击回调', !!t1 && typeof t1.n.handlers.click === 'function')
  const sendsBefore = focusSends.length
  if (t1 && t1.n.handlers.click) t1.n.handlers.click()
  await sleep(400)
  check('点击后窗口回到前台', win.isVisible())
  const f1 = focusSends.slice(sendsBefore)[0]
  check('点击让渲染层定位到该服务的输出标签', !!f1 && f1.id === 'crash' && f1.tab === 'output', JSON.stringify(f1))

  console.log('\n=== 4. 窗口收起：启动被预检拦下，点击定位到诊断 ===')
  win.hide()
  await sleep(300)
  const before2 = toasts.length
  await js(`window.mile.entry.start('block')`)
  check('前提：启动被拦下', (await waitStatus('block', ['blocked'])) === 'blocked')
  check('收到一条通知', await waitToasts(before2 + 1), `${toasts.length - before2} 条`)
  const t2 = toasts[toasts.length - 1]
  check('标题带服务名', !!t2 && t2.title.includes('被拦探针'), t2 && t2.title)
  const sends2 = focusSends.length
  if (t2 && t2.n.handlers.click) t2.n.handlers.click()
  await sleep(400)
  const f2 = focusSends.slice(sends2)[0]
  check('点击让渲染层定位到该服务的诊断标签', !!f2 && f2.id === 'block' && f2.tab === 'diagnose', JSON.stringify(f2))

  console.log('\n=== 5. 关掉开关后不再弹 ===')
  await js(`window.mile.settings.patch({ notifyOnCrash: false })`)
  win.hide()
  await sleep(300)
  const before3 = toasts.length
  await js(`window.mile.entry.start('crash')`)
  await waitStatus('crash', ['crashed'])
  await sleep(1500)
  check('开关关闭时崩溃不弹', toasts.length === before3, `${toasts.length - before3} 条`)
  await js(`window.mile.settings.patch({ notifyOnCrash: true })`)

  console.log('\n=== 6. 用户自己停止不算崩溃 ===')
  win.hide()
  await sleep(300)
  const before4 = toasts.length
  await js(`window.mile.entry.start('ok')`)
  check('前提：服务在运行', (await waitStatus('ok', ['running'], 30000)) === 'running')
  await js(`window.mile.entry.stop('ok')`)
  const end = await waitStatus('ok', ['stopped', 'crashed'], 40000)
  check('前提：服务已停下且记为 stopped', end === 'stopped', end)
  await sleep(1500)
  check('用户主动停止不弹通知', toasts.length === before4, `${toasts.length - before4} 条`)

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`)
  }
  app.exit(fail === 0 ? 0 : 1)
})
