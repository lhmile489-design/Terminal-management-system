/**
 * UI 重构基线与回归门禁，docs/UI/UI-REFACTOR.md 阶段 0。
 *
 * 在最小窗口 1180×760 下，深浅两套主题逐个视图实测：
 *   - 文字对比度（< 4.5:1、< 3:1 的数量与最差样本）
 *   - 小于 12px 的可见文字
 *   - 小于 24×24 的可点击目标
 *   - 标题栏高度、导航轨宽度、内容区宽度
 *
 * 用法：
 *   npm run build
 *   UI_BASELINE=write npx electron scripts/verify-ui.cjs   # 写入 scripts/ui-baseline.json
 *   npx electron scripts/verify-ui.cjs                     # 与基线比较，任何计数上升即失败
 *
 * 对比度计算：沿祖先链把半透明背景逐层合成到不透明底上，文字色再乘上
 * 元素自身及祖先的 opacity 合成到该底色。颜色统一画到 1×1 canvas 再读回，
 * 这样 color-mix / oklab 等写法也能得到 sRGB 值。
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const BASELINE = join(__dirname, 'ui-baseline.json')
const MODE = process.env.UI_BASELINE === 'write' ? 'write' : 'compare'
const SANDBOX = join(tmpdir(), `mile-ui-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
app.setPath('appData', SANDBOX)

const FIX = join(ROOT, 'scripts', 'fixture').replace(/\\/g, '/')
const FIXT = join(ROOT, 'scripts', 'fixture-task').replace(/\\/g, '/')
const now = Date.now()
const mk = (id, name, kind, path, script, scripts, order, registerOnly = false) => ({
  id, kind, name, path,
  framework: 'node', packageManager: 'npm',
  script, scripts, env: {}, registerOnly, pinned: false, order, createdAt: now
})

writeFileSync(
  join(SANDBOX, 'mile-terminal', 'config.json'),
  JSON.stringify({
    version: 1,
    entries: [
      mk('a', '个人博客', 'service', FIX, 'dev', { dev: 'node server.cjs' }, 0),
      mk('b', '公司文档站', 'service', FIX, 'dev', { dev: 'node server.cjs' }, 1),
      mk('d', '清理构建缓存', 'task', FIXT, 'build', { build: 'node make.cjs' }, 2),
      mk('e', '只登记不启动', 'service', FIX, 'dev', { dev: 'node server.cjs' }, 3, true)
    ],
    ignoredListeners: [],
    settings: {
      scanIntervalMs: 2000, theme: 'light', externalTerminal: 'wt',
      terminalFontSize: 13, scrollback: 5000, killOwnedOnQuit: true, closeToTray: false
    }
  }, null, 2),
  'utf8'
)

require(join(ROOT, 'out', 'main', 'index.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 导航顺序 = 视图清单。label 与 NavRail 的 aria-label 一致 */
const VIEWS = ['服务', '总览', '终端', '日志', '设置', '关于']
const THEMES = ['light', 'dark']

/** 在页面里执行的测量函数，返回单个视图的全部指标 */
const MEASURE = `(() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1
  const cx = cv.getContext('2d', { willReadFrequently: true })
  const cache = new Map()
  const rgba = (c) => {
    if (cache.has(c)) return cache.get(c)
    cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1)
    const d = cx.getImageData(0, 0, 1, 1).data
    const v = [d[0], d[1], d[2], d[3] / 255]
    cache.set(c, v); return v
  }
  const over = (top, bot) => {
    const a = top[3]
    return [top[0] * a + bot[0] * (1 - a), top[1] * a + bot[1] * (1 - a), top[2] * a + bot[2] * (1 - a), 1]
  }
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
  }
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }

  /** 从元素往上收集背景层，遇到不透明层停止，再自底向上合成 */
  const bgOf = (el) => {
    const layers = []
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const c = rgba(getComputedStyle(n).backgroundColor)
      if (c[3] > 0) { layers.push(c); if (c[3] >= 1) break }
    }
    let base = rgba(getComputedStyle(document.body).backgroundColor)
    if (base[3] < 1) base = over(base, [255, 255, 255, 1])
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base)
    return base
  }
  const opacityOf = (el) => {
    let o = 1
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity)
    return o
  }
  const visible = (el) => {
    const s = getComputedStyle(el)
    if (s.visibility === 'hidden' || s.display === 'none') return false
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return false
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false
    return opacityOf(el) > 0.05
  }
  const name = (el) => (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 24)

  // ---- 文字：按承载文字的元素去重 ----
  const seen = new Set()
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const texts = []
  for (let t = tw.nextNode(); t; t = tw.nextNode()) {
    if (!t.textContent.trim()) continue
    const el = t.parentElement
    if (!el || seen.has(el)) continue
    seen.add(el)
    if (el.closest('.xterm, [role="tooltip"], script, style')) continue
    if (!visible(el)) continue
    const s = getComputedStyle(el)
    const disabled = !!el.closest('[disabled], [aria-disabled="true"]')
    const bg = bgOf(el)
    const fg = over([...rgba(s.color).slice(0, 3), rgba(s.color)[3] * opacityOf(el)], bg)
    texts.push({ el, size: parseFloat(s.fontSize), ratio: Math.round(ratio(fg, bg) * 100) / 100, disabled })
  }
  const enabled = texts.filter((t) => !t.disabled)
  const lowContrast = enabled.filter((t) => t.ratio < 4.5)
  const veryLow = enabled.filter((t) => t.ratio < 3)
  const small = texts.filter((t) => t.size < 12)

  // ---- 可点击目标 ----
  const targets = [...document.querySelectorAll('button, a[href], [role="button"], [role="tab"], [role="switch"], input:not([type="hidden"]), select')]
    .filter((el) => !el.closest('.xterm') && visible(el))
  const tiny = targets.filter((el) => { const r = el.getBoundingClientRect(); return r.width < 24 || r.height < 24 })

  const box = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } }
  const sample = (arr, f) => arr.slice().sort(f).slice(0, 5)

  return {
    textCount: texts.length,
    lowContrast: lowContrast.length,
    veryLowContrast: veryLow.length,
    minRatio: enabled.length ? Math.min(...enabled.map((t) => t.ratio)) : null,
    smallText: small.length,
    targetCount: targets.length,
    tinyTargets: tiny.length,
    titleBar: box('header.drag-region'),
    nav: box('nav[aria-label="主导航"]'),
    main: box('main'),
    worstContrast: sample(lowContrast, (a, b) => a.ratio - b.ratio).map((t) => name(t.el) + '=' + t.ratio),
    worstSmall: sample(small, (a, b) => a.size - b.size).map((t) => name(t.el) + '=' + t.size + 'px'),
    worstTargets: tiny.slice(0, 5).map((el) => { const r = el.getBoundingClientRect(); return name(el) + '=' + Math.round(r.width) + '×' + Math.round(r.height) }),
    // UI_DUMP=<主题/视图> 时打印全部低对比度文字，用来定位回归
    allLow: lowContrast.map((t) => name(t.el) + '=' + t.ratio + ' [' + (t.el.className && t.el.className.baseVal == null ? String(t.el.className).slice(0, 60) : t.el.tagName) + ']')
  }
})()`

