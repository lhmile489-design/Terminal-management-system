/**
 * 添加与配置表单里的「分类」输入框换成「工作组」下拉（2.3.1）。
 *
 * 分类是 1.x 启动台时代的自由文本，2.0 起不再用来分组，但表单里还留着输入框，
 * 候选项是从旧条目去重来的，用户选的时候只能看到过期数据。约定：
 *   1. 添加对话框与详情「配置」标签都没有分类输入框，也没有分类候选列表
 *   2. 两处都有工作组下拉，选项 = 「未分组」+ 现有工作组，不含任何旧分类值
 *   3. 添加时选的工作组直接随条目落盘；从组菜单点「添加服务到本组」默认选中该组
 *   4. 配置里换工作组并保存后落盘；条目已有的旧分类值不被清掉，行上的小标签仍在
 *
 * 目录选择器在主进程里换成夹具目录，识别与落盘走真实实现。
 *
 *   npm run build
 *   npx electron scripts/verify-review-groupselect.cjs
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const FIXTURE = join(__dirname, 'fixture')
const SANDBOX = join(tmpdir(), `mile-review-groupselect-${process.pid}`)
const DIR = join(SANDBOX, 'mile-terminal')
const CONFIG = join(DIR, 'config.json')
mkdirSync(DIR, { recursive: true })
app.setPath('appData', SANDBOX)

const now = Date.now()
const entry = (id, order, extra) => ({
  id, kind: 'service', name: id, path: FIXTURE, framework: 'node', packageManager: 'npm',
  script: 'dev', scripts: { dev: 'node server.cjs' }, env: {}, registerOnly: false,
  pinned: false, order, createdAt: now, ...extra
})
writeFileSync(CONFIG, JSON.stringify({
  version: 12,
  entries: [entry('old-cat', 0, { category: '旧分类XYZ', groupId: 'g1' }), entry('loose', 1, {})],
  groups: [
    { id: 'g1', name: '组甲', env: 'dev', order: 0, createdAt: now },
    { id: 'g2', name: '组乙', env: 'dev', order: 1, createdAt: now }
  ],
  ignoredListeners: [], groupOverrides: [], watchedKeywords: [],
  settings: { scanIntervalMs: 2000, theme: 'light', externalTerminal: 'wt', terminalFontSize: 13, scrollback: 5000, killOwnedOnQuit: true, closeToTray: false, notifyOnTaskDone: true, hideFromTaskbar: false, notifyOnCrash: true, notifyOnlyWhenBackground: true, globalHotkey: false }
}, null, 2), 'utf8')

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
  ipcMain.handle('dialog:pickDirectory', () => FIXTURE)
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
    const setSelect = (sel, value) => js(`(() => {
      const s = document.querySelector(${JSON.stringify(sel)}); if (!s) return false
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
      setter.call(s, ${JSON.stringify(value)}); s.dispatchEvent(new Event('change', { bubbles: true })); return true
    })()`)
    const optionsOf = (sel) => js(`[...document.querySelectorAll(${JSON.stringify(sel)} + ' option')].map((o) => o.textContent.trim() + '=' + o.value)`)

    await js(`document.querySelector('nav button[aria-label="服务"]').click(); true`)
    await waitFor(`document.querySelectorAll('.svc-row[data-entry-id]').length === 2`)

    console.log('\n=== 1. 添加对话框 ===')
    await js(`[...document.querySelectorAll('.svc-toolbar button')].find((b) => b.textContent.trim() === '添加服务').click(); true`)
    await waitFor(`!!document.querySelector('.add-dialog[role="dialog"]')`)
    await js(`document.querySelector('.add-dialog .add-drop').click(); true`)
    check('识别完成', await waitFor(`!!document.querySelector('.add-dialog [data-entry-group-select]') && document.querySelector('.add-dialog').textContent.includes('识别结果')`))
    check('没有分类输入框', await js(`!document.querySelector('.add-dialog [data-entry-category-input]')`))
    check('没有分类候选列表', await js(`!document.querySelector('.add-dialog datalist') && !document.querySelector('.add-dialog').innerHTML.includes('旧分类XYZ')`))
    const addOpts = await optionsOf('.add-dialog [data-entry-group-select]')
    check('下拉 = 未分组 + 现有工作组', JSON.stringify(addOpts) === JSON.stringify(['未分组=', '组甲=g1', '组乙=g2']), JSON.stringify(addOpts))
    check('选工作组「组乙」', await setSelect('.add-dialog [data-entry-group-select]', 'g2'))
    await js(`(() => { const i = document.querySelector('.add-dialog .ui-input'); const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(i, '新加的'); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await js(`[...document.querySelectorAll('.add-dialog .add-foot button')].find((x) => x.textContent.trim() === '添加服务').click(); true`)
    await waitFor(`!document.querySelector('.add-dialog')`)
    await sleep(500)
    const added = disk().entries.find((e) => e.name === '新加的')
    check('新条目落盘并归入组乙', !!added && added.groupId === 'g2', added && String(added.groupId))
    check('新条目没有分类', !!added && added.category === undefined)

    console.log('\n=== 2. 组菜单「添加服务到本组」默认选中该组 ===')
    await js(`document.querySelector('[aria-label="组甲 更多操作"]').click(); true`)
    await sleep(300)
    check('点到菜单项', await js(`(() => { const m = [...document.querySelectorAll('[role="menuitem"]')].find((x) => x.textContent.includes('添加服务到本组')); if (!m) return false; m.click(); return true })()`))
    // 下拉在识别完成后才渲染，先选目录
    await waitFor(`!!document.querySelector('.add-dialog .add-drop')`)
    await js(`document.querySelector('.add-dialog .add-drop').click(); true`)
    check('识别后出现工作组下拉', await waitFor(`!!document.querySelector('.add-dialog [data-entry-group-select]')`))
    check('默认选中组甲', await js(`document.querySelector('.add-dialog [data-entry-group-select]').value === 'g1'`))
    await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`)
    await waitFor(`!document.querySelector('.add-dialog')`)

    console.log('\n=== 3. 配置标签 ===')
    await js(`document.querySelector('.svc-row[data-entry-id="old-cat"]').click(); true`)
    await sleep(400)
    await js(`[...document.querySelectorAll('.svc-detail [role="tab"]')].find((t) => t.textContent.includes('配置')).click(); true`)
    check('配置标签出现工作组下拉', await waitFor(`!!document.querySelector('.svc-detail [data-entry-group-select]')`))
    check('没有分类输入框', await js(`!document.querySelector('.svc-detail [data-entry-category-input]')`))
    check('没有分类候选列表', await js(`!document.querySelector('.svc-detail datalist') && !document.querySelector('.svc-config').innerHTML.includes('旧分类XYZ')`))
    const cfgOpts = await optionsOf('.svc-detail [data-entry-group-select]')
    check('下拉 = 未分组 + 现有工作组', JSON.stringify(cfgOpts) === JSON.stringify(['未分组=', '组甲=g1', '组乙=g2']), JSON.stringify(cfgOpts))
    check('当前值是组甲', await js(`document.querySelector('.svc-detail [data-entry-group-select]').value === 'g1'`))
    await setSelect('.svc-detail [data-entry-group-select]', 'g2')
    await waitFor(`!!document.querySelector('.svc-savebar')`)
    await js(`[...document.querySelectorAll('.svc-savebar button')].find((b) => b.textContent.trim() === '保存').click(); true`)
    await sleep(900)
    const after = disk().entries.find((e) => e.id === 'old-cat')
    check('换组并保存后落盘', after.groupId === 'g2', String(after.groupId))
    check('旧分类值没被清掉', after.category === '旧分类XYZ', String(after.category))
    check('行上的旧分类小标签仍在', await js(`(document.querySelector('.svc-row[data-entry-id="old-cat"] .svc-cat') || {}).textContent === '旧分类XYZ'`))
    await setSelect('.svc-detail [data-entry-group-select]', '')
    await waitFor(`!!document.querySelector('.svc-savebar')`)
    await js(`[...document.querySelectorAll('.svc-savebar button')].find((b) => b.textContent.trim() === '保存').click(); true`)
    await sleep(900)
    check('选「未分组」后移出工作组', disk().entries.find((e) => e.id === 'old-cat').groupId === undefined)
  } catch (err) {
    console.log('HARNESS ERROR', err)
    fail++
  }
  clearTimeout(guard)
  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`) }
  app.exit(fail === 0 ? 0 : 1)
})
