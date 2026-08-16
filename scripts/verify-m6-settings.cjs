/**
 * M6 §9.3 验证：设置页、托盘、侧栏负载指标切换。
 *
 * 设置的关键不是「界面能点」，而是改动真的落盘、真的驱动行为（采集周期、终端字号），
 * 且非法值被主进程拦住 —— 这些值坏掉是行为问题而不是显示问题。
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, rmSync, readFileSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const FIXTURE = join(__dirname, 'fixture')

const SANDBOX = join(tmpdir(), `mile-m6set-${process.pid}`)
mkdirSync(SANDBOX, { recursive: true })
app.setPath('appData', SANDBOX)

const CONFIG = join(SANDBOX, 'mile-terminal', 'config.json')

const Channels = {
  settingsGet: 'settings:get',
  settingsPatch: 'settings:patch'
}

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
  mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
  writeFileSync(
    CONFIG,
    JSON.stringify(
      {
        version: 1,
        entries: [
          {
            id: 'set-1',
            kind: 'service',
            name: '示例服务',
            path: FIXTURE,
            framework: 'node',
            packageManager: 'npm',
            script: 'dev',
            scripts: { dev: 'node server.cjs' },
            env: {},
            registerOnly: false,
            pinned: false,
            order: 0,
            createdAt: Date.now()
          }
        ],
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

async function callIpc(channel, ...args) {
  const handler = ipcMain._invokeHandlers.get(channel)
  if (!handler) throw new Error(`没有注册 handler: ${channel}`)
  return await handler({}, ...args)
}

const diskSettings = () => JSON.parse(readFileSync(CONFIG, 'utf8')).settings

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

async function goto(win, label) {
  await js(
    win,
    `(() => {
      const b = [...document.querySelector('nav').querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(label)});
      b && b.click();
      return true;
    })()`
  )
  await sleep(500)
}

async function checks(win) {
  await waitFor(() => js(win, `!!document.querySelector('nav')`), 30_000, '外壳挂载')

  console.log('=== 主进程校验：非法值一律拒绝 ===')
  const bad = [
    ['scanIntervalMs', 0],
    ['scanIntervalMs', 3000],
    ['theme', 'neon'],
    ['externalTerminal', 'nc -e /bin/sh'],
    ['terminalFontSize', 200],
    ['terminalFontSize', 1.5],
    ['scrollback', 10],
    ['killOwnedOnQuit', 'yes'],
    ['closeToTray', 1]
  ]
  let rejected = 0
  for (const [key, value] of bad) {
    try {
      await callIpc(Channels.settingsPatch, { [key]: value })
      console.log(`  (未拒绝：${key}=${JSON.stringify(value)})`)
    } catch {
      rejected++
    }
  }
  check('九类非法设置全部被拒绝', rejected === bad.length, `${rejected}/${bad.length}`)
  check(
    '非法请求未污染磁盘配置',
    diskSettings().scanIntervalMs === 2000 && diskSettings().theme === 'dark',
    JSON.stringify(diskSettings())
  )

  let objRejected = false
  try {
    await callIpc(Channels.settingsPatch, 'not-an-object')
  } catch {
    objRejected = true
  }
  check('非对象补丁被拒绝', objRejected)

  console.log('\n=== 合法值：落盘并回执 ===')
  const after = await callIpc(Channels.settingsPatch, { scanIntervalMs: 5000 })
  check('合法采集周期被接受', after.scanIntervalMs === 5000, String(after.scanIntervalMs))
  check('采集周期已落盘', diskSettings().scanIntervalMs === 5000, String(diskSettings().scanIntervalMs))
  check(
    '未提供的键保持不变',
    diskSettings().terminalFontSize === 13 && diskSettings().killOwnedOnQuit === true,
    JSON.stringify(diskSettings())
  )

  console.log('\n=== 设置页：渲染五段并可交互 ===')
  await goto(win, '设置')
  const sections = await js(
    win,
    `[...document.querySelectorAll('section[aria-labelledby^="settings-"] h2')].map((h) => h.textContent.trim())`
  )
  // 分区序号是写在文案里的（「4 · 退出行为」），数量之外还要求序号连续 ——
  // 加一段却忘了改前一段的编号，界面上会出现两个「4 ·」
  check('设置页渲染五个分区', sections.length === 5, JSON.stringify(sections))
  check(
    '分区序号连续无重复',
    sections.every((s, i) => s.startsWith(`${i + 1} ·`)),
    JSON.stringify(sections)
  )
  check(
    '界面反映主进程当前值',
    await js(
      win,
      `[...document.querySelectorAll('[role="radio"]')].some((b) => b.textContent.trim() === '5 秒' && b.getAttribute('aria-checked') === 'true')`
    )
  )

  // 点「2 秒」应写回主进程
  await js(
    win,
    `(() => {
      const b = [...document.querySelectorAll('[role="radio"]')].find((x) => x.textContent.trim() === '2 秒');
      b && b.click();
      return true;
    })()`
  )
  await sleep(700)
  check('点击采集周期写回主进程', diskSettings().scanIntervalMs === 2000, String(diskSettings().scanIntervalMs))

  console.log('\n=== 设置页：开关与字号 ===')
  const beforeTray = diskSettings().closeToTray
  await js(
    win,
    `(() => {
      const s = [...document.querySelectorAll('[role="switch"]')].find((x) => x.getAttribute('aria-label').includes('托盘'));
      s && s.click();
      return true;
    })()`
  )
  await sleep(700)
  check('托盘开关写回主进程', diskSettings().closeToTray === !beforeTray, String(diskSettings().closeToTray))
  check(
    '开关有 switch 语义与标签',
    await js(
      win,
      `[...document.querySelectorAll('[role="switch"]')].every((s) => s.hasAttribute('aria-checked') && !!s.getAttribute('aria-label'))`
    )
  )

  const beforeFont = diskSettings().terminalFontSize
  await js(
    win,
    `(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === '增大');
      b && b.click();
      return true;
    })()`
  )
  await sleep(700)
  check('字号增大写回主进程', diskSettings().terminalFontSize === beforeFont + 1, String(diskSettings().terminalFontSize))

  // 字号上限 22：连点到边界后按钮应禁用，而不是抛错
  for (let i = 0; i < 12; i++) {
    await js(
      win,
      `(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === '增大');
        if (b && !b.disabled) b.click();
        return true;
      })()`
    )
    await sleep(160)
  }
  check('字号被夹在上限 22', diskSettings().terminalFontSize === 22, String(diskSettings().terminalFontSize))
  check(
    '到达上限后增大按钮禁用',
    await js(
      win,
      `[...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === '增大').disabled`
    )
  )
  const noError = await js(win, `!document.querySelector('[role="alert"]')`)
  check('全程未出现错误提示', noError)

  console.log('\n=== 终端：字号设置真的生效 ===')
  await goto(win, '终端')
  // 全新沙箱里没有任何会话，xterm 根本不存在 —— 先开一个 shell 才有东西可量。
  // 这是 harness 的前置条件缺失，不是产品缺陷。
  // 走界面的加号：store 的 openShell 会同时置 activeId，直接调 IPC 不会选中
  await js(
    win,
    `(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === '新建终端会话');
      if (!b) return false;
      b.click();
      return true;
    })()`
  )
  await waitFor(() => js(win, `!!document.querySelector('.xterm')`), 20_000, 'xterm 挂载')

  /*
   * 字号生效的可观测量是 term.cols，不是 DOM 的 fontSize：
   *  - `.xterm-rows` 在启用 WebglAddon 后不存在，字符画在 canvas 上；
   *  - `.xterm` 的 computed fontSize 是外层继承的 CSS，恒为 14px，与终端字号无关；
   *  - `.xterm-screen` 的像素尺寸由 fit() 撑满容器，字号变了它几乎不变。
   * 字号变大 → 同样宽度里列数变少。而 TerminalView 改字号后会 fit() 并把新的
   * cols/rows 通过 session:resize 发回主进程，正好在这里截获。
   */
  const resizes = []
  ipcMain.on('session:resize', (_e, _id, cols, rows) => resizes.push({ cols, rows }))

  // 前面的夹取测试已把字号顶到 22，先落到 14 —— 否则「改成 22」是同值写入，
  // React 依赖不变、不会重新 fit，测出来像是功能坏了
  await callIpc(Channels.settingsPatch, { terminalFontSize: 14 })
  await sleep(900)
  resizes.length = 0
  await callIpc(Channels.settingsPatch, { terminalFontSize: 22 })
  const gotBig = await waitFor(() => resizes.length > 0, 12_000, '字号 22 触发重新 fit')
  const bigCols = resizes.at(-1)?.cols
  check('改字号触发终端重新 fit', gotBig, JSON.stringify(resizes.at(-1)))

  resizes.length = 0
  await callIpc(Channels.settingsPatch, { terminalFontSize: 11 })
  await waitFor(() => resizes.length > 0, 12_000, '字号 11 触发重新 fit')
  const smallCols = resizes.at(-1)?.cols
  check(
    '字号变小后列数变多（字号真的作用到终端）',
    typeof bigCols === 'number' && typeof smallCols === 'number' && smallCols > bigCols,
    `22px → ${bigCols} 列，11px → ${smallCols} 列`
  )

  console.log('\n=== 侧栏：负载指标可切 ===')
  await goto(win, '工作台')
  check(
    '负载指标有 radiogroup 语义',
    await js(win, `!!document.querySelector('[role="radiogroup"][aria-label="负载指标"]')`)
  )
  check(
    '默认按内存排序',
    (await js(
      win,
      `document.querySelector('[aria-label="按内存排序"]').getAttribute('aria-checked')`
    )) === 'true'
  )
  await js(win, `(() => { document.querySelector('[aria-label="按 CPU 排序"]').click(); return true; })()`)
  await sleep(500)
  check(
    '切到 CPU 后选中态更新',
    (await js(win, `document.querySelector('[aria-label="按 CPU 排序"]').getAttribute('aria-checked')`)) === 'true'
  )
  check(
    'CPU 模式下不再显示字节单位',
    await js(
      win,
      `(() => {
        const sec = [...document.querySelectorAll('aside section')].find((s) => s.textContent.includes('Load'));
        if (!sec) return false;
        const items = [...sec.querySelectorAll('li')];
        if (items.length === 0) return true;
        return items.every((li) => !/\\d+(\\.\\d+)?\\s*(MB|KB|GB)/.test(li.textContent));
      })()`
    )
  )

  console.log('\n=== 托盘与 closeToTray ===')
  // Electron 不公开「列出所有 Tray」的 API，改为验证可观察行为：
  // closeToTray 打开时按下关闭，窗口应被隐藏而不是销毁。
  // 前面的开关点击已把它翻成 true，但别依赖那个副作用 —— 显式置位
  await callIpc(Channels.settingsPatch, { closeToTray: true })
  check('closeToTray 已置为开', diskSettings().closeToTray === true, String(diskSettings().closeToTray))
  win.close()
  await sleep(900)
  check('closeToTray 开启时关闭只隐藏窗口', !win.isDestroyed() && !win.isVisible(), `destroyed=${win.isDestroyed()} visible=${win.isVisible()}`)
  win.show()
  await sleep(600)
  check('可重新显示窗口', win.isVisible())

  // 关掉 closeToTray 后，关闭应真的走销毁流程（此处只验设置生效，不真的关）
  await callIpc(Channels.settingsPatch, { closeToTray: false })
  check('closeToTray 可关闭', diskSettings().closeToTray === false)

  console.log('\n=== 无障碍回归 ===')
  await goto(win, '设置')
  const unlabeled = await js(
    win,
    `[...document.querySelectorAll('button')].filter((b) => !b.getAttribute('aria-label') && !b.textContent.trim() && !b.getAttribute('title')).length`
  )
  check('图标按钮无 aria-label 缺失', unlabeled === 0, `${unlabeled} 个无标签按钮`)
  const clipped = await js(
    win,
    `[...document.querySelectorAll('section[aria-labelledby^="settings-"] *')].filter((el) => el.scrollWidth > el.clientWidth + 1).length`
  )
  check('设置页无文字截断', clipped === 0, `${clipped} 个溢出元素`)

  console.log(`\n===== M6 §9.3 结果：PASS ${pass} / FAIL ${fail} =====`)
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
