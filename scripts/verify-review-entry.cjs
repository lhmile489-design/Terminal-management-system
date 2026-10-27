/**
 * entry:add 校形与产物目录读侧（2026-10-27 审查修复）。
 *
 * 1. add 与 edit 同口径：绝对 / 带 .. 的 outputDir、非法框架、不存在的脚本、
 *    不存在的目录一律拒绝，白名单外的键（id、order）静默丢弃。
 * 2. 合法 add 照常成功 —— 不把「全部拒绝」当成安全通过。
 * 3. 读侧兜底：沙箱配置里预置一条旧条目，outputDir 是绝对路径，
 *    entry:outputDir 必须返回 null（它与 knownPath 共用 isSafeRelative）。
 *
 * 不调 shell:openPath —— 那条 IPC 会真的打开文件。
 *
 *   npm run build
 *   npx electron scripts/verify-review-entry.cjs
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const SANDBOX = join(tmpdir(), `mile-review-entry-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)

const FIX = join(ROOT, 'scripts', 'fixture')
// 绝对路径的「产物目录」：一个确实存在的目录，读侧不兜底时 outputDir 会把它原样返回
const OUTSIDE = join(SANDBOX, 'outside')
mkdirSync(OUTSIDE, { recursive: true })

writeFileSync(
  join(SANDBOX, 'mile-terminal', 'config.json'),
  JSON.stringify({
    version: 1,
    entries: [{
      id: 'legacy', kind: 'task', name: '旧条目', path: FIX, framework: 'node', packageManager: 'npm',
      script: null, scripts: {}, env: {}, outputDir: OUTSIDE,
      registerOnly: true, pinned: false, order: 0, createdAt: Date.now()
    }],
    ignoredListeners: [],
    settings: { scanIntervalMs: 2000, theme: 'light', externalTerminal: 'wt', terminalFontSize: 13, scrollback: 5000, killOwnedOnQuit: true, closeToTray: false }
  }, null, 2),
  'utf8'
)

require(join(ROOT, 'out', 'main', 'index.js'))

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

  const base = {
    kind: 'task', name: '审查探针', path: FIX, framework: 'node', packageManager: 'npm',
    script: null, scripts: {}, env: {}, registerOnly: true, pinned: false
  }
  const tryAdd = (extra) => js(`window.mile.entry.add(${JSON.stringify({ ...base, ...extra })})
    .then(e => ({ ok: true, entry: e }), e => ({ ok: false, error: String(e) }))`)

  console.log('\n=== 1. 合法 add 照常成功 ===')
  const good = await tryAdd({ outputDir: 'dist', id: 'forged', order: 99 })
  check('合法条目添加成功', good.ok, good.ok ? good.entry.id : good.error)
  check('渲染层给的 id 被丢弃', good.ok && good.entry.id !== 'forged', good.ok ? good.entry.id : '')
  check('渲染层给的 order 被丢弃', good.ok && good.entry.order !== 99, good.ok ? String(good.entry.order) : '')
  check('相对 outputDir 原样保留', good.ok && good.entry.outputDir === 'dist', good.ok ? good.entry.outputDir : '')

  console.log('\n=== 2. 非法值被拒 ===')
  const cases = [
    ['绝对路径 outputDir', { outputDir: OUTSIDE }, /相对项目根/],
    ['带 .. 的 outputDir', { outputDir: '../..' }, /跳出项目根/],
    ['非法框架', { framework: 'rm-rf' }, /框架非法/],
    ['脚本不在 scripts 里', { script: 'dev', scripts: {} }, /不在该项目的 scripts/],
    ['脚本名含 shell 元字符', { script: 'a&calc', scripts: { 'a&calc': 'x' } }, /非法字符/],
    ['目录不存在', { path: join(SANDBOX, 'nope') }, /目录不存在/],
    ['相对路径的项目目录', { path: 'relative/dir' }, /绝对路径/]
  ]
  for (const [label, extra, re] of cases) {
    const r = await tryAdd(extra)
    // 要求是「因为这个原因」被拒，而不是别的错误碰巧让它失败
    check(`${label}被拒`, !r.ok && re.test(r.error), r.ok ? '竟然添加成功' : r.error)
  }

  const list = await js(`window.mile.entry.list()`)
  check('被拒的请求一条都没落盘', list.length === 2, `${list.length} 条（旧条目 + 合法探针）`)

  console.log('\n=== 3. 旧配置里的绝对 outputDir 读侧不认 ===')
  const legacy = list.find((e) => e.id === 'legacy')
  check('前提：旧条目确实带着绝对 outputDir', !!legacy && legacy.outputDir === OUTSIDE, legacy?.outputDir)
  const dir = await js(`window.mile.entry.outputDir('legacy')`)
  check('entry:outputDir 不返回绝对路径', dir === null, String(dir))

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`)
  }
  app.exit(fail === 0 ? 0 : 1)
})
