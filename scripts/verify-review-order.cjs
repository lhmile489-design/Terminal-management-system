/**
 * 整组按依赖顺序启动（2.3.0）。
 *
 * 以前「全部启动」把组里所有服务同时拉起，前端往往比后端先起来。现在条目可以配
 * startAfter（先等哪些服务），整组启动时主进程按层启动：上一层都进入「运行中」
 * （捕获到端口，或 60 秒没报端口后按端口未知转运行中）才起下一层。
 *   1. 配置版本升到 12，旧配置迁移上来。
 *   2. startAfter 校验：不能指向自己、不能指向不存在的条目、不能成环、必须是字符串数组。
 *   3. 后端先进入运行中，前端才开始预检（看运行态广播的先后）。
 *   4. 前置被预检拦下时，依赖它的条目不启动，结果里写明原因。
 *   5. 没配 startAfter 的组仍然一起启动（回归）。
 *   6. 配置标签里有「先等待」的勾选列表，只列同组的其他服务。
 *
 *   npm run build
 *   npx electron scripts/verify-review-order.cjs
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const FIX = join(ROOT, 'scripts', 'fixture').replace(/\\/g, '/')
const SANDBOX = join(tmpdir(), `mile-review-order-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)
const CONFIG = join(SANDBOX, 'mile-terminal', 'config.json')
const CONFIG_VERSION = Number(/CONFIG_VERSION\s*=\s*(\d+)/.exec(readFileSync(join(ROOT, 'src/shared/types.ts'), 'utf8'))[1])

const now = Date.now()
const mk = (id, name, order, groupId, extra = {}) => ({
  id, kind: 'service', name, path: FIX, framework: 'node', packageManager: 'npm',
  script: 'dev', scripts: { dev: 'node server.cjs' }, env: {}, registerOnly: false, pinned: false,
  order, createdAt: now, groupId, ...extra
})
writeFileSync(CONFIG, JSON.stringify({
  version: 11,
  entries: [
    mk('back', '后端', 0, 'g1'),
    mk('front', '前端', 1, 'g1'),
    mk('solo1', '独立甲', 2, 'g2'),
    mk('solo2', '独立乙', 3, 'g2'),
    // 预检必挂：目录不存在
    mk('badback', '坏后端', 4, 'g3', { path: join(SANDBOX, 'no-such').replace(/\\/g, '/') }),
    mk('front2', '依赖坏后端的前端', 5, 'g3')
  ],
  groups: [
    { id: 'g1', name: '有序组', description: '', env: 'dev', order: 0, createdAt: now },
    { id: 'g2', name: '无序组', description: '', env: 'dev', order: 1, createdAt: now },
    { id: 'g3', name: '前置失败组', description: '', env: 'dev', order: 2, createdAt: now }
  ],
  ignoredListeners: [], groupOverrides: [], watchedKeywords: [],
  settings: { scanIntervalMs: 2000, theme: 'light', externalTerminal: 'wt', terminalFontSize: 13, scrollback: 5000, killOwnedOnQuit: true, closeToTray: false, notifyOnTaskDone: false, hideFromTaskbar: false, notifyOnCrash: false, notifyOnlyWhenBackground: true, globalHotkey: false }
}, null, 2), 'utf8')

require(join(ROOT, 'out', 'main', 'index.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(name, ok, detail) {
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? ` — ${detail}` : ''}`)
}

app.whenReady().then(async () => {
  const guard = setTimeout(() => { console.log('HARNESS TIMEOUT'); console.log(`\n结果：${pass} 通过，${fail + 1} 失败`); app.exit(1) }, 170_000)
  const win = BrowserWindow.getAllWindows()[0]
  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r))
    win.setBounds({ width: 1500, height: 940 })
    const js = (code) => win.webContents.executeJavaScript(code, true)
    const waitFor = async (code, ms = 10000) => {
      for (let t = 0; t < ms; t += 200) { if (await js(code)) return true; await sleep(200) }
      return false
    }
    // 记录运行态广播的先后：谁先「运行中」、谁什么时候开始预检
    const events = []
    const realSend = win.webContents.send.bind(win.webContents)
    win.webContents.send = (channel, ...args) => {
      if (channel === 'entry:runtimeChanged') events.push({ id: args[0].entryId, status: args[0].status })
      return realSend(channel, ...args)
    }
    const firstIdx = (id, status) => events.findIndex((e) => e.id === id && e.status === status)
    await waitFor(`!!document.querySelector('nav[aria-label="主导航"]')`, 30000)

    console.log('\n=== 1. 迁移 ===')
    const disk = () => JSON.parse(readFileSync(CONFIG, 'utf8'))

    console.log('\n=== 2. startAfter 校验 ===')
    const edit = (id, patch) => js(`window.mile.entry.edit(${JSON.stringify(id)}, ${JSON.stringify(patch)}).then(() => 'ok', e => String(e))`)
    check('不能指向自己', (await edit('front', { startAfter: ['front'] })) !== 'ok')
    check('不能指向不存在的条目', (await edit('front', { startAfter: ['nope'] })) !== 'ok')
    check('不是字符串数组被拒', (await edit('front', { startAfter: 'back' })) !== 'ok')
    check('合法设置成功', (await edit('front', { startAfter: ['back'] })) === 'ok')
    const cyc = await edit('back', { startAfter: ['front'] })
    check('成环被拒', cyc !== 'ok' && /环/.test(cyc), cyc)
    check('落盘只有合法那一条', JSON.stringify(disk().entries.find((e) => e.id === 'front').startAfter) === '["back"]' && !disk().entries.find((e) => e.id === 'back').startAfter)
    check('前置失败组也配上', (await edit('front2', { startAfter: ['badback'] })) === 'ok')
    check('null 清空', (await edit('solo2', { startAfter: ['solo1'] })) === 'ok' && (await edit('solo2', { startAfter: null })) === 'ok' && !disk().entries.find((e) => e.id === 'solo2').startAfter)
    // 启动时只在内存迁移，下一次写入才落盘新版本号（同 m9），所以放在编辑之后量
    check(`配置版本升到 ${CONFIG_VERSION}`, disk().version === CONFIG_VERSION && CONFIG_VERSION >= 12, String(disk().version))

    console.log('\n=== 3. 有序组：后端运行中之后前端才开始 ===')
    const r1 = await js(`window.mile.entry.startOrdered(['front','back'])`)
    check('两个都启动了', r1 && r1.length === 2 && r1.every((x) => x.ok), JSON.stringify(r1))
    const backRun = firstIdx('back', 'running')
    const frontPre = firstIdx('front', 'precheck')
    check('后端先进入运行中', backRun >= 0, String(backRun))
    check('前端在后端运行中之后才开始预检', frontPre > backRun, `back running @${backRun}, front precheck @${frontPre}`)
    check('前端最终也在运行', await waitFor(`window.mile.entry.runtimes().then(r=>(r.find(x=>x.entryId==='front')||{}).status==='running')`, 30000))

    console.log('\n=== 4. 前置被拦：依赖它的不启动 ===')
    events.length = 0
    const r2 = await js(`window.mile.entry.startOrdered(['badback','front2'])`)
    const rb = r2 && r2.find((x) => x.id === 'badback')
    const rf = r2 && r2.find((x) => x.id === 'front2')
    check('坏后端被预检拦下', rb && !rb.ok && !!rb.precheck, JSON.stringify(rb))
    check('依赖它的前端没启动，写明原因', rf && !rf.ok && /坏后端/.test(rf.skipped || ''), JSON.stringify(rf))
    check('前端一次预检都没走', firstIdx('front2', 'precheck') === -1)

    console.log('\n=== 5. 无序组仍一起启动 ===')
    events.length = 0
    const r3 = await js(`window.mile.entry.startOrdered(['solo1','solo2'])`)
    check('两个都启动了', r3 && r3.every((x) => x.ok), JSON.stringify(r3))
    const p1 = firstIdx('solo1', 'precheck')
    const p2 = firstIdx('solo2', 'precheck')
    const run1 = firstIdx('solo1', 'running')
    check('第二个没等第一个运行中就开始', p2 >= 0 && (run1 === -1 || p2 < run1), `solo1 precheck @${p1}, solo2 precheck @${p2}, solo1 running @${run1}`)

    console.log('\n=== 6. 配置标签里的「先等待」 ===')
    await js(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'2',ctrlKey:true,bubbles:true,cancelable:true}));true`)
    await waitFor(`(document.querySelector('main h1')||{}).textContent==='服务'`)
    await js(`document.querySelector('.svc-row[data-entry-id="front"]').click();true`)
    await waitFor(`!!document.querySelector('.svc-detail')`)
    await js(`(()=>{const t=[...document.querySelectorAll('.svc-detail [role="tab"]')].find(x=>x.textContent.includes('配置'));t&&t.click();return true})()`)
    await sleep(400)
    await js(`(()=>{const a=document.querySelector('details.svc-adv');if(a)a.open=true;return true})()`)
    check('有「先等待」列表', await waitFor(`!!document.querySelector('[data-start-after]')`, 4000))
    const opts = await js(`[...document.querySelectorAll('[data-start-after] input[type=checkbox]')].map(i=>({id:i.dataset.startAfterId,checked:i.checked}))`)
    check('只列同组的其他服务', opts.length === 1 && opts[0].id === 'back', JSON.stringify(opts))
    check('已配的勾着', opts[0] && opts[0].checked === true)

    await js(`(async()=>{for(const id of ['back','front','solo1','solo2'])await window.mile.entry.stop(id).catch(()=>{});return true})()`)
    await sleep(2500)
  } catch (err) {
    console.log('HARNESS ERROR', err)
    fail++
  }
  clearTimeout(guard)
  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`) }
  app.exit(fail === 0 ? 0 : 1)
})
