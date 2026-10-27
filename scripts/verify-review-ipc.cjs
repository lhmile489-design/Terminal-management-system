/**
 * IPC 边界校验（2026-10-27 审查修复）。
 *
 * 1. session:create 只能开固定 shell：渲染层塞进来的 file / args / cwd / env 一律丢弃。
 *    先要求合法请求成功，再看恶意字段有没有生效 —— 不把「直接拒绝」当成安全通过。
 * 2. 环境变量不泄漏：向返回的 shell 回显 $env:MILE_REVIEW，输出里不能出现探针值。
 * 3. 顶层导航被拦：渲染层改 location 后仍停在应用页面。否则远端页面会再挂一次
 *    preload，拿到完整的 window.mile。
 *
 * 探针只用系统 cmd 的 `exit 0`，不建文件、不执行项目代码。
 *
 *   npm run build
 *   npx electron scripts/verify-review-ipc.cjs
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir, homedir } = require('node:os')
const { pathToFileURL } = require('node:url')

const ROOT = join(__dirname, '..')
const SANDBOX = join(tmpdir(), `mile-review-ipc-${process.pid}`)
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

const MARKER = 'MILE_IPC_MUST_NOT_LEAK'
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
  const appUrl = win.webContents.getURL()

  console.log('\n=== 1. session:create 丢弃渲染层的命令字段 ===')
  const probe = await js(`window.mile.session.create({
    kind: 'shell', file: 'cmd.exe', args: ['/d', '/s', '/c', 'exit 0'],
    cwd: 'C:\\\\', env: { MILE_REVIEW: ${JSON.stringify(MARKER)} }, title: 'probe'
  }).then(m => ({ ok: true, id: m.id, command: m.command, cwd: m.cwd }), e => ({ ok: false, error: String(e) }))`)
  const serialized = JSON.stringify(probe)
  check('带恶意字段的请求仍成功开出会话', probe.ok === true, serialized)
  check('可执行文件是固定 shell，不是渲染层给的 cmd.exe',
    probe.ok && /powershell|pwsh/i.test(probe.command) && !/cmd\.exe|exit 0/i.test(probe.command), probe.command)
  check('工作目录是用户主目录，不是渲染层给的 C:\\',
    probe.ok && String(probe.cwd).toLowerCase() === homedir().toLowerCase(), probe.cwd)

  console.log('\n=== 2. 渲染层的 env 没有进入会话 ===')
  if (probe.ok) {
    // 等 chcp / Clear-Host 跑完，再回显；BEGIN/END 夹住的才是 $env 的值
    await sleep(1500)
    await js(`window.mile.session.write(${JSON.stringify(probe.id)}, '[Console]::WriteLine("BEGIN[" + $env:MILE_REVIEW + "]END")\\r');true`)
    let history = ''
    for (let i = 0; i < 60; i++) {
      history = await js(`window.mile.session.history(${JSON.stringify(probe.id)})`)
      // 命令回显本身也含 BEGIN[，要等到真正的输出行 BEGIN[...]END
      if (/BEGIN\[[^"\]]*\]END/.test(history)) break
      await sleep(250)
    }
    const hit = /BEGIN\[([^"\]]*)\]END/.exec(history)
    check('回显已出现（证明探针真的跑到了）', !!hit, hit ? hit[0] : '超时')
    check('探针值不在会话输出里', !!hit && !history.includes(MARKER), hit ? `值=「${hit[1]}」` : '无输出')
  } else {
    check('回显已出现（证明探针真的跑到了）', false, '会话未创建')
  }

  console.log('\n=== 3. 合法请求照常可用 ===')
  const legit = await js(`window.mile.session.create({ kind: 'shell', title: 'PowerShell' })
    .then(m => ({ ok: true, command: m.command }), e => ({ ok: false, error: String(e) }))`)
  check('{ kind: shell } 开出固定 shell', legit.ok && /powershell|pwsh/i.test(legit.command), JSON.stringify(legit))
  const badKind = await js(`window.mile.session.create({ kind: 'dev' })
    .then(() => 'created', e => String(e))`)
  check('kind 不是 shell 时拒绝', /只允许 shell/.test(badKind), badKind)

  console.log('\n=== 3b. 非主窗口的 IPC 被拒 ===')
  // 同一个 preload 挂到第二个窗口上：window.mile 存在，但主进程应拒绝它的请求
  const second = new BrowserWindow({
    show: false,
    webPreferences: { preload: join(ROOT, 'out', 'preload', 'index.js'), contextIsolation: true, sandbox: true }
  })
  await second.loadURL('about:blank')
  const secondHasApi = await second.webContents.executeJavaScript(`typeof window.mile?.session?.create === 'function'`, true)
  check('第二窗口确实拿到了 window.mile（前提成立）', secondHasApi === true, String(secondHasApi))
  const secondRes = await second.webContents.executeJavaScript(
    `window.mile.session.create({ kind: 'shell' }).then(() => 'created', e => String(e))`, true)
  check('第二窗口创建会话被拒', /拒绝非主窗口/.test(secondRes), secondRes)
  second.destroy()

  console.log('\n=== 4. 顶层导航被拦 ===')
  // 不用 data: —— Chromium 自己就拦渲染层发起的 data: 顶层导航，那样量不到 will-navigate 守卫。
  // file → file 的跳转 Chromium 放行，没有守卫时会真的离开应用页面。
  const probePage = join(SANDBOX, 'probe.html')
  writeFileSync(probePage, '<!doctype html><title>probe</title>', 'utf8')
  const probeUrl = pathToFileURL(probePage).href
  await js(`location.href = ${JSON.stringify(probeUrl)};true`).catch(() => null)
  await sleep(1500)
  const after = win.webContents.getURL()
  check('改 location 后仍停在应用页面', after === appUrl, after.slice(0, 80))
  if (after !== appUrl) {
    // 红运行时把页面拉回来，后续清理才有 window.mile 可用
    await win.loadURL(appUrl).catch(() => null)
    await sleep(1500)
  }
  check('window.mile 仍可用', await js(`typeof window.mile?.session?.list === 'function'`).catch(() => false))

  await js(`(async()=>{for(const s of await window.mile.session.list())await window.mile.session.stop(s.id).catch(()=>{});return true})()`).catch(() => null)

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`)
  }
  app.exit(fail === 0 ? 0 : 1)
})
