/**
 * S33 视觉对等的共用探针：原版（Electron，scripts/s33-orig.cjs）与 mygo 版（CDP，scripts/cdp-s33-visual.mjs）
 * 跑的是同一份页面端测量代码、同一套播种数据、同一个流程，结果写到 build/s33/<side>/，
 * 再由 scripts/s33-diff.mjs 逐页对拍。
 *
 * 断言口径照抄原版：
 *   - verify-ui.cjs 的 MEASURE（对比度沿祖先链合成、<12px 文字、<24px 目标、标题栏 / 导航 / 内容区尺寸），
 *     在最小窗口 1180×760 下深浅各量一轮
 *   - verify-m7-visual.cjs：标题 22px / 700 / Manrope、磁贴 16px 圆角、浅色静态阴影 / 深色靠描边、全页 0 处渐变
 *   - verify-m12-press.cjs：主按钮按下缩到 0.96、不下沉、松开回弹，真实输入（CDP Input.dispatchMouseEvent）
 *
 * driver 接口：{ eval(expr) → 值, send(method, params) → CDP 结果 }。两边都用 CDP 的
 * Emulation.setDeviceMetricsOverride 把布局视口固定到同一尺寸、deviceScaleFactor 1，
 * 截图走 Page.captureScreenshot，所以像素尺寸一致，可以直接并排看。
 */

const VIEWS = ['总览', '服务', '进度', '终端', '设置', '关于']
const THEMES = ['light', 'dark']
const SLUG = { 总览: 'dashboard', 服务: 'services', 进度: 'planner', 终端: 'terminal', 设置: 'settings', 关于: 'about' }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 播种用的配置（version 1，走两边各自的迁移链到 16）。fixture 路径只读，不启动 */
function seedConfig(fixtureDir, fixtureTaskDir) {
  const now = 1763200000000
  const mk = (id, name, kind, path, script, scripts, order, registerOnly = false) => ({
    id, kind, name, path, framework: 'node', packageManager: 'npm',
    script, scripts, env: {}, registerOnly, pinned: false, order, createdAt: now
  })
  return {
    version: 1,
    entries: [
      mk('a', '个人博客', 'service', fixtureDir, 'dev', { dev: 'node server.cjs' }, 0),
      mk('b', '公司文档站', 'service', fixtureDir, 'dev', { dev: 'node server.cjs' }, 1),
      mk('c', '后台管理', 'service', fixtureDir, 'dev', { dev: 'node server.cjs' }, 2),
      mk('d', '清理构建缓存', 'task', fixtureTaskDir, 'build', { build: 'node make.cjs' }, 3),
      mk('e', '只登记不启动', 'service', fixtureDir, 'dev', { dev: 'node server.cjs' }, 4, true)
    ],
    ignoredListeners: [],
    settings: {
      scanIntervalMs: 2000, theme: 'light', externalTerminal: 'wt',
      terminalFontSize: 13, scrollback: 5000, killOwnedOnQuit: true, closeToTray: false
    }
  }
}

/** 页面端：工作组与看板通过真实 API 建（两边 API 同形），只在还没有工作组时建 */
const SEED_RUNTIME = `(async () => {
  const m = window.__mile
  if ((await m.group.list()).length) return 'kept'
  const g1 = await m.group.add({ name: '个人站点', env: 'dev' })
  const g2 = await m.group.add({ name: '公司项目', env: 'prod' })
  await m.entry.edit('a', { groupId: g1.id })
  await m.entry.edit('b', { groupId: g2.id })
  await m.entry.edit('c', { groupId: g2.id })
  const board = await m.planner.addBoard(g1.id)
  await m.planner.addTask(board.id, { title: '写周报' })
  await m.planner.addTask(board.id, { title: '迁移评论系统', status: 'doing' })
  await m.planner.addTask(board.id, { title: '换域名证书', status: 'done' })
  return 'seeded'
})()`

