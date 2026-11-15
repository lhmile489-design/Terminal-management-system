/**
 * S33 原版一侧的采集驱动：沙箱 appData 里播种配置，加载原项目的 out/ 构建产物（只读，不改原项目），
 * 通过 webContents.debugger 走 CDP，跑 scripts/s33-probe.cjs，结果写到 build/s33/orig/。
 *
 * 用法（在 mygo/console 下）：
 *   ../../mile-terminal-management/node_modules/electron/dist/electron.exe scripts/s33-orig.cjs
 *
 * 照原版 verify-ui.cjs：require 主进程之前先 setPath('appData', 沙箱)，不碰真实 %APPDATA%\mile-terminal\。
 * 未打包运行，原版的单实例锁不生效，与已安装的 Mile Terminal 互不影响。
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const probe = require('./s33-probe.cjs')

const ORIG = join(__dirname, '..', '..', '..', 'mile-terminal-management')
const OUT = join(__dirname, '..', 'build', 's33', 'orig')
const SANDBOX = join(tmpdir(), `mile-s33-orig-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
mkdirSync(OUT, { recursive: true })
app.setPath('appData', SANDBOX)
app.setPath('userData', join(SANDBOX, 'mile-terminal'))

const FIX = join(ORIG, 'scripts', 'fixture').replace(/\\/g, '/')
const FIXT = join(ORIG, 'scripts', 'fixture-task').replace(/\\/g, '/')
writeFileSync(join(SANDBOX, 'mile-terminal', 'config.json'), JSON.stringify(probe.seedConfig(FIX, FIXT), null, 2), 'utf8')

require(join(ORIG, 'out', 'main', 'index.js'))

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const dbg = win.webContents.debugger
    let code = 0
    try {
      dbg.attach('1.3')
      const send = (m, p = {}) => dbg.sendCommand(m, p)
      await send('Page.enable')
      const evaluate = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
        return r.result.value
      }
      const driver = {
        eval: evaluate,
        send,
        prepare: () => evaluate('(window.__mile = window.mile, true)')
      }
      const files = { write: (rel, data) => writeFileSync(join(OUT, rel), data) }
      const summary = await probe.run(driver, files, (m) => console.log('[orig] ' + m))
      console.log('[orig] done, press=' + JSON.stringify(summary.press))
    } catch (err) {
      console.error('[orig] FAIL', err)
      code = 1
    }
    try { dbg.detach() } catch { /* 已断开 */ }
    app.exit(code)
    try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* 进程退出后再清也行 */ }
  })
})
