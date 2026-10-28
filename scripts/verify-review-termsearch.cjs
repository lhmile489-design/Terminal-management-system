/**
 * 终端内搜索（2.2.0）。
 *
 * SearchAddon 早就加载了，但没有任何界面能用它。现在焦点在终端里按 Ctrl+F 弹出搜索条：
 *   1. 输入关键字后显示「第 n / 共 m 条」，m 等于输出里真实出现的次数。
 *   2. Enter 到下一条、Shift+Enter 到上一条，序号跟着变。
 *   3. 搜不到时明确显示「无结果」。
 *   4. Esc 关闭搜索条，焦点回到终端。
 *   5. Ctrl+F 不再被当成输入发给 shell（发出去就是 ^F）。
 *
 *   npm run build
 *   npx electron scripts/verify-review-termsearch.cjs
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const SANDBOX = join(tmpdir(), `mile-review-termsearch-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)
writeFileSync(
  join(SANDBOX, 'mile-terminal', 'config.json'),
  JSON.stringify({
    version: 1, entries: [], ignoredListeners: [],
    settings: { scanIntervalMs: 2000, theme: 'light', externalTerminal: 'wt', terminalFontSize: 13, scrollback: 5000, killOwnedOnQuit: true, closeToTray: false }
  }, null, 2),
  'utf8'
)

// 记录渲染层写给会话的输入，确认 Ctrl+F 没被当成 ^F 发出去
const writes = []
{
  const { ipcMain } = require('electron')
  const on = ipcMain.on.bind(ipcMain)
  ipcMain.on = (ch, fn) => on(ch, ch === 'session:write' ? (e, id, data) => { writes.push(String(data)); return fn(e, id, data) } : fn)
}
require(join(ROOT, 'out', 'main', 'index.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(name, ok, detail) {
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? ` — ${detail}` : ''}`)
}

const MARK = 'MILESRCHPROBE'

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  win.setBounds({ width: 1400, height: 900 })
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const waitFor = async (code, ms = 10000) => {
    for (let t = 0; t < ms; t += 150) { if (await js(code)) return true; await sleep(150) }
    return false
  }
  await waitFor(`!!document.querySelector('nav[aria-label="主导航"]')`, 30000)

  console.log('\n=== 0. 前提：终端里有三行带标记的输出 ===')
  await js(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'3',ctrlKey:true,bubbles:true,cancelable:true}));true`)
  await waitFor(`(document.querySelector('main h1')||{}).textContent==='终端'`)
  await js(`(()=>{const b=document.querySelector('button[aria-label="新建终端会话"]');b&&b.click();return !!b})()`)
  check('终端已挂载', await waitFor(`!!document.querySelector('.xterm .xterm-helper-textarea')`))
  const sid = await js(`window.mile.session.list().then(l => l[l.length - 1].id)`)
  await sleep(1500)
  // 拆开写，回显里不会整串出现，只有 echo 的输出带完整标记
  await js(`window.mile.session.write(${JSON.stringify(sid)}, "1..3 | % { 'MILE' + 'SRCHPROBE' + $_ }\\r")`)
  check('输出里有三行标记', await waitFor(`window.mile.session.history(${JSON.stringify(sid)}).then(h => (h.match(/${MARK}[123]/g) || []).length >= 3)`, 15000))
  await sleep(500)

  const focusTerm = `(()=>{const t=document.querySelector('.xterm .xterm-helper-textarea');t.focus();return document.activeElement===t})()`
  const ctrlF = `(()=>{const t=document.activeElement;t.dispatchEvent(new KeyboardEvent('keydown',{key:'f',code:'KeyF',keyCode:70,ctrlKey:true,bubbles:true,cancelable:true}));return true})()`
  const bar = `document.querySelector('[data-term-search]')`

  console.log('\n=== 1. Ctrl+F 打开搜索条 ===')
  check('前提：焦点在终端里', await js(focusTerm))
  const writesBefore = writes.length
  await js(ctrlF)
  check('搜索条出现', await waitFor(`!!${bar}`, 3000))
  check('焦点到了搜索框', await js(`document.activeElement === ${bar}?.querySelector('input')`))
  await sleep(300)
  check('Ctrl+F 没被发给 shell', !writes.slice(writesBefore).some((w) => w.includes('\x06')), JSON.stringify(writes.slice(writesBefore)))

  console.log('\n=== 2. 输入关键字，计数与跳转 ===')
  const type = (v) => js(`(()=>{const i=${bar}.querySelector('input');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,${JSON.stringify(v)});i.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
  const status = () => js(`(${bar}?.querySelector('[data-term-search-status]')||{textContent:''}).textContent.trim()`)
  await type(MARK)
  check('显示 共 3 条', await waitFor(`/共 3/.test((${bar}.querySelector('[data-term-search-status]')||{}).textContent||'')`, 4000), await status())
  const s1 = await status()
  await js(`${bar}.querySelector('input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));true`)
  await sleep(300)
  const s2 = await status()
  check('Enter 跳到下一条（序号变了）', s2 !== s1 && /共 3/.test(s2), `${s1} → ${s2}`)
  await js(`${bar}.querySelector('input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true,cancelable:true}));true`)
  await sleep(300)
  check('Shift+Enter 回到上一条', (await status()) === s1, `${s2} → ${await status()}`)
  const n = (s) => Number((/第\s*(\d+)/.exec(s) || [])[1])
  check('序号在 1–3 之间', n(s1) >= 1 && n(s1) <= 3, s1)

  console.log('\n=== 3. 搜不到 ===')
  await type('MILE_NOTHING_HERE_ZZ')
  check('显示无结果', await waitFor(`/无结果/.test((${bar}.querySelector('[data-term-search-status]')||{}).textContent||'')`, 4000), await status())

  console.log('\n=== 4. Esc 关闭 ===')
  await js(`${bar}.querySelector('input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));true`)
  check('搜索条关闭', await waitFor(`!${bar}`, 2000))
  check('焦点回到终端', await js(`document.activeElement === document.querySelector('.xterm .xterm-helper-textarea')`))
  check('Esc 后仍在终端页（没被全局 Esc 带走）', (await js(`(document.querySelector('main h1')||{}).textContent`)) === '终端')

  console.log('\n=== 5. 快捷键一览里有这一条 ===')
  await js(`document.querySelector('main h1').click();document.body.focus();document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'?',bubbles:true,cancelable:true}));true`)
  check('快捷键一览列出终端搜索', await waitFor(`[...document.querySelectorAll('[role="dialog"] .ui-keys *')].some(e=>/终端.*搜索/.test(e.textContent))`, 3000))

  await js(`(async()=>{for(const s of await window.mile.session.list())await window.mile.session.stop(s.id).catch(()=>{});return true})()`).catch(() => null)
  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`) }
  app.exit(fail === 0 ? 0 : 1)
})
