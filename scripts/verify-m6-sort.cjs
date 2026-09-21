/**
 * M6 §9.4 验证：卡片拖拽与键盘排序。
 *
 * 真实主进程 + 真实渲染层。排序的正确性必须看 DOM 实际顺序和落盘的 config.json，
 * 不能只看「函数被调用了」—— 顺序错乱是这类交互最常见的失败方式。
 */
const { app, BrowserWindow, ipcMain } = require('electron')
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
  if (ok) {
    pass++
    console.log(`PASS ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail++
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 6 个条目：前 2 个置顶，用来验证「移动限制在同置顶组内」 */
const NAMES = ['甲', '乙', '丙', '丁', '戊', '己']

function seedConfig() {
  mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
  const now = Date.now()
  writeFileSync(
    CONFIG,
    JSON.stringify(
      {
        version: 1,
        entries: NAMES.map((name, i) => ({
          id: `sort-${i}`,
          kind: 'service',
          name,
          path: FIXTURE,
          framework: 'node',
          packageManager: 'npm',
          script: 'dev',
          scripts: { dev: 'node server.cjs' },
          env: {},
          registerOnly: false,
          pinned: i < 2,
          order: i,
          createdAt: now
        })),
        ignoredListeners: [],
        settings: {
          scanIntervalMs: 2000,
          theme: 'dark',
          externalTerminal: 'wt',
          terminalFontSize: 13,
          scrollback: 5000,
          killOwnedOnQuit: true,
          closeToTray: false
        }
      },
      null,
      2
    ),
    'utf8'
  )
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await fn()) return true
    } catch {
      /* 还没就绪 */
    }
    await sleep(250)
  }
  console.log(`  (超时 ${timeoutMs}ms 等待 ${label})`)
  return false
}

const js = (win, code) => win.webContents.executeJavaScript(code, true)

/** DOM 里卡片的实际顺序 */
const domOrder = (win) =>
  js(win, `[...document.querySelectorAll('[data-entry-id]')].map((c) => c.dataset.entryId)`)

/** 落盘顺序：按 order 排，验证真的持久化了 */
function diskOrder() {
  const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'))
  return [...cfg.entries].sort((a, b) => a.order - b.order).map((e) => e.id)
}

async function gotoLaunchpad(win) {
  await waitFor(() => js(win, `!!document.querySelector('nav')`), 30_000, '外壳挂载')
  await js(
    win,
    `(() => {
      const b = [...document.querySelector('nav').querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === '前端启动台');
      b && b.click();
      return true;
    })()`
  )
  return await waitFor(
    () => js(win, `document.querySelectorAll('[data-entry-id]').length === 6`),
    25_000,
    '六张卡片'
  )
}

/** 合成一次 HTML5 拖拽：dragstart(源) → dragenter/dragover(目标) → drop(目标) */
async function dragOnto(win, sourceId, targetId) {
  return await js(
    win,
    `(() => {
      const src = document.querySelector('[data-entry-id="${sourceId}"]');
      const dst = document.querySelector('[data-entry-id="${targetId}"]');
      if (!src || !dst) return 'missing';
      const dt = new DataTransfer();
      const fire = (el, type) => {
        const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
        el.dispatchEvent(ev);
        return ev;
      };
      fire(src, 'dragstart');
      fire(dst, 'dragenter');
      const over = fire(dst, 'dragover');
      fire(dst, 'drop');
      fire(src, 'dragend');
      return over.defaultPrevented ? 'moved' : 'rejected';
    })()`
  )
}

async function pressCtrlArrow(win, entryId, key) {
  return await js(
    win,
    `(() => {
      const card = document.querySelector('[data-entry-id="${entryId}"]');
      if (!card) return false;
      card.focus();
      card.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', ctrlKey: true, bubbles: true, cancelable: true }));
      return document.activeElement === card;
    })()`
  )
}

/** 只开一段拖拽（dragstart），停在拖拽态供读样式；返回时不结束 */
async function beginDrag(win, sourceId) {
  return await js(
    win,
    `(() => {
      const src = document.querySelector('[data-entry-id="${sourceId}"]');
      if (!src) return false;
      window.__dragSrc = src;
      window.__dragDt = new DataTransfer();
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__dragDt }));
      return true;
    })()`
  )
}

/** 结束上一段拖拽（dragend），恢复常态 */
async function endDrag(win) {
  return await js(
    win,
    `(() => {
      const src = window.__dragSrc;
      if (!src) return false;
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: window.__dragDt }));
      window.__dragSrc = null;
      return true;
    })()`
  )
}

/** 读某卡片所在网格的 data-sorting，以及卡片 transition-property 是否含 transform */
async function sortingProbe(win, entryId) {
  return await js(
    win,
    `(() => {
      const card = document.querySelector('[data-entry-id="${entryId}"]');
      const host = card && card.parentElement;
      const sorting = (host && host.getAttribute('data-sorting')) || null;
      const props = getComputedStyle(card).transitionProperty;
      return { sorting, hasTransform: props.split(',').map((s) => s.trim()).includes('transform') };
    })()`
  )
}

const liveText = (win) =>
  js(win, `(document.querySelector('[role="status"][aria-live="polite"]')?.textContent ?? '').trim()`)

async function checks(win) {
  console.log('=== 初始状态 ===')
  const ok = await gotoLaunchpad(win)
  check('启动台渲染六张卡片', ok)

  const initial = await domOrder(win)
  check('初始顺序按 order，置顶组在前', initial.join() === 'sort-0,sort-1,sort-2,sort-3,sort-4,sort-5', initial.join())
  check('卡片可聚焦（tabIndex=0）', (await js(win, `document.querySelector('[data-entry-id]').tabIndex`)) === 0)
  check(
    '卡片带可排序语义',
    (await js(win, `document.querySelector('[data-entry-id]').getAttribute('aria-roledescription')`)) === '可排序卡片'
  )
  check(
    '卡片 aria-label 含位置与操作提示',
    await js(win, `document.querySelector('[data-entry-id]').getAttribute('aria-label').includes('第 1 项，共 6 项')`),
    await js(win, `document.querySelector('[data-entry-id]').getAttribute('aria-label')`)
  )

  console.log('\n=== 鼠标拖拽（同组内） ===')
  // 丙(sort-2) 拖到 戊(sort-4) 位置：未置顶组内后移
  const r1 = await dragOnto(win, 'sort-2', 'sort-4')
  check('同组拖拽被接受', r1 === 'moved', r1)
  const afterDrag = await domOrder(win)
  check(
    '拖拽后 DOM 顺序正确',
    afterDrag.join() === 'sort-0,sort-1,sort-3,sort-4,sort-2,sort-5',
    afterDrag.join()
  )
  await sleep(600)
  check('拖拽后顺序已落盘', diskOrder().join() === afterDrag.join(), diskOrder().join())

  console.log('\n=== 拖拽动画：transform 交给 FLIP 独占 ===')
  // 乱跳的根因是拖拽时 .surface-card 的 transform 过渡 + :hover 抬升与 FLIP card.animate 抢同一属性。
  // 修复后拖拽态在网格挂 data-sorting，CSS 把 transform 从卡片 transition 里摘掉。
  // 先量基态（非拖拽）证明探针读得到 transform，再量拖拽态证明它被摘掉 —— 基态对照防假绿。
  const baseProbe = await sortingProbe(win, 'sort-0')
  check('基态：未拖拽无 data-sorting', baseProbe.sorting === null, JSON.stringify(baseProbe))
  check('基态：卡片 transition 含 transform', baseProbe.hasTransform === true, JSON.stringify(baseProbe))
  await beginDrag(win, 'sort-2')
  await sleep(120) // 等 setDragging 的 React 状态提交到 DOM
  const dragProbe = await sortingProbe(win, 'sort-0')
  check('拖拽态：网格挂 data-sorting=true', dragProbe.sorting === 'true', JSON.stringify(dragProbe))
  check('拖拽态：transform 已从卡片 transition 摘除', dragProbe.hasTransform === false, JSON.stringify(dragProbe))
  await endDrag(win)
  await sleep(120)
  const afterProbe = await sortingProbe(win, 'sort-0')
  check('松手后：data-sorting 撤销', afterProbe.sorting === null, JSON.stringify(afterProbe))
  check('松手后：transform 过渡恢复', afterProbe.hasTransform === true, JSON.stringify(afterProbe))

  console.log('\n=== 鼠标拖拽（跨置顶组，应拒绝） ===')
  const before = await domOrder(win)
  const r2 = await dragOnto(win, 'sort-3', 'sort-0')
  check('跨置顶组拖拽不放行', r2 === 'rejected', r2)
  check('跨组拖拽后顺序未变', (await domOrder(win)).join() === before.join(), (await domOrder(win)).join())

  console.log('\n=== 键盘排序 ===')
  const beforeKey = await domOrder(win)
  const focused = await pressCtrlArrow(win, 'sort-5', 'ArrowLeft')
  check('卡片可获得焦点', focused)
  await sleep(400)
  const afterKey = await domOrder(win)
  const moved = beforeKey.indexOf('sort-5') - afterKey.indexOf('sort-5')
  check('Ctrl+← 前移一位', moved === 1, `${beforeKey.join()} → ${afterKey.join()}`)
  check('Ctrl+← 后顺序已落盘', diskOrder().join() === afterKey.join(), diskOrder().join())

  const announced = await liveText(win)
  check('aria-live 播报移动结果', /已移到第 \d+ 位/.test(announced), announced)

  // 置顶组只有 2 项，第 1 项再往前应被夹住，不能窜进未置顶组
  const beforeClamp = await domOrder(win)
  await pressCtrlArrow(win, 'sort-0', 'ArrowLeft')
  await sleep(400)
  check(
    '置顶组首项再前移被夹住',
    (await domOrder(win)).join() === beforeClamp.join(),
    (await domOrder(win)).join()
  )

  // Ctrl+↓ 按实际列数跨行移动。必须挑一个「下移空间足够」的卡片，否则位移被
  // 夹回 0 也算通过，等于什么都没测到。
  const cols = await js(
    win,
    `getComputedStyle(document.querySelector('[data-entry-id]').parentElement).gridTemplateColumns.split(' ').filter(Boolean).length`
  )
  const beforeDown = await domOrder(win)
  // 未置顶组的区间是 [2, 5]，取组内首项，它下移 cols 位仍在组内
  const mover = beforeDown[2]
  await pressCtrlArrow(win, mover, 'ArrowDown')
  await sleep(400)
  const afterDown = await domOrder(win)
  const downDelta = afterDown.indexOf(mover) - beforeDown.indexOf(mover)
  check(
    'Ctrl+↓ 按网格列数跨行移动',
    downDelta === cols,
    `列数=${cols} 位移=${downDelta}（${mover}：${beforeDown.join()} → ${afterDown.join()}）`
  )

  console.log('\n=== 无修饰键不应改序 ===')
  const beforePlain = await domOrder(win)
  await js(
    win,
    `(() => {
      const c = document.querySelector('[data-entry-id="sort-3"]');
      c.focus();
      c.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
      return true;
    })()`
  )
  await sleep(300)
  check('裸方向键不改变顺序', (await domOrder(win)).join() === beforePlain.join(), (await domOrder(win)).join())

  console.log('\n=== 持久化：重载后保持顺序 ===')
  const expected = await domOrder(win)
  win.webContents.reload()
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  await gotoLaunchpad(win)
  const reloaded = await domOrder(win)
  check('重载后顺序与落盘一致', reloaded.join() === expected.join(), `${expected.join()} vs ${reloaded.join()}`)

  console.log('\n=== 无障碍回归 ===')
  const unlabeled = await js(
    win,
    `[...document.querySelectorAll('button')].filter((b) => !b.getAttribute('aria-label') && !b.textContent.trim() && !b.getAttribute('title')).length`
  )
  check('图标按钮无 aria-label 缺失', unlabeled === 0, `${unlabeled} 个无标签按钮`)

  const clipped = await js(
    win,
    `[...document.querySelectorAll('[data-entry-id] *')].filter((el) => el.scrollWidth > el.clientWidth + 1).length`
  )
  check('卡片内无文字截断', clipped === 0, `${clipped} 个溢出元素`)

  console.log(`\n===== M6 §9.4 结果：PASS ${pass} / FAIL ${fail} =====`)
}

seedConfig()
require(join(ROOT, 'out/main/index.js'))

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    console.log('FAIL 没有取到窗口')
    app.exit(1)
    return
  }
  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r))
    await sleep(2500)
    await checks(win)
  } catch (err) {
    console.log('HARNESS ERROR', err)
    fail++
  }
  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`)
  }
  app.exit(fail === 0 ? 0 : 1)
})