/** 页面端：DOM 指纹。逐个可见元素记标签、类名、自身文字、盒子与关键计算样式 */
const FINGERPRINT = `(() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1
  const cx = cv.getContext('2d', { willReadFrequently: true })
  const norm = (c) => {
    if (!c || c === 'none') return c
    cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1)
    const d = cx.getImageData(0, 0, 1, 1).data
    return d[3] === 0 ? 'transparent' : 'rgba(' + d[0] + ',' + d[1] + ',' + d[2] + ',' + Math.round(d[3] / 2.55) / 100 + ')'
  }
  const out = []
  const walk = (el, depth) => {
    if (el.closest && el.closest('.xterm')) return
    const s = getComputedStyle(el)
    if (s.display === 'none' || s.visibility === 'hidden') return
    const r = el.getBoundingClientRect()
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim().replace(/\\s+/g, ' ')
    if (r.width >= 1 && r.height >= 1) {
      const cls = typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || ''
      out.push({
        d: depth,
        k: el.tagName.toLowerCase() + (cls ? '.' + cls.trim().split(/\\s+/).sort().join('.') : ''),
        t: own.slice(0, 40),
        x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
        c: norm(s.color), bg: norm(s.backgroundColor), bc: norm(s.borderTopColor), bw: s.borderTopWidth,
        fs: s.fontSize, fw: s.fontWeight, ff: s.fontFamily.split(',')[0].replace(/["']/g, '').trim(),
        br: s.borderTopLeftRadius, sh: s.boxShadow === 'none' ? 'none' : 'shadow', op: s.opacity, bi: s.backgroundImage === 'none' ? 'none' : 'image'
      })
    }
    if (el.tagName === 'svg' || el.tagName === 'SVG') return
    for (const ch of el.children) walk(ch, depth + 1)
  }
  walk(document.body, 0)
  return out
})()`

/** 页面端：verify-m7-visual 的几条（取当前视图能量到的） */
const M7 = `(() => {
  const h = document.querySelector('main h1'); const hs = h && getComputedStyle(h)
  const tile = document.querySelector('.ui-tile'); const ts = tile && getComputedStyle(tile)
  const grads = [...document.querySelectorAll('body *')].filter((el) => /gradient/.test(getComputedStyle(el).backgroundImage)).length
  const d = document.documentElement, b = document.body
  return {
    title: hs ? { fs: parseFloat(hs.fontSize), fw: hs.fontWeight, ff: hs.fontFamily.split(',')[0].replace(/["']/g, '').trim() } : null,
    tile: ts ? { br: ts.borderTopLeftRadius, shadow: ts.boxShadow !== 'none' && !/0px 0px 0px/.test(ts.boxShadow), bw: parseFloat(ts.borderTopWidth) } : null,
    gradients: grads,
    hscroll: d.scrollWidth > d.clientWidth + 1 || b.scrollWidth > b.clientWidth + 1,
    vscroll: d.scrollHeight > d.clientHeight + 1 || b.scrollHeight > b.clientHeight + 1,
    manrope: document.fonts.check('700 22px Manrope')
  }
})()`

