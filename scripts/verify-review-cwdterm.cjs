/**
 * 在条目目录开终端（2.2.0）。
 *
 * 「新建终端」以前只能开在用户主目录。现在 session:create 可以带一个 entryId，
 * 工作目录由主进程从已登记条目解析（path + cwd 子目录），渲染层给不出任何路径：
 *   1. 带 entryId：会话开在该条目的目录；有 cwd 子目录时开在子目录里；标题带条目名。
 *   2. 渲染层另塞 cwd / file 字段照样被丢弃。
 *   3. 未知 entryId、旧配置里 cwd 跳出项目根的条目、目录已不存在的条目：一律拒绝，不回退到别处。
 *   4. 不带 entryId 时仍开在用户主目录（回归）。
 *   5. 服务页行菜单有「在此目录开终端」，点了切到终端页并选中新会话。
 *
 *   npm run build
 *   npx electron scripts/verify-review-cwdterm.cjs
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir, homedir } = require('node:os')

const ROOT = join(__dirname, '..')
const SANDBOX = join(tmpdir(), `mile-review-cwdterm-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)

const PROJ = join(SANDBOX, 'proj')
const SUB = join(PROJ, 'packages', 'web')
mkdirSync(SUB, { recursive: true })
const pkg = JSON.stringify({ name: 'p', scripts: { dev: 'node -e "0"' } })
writeFileSync(join(PROJ, 'package.json'), pkg, 'utf8')
writeFileSync(join(SUB, 'package.json'), pkg, 'utf8')
const GONE = join(SANDBOX, 'gone')

const now = Date.now()
const mk = (id, name, path, extra = {}) => ({
  id, kind: 'service', name, path, framework: 'node', packageManager: 'npm',
  script: 'dev', scripts: { dev: 'node -e "0"' }, env: {}, registerOnly: false, pinned: false,
  order: 0, createdAt: now, ...extra
})
writeFileSync(
  join(SANDBOX, 'mile-terminal', 'config.json'),
  JSON.stringify({
    version: 11,
    entries: [
      mk('root', '根目录项目', PROJ),
      mk('sub', '子包项目', PROJ, { cwd: 'packages/web', order: 1 }),
      // 旧配置里可能留着跳出项目根的 cwd（以前 add 不校验）
      mk('escape', '越界项目', PROJ, { cwd: '..\\..', order: 2 }),
      mk('gone', '已删目录', GONE, { order: 3 })
    ],
    groups: [], ignoredListeners: [], groupOverrides: [], watchedKeywords: [],
    settings: { scanIntervalMs: 2000, theme: 'light', externalTerminal: 'wt', terminalFontSize: 13, scrollback: 5000, killOwnedOnQuit: true, closeToTray: false, notifyOnTaskDone: true, hideFromTaskbar: false, notifyOnCrash: true, notifyOnlyWhenBackground: true, globalHotkey: false }
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
const norm = (p) => String(p || '').replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const create = (input) => js(`window.mile.session.create(${JSON.stringify(input)})
    .then(m => ({ ok: true, cwd: m.cwd, title: m.title, id: m.id }), e => ({ ok: false, error: String(e) }))`)
  const waitFor = async (code, ms = 8000) => {
    for (let t = 0; t < ms; t += 150) { if (await js(code)) return true; await sleep(150) }
    return false
  }

  console.log('\n=== 1. 带 entryId：开在条目目录 ===')
  const r1 = await create({ kind: 'shell', entryId: 'root' })
  check('根目录条目：会话创建成功', r1.ok, JSON.stringify(r1))
  check('工作目录是项目根', norm(r1.cwd) === norm(PROJ), r1.cwd)
  check('标题带条目名', /根目录项目/.test(r1.title || ''), r1.title)
  const r2 = await create({ kind: 'shell', entryId: 'sub' })
  check('有子目录的条目开在子目录里', r2.ok && norm(r2.cwd) === norm(SUB), r2.cwd || r2.error)

  console.log('\n=== 2. 渲染层的路径字段照样丢弃 ===')
  const r3 = await create({ kind: 'shell', entryId: 'root', cwd: 'C:\\', file: 'cmd.exe' })
  check('塞进来的 cwd 不生效', r3.ok && norm(r3.cwd) === norm(PROJ), r3.cwd || r3.error)

  console.log('\n=== 3. 拒绝：不回退到别的目录 ===')
  const r4 = await create({ kind: 'shell', entryId: 'nope' })
  check('未知条目被拒', !r4.ok && /条目不存在/.test(r4.error), r4.error || r4.cwd)
  const r5 = await create({ kind: 'shell', entryId: 'escape' })
  check('cwd 跳出项目根的旧条目被拒', !r5.ok && /不在条目路径/.test(r5.error), r5.error || r5.cwd)
  const r6 = await create({ kind: 'shell', entryId: 'gone' })
  check('目录已不存在的条目被拒', !r6.ok && /目录不存在/.test(r6.error), r6.error || r6.cwd)
  const r7 = await create({ kind: 'shell', entryId: 42 })
  check('非字符串 entryId 被拒', !r7.ok, r7.error || r7.cwd)

  console.log('\n=== 4. 不带 entryId 仍开在主目录 ===')
  const r8 = await create({ kind: 'shell' })
  check('默认工作目录是用户主目录', r8.ok && norm(r8.cwd) === norm(homedir()), r8.cwd || r8.error)

  console.log('\n=== 5. 服务页行菜单 ===')
  await js(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'2',ctrlKey:true,bubbles:true,cancelable:true}));true`)
  await waitFor(`(document.querySelector('main h1')||{}).textContent==='服务'`)
  await waitFor(`!!document.querySelector('.svc-row[data-entry-id="sub"]')`)
  const opened = await js(`(()=>{const r=document.querySelector('.svc-row[data-entry-id="sub"]');const b=r&&[...r.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')||'').includes('更多操作'));if(!b)return false;b.click();return true})()`)
  check('前提：打开了行菜单', opened)
  await waitFor(`!!document.querySelector('[role="menu"]')`)
  const items = await js(`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map(x=>x.textContent.trim())`)
  check('菜单含「在此目录开终端」', items.includes('在此目录开终端'), items.join('、'))
  const before = (await js(`window.mile.session.list()`)).length
  await js(`(()=>{const b=[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find(x=>x.textContent.trim()==='在此目录开终端');b&&b.click();return !!b})()`)
  check('切到了终端页', await waitFor(`(document.querySelector('main h1')||{}).textContent==='终端'`))
  const list = await js(`window.mile.session.list()`)
  check('新建了一个会话', list.length === before + 1, `${before} → ${list.length}`)
  const fresh = list[list.length - 1]
  check('新会话开在子包目录', fresh && norm(fresh.cwd) === norm(SUB), fresh && fresh.cwd)

  await js(`(async()=>{for(const s of await window.mile.session.list())await window.mile.session.stop(s.id).catch(()=>{});return true})()`).catch(() => null)
  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`)
  }
  app.exit(fail === 0 ? 0 : 1)
})
