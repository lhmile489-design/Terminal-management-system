/**
 * M6 §9.4 验证：服务页成员行排序（UI-REFACTOR 阶段 4 迁移）。
 *
 * 真实主进程 + 真实渲染层。排序的正确性必须看 DOM 实际顺序和落盘的 config.json，
 * 不能只看「函数被调用了」—— 顺序错乱是这类交互最常见的失败方式。
 *
 * 旧卡片的两类断言不再适用，见 docs/UI/UI-REFACTOR.md 执行记录：
 * - 「跨置顶组拖拽应拒绝」：服务页按工作组分段，没有置顶组；跨组拖放是新功能（换组并放到指定位置）。
 * - 「FLIP 动画独占 transform」：成员行没有悬停抬升，也不做 FLIP，排序结果由插入线 + 立即重排表达。
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, rmSync, readFileSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const FIXTURE = join(__dirname, 'fixture')

const SANDBOX = join(tmpdir(), `mile-m6sort-${process.pid}`)
mkdirSync(SANDBOX, { recursive: true })
app.setPath('appData', SANDBOX)

const CONFIG = join(SANDBOX, 'mile-terminal', 'config.json')

let pass = 0
let fail = 0
function check(label, ok, detail = '') {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const NAMES = ['甲', '乙', '丙', '丁', '戊', '己']

function seedConfig() {
  mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
  const now = Date.now()
  writeFileSync(
    CONFIG,
    JSON.stringify({
      version: 1,
      entries: NAMES.map((name, i) => ({
        id: `sort-${i}`, kind: 'service', name, path: FIXTURE, framework: 'node', packageManager: 'npm',
        script: 'dev', scripts: { dev: 'node server.cjs' }, env: {}, registerOnly: false,
        pinned: false, order: i, createdAt: now
      })),
      ignoredListeners: [],
      settings: { scanIntervalMs: 2000, theme: 'light', externalTerminal: 'wt', terminalFontSize: 13, scrollback: 5000, killOwnedOnQuit: true, closeToTray: false }
    }, null, 2),
    'utf8'
  )
}

const js = (win, code) => win.webContents.executeJavaScript(code, true)
async function waitFor(fn, ms = 6000) {
  for (let t = 0; t < ms; t += 120) { if (await fn()) return true; await sleep(120) }
  return false
}
const domOrder = (win) => js(win, `[...document.querySelectorAll('.svc-row')].map(r=>r.dataset.entryId)`)
function diskOrder() {
  const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'))
  return [...cfg.entries].sort((a, b) => a.order - b.order).map((e) => e.id)
}
const key = (win, k, mods = {}) => js(win, `document.body.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)},bubbles:true,cancelable:true,...${JSON.stringify(mods)}}));true`)

async function gotoServices(win) {
  await js(win, `document.querySelector('nav [aria-label="服务"]').click();true`)
  return waitFor(async () => (await js(win, `document.querySelectorAll('.svc-row').length`)) === 6)
}

/** 拖 src 到 dst 行的上半部（before）或下半部 */
async function dragOnto(win, src, dst, before) {
  await js(win, `window.__dt=new DataTransfer();document.querySelector('[data-entry-id="${src}"]').dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:window.__dt}));true`)
  await sleep(60)
  await js(win, `(()=>{const d=document.querySelector('[data-entry-id="${dst}"]');const r=d.getBoundingClientRect();
    d.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:window.__dt,clientX:r.left+20,clientY:r.top+r.height*${before ? 0.25 : 0.75}}));return true})()`)
  await sleep(120)
  const at = await js(win, `document.querySelector('[data-entry-id="${dst}"]').dataset.dropAt||''`)
  await js(win, `(()=>{const d=document.querySelector('[data-entry-id="${dst}"]');d.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:window.__dt}));
    document.querySelector('[data-entry-id="${src}"]').dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:window.__dt}));return true})()`)
  return at
}

