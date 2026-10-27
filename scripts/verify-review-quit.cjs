/**
 * 退出清理校验（2026-10-27 审查修复）。
 *
 * killOwnedOnQuit 开着时，app.quit() 必须等受控进程树真正结束再退出。
 * 以前 before-quit 同步调 disposeAll() 就返回，taskkill 还没跑应用就没了，
 * 会话里拉起的子进程会留在后台。
 *
 * 做法：开一个固定 shell，让它跑 `ping -n 120 127.0.0.1`（系统命令，不执行项目代码），
 * 记下 shell 根 PID 与 ping 子进程 PID，然后 app.quit()。在 will-quit 里同步查
 * 两个 PID 是否还活着 —— will-quit 只在 before-quit 放行之后才触发。
 *
 *   npm run build
 *   npx electron scripts/verify-review-quit.cjs
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { execFileSync } = require('node:child_process')

const ROOT = join(__dirname, '..')
const SANDBOX = join(tmpdir(), `mile-review-quit-${process.pid}`)
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(name, ok, detail) {
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? ` — ${detail}` : ''}`)
}

function alive(pid) {
  try {
    const out = execFileSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true })
    return out.includes(`"${pid}"`)
  } catch {
    return false
  }
}

function childPids(parent) {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${parent}" | ForEach-Object { "$($_.ProcessId):$($_.Name)" }`],
      { encoding: 'utf8', windowsHide: true })
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const [pid, name] = l.split(':')
      return { pid: Number(pid), name }
    })
  } catch {
    return []
  }
}

let rootPid = 0
let pingPid = 0

app.on('will-quit', (e) => {
  e.preventDefault()
  console.log('\n=== 2. will-quit 时进程树已结束 ===')
  check('shell 根进程已结束', !alive(rootPid), `pid=${rootPid}`)
  check('shell 拉起的 ping 已结束（树终止生效）', !alive(pingPid), `pid=${pingPid}`)
  // 红运行时清掉残留，别让 ping 在后台挂两分钟
  for (const pid of [pingPid, rootPid]) {
    if (pid && alive(pid)) {
      try { execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }) } catch { /* 已结束 */ }
    }
  }
  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`)
  }
  app.exit(fail === 0 ? 0 : 1)
})

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  const js = (code) => win.webContents.executeJavaScript(code, true)

  console.log('\n=== 1. 前提：会话里确实跑着子进程 ===')
  const meta = await js(`window.mile.session.create({ kind: 'shell', title: 'quit-probe' })`)
  rootPid = meta.pid
  // 等 chcp 那一行跑完再发命令
  await sleep(1500)
  await js(`window.mile.session.write(${JSON.stringify(meta.id)}, 'ping -n 120 127.0.0.1\\r'); true`)

  for (let i = 0; i < 40 && !pingPid; i++) {
    await sleep(250)
    const kids = childPids(rootPid)
    const ping = kids.find((k) => /^ping/i.test(k.name))
    if (ping) pingPid = ping.pid
  }
  check('shell 根进程在运行', alive(rootPid), `pid=${rootPid}`)
  check('找到了 shell 拉起的 ping 子进程', pingPid > 0 && alive(pingPid), `pid=${pingPid}`)
  if (!pingPid) {
    // 前提不成立时后面的「已结束」会空过，直接判失败退出
    console.log(`\n结果：${pass} 通过，${fail} 失败`)
    app.exit(1)
    return
  }

  app.quit()
})
