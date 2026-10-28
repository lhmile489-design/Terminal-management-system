/**
 * 添加时提示同一目录已登记（2.2.0）。
 *
 * 以前同一目录可以悄悄登记两次，之后预检才报「端口配置重复」，指向端口而不是根因。
 * 现在选完目录后，如果这个目录（大小写、斜杠方向不同也算）已经登记过，对话框里写明是哪个条目。
 * 只提示、不拦截：同一目录配不同脚本（monorepo、dev 与 build 两个条目）是合理用法。
 *
 * 目录选择器换成返回夹具目录（同 verify-m11-add.cjs），识别与落盘走真实实现。
 *
 *   npm run build
 *   npx electron scripts/verify-review-dupdir.cjs
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const FIXTURE = join(__dirname, 'fixture')
const FIXT = join(__dirname, 'fixture-task')
const SANDBOX = join(tmpdir(), `mile-review-dupdir-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)
const CONFIG = join(SANDBOX, 'mile-terminal', 'config.json')

// 已登记的条目：路径故意用正斜杠 + 大写，验证比较时做了归一化
writeFileSync(
  CONFIG,
  JSON.stringify({
    version: 9,
    entries: [{
      id: 'old', kind: 'service', name: '已有的博客', path: FIXTURE.replace(/\\/g, '/').toUpperCase(),
      framework: 'node', packageManager: 'npm', script: 'dev', scripts: { dev: 'node server.cjs' }, env: {},
      registerOnly: false, pinned: false, order: 0, createdAt: Date.now()
    }],
    groups: [], ignoredListeners: [],
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

let picked = FIXTURE
app.whenReady().then(async () => {
  ipcMain.removeHandler('dialog:pickDirectory')
  ipcMain.handle('dialog:pickDirectory', () => picked)
  const win = BrowserWindow.getAllWindows()[0]
  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r))
    win.setBounds({ width: 1500, height: 940 })
    const js = (code) => win.webContents.executeJavaScript(code, true)
    const waitFor = async (code, ms = 8000) => {
      for (let t = 0; t < ms; t += 150) { if (await js(code)) return true; await sleep(150) }
      return false
    }
    const click = (label) => js(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()===${JSON.stringify(label)}||x.getAttribute('aria-label')===${JSON.stringify(label)});if(!b)return false;b.click();return true})()`)
    const notice = `document.querySelector('.add-dialog [data-dup-dir]')`

    await waitFor(`!!document.querySelector('nav[aria-label="主导航"]')`, 30000)
    await click('服务')
    await waitFor(`(document.querySelector('main h1')||{}).textContent==='服务'`)

    console.log('\n=== 1. 选了已登记的目录 ===')
    check('打开添加对话框', await click('添加服务'))
    await waitFor(`!!document.querySelector('.add-dialog[role="dialog"]')`)
    await js(`document.querySelector('.add-dialog .add-drop').click();true`)
    check('识别完成', await waitFor(`(document.querySelector('.add-dialog')||{textContent:''}).textContent.includes('识别结果')`))
    check('出现「已登记」提示', await waitFor(`!!${notice}`, 3000))
    const text = await js(`(${notice}||{textContent:''}).textContent`)
    check('提示写明是哪个条目', text.includes('已有的博客'), text)
    check('提示不是错误（不拦截）', await js(`${notice}.getAttribute('role') !== 'alert'`))
    check('添加按钮仍可用', await js(`(()=>{const b=[...document.querySelectorAll('.add-dialog .add-foot button')].find(x=>x.textContent.trim()==='添加服务');return !!b && !b.disabled})()`))

    console.log('\n=== 2. 仍然可以添加 ===')
    await js(`[...document.querySelectorAll('.add-dialog .add-foot button')].find(x=>x.textContent.trim()==='添加服务').click();true`)
    check('对话框关闭', await waitFor(`!document.querySelector('.add-dialog')`))
    await sleep(300)
    check('磁盘上两条', JSON.parse(readFileSync(CONFIG, 'utf8')).entries.length === 2)

    console.log('\n=== 3. 换成没登记过的目录，没有提示 ===')
    picked = FIXT
    await click('添加服务')
    await waitFor(`!!document.querySelector('.add-dialog[role="dialog"]')`)
    await js(`document.querySelector('.add-dialog .add-drop').click();true`)
    check('识别完成', await waitFor(`(document.querySelector('.add-dialog')||{textContent:''}).textContent.includes('识别结果')`))
    await sleep(300)
    check('没有「已登记」提示', !(await js(`!!${notice}`)))
    await js(`document.querySelector('.add-dialog').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));true`)
  } catch (err) {
    console.log('HARNESS ERROR', err)
    fail++
  }
  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`) }
  app.exit(fail === 0 ? 0 : 1)
})