async function checks(win) {
  console.log('=== 初始状态 ===')
  await waitFor(() => js(win, `!!document.querySelector('nav[aria-label="主导航"]')`), 30_000)
  check('服务页渲染六行', await gotoServices(win))
  check('初始顺序按 order', (await domOrder(win)).join() === 'sort-0,sort-1,sort-2,sort-3,sort-4,sort-5', (await domOrder(win)).join())
  check('成员行可拖动', await js(win, `[...document.querySelectorAll('.svc-row')].every(r=>r.draggable)`))

  console.log('\n=== 鼠标拖拽（同组内） ===')
  const at = await dragOnto(win, 'sort-4', 'sort-1', true)
  check('悬停上半部显示「在前」插入线', at === 'before', at)
  const want = 'sort-0,sort-4,sort-1,sort-2,sort-3,sort-5'
  check('放下后 DOM 顺序正确', await waitFor(async () => (await domOrder(win)).join() === want), (await domOrder(win)).join())
  check('拖拽后顺序已落盘', await waitFor(async () => diskOrder().join() === want), diskOrder().join())
  check('放下后插入线消失', !(await js(win, `!!document.querySelector('[data-drop-at]')`)))
  const atAfter = await dragOnto(win, 'sort-0', 'sort-5', false)
  check('悬停下半部显示「在后」插入线', atAfter === 'after', atAfter)
  const want2 = 'sort-4,sort-1,sort-2,sort-3,sort-5,sort-0'
  check('拖到最后一行之后', await waitFor(async () => diskOrder().join() === want2), diskOrder().join())

  console.log('\n=== 键盘排序 ===')
  // 方向键把光标落到 sort-2（第 3 行），Ctrl+↑ 前移一位
  await js(win, `document.activeElement&&document.activeElement.blur();true`)
  for (let i = 0; i < 4; i++) { await key(win, 'ArrowDown'); await sleep(80) }
  const cur = await js(win, `(document.querySelector('.svc-row[data-cursor]')||{dataset:{}}).dataset.entryId||''`)
  check('方向键把光标移到第三行', cur === 'sort-2', cur)
  const beforeKey = await domOrder(win)
  await key(win, 'ArrowUp', { ctrlKey: true })
  const want3 = 'sort-4,sort-2,sort-1,sort-3,sort-5,sort-0'
  check('Ctrl+↑ 前移一位', await waitFor(async () => (await domOrder(win)).join() === want3), `${beforeKey.join()} → ${(await domOrder(win)).join()}`)
  check('Ctrl+↑ 后顺序已落盘', await waitFor(async () => diskOrder().join() === want3), diskOrder().join())
  const live = await js(win, `(document.querySelector('[data-services-page] [aria-live]')||{textContent:''}).textContent`)
  check('aria-live 播报移动结果', /已移到第 \d+ 位/.test(live), live)
  check('移动后光标仍在被移动的行', (await js(win, `(document.querySelector('.svc-row[data-cursor]')||{dataset:{}}).dataset.entryId||''`)) === 'sort-2')
  await key(win, 'ArrowDown', { ctrlKey: true })
  check('Ctrl+↓ 移回原位', await waitFor(async () => diskOrder().join() === want2), diskOrder().join())

  console.log('\n=== 无修饰键不应改序 ===')
  const beforePlain = diskOrder().join()
  await key(win, 'ArrowUp'); await key(win, 'ArrowDown'); await sleep(400)
  check('裸方向键不改变顺序', diskOrder().join() === beforePlain, diskOrder().join())

  console.log('\n=== 持久化：重载后保持顺序 ===')
  const expected = diskOrder()
  win.webContents.reload()
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  await waitFor(() => js(win, `!!document.querySelector('nav[aria-label="主导航"]')`), 30_000)
  await gotoServices(win)
  const reloaded = await domOrder(win)
  check('重载后顺序与落盘一致', reloaded.join() === expected.join(), `${expected.join()} vs ${reloaded.join()}`)

  console.log('\n=== 无障碍回归 ===')
  const unlabeled = await js(win, `[...document.querySelectorAll('button')].filter(b=>!b.getAttribute('aria-label')&&!b.textContent.trim()&&!b.getAttribute('title')).length`)
  check('图标按钮无 aria-label 缺失', unlabeled === 0, `${unlabeled} 个无标签按钮`)
  const clipped = await js(win, `[...document.querySelectorAll('.svc-row .svc-row-name b')].filter(el=>el.scrollWidth>el.clientWidth+1).length`)
  check('行内名称无截断', clipped === 0, `${clipped} 个溢出`)

  console.log(`\n===== M6 §9.4 结果：PASS ${pass} / FAIL ${fail} =====`)
}

seedConfig()
require(join(ROOT, 'out/main/index.js'))

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) { console.log('FAIL 没有取到窗口'); app.exit(1); return }
  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r))
    win.setBounds({ width: 1180, height: 760 })
    await checks(win)
  } catch (err) {
    console.log('HARNESS ERROR', err)
    fail++
  }
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`) }
  app.exit(fail === 0 ? 0 : 1)
})
