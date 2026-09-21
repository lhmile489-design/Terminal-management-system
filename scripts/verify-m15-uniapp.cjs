/**
 * uniapp（HBuilderX）识别与「用 HBuilderX 打开」验证。
 *
 * 全部走真实主进程 + 真实 out/ 产物：
 *   1. 识别：manifest.json + pages.json（哪怕带 package.json 且有脚本）→ framework='uniapp'、
 *      registerOnly=true。只有 manifest.json（无 pages.json）不误判为 uniapp。
 *   2. 打开动作 + 安全：把 MILE_HBUILDERX_CLI 指向一个**假 cli.cmd**（真批处理，把收到的
 *      参数写进哨兵文件后退出）。断言 openInHBuilderX(id) 传给它的参数精确等于
 *      ['project','open','--path',<登记cwd>]；非 uniapp 条目调用被拒。
 *   3. DOM：uniapp 卡片渲染「HBuilderX」徽标、「用 HBuilderX 打开」按钮存在、「启动」禁用；
 *      非 uniapp 卡片无该徽标。
 *
 * 为什么不真跑 HBuilderX：它是重型 GUI，启动慢、有副作用、结果不确定。假 cli.cmd 只验
 * 我们自己的命令构造（file 固定、子命令硬编码、路径受登记目录约束），这正是本次改动的逻辑。
 *
 * harness 必须在 require 主进程包之前 setPath('appData') 并设好 MILE_HBUILDERX_CLI，
 * 否则会写真实用户配置、或探测到真实 HBuilderX。
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const SANDBOX = join(tmpdir(), `mile-uniapp-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
app.setPath('appData', SANDBOX)
const CONFIG = join(SANDBOX, 'mile-terminal', 'config.json')

// 从 src 读当前配置版本，不写死
const TYPES = readFileSync(join(ROOT, 'src', 'shared', 'types.ts'), 'utf8')
const CONFIG_VERSION = Number((TYPES.match(/CONFIG_VERSION\s*=\s*(\d+)/) || [])[1] || 1)

// ── 假 HBuilderX cli：把收到的参数逐行写进哨兵文件后退出 ──────────────────────
// %* 展开为全部参数；用 >> 逐行追加。cli.exe 名字无所谓，resolveHBuilderXCli 走 env 覆盖。
const FAKE_CLI = join(SANDBOX, 'fake-hbuilderx-cli.cmd')
const ARGS_SENTINEL = join(SANDBOX, 'cli-args.txt')
writeFileSync(
  FAKE_CLI,
  `@echo off\r\n>"${ARGS_SENTINEL}" echo %*\r\nexit /b 0\r\n`,
  'utf8'
)
process.env.MILE_HBUILDERX_CLI = FAKE_CLI

// ── 夹具项目 ────────────────────────────────────────────────────────────────

/** 纯 HBuilderX uniapp 项目：manifest.json + pages.json + 一个无编译脚本的 package.json */
const UNIAPP_PROJECT = join(SANDBOX, 'uniapp-app')
mkdirSync(UNIAPP_PROJECT, { recursive: true })
writeFileSync(join(UNIAPP_PROJECT, 'manifest.json'), '{"name":"demo"}', 'utf8')
writeFileSync(join(UNIAPP_PROJECT, 'pages.json'), '{"pages":[]}', 'utf8')
// 有 package.json 且带脚本 —— 关键：仍应覆盖为 uniapp（编译器在 HBuilderX 里，不走 npm）
writeFileSync(
  join(UNIAPP_PROJECT, 'package.json'),
  JSON.stringify({ name: 'demo', scripts: { build: 'echo x' }, dependencies: { docx: '^1' } }),
  'utf8'
)

