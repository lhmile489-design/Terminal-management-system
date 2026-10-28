/**
 * 托盘菜单直接启停（2.1.0）。
 *
 * 托盘以前只有「显示主窗口」和「退出」，窗口收起后想停一个服务必须先唤出窗口。
 * 现在托盘菜单带：运行数状态行、按工作组「启动全部 / 停止全部」、最近使用的服务（勾选 = 运行中，
 * 点一下启停）、「全部停止」，tooltip 显示运行数。
 *
 * 做法：在 require 主进程包之前拦截 electron 的 Tray 与 dialog.showMessageBox，
 * 记录每次 setContextMenu / setToolTip，再直接调菜单项的 click —— 点击之后走的是真实的
 * EntryService.start / stop 与真实的归属校验，拦截只换「菜单长什么样」和「确认框回答什么」。
 *
 *   npm run build
 *   npx electron scripts/verify-review-tray.cjs
 */
const Module = require('node:module')

const menus = []
const tips = []
const confirmCalls = []
let confirmAnswer = 1 // 0 = 确认，1 = 取消

const realLoad = Module._load
Module._load = function (request, ...rest) {
  const loaded = realLoad.call(this, request, ...rest)
  if (request !== 'electron') return loaded
  const RealTray = loaded.Tray
  class ProbeTray extends RealTray {
    constructor(...args) {
      super(...args)
      // 原生类的实例原型不一定是子类，所以直接给实例装探针
      const setMenu = this.setContextMenu.bind(this)
      const setTip = this.setToolTip.bind(this)
      this.setContextMenu = (menu) => { menus.push(menu); return setMenu(menu) }
      this.setToolTip = (tip) => { tips.push(tip); return setTip(tip) }
    }
  }
  const dialog = new Proxy(loaded.dialog, {
    get: (target, key) => {
      if (key !== 'showMessageBox') return target[key]
      return (...args) => {
        confirmCalls.push(args[args.length - 1])
        return Promise.resolve({ response: confirmAnswer, checkboxChecked: false })
      }
    }
  })
  return new Proxy(loaded, {
    get: (target, key) => (key === 'Tray' ? ProbeTray : key === 'dialog' ? dialog : target[key]),
    has: (target, key) => key in target
  })
}

