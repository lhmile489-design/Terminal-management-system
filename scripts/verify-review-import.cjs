/**
 * 批量导入（2.3.0）。
 *
 * 以前只能一个目录一个目录地添加。现在服务页工具栏有「导入文件夹」：选一个父目录，
 * 主进程扫描一层子目录并逐个识别（只读标记文件），列成勾选表，一次添加，可顺带建工作组。
 *   1. 只列能识别的项目：没有标记文件的目录、隐藏目录、node_modules 不出现。
 *   2. 已登记过的目录标「已登记」且默认不勾。
 *   3. 有启动脚本的项目默认勾选，没有脚本的默认不勾（勾了就以「仅登记」加入）。
 *   4. 提交后条目落盘，勾了「同时建工作组」时新组以父目录名命名，导入的条目都归进去。
 *   5. 扫描根只能来自系统选择框：渲染层没有能传路径的扫描接口。
 *
 * 目录选择框用 Module._load 拦截，只换「用户选了哪个目录」，扫描、识别、落盘全走真实实现。
 *
 *   npm run build
 *   npx electron scripts/verify-review-import.cjs
 */
const Module = require('node:module')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const SANDBOX = join(tmpdir(), `mile-review-import-${process.pid}`)
const PARENT = join(SANDBOX, 'workspace')
let pickResult = { canceled: false, filePaths: [PARENT] }

const realLoad = Module._load
Module._load = function (request, ...rest) {
  const loaded = realLoad.call(this, request, ...rest)
  if (request !== 'electron') return loaded
  const dialog = new Proxy(loaded.dialog, {
    get: (target, key) => (key === 'showOpenDialog' ? () => Promise.resolve(pickResult) : target[key])
  })
  return new Proxy(loaded, {
    get: (target, key) => (key === 'dialog' ? dialog : target[key]),
    has: (target, key) => key in target
  })
}

const { app, BrowserWindow } = require('electron')

// 夹具：web（有 dev）、jobs（只有 build）、docs（无标记）、node_modules、.hidden、already（已登记）
const mkPkg = (dir, pkg) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg), 'utf8') }
mkPkg(join(PARENT, 'web'), { name: 'web', scripts: { dev: 'vite' }, devDependencies: { vite: '7.0.0' } })
mkPkg(join(PARENT, 'jobs'), { name: 'jobs', scripts: { build: 'node build.js' } })
mkdirSync(join(PARENT, 'docs'), { recursive: true }); writeFileSync(join(PARENT, 'docs', 'readme.md'), '# docs', 'utf8')
mkPkg(join(PARENT, 'node_modules', 'left-pad'), { name: 'left-pad' })
mkPkg(join(PARENT, '.hidden'), { name: 'hidden', scripts: { dev: 'x' } })
mkPkg(join(PARENT, 'already'), { name: 'already', scripts: { dev: 'node x.js' } })

mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)
const CONFIG = join(SANDBOX, 'mile-terminal', 'config.json')
writeFileSync(CONFIG, JSON.stringify({
  version: 11,
  entries: [{
    id: 'old', kind: 'service', name: '已有条目', path: join(PARENT, 'already'), framework: 'node', packageManager: 'npm',
    script: 'dev', scripts: { dev: 'node x.js' }, env: {}, registerOnly: false, pinned: false, order: 0, createdAt: Date.now()
  }],
  groups: [], ignoredListeners: [], groupOverrides: [], watchedKeywords: [],
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
const same = (a, b) => String(a).replace(/\\/g, '/').toLowerCase() === String(b).replace(/\\/g, '/').toLowerCase()

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  const guard = setTimeout(() => { console.log('  FAIL  超时'); console.log(`\n结果：${pass} 通过，${fail + 1} 失败`); app.exit(1) }, 90_000)
  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r))
    win.setBounds({ width: 1500, height: 940 })
    const js = (code) => win.webContents.executeJavaScript(code, true)
    const waitFor = async (code, ms = 8000) => {
      for (let t = 0; t < ms; t += 150) { if (await js(code)) return true; await sleep(150) }
      return false
    }
    await waitFor(`!!document.querySelector('nav[aria-label="主导航"]')`, 30000)
    await js(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'2',ctrlKey:true,bubbles:true,cancelable:true}));true`)
    await waitFor(`(document.querySelector('main h1')||{}).textContent==='服务'`)

    console.log('\n=== 0. 渲染层没有能传路径的扫描接口 ===')
    const api = await js(`Object.keys(window.mile.dialog)`)
    const entryApi = await js(`Object.keys(window.mile.entry)`)
    check('dialog 只有无参的选择入口', api.includes('pickImportRoot') && !entryApi.some((k) => /scan/i.test(k)), api.join(','))
    const arg = await js(`window.mile.dialog.pickImportRoot('C:\\\\Windows').then(r => r && r.root)`)
    check('传进去的路径被忽略，扫描根仍是选择框给的目录', same(arg, PARENT), arg)

    console.log('\n=== 1. 打开导入对话框 ===')
    const clickBtn = (label) => js(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()===${JSON.stringify(label)});if(!b)return false;b.click();return true})()`)
    check('工具栏有「导入文件夹」', await clickBtn('导入文件夹'))
    const dlg = `document.querySelector('[data-import-dialog]')`
    check('对话框出现', await waitFor(`!!${dlg}`))
    const rows = await js(`[...${dlg}.querySelectorAll('[data-import-row]')].map(r=>({name:r.dataset.importRow,checked:r.querySelector('input[type=checkbox]').checked,disabled:r.querySelector('input[type=checkbox]').disabled,text:r.textContent}))`)
    const names = rows.map((r) => r.name).sort()
    check('只列能识别的项目', names.join(',') === 'already,jobs,web', names.join(','))
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]))
    check('有 dev 脚本的默认勾选', byName.web && byName.web.checked)
    check('没有启动脚本的默认不勾', byName.jobs && !byName.jobs.checked)
    check('已登记的标出来且不能勾', byName.already && byName.already.disabled && !byName.already.checked && /已登记/.test(byName.already.text), byName.already && byName.already.text)

    console.log('\n=== 2. 同时建工作组并提交 ===')
    const groupName = await js(`(${dlg}.querySelector('input[data-import-group-name]')||{}).value`)
    check('工作组名默认取父目录名', groupName === 'workspace', groupName)
    await js(`(()=>{const c=${dlg}.querySelector('input[data-import-group]');if(!c.checked)c.click();const j=${dlg}.querySelector('[data-import-row="jobs"] input[type=checkbox]');if(!j.checked)j.click();return true})()`)
    check('确认按钮写明数量', await waitFor(`/导入 2 个/.test(${dlg}.textContent)`), await js(`${dlg}.querySelector('.ui-dialog-foot').textContent`))
    await js(`[...${dlg}.querySelectorAll('button')].find(b=>/导入 2 个/.test(b.textContent)).click();true`)
    check('对话框关闭', await waitFor(`!${dlg}`, 10000))
    const d = disk()
    const web = d.entries.find((e) => same(e.path, join(PARENT, 'web')))
    const jobs = d.entries.find((e) => same(e.path, join(PARENT, 'jobs')))
    check('web 落盘且可启动', web && web.script === 'dev' && web.registerOnly === false, web && JSON.stringify({ script: web.script, registerOnly: web.registerOnly }))
    check('jobs 以仅登记落盘', jobs && jobs.registerOnly === true, jobs && String(jobs.registerOnly))
    check('已登记的没被重复添加', d.entries.filter((e) => same(e.path, join(PARENT, 'already'))).length === 1)
    const g = d.groups.find((x) => x.name === 'workspace')
    check('建了工作组 workspace', !!g)
    check('导入的条目都归进新组', !!g && web && jobs && web.groupId === g.id && jobs.groupId === g.id)
    check('原有条目没被移进新组', !d.entries.find((e) => e.id === 'old').groupId)

    console.log('\n=== 3. 取消选择框不弹对话框 ===')
    pickResult = { canceled: true, filePaths: [] }
    await clickBtn('导入文件夹')
    await sleep(800)
    check('取消后没有对话框', !(await js(`!!${dlg}`)))
  } catch (err) {
    console.log('HARNESS ERROR', err)
    fail++
  }
  clearTimeout(guard)
  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`) }
  app.exit(fail === 0 ? 0 : 1)
})