/** 页面端：原版 verify-ui.cjs 的 MEASURE，逐字搬（只删掉不需要的 allLow / 小样本以外的字段） */
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
  const targets = [...document.querySelectorAll('button, a[href], [role="button"], [role="tab"], [role="switch"], input:not([type="hidden"]), select')]
    .filter((el) => !el.closest('.xterm') && visible(el))
  const tiny = targets.filter((el) => { const r = el.getBoundingClientRect(); return r.width < 24 || r.height < 24 })
  const box = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } }
  const d = document.documentElement, b = document.body
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
    hscroll: d.scrollWidth > d.clientWidth + 1 || b.scrollWidth > b.clientWidth + 1,
    worstContrast: lowContrast.slice().sort((a, b) => a.ratio - b.ratio).slice(0, 5).map((t) => name(t.el) + '=' + t.ratio),
    worstTargets: tiny.slice(0, 5).map((el) => { const r = el.getBoundingClientRect(); return name(el) + '=' + Math.round(r.width) + '×' + Math.round(r.height) })
  }
})()`

const decode = (t) => {
  if (!t || t === 'none') return { scale: 1, ty: 0 }
  const n = (t.match(/[-\d.]+/g) || []).map(Number)
  return n.length >= 6 ? { scale: n[0], ty: n[5] } : { scale: 1, ty: 0 }
}

/**
 * 主流程。files.write(rel, data) 写到 build/s33/<side>/rel。返回汇总对象（也写成 summary.json）。
 */
async function run(driver, files, log = console.log) {
  const ev = driver.eval
  const waitFor = async (expr, ms = 8000) => {
    for (let t = 0; t < ms; t += 150) { if (await ev(expr)) return true; await sleep(150) }
    return false
  }
  const metrics = (w, h) => driver.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })

  // 两边的 localStorage 里可能留着上一次的导航折叠、视图、分组折叠状态：清空后重载，起点一致
  await ev(`(localStorage.clear(), sessionStorage.clear(), true)`)
  await ev(`(location.reload(), true)`).catch(() => undefined)
  await sleep(1500)
  await waitFor(`!!document.querySelector('nav[aria-label="主导航"]')`, 30000)
  // 原版是 window.mile（preload），mygo 版是 src/lib/mile.ts 模块：由 driver 挂到 window.__mile
  await driver.prepare()
  await metrics(1440, 900)
  log('seed: ' + (await ev(SEED_RUNTIME)))
  await sleep(800)

  const goto = async (label) => {
    await ev(`(()=>{const b=[...document.querySelectorAll('nav[aria-label="主导航"] button')].find(x=>x.getAttribute('aria-label')===${JSON.stringify(label)});b&&b.click();return !!b})()`)
    const ok = await waitFor(`(document.querySelector('main h1')||{textContent:''}).textContent.trim()===${JSON.stringify(label)}`, 4000)
    await sleep(700)
    return ok
  }
  const setTheme = async (t) => {
    await ev(`window.__mile.settings.patch({theme:'${t}'}).then(()=>true)`)
    await waitFor(`document.documentElement.dataset.theme==='${t}'`, 3000)
    await sleep(400) // 等配色过渡跑完
  }
  const shot = async (rel) => {
    const r = await driver.send('Page.captureScreenshot', { format: 'png' })
    files.write(rel, Buffer.from(r.data, 'base64'))
  }

  const summary = { views: {}, small: {}, press: null }
  await ev(`(document.activeElement?.blur(), true)`)
  for (const theme of THEMES) {
    await setTheme(theme)
    for (const view of VIEWS) {
      const ok = await goto(view)
      // 鼠标停在页面外，避免悬停态混进截图
      await driver.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1439, y: 899 })
      await sleep(250)
      const key = `${theme}-${SLUG[view]}`
      await shot(`${key}.png`)
      files.write(`${key}.json`, JSON.stringify(await ev(FINGERPRINT)))
      summary.views[key] = { ok, ...(await ev(M7)) }
      log(`${key}: ${ok ? 'ok' : 'NAV FAIL'}`)
    }
  }

  // 最小窗口：原版 verify-ui 的口径
  await metrics(1180, 760)
  await sleep(400)
  for (const theme of THEMES) {
    await setTheme(theme)
    for (const view of VIEWS) {
      await goto(view)
      summary.small[`${theme}/${view}`] = await ev(MEASURE)
    }
  }
  await shot('min-light-services.png').catch(() => undefined)

  // 按压：服务页工具栏的主按钮（verify-m12-press 第 1 节），真实输入，click 在捕获阶段吃掉
  await metrics(1440, 900)
  await setTheme('light')
  await goto('服务')
  const SEL = `document.querySelector('.svc-toolbar button.ui-btn[data-variant="primary"]')`
  const box = await ev(`(()=>{const el=${SEL};if(!el)return null;const r=el.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`)
  if (box) {
    const read = `(()=>{const el=${SEL};const cs=getComputedStyle(el);return {transform:cs.transform,bg:cs.backgroundColor,active:el.matches(':active')}})()`
    const idle = await ev(read)
    await ev(`(()=>{window.__mileEat=(e)=>{e.stopImmediatePropagation();e.preventDefault()};window.addEventListener('click',window.__mileEat,true);return true})()`)
    await driver.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
    await driver.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await sleep(140)
    const down = await ev(read)
    await driver.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await sleep(320)
    const up = await ev(read)
    await ev(`(()=>{window.removeEventListener('click',window.__mileEat,true);return true})()`)
    summary.press = { idle: decode(idle.transform), down: decode(down.transform), up: decode(up.transform), downActive: down.active, upActive: up.active, bgChanged: down.bg !== idle.bg }
  }

  await setTheme('light')
  await driver.send('Emulation.clearDeviceMetricsOverride')
  files.write('summary.json', JSON.stringify(summary, null, 2))
  return summary
}

module.exports = { VIEWS, THEMES, SLUG, seedConfig, run }
