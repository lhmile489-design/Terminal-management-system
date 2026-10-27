/**
 * 关于页外链（2026-10-27 审查修复）。
 *
 * 以前两个按钮用 window.open，被 setWindowOpenHandler 的 localhost 白名单拦下，点了没反应。
 * 现在走 shell:openProjectLink：渲染层只给键名，地址由主进程查 PROJECT_LINKS。
 *
 * shell.openExternal 用 Module._load + Proxy 换成记录器（同 verify-m10 换 Notification 的写法），
 * 不会真的打开浏览器。断言：
 * 1. 点两个按钮，各记录到一次对应的 GitHub 地址
 * 2. 未知键名、直接传 URL、原型链上的键（toString）一律不开
 *
 *   npm run build
 *   npx electron scripts/verify-review-links.cjs
 */
const Module = require('node:module')

const opened = []
const realLoad = Module._load
Module._load = function (request, ...rest) {
  const loaded = realLoad.call(this, request, ...rest)
  if (request !== 'electron') return loaded
  const fakeShell = new Proxy(loaded.shell, {
    get: (target, key) =>
      key === 'openExternal' ? async (url) => { opened.push(String(url)) } : target[key]
  })
  return new Proxy(loaded, {
    get: (target, key) => (key === 'shell' ? fakeShell : target[key]),
    has: (target, key) => key in target
  })
}

const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const SANDBOX = join(tmpdir(), `mile-review-links-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)
writeFileSync(
  join(SANDBOX, 'mile-terminal', 'config.json'),
  JSON.stringify({
    version: 1,
    entries: [],
    ignoredListeners: [],
    settings: { scanIntervalMs: 2000, theme: 'light', externalTerminal: 'wt', terminalFontSize: 13, scrollback: 5000, killOwnedOnQuit: true, closeToTray: false }
  }, null, 2),
  'utf8'
)

require(join(ROOT, 'out', 'main', 'index.js'))

const REPO = 'https://github.com/lhmile489-design/Terminal-management-system'
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
  const waitFor = async (code, ms = 5000) => {
    for (let t = 0; t < ms; t += 100) { if (await js(code)) return true; await sleep(100) }
    return false
  }
  const waitOpened = async (n, ms = 3000) => {
    for (let t = 0; t < ms && opened.length < n; t += 50) await sleep(50)
  }

  await waitFor(`!!document.querySelector('nav[aria-label="主导航"]')`, 30000)
  await js(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'5',ctrlKey:true,bubbles:true,cancelable:true}));true`)
  const onAbout = await waitFor(`!!document.querySelector('.about-actions')`)
  check('前提：已到关于页', onAbout)

  console.log('\n=== 1. 两个按钮真的会打开 ===')
  const clickBtn = (text) => js(`(()=>{const b=[...document.querySelectorAll('.about-actions button')].find(x=>x.textContent.includes(${JSON.stringify(text)}));if(!b)return false;b.click();return true})()`)
  check('点到了「GitHub 仓库」', await clickBtn('GitHub 仓库'))
  await waitOpened(1)
  check('打开的是仓库地址', opened[0] === REPO, opened[0] ?? '没有打开')
  check('点到了「提交 Issue」', await clickBtn('提交 Issue'))
  await waitOpened(2)
  check('打开的是 Issue 地址', opened[1] === `${REPO}/issues`, opened[1] ?? '没有打开')

  console.log('\n=== 2. 白名单外一律不开 ===')
  const before = opened.length
  for (const bad of ['evil', 'https://example.com', 'toString', '__proto__']) {
    await js(`window.mile.shell.openProjectLink(${JSON.stringify(bad)});true`)
  }
  await js(`window.open('https://example.com', '_blank');true`)
  await sleep(800)
  check('非法键名与任意 URL 都没打开', opened.length === before, opened.slice(before).join(' | ') || '无')

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`)
  }
  app.exit(fail === 0 ? 0 : 1)
})
