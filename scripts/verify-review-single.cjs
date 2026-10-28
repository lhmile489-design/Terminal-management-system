/**
 * 单实例锁（2.1.0）。
 *
 * 以前双击快捷方式会起第二个实例，两个实例抢同一份 config.json 和同一批端口扫描。
 * 现在第二个实例直接退出，并把第一个实例的窗口带到前台。
 *
 * 锁的作用域是 userData 目录。开发期的默认 userData 与本机其他 Electron 项目共用，
 * 所以产品里只在打包后启用；harness 用 MILE_FORCE_SINGLE_INSTANCE=1 强开，并把 userData
 * 指到沙箱，不会碰到别的 Electron 程序。
 *
 * 本脚本自己当驱动：先后拉起两个真实 Electron 进程（共用同一个沙箱）。
 *   primary   ：启动、把窗口 hide、写 ready 标记，等 second-done 标记后看窗口是否被带回前台。
 *   secondary ：只是再起一次应用。有锁时它应自己退出（退出码 0）；没锁时它会一直活着，
 *               8 秒后由兜底计时器以退出码 3 结束，驱动据此判红。
 *
 *   npm run build
 *   npx electron scripts/verify-review-single.cjs
 */
const { join } = require('node:path')
const { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const PHASE = process.env.MILE_PHASE
const SANDBOX = process.env.MILE_SANDBOX || join(tmpdir(), `mile-review-single-${process.pid}`)
const READY = join(SANDBOX, 'primary-ready')
const DONE = join(SANDBOX, 'second-done')
const RESULT = join(SANDBOX, 'primary-result.json')

// ───────────────────────── 驱动 ─────────────────────────
if (!PHASE) {
  const { spawn, spawnSync } = require('node:child_process')
  mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
  writeFileSync(
    join(SANDBOX, 'mile-terminal', 'config.json'),
    JSON.stringify({ version: 10, entries: [], groups: [], ignoredListeners: [], groupOverrides: [], watchedKeywords: [],
      settings: { scanIntervalMs: 2000, theme: 'light', externalTerminal: 'wt', terminalFontSize: 13, scrollback: 5000, killOwnedOnQuit: true, closeToTray: false, notifyOnTaskDone: true, hideFromTaskbar: false, notifyOnCrash: true, notifyOnlyWhenBackground: true } }, null, 2),
    'utf8'
  )
  const env = (phase) => ({ ...process.env, MILE_PHASE: phase, MILE_SANDBOX: SANDBOX, MILE_FORCE_SINGLE_INSTANCE: '1' })
  let pass = 0
  let fail = 0
  const check = (name, ok, detail) => {
    ok ? pass++ : fail++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? ` — ${detail}` : ''}`)
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  ;(async () => {
    const primary = spawn(process.execPath, [__filename], { env: env('primary'), stdio: 'ignore' })
    let primaryExit = null
    primary.on('exit', (code) => { primaryExit = code })
    for (let i = 0; i < 200 && !existsSync(READY) && primaryExit === null; i++) await sleep(150)
    check('前提：第一个实例已启动并收起窗口', existsSync(READY))

    const t0 = Date.now()
    const second = spawnSync(process.execPath, [__filename], { env: env('secondary'), encoding: 'utf8', timeout: 30_000 })
    const took = Date.now() - t0
    check('第二个实例自己退出了（退出码 0）', second.status === 0, `退出码 ${second.status}，${took}ms`)
    writeFileSync(DONE, '1', 'utf8')

    for (let i = 0; i < 100 && !existsSync(RESULT) && primaryExit === null; i++) await sleep(150)
    const res = existsSync(RESULT) ? JSON.parse(readFileSync(RESULT, 'utf8')) : null
    check('第一个实例给出了结果', !!res)
    check('第一个实例的窗口被带回前台', res?.visible === true, JSON.stringify(res))
    check('第一个实例仍只有一个窗口', res?.windows === 1, String(res?.windows))
    for (let i = 0; i < 60 && primaryExit === null; i++) await sleep(150)
    if (primaryExit === null) primary.kill()

    console.log(`\n结果：${pass} 通过，${fail} 失败`)
    try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { console.log(`  (沙箱残留：${SANDBOX})`) }
    process.exit(fail === 0 ? 0 : 1)
  })()
  return
}

// ───────────────────────── 实例进程 ─────────────────────────
const { app, BrowserWindow } = require('electron')
// appData 与 userData 都指向沙箱：锁的作用域是 userData，必须在 require 主进程包之前
app.setPath('appData', SANDBOX)
app.setPath('userData', join(SANDBOX, 'user'))

require(join(ROOT, 'out', 'main', 'index.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (PHASE === 'secondary') {
  // 没有锁时应用会一直活着：8 秒后兜底结束，退出码 3 让驱动判红
  setTimeout(() => app.exit(3), 8000)
}

if (PHASE === 'primary') {
  app.whenReady().then(async () => {
    const win = BrowserWindow.getAllWindows()[0]
    await new Promise((r) => win.webContents.once('did-finish-load', r))
    win.hide()
    await sleep(300)
    writeFileSync(READY, '1', 'utf8')
    for (let i = 0; i < 200 && !existsSync(DONE); i++) await sleep(150)
    // 给 second-instance 事件和窗口显示留一点时间
    for (let i = 0; i < 40 && !win.isVisible(); i++) await sleep(100)
    writeFileSync(RESULT, JSON.stringify({ visible: win.isVisible(), windows: BrowserWindow.getAllWindows().length }), 'utf8')
    await sleep(300)
    app.exit(0)
  })
}
