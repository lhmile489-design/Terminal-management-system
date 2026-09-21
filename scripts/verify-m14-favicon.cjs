/**
 * M14 验证：识别到前端项目时读取本地 favicon 显示在卡片/列表图标位。
 *
 * 分两段：
 *  1. 主进程读取正确性（真实文件系统夹具）—— favicon(id) 的来源、优先级、
 *     框架门槛与路径逃逸拦截。断言带内容比对，不只是「非空」，避免读错文件也算过。
 *  2. 渲染层显示 —— 前端条目卡片图标瓦片里出现 <img src="data:image/...">，
 *     非前端条目回退字标 <span>。断言带计数，防选择器选空静默通过。
 *
 * 与其它 harness 一样：必须在 require 主进程包之前 app.setPath('appData', sandbox)，
 * 否则会写到真实的 %APPDATA%/mile-terminal/config.json。
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const SANDBOX = join(tmpdir(), `mile-m14-${process.pid}`)
const PROJECTS = join(SANDBOX, 'projects')

// —— favicon 夹具内容（内容比对用，故写成已知常量）——
const REACT_FAVICON = '<svg xmlns="http://www.w3.org/2000/svg"><!-- react favicon --></svg>'
// 真实 1×1 PNG：<img> 要能解码，否则 onError 会回退字标，DOM 断言就验不到图片。
const BRAND_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const BRAND_PNG = Buffer.from(BRAND_PNG_B64, 'base64')
const ICO_BYTES = 'ICO-BYTES-lower-priority'
const BARE_ICO = 'ICO-in-unknown-project'

function mk(dir, file, content) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), content)
}

function buildSandbox() {
  mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })

  // e-react：react-vite，public 下同时有 svg 与 ico —— 应取优先级更高的 svg
  const react = join(PROJECTS, 'react-app')
  mk(join(react, 'public'), 'favicon.svg', REACT_FAVICON)
  mk(join(react, 'public'), 'favicon.ico', ICO_BYTES)

  // e-htmllink：next，图标在非约定位置，靠 index.html 的 <link rel=icon> 找到
  const htmllink = join(PROJECTS, 'html-link-app')
  mk(htmllink, 'index.html', '<html><head><link rel="icon" href="assets/brand.png"></head></html>')
  mk(join(htmllink, 'assets'), 'brand.png', BRAND_PNG)

  // e-escape：next，index.html 的 href 用 ../ 逃出项目根 —— 必须被拒。
  // secret 放在项目根的上一级（projects/secret.png），href 用 ../secret.png：
  // 守卫开着时读不到（返回 null）；守卫若被关掉就会读到 —— 这正是反向对照要验的。
  const escape = join(PROJECTS, 'escape-app')
  mk(escape, 'index.html', '<html><head><link rel="icon" href="../secret.png"></head></html>')
  mk(PROJECTS, 'secret.png', 'SECRET-SHOULD-NOT-BE-READ')

  // e-go：go 后端项目，目录里放个 favicon.ico 也不该被当网站图标
  const go = join(PROJECTS, 'go-app')
  mk(go, 'favicon.ico', 'GO-ICO-NOT-A-WEBSITE-ICON')

  // e-bareicon：unknown 框架，有 favicon.ico 但框架门槛挡住
  const bare = join(PROJECTS, 'bare-app')
  mk(bare, 'favicon.ico', BARE_ICO)

  const entry = (id, name, framework, path) => ({
    id,
    kind: framework === 'go' || framework === 'unknown' ? 'task' : 'service',
    name,
    path,
    framework,
    packageManager: 'npm',
    script: framework === 'go' || framework === 'unknown' ? null : 'dev',
    scripts: {},
    env: {},
    registerOnly: framework === 'go' || framework === 'unknown',
    pinned: false,
    order: 0,
    createdAt: Date.now()
  })

  const config = {
    version: 1, // 起低版本走迁移，别写死当前版本号
    entries: [
      entry('e-react', 'React App', 'react-vite', react),
      entry('e-htmllink', 'Next App', 'next', htmllink),
      entry('e-escape', 'Escape App', 'next', escape),
      entry('e-go', 'Go App', 'go', go),
      entry('e-bareicon', 'Bare App', 'unknown', bare)
    ],
    ignoredListeners: [],
    settings: {}
  }
  writeFileSync(join(SANDBOX, 'mile-terminal', 'config.json'), JSON.stringify(config, null, 2), 'utf8')
}

buildSandbox()
app.setPath('appData', SANDBOX)
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
    win.setBounds({ width: 1500, height: 940 })
    const js = (code) => win.webContents.executeJavaScript(code, true)
    const waitFor = async (expr, ms = 8000) => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        if (await js(expr)) return true
        await sleep(120)
      }
      return false
    }

    console.log('\n=== 1. 主进程 favicon(id) 读取正确性 ===')
    const svg = (id) => js(`window.mile.entry.favicon(${JSON.stringify(id)})`)

    const react = await svg('e-react')
    check(
      'react-vite 条目读到 favicon',
      typeof react === 'string' && react.startsWith('data:image/svg+xml;base64,'),
      `got=${String(react).slice(0, 40)}`
    )
    const decoded = react ? Buffer.from(react.split(',')[1], 'base64').toString('utf8') : ''
    check('favicon 内容与写入一致', decoded === REACT_FAVICON, `len=${decoded.length}`)
    check('优先级取 svg 而非 ico', !!react && react.startsWith('data:image/svg+xml'), 'svg 应优先')

    const htmllink = await svg('e-htmllink')
    check(
      'index.html <link rel=icon> 解析生效',
      typeof htmllink === 'string' && htmllink.startsWith('data:image/png;base64,'),
      `got=${String(htmllink).slice(0, 40)}`
    )
    const linkDecoded = htmllink ? htmllink.split(',')[1] : ''
    check('link 指向的文件内容一致', linkDecoded === BRAND_PNG_B64, `len=${linkDecoded.length}`)

    console.log('\n=== 2. 安全与门槛 ===')
    const go = await svg('e-go')
    check('非前端框架（go）返回 null', go === null, `got=${JSON.stringify(go)}`)

    const missing = await svg('does-not-exist')
    check('未知 id 返回 null', missing === null, `got=${JSON.stringify(missing)}`)

    const escape = await svg('e-escape')
    check('路径逃逸（../）被拒', escape === null, `got=${JSON.stringify(escape)}`)

    const bare = await svg('e-bareicon')
    check('unknown 框架即使有 .ico 也返回 null', bare === null, `got=${JSON.stringify(bare)}`)

    console.log('\n=== 3. 渲染层：卡片图标瓦片显示 <img> ===')
    await js(`(() => {
      const b = [...document.querySelectorAll('button,a')].find((x) =>
        (x.textContent||'').trim() === '前端启动台' || x.getAttribute('aria-label') === '前端启动台')
      if (b) b.click()
    })()`)
    check(
      '卡片已渲染',
      await waitFor(`document.querySelectorAll('article[data-entry-id]').length >= 3`)
    )
    // favicon 是挂载后异步懒加载的：轮询到 img 出现再断言，别用固定时序把「还没加载」误判成「没有」
    check(
      '前端卡片的 favicon 图片已加载',
      await waitFor(
        `document.querySelectorAll('article[data-entry-id] .icon-tile img[src^="data:image/"]').length >= 2`
      )
    )

    const reactImg = await js(`(() => {
      const card = document.querySelector('article[data-entry-id="e-react"]')
      if (!card) return 'no-card'
      const img = card.querySelector('.icon-tile img')
      if (!img) return 'no-img'
      return img.getAttribute('src') || ''
    })()`)
    check(
      'react 卡片图标瓦片内是 data:image 的 <img>',
      typeof reactImg === 'string' && reactImg.startsWith('data:image/'),
      `src=${String(reactImg).slice(0, 30)}`
    )

    const goGlyph = await js(`(() => {
      const card = document.querySelector('article[data-entry-id="e-go"]')
      if (!card) return 'no-card'
      const img = card.querySelector('.icon-tile img')
      const span = card.querySelector('.icon-tile span')
      return { hasImg: !!img, glyph: span ? (span.textContent||'').trim() : null }
    })()`)
    check('go 卡片无 img', goGlyph && goGlyph.hasImg === false, JSON.stringify(goGlyph))
    check('go 卡片回退字标 Go', goGlyph && goGlyph.glyph === 'Go', JSON.stringify(goGlyph))

    const imgCount = await js(
      `document.querySelectorAll('article[data-entry-id] .icon-tile img[src^="data:image/"]').length`
    )
    check('带 favicon 图片的卡片数 ≥ 2', imgCount >= 2, `imgCount=${imgCount}`)

    // 全卡片矩阵：web 框架显图片、非 web / 逃逸 / unknown 回退字标
    const dump = await js(`JSON.stringify([...document.querySelectorAll('article[data-entry-id]')].map(c => ({
      id: c.getAttribute('data-entry-id'),
      hasImg: !!c.querySelector('.icon-tile img'),
      glyph: (c.querySelector('.icon-tile span')||{}).textContent || null
    })))`)
    const cards = JSON.parse(dump)
    const byId = Object.fromEntries(cards.map((c) => [c.id, c]))
    check('全卡片矩阵：5 张卡片齐全', cards.length === 5, `count=${cards.length}`)
    check('e-react 显图片', byId['e-react'] && byId['e-react'].hasImg === true, dump)
    check('e-htmllink 显图片', byId['e-htmllink'] && byId['e-htmllink'].hasImg === true, dump)
    check('e-escape 逃逸被拒回退字标', byId['e-escape'] && byId['e-escape'].hasImg === false, dump)
    check('e-go 非 web 回退字标', byId['e-go'] && byId['e-go'].hasImg === false, dump)
    check('e-bareicon unknown 回退字标', byId['e-bareicon'] && byId['e-bareicon'].hasImg === false, dump)
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
