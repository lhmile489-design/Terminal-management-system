/**
 * 采集失败的收口（2026-10-27 审查修复）。
 *
 * ScannerService.tick() 的 catch 以前先 emit('error')。主进程没挂 'error' 监听器，
 * EventEmitter 会同步抛出，publishFailure() 跑不到，界面一直显示旧数据；异常再变成
 * void tick() 上未处理的 rejection。
 *
 * 做法：在 require 主进程包之前拦截 node:child_process，按开关让 netstat.exe 失败。
 * 拦截只换「netstat 这一次返回什么」，采集、发布、IPC 全走真实实现。
 *
 *   npm run build
 *   npx electron scripts/verify-review-scanner.cjs
 */
const Module = require('node:module')
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const SANDBOX = join(tmpdir(), `mile-review-scanner-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)
writeFileSync(
  join(SANDBOX, 'mile-terminal', 'config.json'),
  JSON.stringify({
    version: 1,
    entries: [],
    ignoredListeners: [],
    settings: { scanIntervalMs: 1000, theme: 'light', externalTerminal: 'wt', terminalFontSize: 13, scrollback: 5000, killOwnedOnQuit: true, closeToTray: false }
  }, null, 2),
  'utf8'
)

/** 开关：为真时 netstat.exe 立即以错误回调 */
let failNetstat = false
let netstatCalls = 0
const realLoad = Module._load
Module._load = function (request, ...rest) {
  const mod = realLoad.call(this, request, ...rest)
  if (request !== 'node:child_process' && request !== 'child_process') return mod
  return new Proxy(mod, {
    get(target, key) {
      if (key !== 'execFile') return Reflect.get(target, key)
      return function (file, ...args) {
        if (/netstat\.exe$/i.test(String(file))) {
          netstatCalls++
          if (failNetstat) {
            const cb = args.find((a) => typeof a === 'function')
            setImmediate(() => cb(new Error('探针：netstat 被拦截失败')))
            return { kill() {}, on() {} }
          }
        }
        return target.execFile(file, ...args)
      }
    }
  })
}

const rejections = []
process.on('unhandledRejection', (reason) => rejections.push(String(reason)))
const uncaught = []
process.on('uncaughtException', (err) => uncaught.push(String(err)))

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

  // 记录主进程推给窗口的采集增量，只看 scanner:diff
  const diffs = []
  const realSend = win.webContents.send.bind(win.webContents)
  win.webContents.send = (channel, ...args) => {
    if (channel === 'scanner:diff') diffs.push(args[0])
    return realSend(channel, ...args)
  }

  console.log('\n=== 1. 前提：正常采集在跑，探针挂上了 ===')
  for (let i = 0; i < 60 && !diffs.some((d) => !d.failed); i++) await sleep(250)
  check('拦截器确实看到了 netstat 调用', netstatCalls > 0, `${netstatCalls} 次`)
  check('正常时推送过成功的采集', diffs.some((d) => !d.failed), `${diffs.length} 条`)

  console.log('\n=== 2. netstat 失败时界面收到 failed ===')
  const before = diffs.length
  const callsBefore = netstatCalls
  failNetstat = true
  for (let i = 0; i < 40 && !diffs.slice(before).some((d) => d.failed); i++) await sleep(250)
  const failedDiffs = diffs.slice(before).filter((d) => d.failed)
  check('失败期间确实又调用了 netstat（前提成立）', netstatCalls > callsBefore, `${netstatCalls - callsBefore} 次`)
  check('推送了 failed: true 的增量', failedDiffs.length > 0, `${failedDiffs.length} 条`)
  check('没有未处理的 rejection', rejections.length === 0, rejections.join(' | ') || '无')
  check('没有未捕获的异常', uncaught.length === 0, uncaught.join(' | ') || '无')

  console.log('\n=== 3. 恢复后采集继续 ===')
  failNetstat = false
  const after = diffs.length
  for (let i = 0; i < 40 && !diffs.slice(after).some((d) => !d.failed); i++) await sleep(250)
  check('netstat 恢复后又推送成功的采集（调度没断）', diffs.slice(after).some((d) => !d.failed))

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`)
  }
  app.exit(fail === 0 ? 0 : 1)
})