const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const FIX = join(ROOT, 'scripts', 'fixture').replace(/\\/g, '/')
const SANDBOX = join(tmpdir(), `mile-review-tray-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)

const now = Date.now()
const mk = (id, name, order, extra = {}) => ({
  id, kind: 'service', name, path: FIX, framework: 'node', packageManager: 'npm',
  script: 'dev', scripts: { dev: 'node server.cjs' }, env: {}, registerOnly: false, pinned: false,
  order, createdAt: now, ...extra
})
writeFileSync(
  join(SANDBOX, 'mile-terminal', 'config.json'),
  JSON.stringify({
    version: 9,
    entries: [
      mk('a', '开发组服务', 0, { groupId: 'g1', lastStartedAt: now - 5000 }),
      mk('b', '未分组服务', 1, { lastStartedAt: now - 1000 }),
      mk('c', '生产组服务', 2, { groupId: 'g2', lastStartedAt: now - 9000 }),
      mk('d', '从没启动过', 3)
    ],
    groups: [
      { id: 'g1', name: '开发组', description: '', env: 'dev', order: 0, createdAt: now },
      { id: 'g2', name: '生产组', description: '', env: 'prod', order: 1, createdAt: now }
    ],
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

const last = () => menus[menus.length - 1]
const find = (items, label) => (items || []).find((i) => i.label === label)
const labels = (items) => (items || []).filter((i) => i.type !== 'separator').map((i) => i.label)
const waitFor = async (fn, ms = 20000) => {
  for (let t = 0; t < ms; t += 150) {
    try { if (await fn()) return true } catch { /* 菜单还没建好 */ }
    await sleep(150)
  }
  return false
}
const click = (item) => item.click(item, undefined, {})

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const status = (id) => js(`window.mile.entry.runtimes().then(r => (r.find(x => x.entryId === ${JSON.stringify(id)}) || {}).status || 'idle')`)

  console.log('\n=== 1. 初始菜单 ===')
  check('托盘菜单已建', await waitFor(() => menus.length > 0 && labels(last().items).length > 3), `${menus.length} 次`)
  const top0 = labels(last().items)
  check('有「N 个运行中」状态行', top0.some((l) => /^0 个运行中$/.test(l)), top0.join(' | '))
  check('状态行是禁用的', last().items[0].enabled === false)
  for (const l of ['显示主窗口', '工作组', '最近使用', '全部停止', '退出']) {
    check(`含「${l}」`, top0.includes(l), top0.join(' | '))
  }
  check('「全部停止」没有运行项时禁用', find(last().items, '全部停止')?.enabled === false)
  check('tooltip 无运行项时只显示应用名', tips[tips.length - 1] === 'Mile Terminal', String(tips[tips.length - 1]))

  const groupMenu = find(last().items, '工作组')?.submenu?.items
  const g1 = groupMenu?.find((i) => i.label.startsWith('开发组'))
  const g2 = groupMenu?.find((i) => i.label.startsWith('生产组'))
  check('工作组子菜单列出两个组', !!g1 && !!g2, labels(groupMenu).join(' | '))
  check('组名带环境标签', /开发/.test(g1?.label || '') && /生产/.test(g2?.label || ''), `${g1?.label} / ${g2?.label}`)

  const recent = find(last().items, '最近使用')?.submenu?.items
  const recentNames = labels(recent)
  check('最近使用按最近启动时间排序', recentNames.join(',') === '未分组服务,开发组服务,生产组服务', recentNames.join(','))
  check('从没启动过的不进最近使用', !recentNames.includes('从没启动过'))

  console.log('\n=== 2. 开发组：启动全部 ===')
  click(g1.submenu.items.find((i) => i.label === '启动全部'))
  check('开发环境不弹确认', confirmCalls.length === 0, `${confirmCalls.length} 次`)
  check('服务真的起来了', await waitFor(async () => (await status('a')) === 'running', 30000), await status('a'))
  check('菜单刷新：状态行变 1 个运行中', await waitFor(() => labels(last().items).some((l) => /^1 个运行中$/.test(l))), labels(last().items)[0])
  check('tooltip 显示运行数', await waitFor(() => /1 个运行中/.test(tips[tips.length - 1] || '')), String(tips[tips.length - 1]))
  check('「全部停止」启用', find(last().items, '全部停止')?.enabled === true)
  const g1b = find(last().items, '工作组').submenu.items.find((i) => i.label.startsWith('开发组'))
  check('该组的「停止全部」启用、「启动全部」禁用',
    g1b.submenu.items.find((i) => i.label === '停止全部')?.enabled === true &&
    g1b.submenu.items.find((i) => i.label === '启动全部')?.enabled === false)
  const recentA = find(last().items, '最近使用').submenu.items.find((i) => i.label === '开发组服务')
  check('最近使用里该服务显示为已勾选', recentA?.checked === true, String(recentA?.checked))

  console.log('\n=== 3. 生产组：确认框 ===')
  confirmAnswer = 1
  const g2b = find(last().items, '工作组').submenu.items.find((i) => i.label.startsWith('生产组'))
  click(g2b.submenu.items.find((i) => i.label === '启动全部'))
  check('生产环境弹了确认框', await waitFor(() => confirmCalls.length === 1, 5000), `${confirmCalls.length} 次`)
  check('确认框文案带组名', /生产组/.test(JSON.stringify(confirmCalls[0] || {})), JSON.stringify(confirmCalls[0] || {}).slice(0, 120))
  await sleep(2500)
  check('取消后没有启动', (await status('c')) !== 'running' && (await status('c')) !== 'starting', await status('c'))
  confirmAnswer = 0
  click(g2b.submenu.items.find((i) => i.label === '启动全部'))
  check('确认后启动', await waitFor(async () => (await status('c')) === 'running', 30000), await status('c'))

  console.log('\n=== 4. 最近使用：点一下启停 ===')
  const recentNow = find(last().items, '最近使用').submenu.items
  click(recentNow.find((i) => i.label === '开发组服务'))
  check('点已运行的服务会停止它', await waitFor(async () => {
    const s = await status('a')
    return s === 'stopped' || s === 'crashed'
  }, 30000), await status('a'))
  const confirmsBefore = confirmCalls.length
  click(find(last().items, '最近使用').submenu.items.find((i) => i.label === '未分组服务'))
  check('点没运行的服务会启动它', await waitFor(async () => (await status('b')) === 'running', 30000), await status('b'))
  check('未分组服务不弹确认', confirmCalls.length === confirmsBefore, `${confirmCalls.length - confirmsBefore} 次`)

  console.log('\n=== 5. 全部停止 ===')
  click(find(last().items, '全部停止'))
  check('所有运行项都停了', await waitFor(async () => {
    const s = await Promise.all(['a', 'b', 'c'].map(status))
    return s.every((x) => x !== 'running' && x !== 'starting' && x !== 'stopping')
  }, 40000), (await Promise.all(['a', 'b', 'c'].map(status))).join(','))
  check('菜单回到 0 个运行中', await waitFor(() => labels(last().items).some((l) => /^0 个运行中$/.test(l))), labels(last().items)[0])
  check('tooltip 回到只显示应用名', await waitFor(() => tips[tips.length - 1] === 'Mile Terminal'), String(tips[tips.length - 1]))

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`)
  }
  app.exit(fail === 0 ? 0 : 1)
})
