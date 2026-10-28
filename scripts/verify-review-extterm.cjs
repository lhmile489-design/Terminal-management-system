/**
 * 外部终端联动（2.2.0）。
 *
 * 设置里的 externalTerminal（wt / pwsh / powershell / cmd / gitbash）以前没有任何代码读它。
 * 现在服务行菜单有「在外部终端打开」，用选中的终端打开该条目的目录。这里验：
 *   1. 渲染层只给 entryId；目录由主进程按登记条目解析（有子目录开子目录），塞进来的 cwd 不生效。
 *   2. 拉起方式是 `cmd /d /c start "标题" <终端> <固定参数>`，命令行里没有任何条目路径或用户字符串，
 *      目录只走 spawn 的 cwd 选项。
 *   3. 未知条目、cwd 跳出项目根的旧条目、目录已不存在：一律拒绝，不回退。
 *   4. 切换设置后用的是新选的终端。
 *   5. 服务页行菜单有「在外部终端打开」。
 *
 * 在 require 主进程包之前拦截 child_process.spawn：只拦「cmd ... start」这一种调用，记录后返回假进程，
 * 不真的弹窗口；其余 spawn 照常。
 *
 *   npm run build
 *   npx electron scripts/verify-review-extterm.cjs
 */
const Module = require('node:module')
const { EventEmitter } = require('node:events')

const launches = []
const realLoad = Module._load
Module._load = function (request, ...rest) {
  const mod = realLoad.call(this, request, ...rest)
  if (request !== 'node:child_process' && request !== 'child_process') return mod
  return new Proxy(mod, {
    get(target, key) {
      if (key !== 'spawn') return Reflect.get(target, key)
      return function (file, args, opts) {
        if (Array.isArray(args) && args.includes('start') && /cmd\.exe$/i.test(String(file))) {
          launches.push({ file, args: [...args], cwd: opts && opts.cwd })
          const fake = new EventEmitter()
          fake.unref = () => undefined
          fake.pid = 0
          return fake
        }
        return target.spawn(file, args, opts)
      }
    }
  })
}