/** 参与回归比较的计数；数值只许持平或下降 */
const GATED = ['lowContrast', 'veryLowContrast', 'smallText', 'tinyTargets']

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  win.setBounds({ width: 1180, height: 760 })
  const js = (code) => win.webContents.executeJavaScript(code, true)

  await js(`window.mile.scanner.setVisible(true); window.mile.scanner.refresh(); true`)
  await sleep(2500)

  const goto = async (label) => {
    await js(`(()=>{const b=[...document.querySelectorAll('nav button')]
      .find(x=>x.getAttribute('aria-label')===${JSON.stringify(label)});b&&b.click();return !!b})()`)
    for (let i = 0; i < 25; i++) {
      const h = await js(`(document.querySelector('main h1')||document.querySelector('h1')||{textContent:''}).textContent.trim()`)
      if (h.startsWith(label)) { await sleep(500); return true }
      await sleep(200)
    }
    return false
  }

  const results = {}
  let navFailures = 0
  for (const theme of THEMES) {
    await js(`window.mile.settings.patch({theme:'${theme}'})`)
    for (let i = 0; i < 40; i++) {
      if (await js(`document.documentElement.dataset.theme === '${theme}'`)) break
      await sleep(100)
    }
    await sleep(400)
    for (const view of VIEWS) {
      const ok = await goto(view)
      if (!ok) { navFailures++; console.log(`  FAIL  无法进入视图：${view}`); continue }
      results[`${theme}/${view}`] = await js(MEASURE)
    }
  }

  console.log('\n视图/主题'.padEnd(18) + '文字  <4.5  <3   最低    <12px  目标  <24px  标题栏  导航  内容区')
  for (const [k, r] of Object.entries(results)) {
    console.log(
      k.padEnd(16) +
      String(r.textCount).padStart(4) + String(r.lowContrast).padStart(6) + String(r.veryLowContrast).padStart(5) +
      String(r.minRatio).padStart(7) + String(r.smallText).padStart(7) + String(r.targetCount).padStart(6) +
      String(r.tinyTargets).padStart(7) + String(r.titleBar ? r.titleBar.h : '-').padStart(7) +
      String(r.nav ? r.nav.w : '-').padStart(6) + String(r.main ? r.main.w : '-').padStart(7)
    )
  }
  console.log('\n最差样本：')
  for (const [k, r] of Object.entries(results)) {
    if (r.worstContrast.length) console.log(`  ${k} 对比度：${r.worstContrast.join('，')}`)
    if (r.worstSmall.length) console.log(`  ${k} 小字：${r.worstSmall.join('，')}`)
    if (r.worstTargets.length) console.log(`  ${k} 小目标：${r.worstTargets.join('，')}`)
  }

  if (process.env.UI_DUMP && results[process.env.UI_DUMP]) {
    console.log(`\n${process.env.UI_DUMP} 全部 < 4.5:1 的文字：`)
    for (const line of results[process.env.UI_DUMP].allLow) console.log('  ' + line)
  }

  let fail = navFailures
  if (MODE === 'write') {
    const slim = Object.fromEntries(Object.entries(results).map(([k, r]) =>
      [k, Object.fromEntries(GATED.map((g) => [g, r[g]]).concat([['titleBarH', r.titleBar && r.titleBar.h], ['navW', r.nav && r.nav.w]]))]))
    writeFileSync(BASELINE, JSON.stringify({ measuredAt: new Date().toISOString(), window: '1180x760', views: slim }, null, 2) + '\n', 'utf8')
    console.log(`\n基线已写入 ${BASELINE}`)
  } else if (!existsSync(BASELINE)) {
    console.log('\n没有基线文件，先用 UI_BASELINE=write 跑一次')
    fail++
  } else {
    const base = JSON.parse(readFileSync(BASELINE, 'utf8')).views
    console.log('\n与基线比较：')
    for (const [k, r] of Object.entries(results)) {
      const b = base[k]
      if (!b) continue
      for (const g of GATED) {
        if (r[g] > b[g]) { fail++; console.log(`  FAIL  ${k} ${g} ${b[g]} → ${r[g]}`) }
      }
    }
    if (fail === 0) console.log('  PASS  所有计数持平或下降')
  }

  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`)
  }
  app.exit(fail === 0 ? 0 : 1)
})
