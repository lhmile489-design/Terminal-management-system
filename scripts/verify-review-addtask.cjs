/**
 * 服务页的「添加任务」入口（2.3.1）。
 *
 * 2.0 把启动台并进服务页时，只迁了「添加服务」，任务只剩总览页按钮和命令面板两个入口，
 * 而服务页本身有「任务」筛选。约定：
 *   1. 服务页工具栏有「添加任务」，点开是任务模式的添加对话框（标题「添加任务」），
 *      提交后落盘 kind = task
 *   2. 工作组菜单有「添加任务到本组」，对话框里工作组下拉默认选中该组，提交后归入该组
 *   3. 服务页空状态（没有任何条目）也能直接添加任务
 *
 * 目录选择器在主进程里换成任务夹具目录，识别与落盘走真实实现。
 *
 *   npm run build
 *   npx electron scripts/verify-review-addtask.cjs
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const FIXTURE_TASK = join(__dirname, 'fixture-task')
const SANDBOX = join(tmpdir(), `mile-review-addtask-${process.pid}`)
const DIR = join(SANDBOX, 'mile-terminal')
const CONFIG = join(DIR, 'config.json')
mkdirSync(DIR, { recursive: true })
app.setPath('appData', SANDBOX)

const now = Date.now()
const settings = { scanIntervalMs: 2000, theme: 'light', externalTerminal: 'wt', terminalFontSize: 13, scrollback: 5000, killOwnedOnQuit: true, closeToTray: false, notifyOnTaskDone: true, hideFromTaskbar: false, notifyOnCrash: true, notifyOnlyWhenBackground: true, globalHotkey: false }
const base = (extra) => ({ version: 12, entries: [], groups: [], ignoredListeners: [], groupOverrides: [], watchedKeywords: [], settings, ...extra })
// 阶段 A：一个空工作组 + 一个游离服务，量工具栏与组菜单；阶段 B 才清空到零条目量空状态
writeFileSync(CONFIG, JSON.stringify(base({
  entries: [{
    id: 'svc', kind: 'service', name: 'svc', path: join(__dirname, 'fixture'), framework: 'node', packageManager: 'npm',
    script: 'dev', scripts: { dev: 'node server.cjs' }, env: {}, registerOnly: false, pinned: false, order: 0, createdAt: now
  }],
  groups: [{ id: 'g1', name: '组甲', env: 'dev', order: 0, createdAt: now }]
}), null, 2), 'utf8')

require(join(ROOT, 'out', 'main', 'index.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(name, ok, detail) {
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? ` — ${detail}` : ''}`)
}
const disk = () => JSON.parse(readFileSync(CONFIG, 'utf8'))

app.whenReady().then(async () => {
  ipcMain.removeHandler('dialog:pickDirectory')
  ipcMain.handle('dialog:pickDirectory', () => FIXTURE_TASK)
  const guard = setTimeout(() => { console.log('  FAIL  超时'); console.log(`\n结果：${pass} 通过，${fail + 1} 失败`); app.exit(1) }, 90000)
  const win = BrowserWindow.getAllWindows()[0]
  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r))
    win.setBounds({ width: 1500, height: 940 })
    const js = (code) => win.webContents.executeJavaScript(code, true)
    const waitFor = async (expr, ms = 8000) => {
      const end = Date.now() + ms
      while (Date.now() < end) { if (await js(expr)) return true; await sleep(120) }
      return false
    }
    const clickText = (scope, text) => js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope)})].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true })()`)
    const setName = (v) => js(`(() => { const i = document.querySelector('.add-dialog .ui-input'); const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(i, ${JSON.stringify(v)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    const identified = () => waitFor(`!!document.querySelector('.add-dialog [data-entry-group-select]') && document.querySelector('.add-dialog').textContent.includes('识别结果')`)
    const closeDialog = async () => {
      await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`)
      await waitFor(`!document.querySelector('.add-dialog')`)
    }

    await js(`document.querySelector('nav button[aria-label="服务"]').click(); true`)
    await waitFor(`document.querySelectorAll('.svc-row[data-entry-id]').length === 1`)

    console.log('\n=== 1. 工具栏「添加任务」 ===')
    check('工具栏有「添加任务」', await js(`[...document.querySelectorAll('.svc-toolbar button')].some((b) => b.textContent.trim() === '添加任务')`))
    check('点到按钮', await clickText('.svc-toolbar button', '添加任务'))
    check('对话框标题是「添加任务」', await waitFor(`(document.querySelector('#add-entry-title') || {}).textContent === '添加任务'`))
    await js(`document.querySelector('.add-dialog .add-drop').click(); true`)
    check('识别完成', await identified())
    await setName('工具栏任务')
    check('提交按钮是「添加任务」', await clickText('.add-dialog .add-foot button', '添加任务'))
    await waitFor(`!document.querySelector('.add-dialog')`)
    await sleep(500)
    const t1 = disk().entries.find((e) => e.name === '工具栏任务')
    check('落盘 kind = task', !!t1 && t1.kind === 'task', t1 && t1.kind)
    check('未选工作组则未分组', !!t1 && t1.groupId === undefined, t1 && String(t1.groupId))

    console.log('\n=== 2. 组菜单「添加任务到本组」 ===')
    await js(`document.querySelector('[aria-label="组甲 更多操作"]').click(); true`)
    await sleep(300)
    check('组菜单有「添加任务到本组」', await js(`[...document.querySelectorAll('[role="menuitem"]')].some((x) => x.textContent.includes('添加任务到本组'))`))
    check('点到菜单项', await js(`(() => { const m = [...document.querySelectorAll('[role="menuitem"]')].find((x) => x.textContent.includes('添加任务到本组')); if (!m) return false; m.click(); return true })()`))
    check('对话框是任务模式', await waitFor(`(document.querySelector('#add-entry-title') || {}).textContent === '添加任务'`))
    await js(`document.querySelector('.add-dialog .add-drop').click(); true`)
    check('识别完成', await identified())
    check('下拉默认选中组甲', await js(`document.querySelector('.add-dialog [data-entry-group-select]').value === 'g1'`))
    await setName('组内任务')
    await clickText('.add-dialog .add-foot button', '添加任务')
    await waitFor(`!document.querySelector('.add-dialog')`)
    await sleep(700)
    const t2 = disk().entries.find((e) => e.name === '组内任务')
    check('组内任务 kind = task 且归入组甲', !!t2 && t2.kind === 'task' && t2.groupId === 'g1', t2 && `${t2.kind}/${t2.groupId}`)
    // 「添加服务到本组」不能被改坏
    await js(`document.querySelector('[aria-label="组甲 更多操作"]').click(); true`)
    await sleep(300)
    await js(`(() => { const m = [...document.querySelectorAll('[role="menuitem"]')].find((x) => x.textContent.includes('添加服务到本组')); m && m.click(); return !!m })()`)
    check('「添加服务到本组」仍是服务模式', await waitFor(`(document.querySelector('#add-entry-title') || {}).textContent === '添加服务'`))
    await closeDialog()

    console.log('\n=== 3. 空状态 ===')
    // 通过 IPC 删光条目与工作组，量空状态
    await js(`(async () => { for (const e of await window.mile.entry.list()) await window.mile.entry.remove(e.id); for (const g of await window.mile.group.list()) await window.mile.group.remove(g.id); return true })()`)
    check('列表已清空', await waitFor(`document.querySelectorAll('.svc-row[data-entry-id]').length === 0`))
    check('空状态有「添加任务」', await waitFor(`[...document.querySelectorAll('.svc-empty-row button')].some((b) => b.textContent.trim() === '添加任务')`))
    check('点空状态的「添加任务」', await clickText('.svc-empty-row button', '添加任务'))
    check('对话框是任务模式', await waitFor(`(document.querySelector('#add-entry-title') || {}).textContent === '添加任务'`))
  } catch (err) {
    console.log('HARNESS ERROR', err)
    fail++
  }
  clearTimeout(guard)
  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`) }
  app.exit(fail === 0 ? 0 : 1)
})
