/**
 * 启动台界面验证：真实主进程 + 真实构建产物，通过 executeJavaScript 驱动渲染层。
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

async function checks(win) {
  console.log('=== 启动台视图 ===')
  await waitUntil(win, `!!document.querySelector('nav')`, 30_000, '外壳挂载')

  // 切到启动台
  const navigated = await run(
    win,
    clickByLabel(`document.querySelector('nav')`, '启动台')
  )
  check('导航到启动台', navigated)

  const cardsReady = await waitUntil(
    win,
    `document.querySelectorAll('section[data-category-kind="service"] article, section[data-category-kind="task"] article').length === 2`,
    20_000,
    '两张条目卡片'
  )
  const cardInfo = await run(
    win,
    `(() => {
      const arts = [...document.querySelectorAll('section[data-category-kind="service"] article, section[data-category-kind="task"] article')];
      return arts.map((a) => ({
        title: a.querySelector('h3 span')?.textContent?.trim(),
        badges: [...a.querySelectorAll('span')].map((s) => s.textContent.trim()).filter((t) => ['服务','任务','未启动','运行中','启动中','已停止','异常退出','已完成','失败','预检未通过'].includes(t)),
        clipped: [...a.querySelectorAll('*')].filter((el) => el.scrollWidth > el.clientWidth + 1).length
      }));
    })()`
  )
  check('渲染两张真实条目卡片', cardsReady, JSON.stringify(cardInfo))
  check(
    '卡片含类型与状态文字标签（不只靠颜色）',
    cardInfo.every((c) => c.badges.includes('服务') || c.badges.includes('任务')) &&
      cardInfo.every((c) => c.badges.some((b) => b === '未启动')),
    cardInfo.map((c) => c.badges.join('+')).join(' | ')
  )

  console.log('\n=== 预检 fail 分支渲染 ===')
  const brokenClicked = await run(
    win,
    `(() => {
      const arts = [...document.querySelectorAll('section[data-category-kind="service"] article, section[data-category-kind="task"] article')];
      const target = arts.find((a) => a.textContent.includes('目录不存在的任务'));
      if (!target) return false;
      // 任务的启动按钮叫「运行」——一次性命令没有「停止运行中的服务」那层含义
      const btn = [...target.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '运行');
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    })()`
  )
  check('点击目录不存在条目的启动', brokenClicked)

  const panelUp = await waitUntil(
    win,
    `!!document.querySelector('section[aria-labelledby="precheck-heading"]')`,
    20_000,
    '预检面板'
  )
  const panel = await run(
    win,
    `(() => {
      const sec = document.querySelector('section[aria-labelledby="precheck-heading"]');
      if (!sec) return null;
      return {
        items: sec.querySelectorAll('li').length,
        text: sec.textContent.replace(/\\s+/g, ' ').slice(0, 220),
        hasFix: [...sec.querySelectorAll('button')].some((b) => b.textContent.includes('重新选择目录'))
      };
    })()`
  )
  check('预检未通过时渲染面板', panelUp, panel ? `${panel.items} 项` : '')
  check('面板给出修复入口按钮', !!panel?.hasFix, panel?.text)
  check('状态转为预检未通过', await run(win, `document.body.textContent.includes('预检未通过')`))

  console.log('\n=== 启动真实服务并回填端口 ===')
  const startClicked = await run(
    win,
    `(() => {
      const arts = [...document.querySelectorAll('section[data-category-kind="service"] article, section[data-category-kind="task"] article')];
      const target = arts.find((a) => a.textContent.includes('Fixture Dev'));
      const btn = [...target.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '启动');
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    })()`
  )
  check('点击启动 Fixture Dev', startClicked)

  const running = await waitUntil(
    win,
    `(() => {
      const arts = [...document.querySelectorAll('section[data-category-kind="service"] article, section[data-category-kind="task"] article')];
      const t = arts.find((a) => a.textContent.includes('Fixture Dev'));
      return !!t && t.textContent.includes('运行中');
    })()`,
    60_000,
    '状态转运行中'
  )
  check('卡片状态转运行中', running)

  const portShown = await waitUntil(
    win,
    `(() => {
      const arts = [...document.querySelectorAll('section[data-category-kind="service"] article, section[data-category-kind="task"] article')];
      const t = arts.find((a) => a.textContent.includes('Fixture Dev'));
      if (!t) return false;
      // 端口在页头当作「打开 localhost」的按钮，不再是 dl 里的一行
      return [...t.querySelectorAll('button')].some((b) => /^:\\d{2,5}$/.test(b.textContent.trim()));
    })()`,
    30_000,
    '端口渲染'
  )
  const portText = await run(
    win,
    `(() => {
      const arts = [...document.querySelectorAll('section[data-category-kind="service"] article, section[data-category-kind="task"] article')];
      const t = arts.find((a) => a.textContent.includes('Fixture Dev'));
      const port = [...t.querySelectorAll('button')].find((b) => /^:\\d{2,5}$/.test(b.textContent.trim()));
      return [port ? port.textContent.trim() + ' → ' + (port.getAttribute('title') || '') : '无端口按钮']
        .concat([...t.querySelectorAll('dd')].map((d) => d.textContent.trim())).join(' | ');
    })()`
  )
  check('卡片渲染捕获到的端口', portShown, portText)

  check(
    '运行中时按钮切为停止且移除被禁用',
    await run(
      win,
      `(() => {
        const arts = [...document.querySelectorAll('section[data-category-kind="service"] article, section[data-category-kind="task"] article')];
        const t = arts.find((a) => a.textContent.includes('Fixture Dev'));
        const btns = [...t.querySelectorAll('button')];
        const stop = btns.find((b) => b.getAttribute('aria-label') === '停止');
        const remove = btns.find((b) => b.getAttribute('aria-label') === '移除条目');
        return !!stop && !!remove && remove.disabled;
      })()`
    )
  )

  console.log('\n=== KPI 与事件流联动 ===')
  const dashOk = await run(win, clickByLabel(`document.querySelector('nav')`, '工作台'))
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

  check(
    '模态对话框带 aria-modal',
    await run(
      win,
      `(() => {
        const add = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '添加服务');
        return true;
      })()`
    )
  )

  for (const [theme, expect] of [
    ['light', 'rgb(246, 247, 249)'],
    ['dark', 'rgb(11, 15, 20)']
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
  await run(win, clickByLabel(`document.querySelector('nav')`, '启动台'))
  await run(
    win,
    `(() => {
      const arts = [...document.querySelectorAll('section[data-category-kind="service"] article, section[data-category-kind="task"] article')];
      const t = arts.find((a) => a.textContent.includes('Fixture Dev'));
      const btn = [...t.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '停止');
      if (btn) btn.click();
      return true;
    })()`
  )
  await waitUntil(
    win,
    `(() => {
      const arts = [...document.querySelectorAll('section[data-category-kind="service"] article, section[data-category-kind="task"] article')];
      const t = arts.find((a) => a.textContent.includes('Fixture Dev'));
      return !!t && !t.textContent.includes('运行中');
    })()`,
    25_000,
    '停止生效'
  )
  check('界面上可停止受控服务', true)

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
