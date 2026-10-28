/**
 * 全局快捷键 Ctrl+Alt+M 唤起窗口并打开命令面板（2.1.0）。
 *
 * 以前 Ctrl+K 只是 document 级 keydown，窗口收起到托盘或失焦时完全无效。
 * 这里验：
 *   1. 新设置 globalHotkey 默认开（从 v10 配置迁移上来），校验布尔。
 *   2. 启动时注册了 Ctrl+Alt+M。
 *   3. 窗口收起时按下，窗口回到前台、命令面板打开。
 *   4. 关掉设置后快捷键被注销；再打开重新注册。
 *   5. 组合键已被别的程序占用时不崩，实时动态里给出提示。
 *
 * globalShortcut 用 Module._load 拦截（同 verify-m10.cjs 的 Notification），在 require
 * 主进程包之前装好：只换「注册到了哪里」，回调触发后走的是真实的窗口与渲染层。
 *
 *   npm run build
 *   npx electron scripts/verify-review-hotkey.cjs
 */
const Module = require('node:module')

const registered = new Map()
const calls = []
let occupied = false
const probe = {
  register(accel, cb) {
    calls.push(['register', accel])
    if (occupied) return false
    registered.set(accel, cb)
    return true
  },
  unregister(accel) {
    calls.push(['unregister', accel])
    registered.delete(accel)
  },
  unregisterAll() {
    calls.push(['unregisterAll'])
    registered.clear()
  },
  isRegistered(accel) {
    return registered.has(accel)
  }
}
const realLoad = Module._load
Module._load = function (request, ...rest) {
  const loaded = realLoad.call(this, request, ...rest)
  if (request !== 'electron') return loaded
  return new Proxy(loaded, {
    get: (target, key) => (key === 'globalShortcut' ? probe : target[key]),
    has: (target, key) => key in target
  })
}

const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const SANDBOX = join(tmpdir(), `mile-review-hotkey-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)
const CONFIG = join(SANDBOX, 'mile-terminal', 'config.json')
// v10 配置：没有 globalHotkey，迁移要补上默认开
writeFileSync(CONFIG, JSON.stringify({
  version: 10, entries: [], groups: [], ignoredListeners: [], groupOverrides: [], watchedKeywords: [],
  settings: { scanIntervalMs: 2000, theme: 'light', externalTerminal: 'wt', terminalFontSize: 13, scrollback: 5000, killOwnedOnQuit: true, closeToTray: true, notifyOnTaskDone: true, hideFromTaskbar: false, notifyOnCrash: true, notifyOnlyWhenBackground: true }
}, null, 2), 'utf8')

require(join(ROOT, 'out', 'main', 'index.js'))

// 与产品里 GLOBAL_HOTKEY 逐字一致：探针按字符串比对，'Control+Alt+M' 虽然等价也对不上
const ACCEL = 'Ctrl+Alt+M'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(name, ok, detail) {
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? ` — ${detail}` : ''}`)
}

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.log('  FAIL  超时'); app.exit(3) }, 60_000)
  const win = BrowserWindow.getAllWindows()[0]
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const waitFor = async (fn, ms = 6000) => {
    for (let t = 0; t < ms; t += 120) { if (await fn()) return true; await sleep(120) }
    return false
  }
  const paletteOpen = () => js(`!!document.querySelector('[role="dialog"][aria-label="命令面板"]')`)
  await waitFor(() => js(`!!document.querySelector('nav[aria-label="主导航"]')`), 30000)

  console.log('\n=== 1. 设置：默认值与校验 ===')
  const s = await js(`window.mile.settings.get()`)
  check('迁移补上 globalHotkey 默认开', s.globalHotkey === true, String(s.globalHotkey))
  const bad = await js(`window.mile.settings.patch({ globalHotkey: 'yes' }).then(() => '通过了', e => String(e))`)
  check('拒绝非布尔的 globalHotkey', /布尔/.test(bad), bad)

  console.log('\n=== 2. 启动时注册 ===')
  check('注册了 Ctrl+Alt+M', registered.has(ACCEL), JSON.stringify(calls))

  console.log('\n=== 3. 窗口收起时按下 ===')
  win.hide()
  await sleep(300)
  check('前提：窗口已收起', !win.isVisible())
  check('前提：命令面板没开', !(await paletteOpen()))
  const cb = registered.get(ACCEL)
  if (cb) cb()
  check('窗口回到前台', await waitFor(async () => win.isVisible()), String(win.isVisible()))
  check('命令面板已打开', await waitFor(paletteOpen))
  // 再按一次不应把面板关掉：快捷键语义是「唤起」，不是开关
  if (cb) cb()
  await sleep(400)
  check('再按一次面板仍开着', await paletteOpen())
  await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));true`)
  await waitFor(async () => !(await paletteOpen()))

  console.log('\n=== 4. 关掉设置后注销，打开后重新注册 ===')
  await js(`window.mile.settings.patch({ globalHotkey: false })`)
  check('关闭后注销', await waitFor(async () => !registered.has(ACCEL)), JSON.stringify(calls.slice(-2)))
  check('已落盘为 false', JSON.parse(readFileSync(CONFIG, 'utf8')).settings.globalHotkey === false)
  await js(`window.mile.settings.patch({ globalHotkey: true })`)
  check('打开后重新注册', await waitFor(async () => registered.has(ACCEL)))

  console.log('\n=== 5. 组合键被占用 ===')
  await js(`window.mile.settings.patch({ globalHotkey: false })`)
  occupied = true
  const before = await js(`document.querySelector('[aria-label^="实时动态"]')?.getAttribute('aria-label') || ''`)
  const r = await js(`window.mile.settings.patch({ globalHotkey: true }).then(s => 'ok:' + s.globalHotkey, e => String(e))`)
  check('被占用时设置仍能保存，不抛错', r === 'ok:true', r)
  check('没有注册上', !registered.has(ACCEL))
  const after = await js(`document.querySelector('[aria-label^="实时动态"]')?.getAttribute('aria-label') || ''`)
  check('实时动态收到提示（未读数增加）', after !== before, `${before} → ${after}`)

  clearTimeout(watchdog)
  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`) }
  app.exit(fail === 0 ? 0 : 1)
})
