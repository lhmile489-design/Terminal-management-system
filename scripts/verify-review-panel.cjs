/**
 * 总览「服务操作台」停止按钮（2026-10-27 审查修复）。
 *
 * 以前这里有「停止」和「强制关闭」两个按钮，调用完全相同；普通停止的显示条件
 * `isLive && !(isRunning || isBusy)` 几乎恒假，用户看到的只有名不副实的「强制关闭」。
 * 现在合并为一个如实命名的「停止」。这里量三件事：
 *   1. 服务运行时该行恰好一个停止按钮，且没有「强制关闭」字样
 *   2. 点击后服务真的停下（终态必须是 stopped，crashed 不算）
 *   3. 停止后按钮消失，启动按钮回来
 *
 *   npm run build
 *   npx electron scripts/verify-review-panel.cjs
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const FIX = join(__dirname, 'fixture')
const SANDBOX = join(tmpdir(), `mile-review-panel-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)

const NAME = '面板探针服务'
writeFileSync(
  join(SANDBOX, 'mile-terminal', 'config.json'),
  JSON.stringify({
    version: 1,
    entries: [{
      id: 'pnl', kind: 'service', name: NAME, path: FIX, framework: 'node', packageManager: 'npm',
      script: 'dev', scripts: { dev: 'node server.cjs' }, env: {}, registerOnly: false, pinned: false,
      order: 0, createdAt: Date.now()
    }],
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

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  win.setBounds({ width: 1440, height: 900 })
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const waitFor = async (code, ms = 8000) => {
    for (let t = 0; t < ms; t += 150) { if (await js(code)) return true; await sleep(150) }
    return false
  }
  const status = () => js(`window.mile.entry.runtimes().then(l => (l.find(r => r.entryId === 'pnl') || {}).status || 'idle')`)

  // 只在「服务操作台」区块里找，别量到服务页或别的列表
  const panel = `document.querySelector('section[aria-labelledby="my-services-panel-heading"]')`
  const row = `[...(${panel}?.querySelectorAll('li') ?? [])].find(li => li.textContent.includes(${JSON.stringify(NAME)}))`

  try {
    const onDash = await waitFor(`!!${panel} && !!(${row})`, 30000)
    check('前提：总览里有服务操作台和探针行', onDash)

    await js(`window.mile.entry.start('pnl')`)
    let s = 'idle'
    for (let i = 0; i < 80; i++) { s = await status(); if (s === 'running') break; await sleep(250) }
    check('前提：服务已运行', s === 'running', s)
    await waitFor(`!!(${row})?.querySelector('button[aria-label^="停止"]')`)

    const btns = await js(`(() => {
      const li = ${row}; if (!li) return null
      const stop = [...li.querySelectorAll('button')].filter(b => (b.getAttribute('aria-label') || '').startsWith('停止'))
      return { stop: stop.length, text: li.textContent, label: stop[0]?.getAttribute('aria-label') || '' }
    })()`)
    check('运行时恰好一个停止按钮', btns && btns.stop === 1, btns ? `${btns.stop} 个` : '找不到行')
    check('按钮 aria-label 带服务名', btns && btns.label === `停止 ${NAME}`, btns?.label)
    check('行里不再出现「强制关闭」', btns && !btns.text.includes('强制关闭'), btns?.text.slice(0, 60))

    const clicked = await js(`(() => { const b = (${row})?.querySelector('button[aria-label^="停止"]'); if (!b) return false; b.click(); return true })()`)
    check('点到了停止按钮', clicked)
    for (let i = 0; i < 60; i++) { s = await status(); if (s === 'stopped' || s === 'crashed' || s === 'idle') break; await sleep(250) }
    // crashed 不算：那是异常退出，不是被停止
    check('点击后服务停下，终态是 stopped', s === 'stopped', s)

    const gone = await waitFor(`!(${row})?.querySelector('button[aria-label^="停止"]')`, 4000)
    check('停止后停止按钮消失', gone)
  } catch (err) {
    console.log('HARNESS ERROR', err)
    fail++
  }

  await js(`window.mile.entry.stop('pnl').catch(() => {})`).catch(() => null)
  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`)
  }
  app.exit(fail === 0 ? 0 : 1)
})
