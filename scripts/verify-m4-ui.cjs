/**
 * 服务页界面验证（原启动台，UI-REFACTOR 阶段 4 迁到服务页）：真实主进程 + 真实构建产物，通过 executeJavaScript 驱动渲染层。
 *
 * 不 mock 数据 —— 要证明的是「主进程推来的真实条目与状态能正确渲染」。
 * 预置两个条目：一个可启动的夹具，一个目录不存在的（走预检 fail 分支）。
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const FIXTURE = join(__dirname, 'fixture')

/*
 * 隔离 appData —— 这一步曾经缺失，代价是真实的用户配置被夹具条目整份覆盖。
 *
 * seedConfig 直接往 app.getPath('appData')/mile-terminal/config.json 写夹具数据。
 * 不改 appData 时那就是 %APPDATA%\mile-terminal\config.json 本身，用户登记的项目全丢，
 * 且 ConfigStore 的 .bak 轮转会把备份一起换成夹具版本，等于两份都没了。
 * 必须在 require 主进程包之前改：ConfigStore 在构造时就解析路径。
 */
const SANDBOX = join(tmpdir(), `mile-m4ui-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
app.setPath('appData', SANDBOX)

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

function seedConfig() {
  const dir = join(app.getPath('appData'), 'mile-terminal')
  mkdirSync(dir, { recursive: true })
  const now = Date.now()
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify(
      {
        version: 1,
        entries: [
          {
            id: 'ui-ok',
            kind: 'service',
            name: 'Fixture Dev',
            path: FIXTURE,
            framework: 'node',
            packageManager: 'npm',
            script: 'dev',
            scripts: { dev: 'node server.cjs' },
            env: {},
            registerOnly: false,
            pinned: false,
            order: 0,
            createdAt: now
          },
          {
            id: 'ui-broken',
            kind: 'task',
            name: '目录不存在的任务',
            path: 'E:\\WebApp\\__不存在的目录__',
            framework: 'unknown',
            packageManager: 'npm',
            script: 'build',
            scripts: {},
            env: {},
            registerOnly: false,
            pinned: false,
            order: 1,
            createdAt: now
          }
        ],
        ignoredListeners: [],
        settings: {
          scanIntervalMs: 2000,
          theme: 'light',
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

const run = (win, src) => win.webContents.executeJavaScript(src, true)

async function waitUntil(win, src, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await run(win, src)) return true
    } catch {
      // 页面还没挂载完，继续等
    }
    await sleep(300)
  }
  console.log(`  (超时 ${timeoutMs}ms 等待 ${label})`)
  return false
}

/** 点击带指定 aria-label 的按钮，返回是否点到 */
const clickByLabel = (scope, label) => `
  (() => {
    const root = ${scope};
    if (!root) return false;
    const btn = [...root.querySelectorAll('button')].find(
      (b) => (b.getAttribute('aria-label') || b.textContent || '').trim() === ${JSON.stringify(label)}
    );
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  })()
`


/** 服务页成员行（UI-REFACTOR §3.3），按名称定位 */
const ROW = (name) => `[...document.querySelectorAll('.svc-row')].find((r) => r.textContent.includes(${JSON.stringify(name)}))`
const pressIn = (scope, text) => `(() => {
  const r = ${scope};
  if (!r) return false;
  const b = [...r.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || x.textContent || '').trim() === ${JSON.stringify(text)});
  if (!b || b.disabled) return false;
  b.click();
  return true;
})()`

async function checks(win) {
  console.log('=== 服务页 ===')
  await waitUntil(win, `!!document.querySelector('nav')`, 30_000, '外壳挂载')

  const navigated = await run(win, clickByLabel(`document.querySelector('nav')`, '服务'))
  check('导航到服务页', navigated)

  const rowsReady = await waitUntil(win, `document.querySelectorAll('.svc-row').length === 2`, 20_000, '两个成员行')
  const rowInfo = await run(
    win,
    `[...document.querySelectorAll('.svc-row')].map((r) => ({
      name: r.querySelector('.svc-row-name b')?.textContent.trim(),
      kind: r.querySelector('.svc-kind')?.textContent.trim(),
      status: r.querySelector('.ui-dot')?.getAttribute('aria-label'),
      clipped: [...r.querySelectorAll('*')].filter((el) => getComputedStyle(el).textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 1).length
    }))`
  )
  check('渲染两个真实条目行', rowsReady, JSON.stringify(rowInfo))
  check(
    '行内有类型与状态文字（不只靠颜色）',
    rowInfo.every((r) => (r.kind === '服务' || r.kind === '任务') && r.status === '未启动'),
    rowInfo.map((r) => `${r.kind}+${r.status}`).join(' | ')
  )

  console.log('\n=== 预检 fail 分支渲染 ===')
  // 任务的启动按钮叫「运行」——一次性命令没有「停止运行中的服务」那层含义
  const brokenClicked = await run(win, pressIn(ROW('目录不存在的任务'), '运行'))
  check('点击目录不存在条目的运行', brokenClicked)

  // 被预检拦下时服务页打开该条目详情的「诊断」标签（UI-REFACTOR §3.3）
  const panelUp = await waitUntil(
    win,
    `(() => {
      const tab = document.querySelector('.svc-detail [role="tab"][aria-selected="true"]');
      return !!tab && tab.textContent.includes('诊断') && document.querySelectorAll('.svc-detail-body li').length > 0;
    })()`,
    20_000,
    '诊断标签'
  )
  const panel = await run(
    win,
    `(() => {
      const sec = document.querySelector('.svc-detail-body');
      if (!sec) return null;
      return {
        items: sec.querySelectorAll('li').length,
        text: sec.textContent.replace(/\\s+/g, ' ').slice(0, 220),
        hasFix: [...sec.querySelectorAll('button')].some((b) => b.textContent.includes('重新选择目录'))
      };
    })()`
  )
  check('预检未通过时打开详情的诊断标签', panelUp, panel ? `${panel.items} 项` : '')
  check('诊断里给出修复入口按钮', !!panel?.hasFix, panel?.text)
  check('状态转为预检未通过', await run(win, `(${ROW('目录不存在的任务')})?.querySelector('.ui-dot')?.getAttribute('aria-label') === '预检未通过'`))

  console.log('\n=== 启动真实服务并回填端口 ===')
  const startClicked = await run(win, pressIn(ROW('Fixture Dev'), '启动'))
  check('点击启动 Fixture Dev', startClicked)

  const running = await waitUntil(
    win,
    `(${ROW('Fixture Dev')})?.querySelector('.ui-dot')?.getAttribute('aria-label') === '运行中'`,
    60_000,
    '状态转运行中'
  )
  check('行状态转运行中', running)

  const portShown = await waitUntil(
    win,
    `/^:\\d{2,5}$/.test(((${ROW('Fixture Dev')})?.querySelector('.svc-row-port')?.textContent || '').trim())`,
    30_000,
    '端口渲染'
  )
  const portText = await run(win, `((${ROW('Fixture Dev')})?.querySelector('.svc-row-port')?.textContent || '无端口').trim()`)
  check('行内渲染捕获到的端口', portShown, portText)

  // 「移除」在「⋯」菜单里，运行中禁用
  const menu = await run(
    win,
    `(async () => {
      const r = ${ROW('Fixture Dev')};
      const stop = [...r.querySelectorAll('button')].find((b) => b.textContent.trim() === '停止');
      r.querySelector('button[aria-label$="更多操作"]').click();
      await new Promise((res) => setTimeout(res, 200));
      const rm = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find((b) => b.textContent.trim() === '移除');
      const out = { stop: !!stop, remove: !!rm, disabled: !!rm && rm.disabled };
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return out;
    })()`
  )
  check('运行中时按钮切为停止且移除被禁用', menu.stop && menu.remove && menu.disabled, JSON.stringify(menu))

  console.log('\n=== KPI 与事件流联动 ===')
  const dashOk = await run(win, clickByLabel(`document.querySelector('nav')`, '总览'))
  check('回到工作台', dashOk)
  const kpi = await run(
    win,
    `(() => {
      const cards = [...document.querySelectorAll('section[aria-labelledby="kpi-heading"] article')];
      // 只量读数与单位。hint 那行带 truncate 是有意的（六列并排必然放不下，
      // 悬停有 title 兜底），把它算进来会把设计意图当成 bug。
      return {
        count: cards.length,
        clipped: cards.flatMap((c) => [...c.querySelectorAll('p:not(.truncate) span')]).filter((el) => el.scrollWidth > el.clientWidth + 1).length,
        untitledHint: cards.flatMap((c) => [...c.querySelectorAll('p.truncate')]).filter((el) => !el.getAttribute('title')).length,
        mine: cards[0]?.textContent.replace(/\\s+/g, ' ').trim(),
        conflicts: cards.find((c) => c.textContent.includes('端口冲突'))?.textContent.replace(/\\s+/g, ' ').trim()
      };
    })()`
  )
  check('KPI 六张卡且数值无截断', kpi.count === 6 && kpi.clipped === 0, JSON.stringify(kpi))
  check('被截断的说明行都有 title 可悬停看全', kpi.untitledHint === 0, `${kpi.untitledHint} 处缺 title`)
  check('我的服务按启动台条目计数', /1\s*\/\s*2/.test(kpi.mine ?? ''), kpi.mine)

  // UI-REFACTOR Q1：实时动态改为标题栏按钮打开的抽屉，先打开再读
  await run(win, `(() => { const b = document.querySelector('[aria-label^="实时动态"]'); b && b.click(); return !!b })()`)
  await new Promise((r) => setTimeout(r, 400))
  const events = await run(
    win,
    `(() => {
      const aside = document.querySelector('aside');
      return aside ? aside.textContent.replace(/\\s+/g, ' ').slice(0, 200) : null;
    })()`
  )
  check('事件流收到条目状态事件', /运行中|启动中|预检/.test(events ?? ''), events)

  console.log('\n=== 无障碍与主题 ===')
  const unlabeled = await run(
    win,
    `(() => {
      const bad = [...document.querySelectorAll('button')].filter(
        (b) => !b.getAttribute('aria-label') && !b.textContent.trim() && !b.getAttribute('title')
      );
      return bad.length;
    })()`
  )
  check('图标按钮无 aria-label 缺失', unlabeled === 0, `${unlabeled} 个无标签按钮`)

  // 以前这条只找按钮就 return true，从不打开对话框。现在真的打开、读属性、再关掉
  const modal = await run(
    win,
    `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // 先关掉前面打开的实时动态抽屉，否则添加按钮被浮层挡住
      for (let i = 0; i < 3 && document.querySelector('[role="dialog"]'); i++) {
        document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await sleep(250);
      }
      const add = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '添加服务');
      if (!add) return { found: false };
      add.click();
      let dlg = null;
      for (let t = 0; t < 30 && !dlg; t++) { await sleep(100); dlg = document.querySelector('.add-dialog[role="dialog"]'); }
      if (!dlg) return { found: true, opened: false };
      const ariaModal = dlg.getAttribute('aria-modal');
      const labelled = !!(dlg.getAttribute('aria-labelledby') || dlg.getAttribute('aria-label'));
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      for (let t = 0; t < 30 && document.querySelector('.add-dialog[role="dialog"]'); t++) await sleep(100);
      return { found: true, opened: true, ariaModal, labelled, closed: !document.querySelector('.add-dialog[role="dialog"]') };
    })()`
  )
  check('前提：找到并打开了添加服务对话框', modal.found && modal.opened, JSON.stringify(modal))
  check('模态对话框带 aria-modal="true"', modal.ariaModal === 'true', String(modal.ariaModal))
  check('模态对话框有可读名称', modal.labelled === true, String(modal.labelled))
  check('Esc 关闭了对话框', modal.closed === true, String(modal.closed))

  for (const [theme, expect] of [
    // UI-REFACTOR §4.1 画布色：浅 #F6F7FB，深 #0F1219
    ['light', 'rgb(246, 247, 251)'],
    ['dark', 'rgb(15, 18, 25)']
  ]) {
    await run(win, `window.mile.theme.set('${theme}')`)
    // 等两帧再断言，否则会把「读取早于重绘」误判成主题没生效
    const bg = await run(
      win,
      `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() =>
        r(getComputedStyle(document.body).backgroundColor)
      )))`
    )
    check(`${theme} 主题实绘背景`, bg === expect, bg)
  }

  console.log('\n=== 清理 ===')
  await run(win, clickByLabel(`document.querySelector('nav')`, '服务'))
  await waitUntil(win, `!!(${ROW('Fixture Dev')})`, 10_000, '服务页')
  await run(win, pressIn(ROW('Fixture Dev'), '停止'))
  const stopped = await waitUntil(
    win,
    `(${ROW('Fixture Dev')})?.querySelector('.ui-dot')?.getAttribute('aria-label') !== '运行中'`,
    25_000,
    '停止生效'
  )
  check('界面上可停止受控服务', stopped)

  console.log(`\n===== 界面结果：PASS ${pass} / FAIL ${fail} =====`)
}

seedConfig()
require(join(ROOT, 'out/main/index.js'))

app.whenReady().then(async () => {
  // 主进程的 whenReady 回调先注册先执行，此时窗口已创建
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    console.log('FAIL 没有取到窗口')
    app.exit(1)
    return
  }
  win.webContents.on('console-message', (_e, _level, message) => {
    if (/error/i.test(message)) console.log('  [renderer]', message.slice(0, 160))
  })

  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r))
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
