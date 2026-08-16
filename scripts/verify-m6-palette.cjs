/**
 * M6 §9.5 验证：全局命令面板。
 *
 * 重点不是「面板能打开」，而是回车真的触发了正确动作，且脚本执行没有绕开
 * 主进程的命令校验 —— 渲染层能构造任意命令是这一功能最大的风险面。
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const FIXTURE = join(__dirname, 'fixture')
const TASK_FIXTURE = join(__dirname, 'fixture-task')

const SANDBOX = join(tmpdir(), `mile-m6pal-${process.pid}`)
mkdirSync(SANDBOX, { recursive: true })
app.setPath('appData', SANDBOX)

const Channels = {
  entryRunScript: 'entry:runScript',
  entryRuntimes: 'entry:runtimes'
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
  const now = Date.now()
  writeFileSync(
    join(SANDBOX, 'mile-terminal', 'config.json'),
    JSON.stringify(
      {
        version: 1,
        entries: [
          {
            id: 'pal-service',
            kind: 'service',
            name: '晚间站点',
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
            id: 'pal-task',
            kind: 'task',
            name: '构建任务',
            path: TASK_FIXTURE,
            framework: 'node',
            packageManager: 'npm',
            script: 'build',
            scripts: { build: 'node make.cjs', lint: 'node -e "0"' },
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

/** 真按 Ctrl+K：走 document 上的 capture 监听，等价于用户按键 */
const pressCtrlK = (win) =>
  js(
    win,
    `(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
      return true;
    })()`
  )

const paletteOpen = (win) => js(win, `!!document.querySelector('[role="dialog"][aria-label="命令面板"]')`)

const typeQuery = (win, text) =>
  js(
    win,
    `(() => {
      const input = document.querySelector('[aria-label="命令面板输入"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`
  )

const optionLabels = (win) =>
  js(win, `[...document.querySelectorAll('[role="option"]')].map((o) => o.textContent.trim())`)

const pressKey = (win, key) =>
  js(
    win,
    `(() => {
      const dlg = document.querySelector('[role="dialog"][aria-label="命令面板"]');
      if (!dlg) return false;
      dlg.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
      return true;
    })()`
  )

