/**
 * 启动顺序视图（PRD-FEATURE-UPGRADE P1-5）。
 *
 *   1. 工作组 g1 里 A ← B ← C：3 个节点、2 条连线、3 批。
 *   2. 没有任何「先等待」的工作组 g2 不画。
 *   3. 把 C 改成先等 A：连线随 entry:changed 广播更新，变成 2 批。
 *   4. 键盘：方向键在节点间移焦点，Enter 打开详情；节点不启停条目。
 *
 * 只展示，不启动任何条目，所以夹具目录不需要真的能跑。
 *
 *   npm run build
 *   npx electron scripts/verify-topology.cjs
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const CONFIG_VERSION = Number(/CONFIG_VERSION = (\d+)/.exec(readFileSync(join(ROOT, 'src/shared/types.ts'), 'utf8'))[1])
const SANDBOX = join(tmpdir(), `mile-verify-topology-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)
const CONFIG = join(SANDBOX, 'mile-terminal', 'config.json')

const dir = (name) => {
  const d = join(SANDBOX, name)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name, version: '1.0.0', scripts: { dev: 'node -e 0' } }), 'utf8')
  return d.replace(/\\/g, '/')
}
const entry = (id, name, groupId, order, startAfter) => ({
  id, kind: 'service', name, path: dir(id), framework: 'node', packageManager: 'npm',
  script: 'dev', scripts: { dev: 'node -e 0' }, env: {}, registerOnly: false, pinned: false,
  order, createdAt: Date.now(), groupId, ...(startAfter ? { startAfter } : {})
})

writeFileSync(CONFIG, JSON.stringify({
  version: CONFIG_VERSION,
  entries: [
    entry('a', '顺序甲', 'g1', 0),
    entry('b', '顺序乙', 'g1', 1, ['a']),
    entry('c', '顺序丙', 'g1', 2, ['b']),
    entry('d', '无依赖丁', 'g2', 3)
  ],
  groups: [
    { id: 'g1', name: '顺序组', env: 'dev', createdAt: Date.now(), order: 0 },
    { id: 'g2', name: '平铺组', env: 'dev', createdAt: Date.now(), order: 1 }
  ],
  ignoredListeners: [], groupOverrides: [], watchedKeywords: [],
  settings: {
    scanIntervalMs: 2000, theme: 'light', externalTerminal: 'wt', terminalFontSize: 13, scrollback: 5000,
    killOwnedOnQuit: true, closeToTray: false, notifyOnTaskDone: false, hideFromTaskbar: false,
    notifyOnCrash: false, notifyOnlyWhenBackground: true, globalHotkey: false, loginShellPath: false
  }
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
  const guard = setTimeout(() => { console.log('  FAIL  超时'); console.log(`\n结果：${pass} 通过，${fail + 1} 失败`); app.exit(1) }, 120000)
  const win = BrowserWindow.getAllWindows()[0]
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const waitFor = async (code, ms = 10000) => {
    for (let t = 0; t < ms; t += 200) { if (await js(code)) return true; await sleep(200) }
    return false
  }
  const G1 = `[data-start-order-group="g1"]`
  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r))
    win.setBounds({ width: 1500, height: 940 })
    await waitFor(`!!document.querySelector('nav[aria-label="主导航"]')`, 30000)
    await js(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'2',ctrlKey:true,bubbles:true,cancelable:true}));true`)
    await waitFor(`(document.querySelector('main h1')||{}).textContent==='服务'`)

    console.log('\n=== 1. A ← B ← C ===')
    check('有启动顺序面板', await waitFor(`!!document.querySelector('[data-start-order]')`, 8000))
    check('面板默认展开（不到 30 个节点）', await js(`document.querySelector('.start-order-toggle').getAttribute('aria-expanded')==='true'`))
    const nodes = await js(`[...document.querySelectorAll('${G1} [data-start-node]')].map(n=>n.dataset.startNode+':'+n.dataset.col)`)
    check('节点 3/3', nodes.length === 3, JSON.stringify(nodes))
    check('分层：甲 0、乙 1、丙 2', JSON.stringify([...nodes].sort()) === '["a:0","b:1","c:2"]', JSON.stringify(nodes))
    const edges = await js(`[...document.querySelectorAll('${G1} [data-start-edge]')].map(e=>e.dataset.startEdge).sort()`)
    check('连线 2 条：a->b、b->c', JSON.stringify(edges) === '["a->b","b->c"]', JSON.stringify(edges))
    check('分 3 批', await js(`document.querySelector('${G1} svg').dataset.cols==='3'`))

    console.log('\n=== 2. 没有先等待的工作组不画 ===')
    check('平铺组不出现', await js(`!document.querySelector('[data-start-order-group="g2"]')`))
    check('面板里没有丁', await js(`!document.querySelector('[data-start-node="d"]')`))

    console.log('\n=== 3. 改 startAfter 后随广播更新 ===')
    const edited = await js(`window.mile.entry.edit('c',{startAfter:['a']}).then(()=>'ok',e=>String(e))`)
    check('前提：编辑成功', edited === 'ok', edited)
    check('连线变成 a->b、a->c', await waitFor(`JSON.stringify([...document.querySelectorAll('${G1} [data-start-edge]')].map(e=>e.dataset.startEdge).sort())==='["a->b","a->c"]'`, 5000),
      JSON.stringify(await js(`[...document.querySelectorAll('${G1} [data-start-edge]')].map(e=>e.dataset.startEdge)`)))
    check('变成 2 批', await js(`document.querySelector('${G1} svg').dataset.cols==='2'`))

    console.log('\n=== 4. 键盘 ===')
    const first = await js(`(()=>{const n=document.querySelector('${G1} [data-start-node]');n.focus();return n.dataset.startNode})()`)
    check('节点可聚焦', await js(`document.activeElement && document.activeElement.dataset.startNode === '${first}'`), first)
    await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));true`)
    const second = await js(`document.activeElement && document.activeElement.dataset.startNode`)
    check('方向键移到下一个节点', !!second && second !== first, `${first} -> ${second}`)
    const label = await js(`document.activeElement.getAttribute('aria-label')||''`)
    check('节点有可读的 aria-label', /第 \d 批/.test(label), label)
    await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));true`)
    check('Enter 打开该条目的详情', await waitFor(`!!document.querySelector('.svc-detail') && document.querySelector('.svc-detail').getAttribute('aria-label').includes(${JSON.stringify('')}+(document.querySelector('[data-start-node="${second}"]').getAttribute('aria-label').split('，')[0]))`, 5000))
    const rts = await js(`window.mile.entry.runtimes()`)
    check('节点操作没有启动任何条目', rts.every((r) => r.status === 'idle' || r.status === 'stopped'), JSON.stringify(rts.map((r) => r.status)))

    console.log('\n=== 5. 折叠 ===')
    await js(`document.querySelector('.start-order-toggle').click();true`)
    check('点标题后折叠', await waitFor(`!document.querySelector('${G1}')`, 3000))
  } catch (err) {
    console.log('HARNESS ERROR', err)
    fail++
  }
  clearTimeout(guard)
  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`) }
  app.exit(fail === 0 ? 0 : 1)
})