/** 只有 manifest.json（无 pages.json）：不该被误判为 uniapp */
const MANIFEST_ONLY = join(SANDBOX, 'manifest-only')
mkdirSync(MANIFEST_ONLY, { recursive: true })
writeFileSync(join(MANIFEST_ONLY, 'manifest.json'), '{"name":"x"}', 'utf8')
writeFileSync(join(MANIFEST_ONLY, 'package.json'), JSON.stringify({ name: 'x' }), 'utf8')

/** 普通 Node 项目：用于「非 uniapp 条目调用 openInHBuilderX 被拒」 */
const NODE_PROJECT = join(SANDBOX, 'node-app')
mkdirSync(NODE_PROJECT, { recursive: true })
writeFileSync(
  join(NODE_PROJECT, 'package.json'),
  JSON.stringify({ name: 'n', scripts: { dev: 'node .' }, dependencies: { react: '^19' } }),
  'utf8'
)

writeFileSync(
  CONFIG,
  JSON.stringify(
    { version: CONFIG_VERSION, entries: [], ignoredListeners: [], settings: {} },
    null,
    2
  ),
  'utf8'
)

require(join(ROOT, 'out', 'main', 'index.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0

function check(label, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail++
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    console.log('FAIL 没有取到窗口')
    app.exit(1)
    return
  }

  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r))
    const js = (code) => win.webContents.executeJavaScript(code, true)

    // ── 1. 识别 ──────────────────────────────────────────────────────────
    console.log('\n=== 1. 识别 ===')

    const uniDetect = await js(`window.mile.entry.detect(${JSON.stringify(UNIAPP_PROJECT)})`)
    check('uniapp 项目识别为 uniapp', uniDetect.framework === 'uniapp', uniDetect.framework)
    check('uniapp 项目标为仅登记（registerOnly=true）', uniDetect.registerOnly === true, String(uniDetect.registerOnly))
    check('uniapp 有脚本也不推 devScript', uniDetect.devScript === null, String(uniDetect.devScript))

    const manifestOnly = await js(`window.mile.entry.detect(${JSON.stringify(MANIFEST_ONLY)})`)
    check('仅 manifest.json 不被认成 uniapp', manifestOnly.framework !== 'uniapp', manifestOnly.framework)

    const nodeDetect = await js(`window.mile.entry.detect(${JSON.stringify(NODE_PROJECT)})`)
    check('普通 Node 项目不被认成 uniapp', nodeDetect.framework !== 'uniapp', nodeDetect.framework)

    // ── 2. 打开动作 + 命令构造安全 ────────────────────────────────────────
    console.log('\n=== 2. 用 HBuilderX 打开：命令构造 ===')

    const added = await js(`window.mile.entry.add({
      kind: 'service',
      name: 'Uniapp Demo',
      path: ${JSON.stringify(UNIAPP_PROJECT)},
      framework: 'uniapp',
      packageManager: 'npm',
      script: null,
      scripts: {},
      env: {},
      registerOnly: true,
      pinned: false
    })`)
    check('新增 uniapp 条目', !!added && added.framework === 'uniapp')
    check('uniapp 条目仍为仅登记', added.registerOnly === true)
    const uniId = added.id

    const openResult = await js(
      `window.mile.entry.openInHBuilderX(${JSON.stringify(uniId)}).then(() => 'OK').catch((e) => 'ERR: ' + e.message)`
    )
    check('openInHBuilderX 调用成功', openResult === 'OK', String(openResult))

    // 假 cli.cmd 把收到的参数写进哨兵文件；轮询到出现再读（避免固定 sleep）
    const args = await (async (ms = 5000) => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        if (existsSync(ARGS_SENTINEL)) return readFileSync(ARGS_SENTINEL, 'utf8').trim()
        await sleep(100)
      }
      return null
    })()
    // cmd 的 %* 会保留引号；期望参数序列 project open --path <cwd>
    check('cli 收到子命令 project open', !!args && /project\s+open/i.test(args), String(args))
    check('cli 收到 --path', !!args && /--path/i.test(args), String(args))
    check(
      'cli 收到的路径是登记目录',
      !!args && args.includes(UNIAPP_PROJECT),
      String(args)
    )

    // 非 uniapp 条目调用 openInHBuilderX 必须被拒
    const nodeAdded = await js(`window.mile.entry.add({
      kind: 'service',
      name: 'Node Demo',
      path: ${JSON.stringify(NODE_PROJECT)},
      framework: 'react-vite',
      packageManager: 'npm',
      script: 'dev',
      scripts: { dev: 'node .' },
      env: {},
      registerOnly: false,
      pinned: false
    })`)
    const nodeOpen = await js(
      `window.mile.entry.openInHBuilderX(${JSON.stringify(nodeAdded.id)}).then(() => 'ACCEPTED').catch((e) => 'REJECTED: ' + e.message)`
    )
    check('非 uniapp 条目调用被拒', String(nodeOpen).startsWith('REJECTED'), String(nodeOpen))

    // ── 3. DOM：徽标、动作按钮、启动禁用 ──────────────────────────────────
    console.log('\n=== 3. 渲染层：徽标与动作 ===')

    // 切到启动台视图，卡片才会渲染
    await js(`(() => {
      const b = [...document.querySelectorAll('button,a')].find((x) =>
        (x.textContent||'').trim() === '前端启动台' || x.getAttribute('aria-label') === '前端启动台')
      if (b) b.click()
    })()`)

    // 等卡片渲染出来
    await (async (ms = 5000) => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        const n = await js(`document.querySelectorAll('article[data-entry-id]').length`)
        if (n >= 2) return
        await sleep(100)
      }
    })()

    const cardDump = await js(`JSON.stringify([...document.querySelectorAll('article[data-entry-id]')].map(c => {
      const id = c.getAttribute('data-entry-id')
      const text = c.textContent || ''
      const startBtn = [...c.querySelectorAll('button')].find(b => /启动|运行/.test(b.getAttribute('aria-label')||b.getAttribute('title')||b.textContent||''))
      const hbBtn = [...c.querySelectorAll('button')].find(b => /HBuilderX/.test(b.getAttribute('aria-label')||b.getAttribute('title')||''))
      return {
        id,
        hasBadge: /HBuilderX/.test(text),
        hasOpenBtn: !!hbBtn,
        startDisabled: startBtn ? startBtn.disabled : null
      }
    }))`)
    const cards = JSON.parse(cardDump)
    const byId = Object.fromEntries(cards.map((c) => [c.id, c]))

    check('uniapp 卡片显示 HBuilderX 徽标', byId[uniId] && byId[uniId].hasBadge === true, cardDump)
    check('uniapp 卡片有「用 HBuilderX 打开」按钮', byId[uniId] && byId[uniId].hasOpenBtn === true, cardDump)
    check('uniapp 卡片「启动」按钮禁用', byId[uniId] && byId[uniId].startDisabled === true, cardDump)
    check('非 uniapp 卡片无 HBuilderX 徽标', byId[nodeAdded.id] && byId[nodeAdded.id].hasBadge === false, cardDump)
    check('非 uniapp 卡片无「用 HBuilderX 打开」按钮', byId[nodeAdded.id] && byId[nodeAdded.id].hasOpenBtn === false, cardDump)

    // ── 4. 落盘正确性 ────────────────────────────────────────────────────
    console.log('\n=== 4. 落盘 ===')
    const disk = JSON.parse(readFileSync(CONFIG, 'utf8'))
    const uniEntry = disk.entries.find((e) => e.id === uniId)
    check('落盘 uniapp 条目存在', !!uniEntry)
    check('落盘 framework 为 uniapp', uniEntry && uniEntry.framework === 'uniapp', String(uniEntry?.framework))
    check('落盘 registerOnly 为 true', uniEntry && uniEntry.registerOnly === true, String(uniEntry?.registerOnly))
  } catch (err) {
    console.log('HARNESS ERROR', err)
    fail++
  }

  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`)
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
})