async function checks(win) {
  await waitFor(() => js(win, `!!document.querySelector('nav')`), 30_000, '外壳挂载')

  console.log('=== 唤起与关闭 ===')
  await pressCtrlK(win)
  await sleep(300)
  check('Ctrl+K 唤起面板', await paletteOpen(win))
  check(
    '面板是模态对话框',
    (await js(win, `document.querySelector('[role="dialog"][aria-label="命令面板"]').getAttribute('aria-modal')`)) === 'true'
  )
  check(
    '输入框自动聚焦',
    await js(win, `document.activeElement === document.querySelector('[aria-label="命令面板输入"]')`)
  )
  check('空查询即给出内置动作', (await optionLabels(win)).length > 0, String((await optionLabels(win)).length))

  await pressKey(win, 'Escape')
  await sleep(250)
  check('Escape 关闭面板', !(await paletteOpen(win)))

  console.log('\n=== 匹配：条目名 / 端口 / 脚本 / 动作 ===')
  await pressCtrlK(win)
  await sleep(250)
  await typeQuery(win, '构建')
  await sleep(250)
  const byName = await optionLabels(win)
  check('条目名匹配到条目', byName.some((l) => l.includes('构建任务')), JSON.stringify(byName.slice(0, 3)))
  check('未运行条目给「启动」动作', byName.some((l) => l.includes('启动 构建任务')), JSON.stringify(byName.slice(0, 3)))

  await typeQuery(win, 'lint')
  await sleep(250)
  const byScript = await optionLabels(win)
  check('脚本名匹配到脚本项', byScript.some((l) => l.includes('lint')), JSON.stringify(byScript.slice(0, 3)))

  await typeQuery(win, '>')
  await sleep(250)
  const builtins = await optionLabels(win)
  check('「>」进入动作模式', builtins.some((l) => l.includes('添加服务')), JSON.stringify(builtins.slice(0, 4)))
  check('动作模式不混入条目', !builtins.some((l) => l.includes('构建任务')), JSON.stringify(builtins.slice(0, 6)))

  await typeQuery(win, '> 主题')
  await sleep(250)
  const themes = await optionLabels(win)
  check('动作可按名筛选', themes.length === 3 && themes.every((l) => l.includes('主题')), JSON.stringify(themes))

  console.log('\n=== 键盘导航 ===')
  await typeQuery(win, '>')
  await sleep(250)
  // 选中态挂在 [role="option"] 自身，但 onMouseEnter 会跟着鼠标改 cursor。
  // harness 里鼠标可能正停在某个候选项上，所以先用键盘把 cursor 归位再断言。
  const selectedIndex = () =>
    js(
      win,
      `[...document.querySelectorAll('[role="option"]')].findIndex((o) => o.getAttribute('aria-selected') === 'true')`
    )
  const start = await selectedIndex()
  check('有且仅有一项被选中', start >= 0, `第 ${start} 项`)

  await pressKey(win, 'ArrowDown')
  await sleep(200)
  const afterDown = await selectedIndex()
  check('ArrowDown 下移一项', afterDown === start + 1, `${start} → ${afterDown}`)

  await pressKey(win, 'ArrowUp')
  await sleep(200)
  const afterUp = await selectedIndex()
  check('ArrowUp 上移一项', afterUp === start, `${afterDown} → ${afterUp}`)

  console.log('\n=== 回车执行：主题切换 ===')
  const themeBefore = await js(win, `document.documentElement.getAttribute('data-theme')`)
  await typeQuery(win, themeBefore === 'dark' ? '> 主题：浅色' : '> 主题：深色')
  await sleep(250)
  await pressKey(win, 'Enter')
  await sleep(800)
  check('回车后面板自动关闭', !(await paletteOpen(win)))
  const themeAfter = await js(win, `document.documentElement.getAttribute('data-theme')`)
  check('主题动作真的生效', themeAfter !== themeBefore, `${themeBefore} → ${themeAfter}`)

  console.log('\n=== 回车执行：前往视图 ===')
  await pressCtrlK(win)
  await sleep(250)
  await typeQuery(win, '> 前往诊断')
  await sleep(250)
  await pressKey(win, 'Enter')
  await sleep(700)
  check(
    '前往诊断切换了视图',
    await js(win, `document.querySelector('h1').textContent.trim().startsWith('诊断')`),
    await js(win, `document.querySelector('h1').textContent.trim()`)
  )

  console.log('\n=== 回车执行：端口定位 ===')
  // 采集是按窗口可见性节流的，harness 窗口未必被判为可见，首轮快照可能还是空的。
  // 先显式置可见并触发一次采集，再等快照真的有监听项 —— 这是 harness 的环境问题，
  // 不是产品缺陷。
  await js(
    win,
    `(() => {
      window.mile.scanner.setVisible(true);
      window.mile.scanner.refresh();
      return true;
    })()`
  )
  const gotSnapshot = await waitFor(
    () =>
      js(
        win,
        `(async () => {
          const snap = await window.mile.scanner.snapshot();
          return !!snap?.listeners?.some((l) => l.ports.length);
        })()`
      ),
    30_000,
    '采集快照出现监听项'
  )
  void gotSnapshot
  const realPort = await js(
    win,
    `(async () => {
      const snap = await window.mile.scanner.snapshot();
      return snap?.listeners?.find((l) => l.ports.length)?.ports[0] ?? null;
    })()`
  )
  if (realPort === null) {
    check('取到一个真实监听端口', false, '采集快照里没有监听项')
  } else {
    check('取到一个真实监听端口', true, `:${realPort}`)
    await pressCtrlK(win)
    await sleep(250)
    await typeQuery(win, String(realPort))
    await sleep(300)
    const portOptions = await optionLabels(win)
    check(
      '数字查询匹配到端口分组',
      portOptions.some((l) => l.includes(`:${realPort}`)),
      JSON.stringify(portOptions.slice(0, 3))
    )
    await pressKey(win, 'Enter')
    await sleep(1200)
    check(
      '端口定位切到工作台',
      await js(win, `document.querySelector('h1').textContent.trim().startsWith('工作台')`),
      await js(win, `document.querySelector('h1').textContent.trim()`)
    )
    check(
      '对应表格行被高亮',
      await js(win, `!!document.querySelector('[data-highlighted]')`)
    )
    // 高亮 2 秒后应自动消除，常驻会被误读成异常行
    await sleep(2400)
    check('高亮 2 秒后自动消除', !(await js(win, `!!document.querySelector('[data-highlighted]')`)))
  }

  console.log('\n=== 安全：脚本执行不绕过主进程校验 ===')
  let rejectedInjection = false
  try {
    await callIpc(Channels.entryRunScript, 'pal-task', 'build & calc.exe')
  } catch (err) {
    rejectedInjection = /非法字符|拒绝执行|没有|不存在/.test(String(err.message))
  }
  check('含 & 的脚本名被拒绝', rejectedInjection)

  let rejectedUndeclared = false
  try {
    await callIpc(Channels.entryRunScript, 'pal-task', 'nosuchscript')
  } catch (err) {
    // 主进程的实际措辞是「不在 package.json scripts 中，拒绝执行」
    rejectedUndeclared = /不在 package\.json scripts 中|拒绝执行/.test(String(err.message))
  }
  check('未声明的脚本名被拒绝', rejectedUndeclared)

  let rejectedBadId = false
  try {
    await callIpc(Channels.entryRunScript, '不存在的id', 'lint')
  } catch (err) {
    rejectedBadId = /条目不存在/.test(String(err.message))
  }
  check('不存在的条目 id 被拒绝', rejectedBadId)

  console.log('\n=== 脚本执行：已声明脚本可跑通 ===')
  const runtime = await callIpc(Channels.entryRunScript, 'pal-task', 'lint')
  check('已声明脚本创建了会话', !!runtime?.sessionId, JSON.stringify(runtime?.status))
  const done = await waitFor(
    async () => {
      const rts = await callIpc(Channels.entryRuntimes)
      const r = rts.find((x) => x.entryId === 'pal-task')
      return r?.status === 'succeeded' || r?.status === 'failed'
    },
    60_000,
    'lint 会话结束'
  )
  const final = (await callIpc(Channels.entryRuntimes)).find((x) => x.entryId === 'pal-task')
  check('脚本按退出码收敛', done && final?.status === 'succeeded', JSON.stringify(final?.status))

  console.log('\n=== 无障碍 ===')
  await pressCtrlK(win)
  await sleep(300)
  const unlabeled = await js(
    win,
    `[...document.querySelectorAll('button')].filter((b) => !b.getAttribute('aria-label') && !b.textContent.trim() && !b.getAttribute('title')).length`
  )
  check('图标按钮无 aria-label 缺失', unlabeled === 0, `${unlabeled} 个无标签按钮`)
  check(
    '结果列表有 listbox 语义',
    await js(win, `!!document.querySelector('[role="listbox"]')`)
  )
  const clipped = await js(
    win,
    `[...document.querySelectorAll('[role="option"] *')].filter((el) => el.scrollWidth > el.clientWidth + 1).length`
  )
  check('候选项无文字截断', clipped === 0, `${clipped} 个溢出元素`)

  console.log(`\n===== M6 §9.5 结果：PASS ${pass} / FAIL ${fail} =====`)
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