const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const SANDBOX = join(tmpdir(), `mile-review-extterm-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)

const PROJ = join(SANDBOX, 'proj & co')
mkdirSync(join(PROJ, 'packages', 'web'), { recursive: true })
writeFileSync(join(PROJ, 'package.json'), JSON.stringify({ name: 'p', scripts: { dev: 'node -e 0' } }), 'utf8')
const now = Date.now()
const mk = (id, name, path, extra = {}) => ({
  id, kind: 'service', name, path, framework: 'node', packageManager: 'npm',
  script: 'dev', scripts: { dev: 'node -e 0' }, env: {}, registerOnly: false, pinned: false,
  order: 0, createdAt: now, ...extra
})
writeFileSync(
  join(SANDBOX, 'mile-terminal', 'config.json'),
  JSON.stringify({
    version: 11,
    entries: [
      mk('root', '根目录项目', PROJ),
      { ...mk('sub', '子包项目', PROJ, { cwd: 'packages/web' }), order: 1 },
      // 旧配置里的越界 cwd 与已删除目录，绕过 sanitizeEdit 直接写进配置
      { ...mk('escape', '越界项目', PROJ, { cwd: '..' }), order: 2 },
      { ...mk('gone', '已删除项目', join(SANDBOX, 'gone')), order: 3 }
    ],
    groups: [], ignoredListeners: [], groupOverrides: [], watchedKeywords: [],
    settings: { scanIntervalMs: 2000, theme: 'light', externalTerminal: 'cmd', terminalFontSize: 13, scrollback: 5000, killOwnedOnQuit: true, closeToTray: false, notifyOnTaskDone: true, hideFromTaskbar: false, notifyOnCrash: true, notifyOnlyWhenBackground: true, globalHotkey: false }
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
const same = (a, b) => String(a || '').replace(/[\\/]+$/, '').toLowerCase() === String(b || '').replace(/[\\/]+$/, '').toLowerCase()

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const waitFor = async (code, ms = 8000) => {
    for (let t = 0; t < ms; t += 150) { if (await js(code)) return true; await sleep(150) }
    return false
  }
  const open = (id, extra) => js(`(window.mile.entry.openExternalTerminal
      ? window.mile.entry.openExternalTerminal(${JSON.stringify(id)}${extra ? ', ' + JSON.stringify(extra) : ''})
      : Promise.reject(new Error('没有 openExternalTerminal')))
    .then(() => 'ok', e => String(e))`)

  console.log('\n=== 1. 打开条目目录 ===')
  const before = launches.length
  const r1 = await open('root', { cwd: 'C:\\' })
  check('打开成功', r1 === 'ok', r1)
  const l1 = launches[before]
  check('拉起了一次', launches.length === before + 1, `${launches.length - before} 次`)
  check('工作目录是项目根（塞进来的 cwd 不生效）', l1 && same(l1.cwd, PROJ), l1 && l1.cwd)
  check('经 cmd start 拉起', l1 && l1.args.slice(0, 3).join(' ') === '/d /c start', l1 && l1.args.join(' '))
  check('用的是设置里选的 CMD', l1 && /cmd\.exe$/i.test(l1.args[4] || ''), l1 && l1.args[4])
  check('命令行里没有条目路径', l1 && !l1.args.some((a) => /proj/i.test(a)), l1 && l1.args.join(' | '))
  const r2 = await open('sub')
  const l2 = launches[launches.length - 1]
  check('有子目录的条目开在子目录', r2 === 'ok' && same(l2.cwd, join(PROJ, 'packages', 'web')), l2 && l2.cwd)

  console.log('\n=== 2. 拒绝 ===')
  const n = launches.length
  const bad = [['nope', '未知条目'], ['escape', 'cwd 跳出项目根'], ['gone', '目录已不存在']]
  for (const [id, label] of bad) {
    const r = await open(id)
    check(`${label}被拒`, r !== 'ok', r)
  }
  const r7 = await js(`(window.mile.entry.openExternalTerminal ? window.mile.entry.openExternalTerminal(42) : Promise.reject(new Error('无'))).then(() => 'ok', e => String(e))`)
  check('非字符串 id 被拒', r7 !== 'ok', r7)
  check('被拒时一次都没拉起', launches.length === n, `${launches.length - n} 次`)

  console.log('\n=== 3. 换终端 ===')
  await js(`window.mile.settings.patch({ externalTerminal: 'powershell' })`)
  const r8 = await open('root')
  const l8 = launches[launches.length - 1]
  check('换成 PowerShell 后用 powershell.exe', r8 === 'ok' && /powershell\.exe$/i.test(l8.args[4] || ''), l8 && l8.args[4])
  check('PowerShell 带 -NoExit', l8 && l8.args.includes('-NoExit'))

  console.log('\n=== 4. 服务行菜单 ===')
  await js(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'2',ctrlKey:true,bubbles:true,cancelable:true}));true`)
  await waitFor(`(document.querySelector('main h1')||{}).textContent==='服务'`)
  await waitFor(`!!document.querySelector('.svc-row[data-entry-id="root"]')`)
  await js(`(()=>{const r=document.querySelector('.svc-row[data-entry-id="root"]');const b=[...r.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')||'').includes('更多操作'));b&&b.click();return !!b})()`)
  check('前提：打开了行菜单', await waitFor(`!!document.querySelector('[role="menu"]')`))
  const items = await js(`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map(x=>x.textContent.trim())`)
  check('菜单含「在外部终端打开」', items.includes('在外部终端打开'), items.join('、'))
  const n2 = launches.length
  await js(`(()=>{const b=[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find(x=>x.textContent.trim()==='在外部终端打开');b&&b.click();return !!b})()`)
  for (let i = 0; i < 30 && launches.length === n2; i++) await sleep(150)
  check('点菜单拉起了外部终端', launches.length === n2 + 1 && same(launches[launches.length - 1].cwd, PROJ), `${launches.length - n2} 次`)

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`) }
  app.exit(fail === 0 ? 0 : 1)
})
