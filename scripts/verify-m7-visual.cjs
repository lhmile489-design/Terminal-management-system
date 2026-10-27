/**
 * 视觉系统校验，docs/UI/UI-REFACTOR.md §4（UI 重构后改写，原 M7 断言的是旧设计）。
 *
 * 只量计算值，不看图：截图证明不了圆角是 16px、状态色只进了描边没染底、
 * 标题真的用上了打包的 Manrope。每条断言都读 getComputedStyle 或 document.fonts。
 * 总览 KPI 的断言留给阶段 5（总览重排）补回。
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const SANDBOX = join(tmpdir(), `mile-m7-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
app.setPath('appData', SANDBOX)

const FIX = join(ROOT, 'scripts', 'fixture').replace(/\\/g, '/')
const now = Date.now()
const mk = (id, name, order) => ({
  id, kind: 'service', name, path: FIX, framework: 'node', packageManager: 'npm',
  script: 'dev', scripts: { dev: 'node server.cjs' }, env: {}, registerOnly: false, pinned: false, order, createdAt: now
})
writeFileSync(
  join(SANDBOX, 'mile-terminal', 'config.json'),
  JSON.stringify({
    version: 1,
    entries: [mk('a', '个人博客', 0), mk('b', '公司文档站', 1)],
    ignoredListeners: [],
    settings: { scanIntervalMs: 2000, theme: 'light', externalTerminal: 'wt', terminalFontSize: 13, scrollback: 5000, killOwnedOnQuit: true, closeToTray: false }
  }, null, 2),
  'utf8'
)

require(join(ROOT, 'out', 'main', 'index.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(name, ok, detail) {
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null && detail !== '' ? ` — ${detail}` : ''}`)
}

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  win.setBounds({ width: 1500, height: 940 })
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const waitFor = async (code, ms = 8000) => {
    for (let t = 0; t < ms; t += 120) { if (await js(code)) return true; await sleep(120) }
    return false
  }
  const goto = async (label) => {
    await js(`(()=>{const b=[...document.querySelectorAll('nav[aria-label="主导航"] button')].find(x=>x.getAttribute('aria-label')===${JSON.stringify(label)});b&&b.click();return true})()`)
    return waitFor(`(document.querySelector('main h1')||{textContent:''}).textContent.trim()===${JSON.stringify(label)}`, 4000)
  }
  const setTheme = async (t) => {
    await js(`window.mile.settings.patch({theme:'${t}'})`)
    await waitFor(`document.documentElement.dataset.theme==='${t}'`, 3000)
    await sleep(300) // 等配色过渡跑完再量，否则读到插值中的中间色
  }

  try {
    await waitFor(`!!document.querySelector('nav[aria-label="主导航"]')`, 30000)

    console.log('\n=== 1. 视图头：标题 + 说明，无罗马字副标与 eyebrow（§3.2）===')
    for (const label of ['总览', '服务', '终端', '设置', '关于']) {
      const ok = await goto(label)
      const h = await js(`(()=>{const h=document.querySelector('main h1');const s=getComputedStyle(h);
        const head=h.closest('.ui-view-head');
        return {cls:h.className,fs:parseFloat(s.fontSize),fw:s.fontWeight,ff:s.fontFamily,
          legacy:!!(head&&head.querySelector('.romanized, .eyebrow'))}})()`)
      check(`${label}：进入页面`, ok)
      check(`${label}：标题 22px / 700 / Manrope`,
        h.cls.includes('ui-view-title') && h.fs === 22 && h.fw === '700' && /Manrope/.test(h.ff),
        `${h.fs}px ${h.fw} ${h.ff.split(',')[0]}`)
      check(`${label}：视图头没有旧的罗马字副标 / eyebrow`, !h.legacy)
    }
    check('Manrope 已真正加载（不是回落字体）', await waitFor(`document.fonts.ready.then(()=>document.fonts.check('700 22px Manrope'))`, 4000))

    console.log('\n=== 2. 磁贴：16px 圆角，浅色有静态阴影，深色靠描边（§4.3）===')
    await goto('服务')
    await waitFor(`!!document.querySelector('.ui-tile[data-group-id]')`)
    const tile = () => js(`(()=>{const t=document.querySelector('.ui-tile[data-group-id]');const s=getComputedStyle(t);
      return {br:s.borderTopLeftRadius,shadow:s.boxShadow,border:s.borderTopColor,bw:s.borderTopWidth,bg:s.backgroundColor,
        canvas:getComputedStyle(document.body).backgroundColor,tone:t.dataset.tone||null}})()`)
    const light = await tile()
    check('磁贴圆角 16px', light.br === '16px', light.br)
    check('浅色：磁贴有静态阴影', light.shadow !== 'none' && !/^rgba\(0, 0, 0, 0\) 0px 0px 0px/.test(light.shadow), light.shadow.slice(0, 50))
    check('浅色：磁贴与画布可分（底色不同）', light.bg !== light.canvas, `${light.bg} vs ${light.canvas}`)
    await setTheme('dark')
    const dark = await tile()
    check('深色：不靠阴影表现层次', dark.shadow === 'none' || /0px 0px 0px/.test(dark.shadow), dark.shadow.slice(0, 50))
    // 边框量的是设备像素：dpr 1.75 下 1px CSS 被报成 0.571px（正好一个设备像素），只判非零
    check('深色：磁贴有 1px 可见描边', parseFloat(dark.bw) > 0 && dark.border !== 'rgba(0, 0, 0, 0)', `${dark.bw} ${dark.border}`)
    check('深色：磁贴与画布可分', dark.bg !== dark.canvas, `${dark.bg} vs ${dark.canvas}`)
    await setTheme('light')

    console.log('\n=== 3. 状态色只进描边、胶囊、圆点，不染底（§4.6）===')
    const before = await tile()
    await js(`window.mile.entry.start('a')`)
    await js(`window.mile.entry.start('b')`)
    const lit = await waitFor(`(document.querySelector('.ui-tile[data-group-id]')||{dataset:{}}).dataset.tone==='live'`, 30000)
    await sleep(300)
    const after = await tile()
    check('全部运行后磁贴 data-tone=live', lit, String(after.tone))
    check('描边转成功色', after.border !== before.border, `${before.border} → ${after.border}`)
    check('磁贴底色没被状态色染', after.bg === before.bg, after.bg)
    const dot = await js(`(()=>{const d=document.querySelector('[data-entry-id="a"] .ui-dot');const s=getComputedStyle(d);
      return {w:s.width,h:s.height,br:s.borderTopLeftRadius,anim:s.animationName,tone:d.dataset.tone}})()`)
    check('状态点 8×8 圆形', dot.w === '8px' && dot.h === '8px' && dot.br === '50%', `${dot.w}×${dot.h} ${dot.br}`)
    check('运行中状态点在呼吸', dot.tone === 'live' && dot.anim === 'ui-breathe', `${dot.tone} ${dot.anim}`)
    await js(`document.querySelector('[data-entry-id="a"]').click();true`)
    await waitFor(`!!document.querySelector('.svc-detail .ui-pill')`)
    const pill = await js(`(()=>{const p=document.querySelector('.svc-detail .ui-pill[data-tone="live"]');if(!p)return null;const s=getComputedStyle(p);
      return {br:s.borderTopLeftRadius,h:s.height,bg:s.backgroundColor,fg:s.color}})()`)
    check('详情里有运行中胶囊', !!pill)
    if (pill) {
      check('胶囊全圆角', parseFloat(pill.br) >= 11, pill.br)
      check('胶囊高 22px', pill.h === '22px', pill.h)
      check('胶囊底色与文字色不同（淡底深字）', pill.bg !== pill.fg, `${pill.bg} / ${pill.fg}`)
    }
    await js(`window.mile.entry.stop('a').catch(()=>null);window.mile.entry.stop('b').catch(()=>null);true`)

    console.log('\n=== 4. 分段控件：凹槽 + 浮起的选中项 ===')
    const seg = await js(`(()=>{const g=document.querySelector('.ui-seg');if(!g)return null;
      const on=g.querySelector('[aria-checked="true"]'),off=g.querySelector('[aria-checked="false"]');
      const gs=getComputedStyle(g),os=getComputedStyle(on),fs=getComputedStyle(off);
      return {groove:gs.backgroundColor,on:os.backgroundColor,off:fs.backgroundColor,shadow:os.boxShadow,onFg:os.color,offFg:fs.color}})()`)
    check('分段控件存在', !!seg)
    if (seg) {
      check('选中项底色与凹槽不同（浮起）', seg.on !== seg.groove, `${seg.on} vs ${seg.groove}`)
      check('未选中项底透明，露出凹槽', seg.off === 'rgba(0, 0, 0, 0)', seg.off)
      check('浅色：选中项有投影', seg.shadow !== 'none', seg.shadow.slice(0, 40))
      check('选中项文字强于未选中', seg.onFg !== seg.offFg, `${seg.onFg} vs ${seg.offFg}`)
    }

    console.log('\n=== 5. 渐变只用于品牌标识（§4.3）===')
    const grads = await js(`[...document.querySelectorAll('body *')].filter(el=>/gradient/.test(getComputedStyle(el).backgroundImage))
      .map(el=>el.className&&el.className.baseVal===undefined?String(el.className).split(' ')[0]:el.tagName)`)
    const offenders = grads.filter((c) => !/ui-brand-mark|about-logo/.test(c))
    check('除品牌标识外没有渐变背景', offenders.length === 0, offenders.join(' | ') || `只有 ${grads.length} 处品牌`)

    console.log('\n=== 6. 总览便当网格（§3.4）===')
    await setTheme('light')
    check('进入总览', await goto('总览'))
    await waitFor(`document.querySelectorAll('[data-kpi-card]').length===6`, 6000)
    const kpi = await js(`(()=>{const g=document.querySelector('.dash-kpi');if(!g)return null;
      const tiles=[...g.querySelectorAll('[data-kpi-card]')];const gs=getComputedStyle(g);
      const cols=gs.gridTemplateColumns.split(' ').filter(Boolean).length;
      const one=tiles.find(t=>t.dataset.wide!=='true');const wide=tiles.filter(t=>t.dataset.wide==='true');
      const v=one.querySelector('.kpi-tile-value');const vs=getComputedStyle(v);const ic=one.querySelector('.kpi-tile-icon').getBoundingClientRect();
      const ts=getComputedStyle(one);const bar=g.querySelector('.kpi-tile-bar');
      const unit=one.querySelector('.kpi-tile-unit')||g.querySelector('.kpi-tile-unit');
      return {n:tiles.length,cols,wide:wide.length,wideW:wide.map(t=>Math.round(t.getBoundingClientRect().width)),
        oneW:Math.round(one.getBoundingClientRect().width),fs:parseFloat(vs.fontSize),ff:vs.fontFamily,num:vs.fontVariantNumeric,
        icon:Math.round(ic.width)+'x'+Math.round(ic.height),br:ts.borderRadius,shadow:ts.boxShadow,bar:!!bar,
        unitFs:unit?parseFloat(getComputedStyle(unit).fontSize):null}})()`)
    check('统计磁贴 6 张', kpi && kpi.n === 6, kpi && `${kpi.n} 张`)
    if (kpi) {
      check('1500px 下 4 列', kpi.cols === 4, `${kpi.cols} 列`)
      check('两张主磁贴跨 2 列', kpi.wide === 2 && kpi.wideW.every((w) => w > kpi.oneW * 1.8), `${kpi.wideW.join('/')} vs ${kpi.oneW}`)
      check('读数 30px Manrope 等宽数字', kpi.fs === 30 && /Manrope/.test(kpi.ff) && /tabular-nums/.test(kpi.num), `${kpi.fs}px ${kpi.ff.split(',')[0]} ${kpi.num}`)
      check('单位字号 ≥ 12px', kpi.unitFs == null || kpi.unitFs >= 12, String(kpi.unitFs))
      check('图标块 36×36', kpi.icon === '36x36', kpi.icon)
      check('磁贴圆角 16px', kpi.br === '16px', kpi.br)
      check('浅色：磁贴有静态阴影', kpi.shadow !== 'none', kpi.shadow.slice(0, 40))
      check('「我的服务」带运行占比条', kpi.bar)
    }
    const heads = await js(`[...document.querySelectorAll('main h2')].map(h=>h.textContent.trim())`)
    check('区块标题去掉了英文前缀', heads.length > 0 && heads.every((h) => !/[A-Za-z]{3,} ·/.test(h)), heads.join(' | '))
    const eb = await js(`(()=>{const h=document.querySelector('main h2.eyebrow');if(!h)return null;const s=getComputedStyle(h);
      return {tt:s.textTransform,ff:s.fontFamily,fs:parseFloat(s.fontSize),before:getComputedStyle(h,'::before').content}})()`)
    check('区块标题用 Manrope、不大写、无方块', eb && /Manrope/.test(eb.ff) && eb.tt === 'none' && (eb.before === 'none' || eb.before === 'normal'), eb && JSON.stringify(eb))
    const ops = await js(`(()=>{const o=document.querySelector('.dash-ops');if(!o)return null;
      return getComputedStyle(o).gridTemplateColumns.split(' ').filter(Boolean).length})()`)
    check('服务操作台与侧栏两列并排', ops === 2, String(ops))
  } catch (err) {
    console.log('HARNESS ERROR', err)
    fail++
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`) }
  app.exit(fail === 0 ? 0 : 1)
})
