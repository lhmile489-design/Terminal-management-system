/**
 * M7 视觉系统校验，PRD §12.7。
 *
 * 只量计算值，不看图：截图能证明「没崩」，证明不了圆角是 12px、选中项真的浮起、
 * 状态色真的进了边框。前六个里程碑三次教训都是同一个 —— 先确认自己量的是不是
 * 那个东西，再判断代码对不对。因此每条断言都读 getComputedStyle 或 getBoundingClientRect。
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
      // 仅登记条目的启动按钮是禁用的 —— 第 7 节要靠它量禁用态对比度
      mk('e', '只登记不启动', 'service', FIX, 'dev', { dev: 'node server.cjs' }, 3, true)
    ],
    ignoredListeners: [],
    settings: {
      scanIntervalMs: 2000, theme: 'dark', externalTerminal: 'wt',
      terminalFontSize: 13, scrollback: 5000, killOwnedOnQuit: true, closeToTray: false
    }
  }, null, 2),
  'utf8'
)

require(join(ROOT, 'out', 'main', 'index.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0

function check(name, ok, detail) {
  if (ok) {
    pass++
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 把 rgb(a) 串解析成数组，便于比较「是否被状态色染过」 */
const RGB = `(s)=>{const m=s.match(/[\\d.]+/g);return m?m.map(Number):null}`

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  win.setBounds({ width: 1500, height: 940 })
  const js = (code) => win.webContents.executeJavaScript(code, true)

  await js(`window.mile.scanner.setVisible(true); window.mile.scanner.refresh(); true`)
  await sleep(2500)

  const goto = async (label) => {
    await js(`(()=>{const b=[...document.querySelector('nav').querySelectorAll('button')]
      .find(x=>x.getAttribute('aria-label')===${JSON.stringify(label)});b&&b.click();return true})()`)
    for (let i = 0; i < 25; i++) {
      const h = await js(`document.querySelector('h1').textContent.trim()`)
      if (h.startsWith(label)) break
      await sleep(250)
    }
    await sleep(600)
  }

  console.log('\n=== 1. 展示型页头 ===')
  await goto('启动台')

  const head = await js(`(()=>{const h=document.querySelector('h1');const s=getComputedStyle(h);
    const r=h.querySelector('.romanized');const rs=r?getComputedStyle(r):null;
    return {fs:parseFloat(s.fontSize),fw:s.fontWeight,text:h.textContent.trim(),
      roman:r?r.textContent.trim():null,rfs:rs?parseFloat(rs.fontSize):null,
      rls:rs?rs.letterSpacing:null,rff:rs?rs.fontFamily:null}})()`)
  check('主标字号 ≥ 28px', head.fs >= 28, `${head.fs}px`)
  check('主标字重 800', head.fw === '800', head.fw)
  check('罗马字副标存在', head.roman === 'LAUNCHPAD', String(head.roman))
  // 副标用 em 跟随主标：0.32em × 主标字号，允许 0.5px 舍入
  check('副标随主标缩放（0.32em）', Math.abs(head.rfs - head.fs * 0.32) < 0.6,
    `${head.rfs}px vs ${(head.fs * 0.32).toFixed(1)}px`)
  check('副标为等宽字体', /mono|Consolas|Cascadia|Menlo/i.test(head.rff || ''), head.rff)
  check('副标字距 ≥ 2px', parseFloat(head.rls) >= 2, head.rls)

  const eyebrow = await js(`(()=>{const e=document.querySelector('.eyebrow');
    const s=getComputedStyle(e);const b=getComputedStyle(e,'::before');
    return {ls:s.letterSpacing,tt:s.textTransform,w:b.width,h:b.height,bg:b.backgroundColor}})()`)
  check('eyebrow 大写', eyebrow.tt === 'uppercase', eyebrow.tt)
  check('eyebrow 字距 ≥ 1.5px', parseFloat(eyebrow.ls) >= 1.5, eyebrow.ls)
  check('eyebrow 前置 6×6 方块', eyebrow.w === '6px' && eyebrow.h === '6px',
    `${eyebrow.w}×${eyebrow.h}`)

  console.log('\n=== 2. 卡片与状态着色 ===')
  const card = await js(`(()=>{const c=document.querySelector('article.surface-card');
    const s=getComputedStyle(c);const t=c.querySelector('.icon-tile');const ts=getComputedStyle(t);
    return {br:s.borderRadius,bw:parseFloat(s.borderTopWidth)*devicePixelRatio,dpr:devicePixelRatio,
      tw:ts.width,th:ts.height,tbr:ts.borderRadius,
      tbg:ts.backgroundColor,tone:c.dataset.tone||null,interactive:c.dataset.interactive||null,
      pageBg:getComputedStyle(document.body).backgroundColor,cardBg:s.backgroundColor}})()`)
  check('卡片圆角 12px', card.br === '12px', card.br)
  // 边框量的是设备像素：dpr 1.75 下 1px CSS 边框被报成 0.571429px（正好一个设备像素），
  // 直接比 '1px' 会在缩放屏上假失败 —— 又一次「先确认自己量的是不是那个东西」
  check('卡片边框为 1 设备像素', Math.abs(card.bw - 1) < 0.02, `${card.bw.toFixed(3)}dp @dpr${card.dpr}`)
  check('图标瓦片 44×44', card.tw === '44px' && card.th === '44px', `${card.tw}×${card.th}`)
  check('图标瓦片圆角 10px', card.tbr === '10px', card.tbr)
  check('卡片底色区别于画布', card.cardBg !== card.pageBg, `${card.cardBg} vs ${card.pageBg}`)
  check('卡片标记为可交互（可拖拽）', card.interactive === 'true', String(card.interactive))

  // 图标瓦片底色必须真的混入了 --glow，而不是等于卡片底色
  check('图标瓦片底色混入状态色', card.tbg !== card.cardBg, `${card.tbg} vs ${card.cardBg}`)

  // 启动一个服务，验边框被 live 染色 —— 这是「状态只染边框」的核心断言
  const beforeBorder = await js(`getComputedStyle(document.querySelector('article.surface-card')).borderTopColor`)
  await js(`(()=>{const c=document.querySelector('article.surface-card');
    const b=[...c.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='启动');
    b&&b.click();return true})()`)
  for (let i = 0; i < 40; i++) {
    const tone = await js(`document.querySelector('article.surface-card').dataset.tone||''`)
    if (tone === 'live') break
    await sleep(500)
  }
  const lit = await js(`(()=>{const c=document.querySelector('article.surface-card');
    const s=getComputedStyle(c);const p=c.querySelector('.status-pill');
    const ps=p?getComputedStyle(p):null;const d=c.querySelector('.status-dot');
    const ds=d?getComputedStyle(d):null;
    return {tone:c.dataset.tone||null,border:s.borderTopColor,bg:s.backgroundColor,
      pill:ps?{bg:ps.backgroundColor,bc:ps.borderTopColor,color:ps.color,br:ps.borderRadius}:null,
      halo:ds?ds.boxShadow:null,dotW:ds?ds.width:null,
      port:(()=>{const b=[...c.querySelectorAll('button')].find(x=>/^:\\d+$/.test(x.textContent.trim()));
        return b?{text:b.textContent.trim(),color:getComputedStyle(b).color}:null})()}})()`)
  check('运行后 data-tone=live', lit.tone === 'live', String(lit.tone))
  check('live 边框颜色已改变', lit.border !== beforeBorder, `${beforeBorder} → ${lit.border}`)
  check('卡片底色未被状态色淹没', lit.bg === card.cardBg, `${lit.bg}`)
  check('状态胶囊为全圆角', lit.pill && parseFloat(lit.pill.br) >= 20, lit.pill && lit.pill.br)
  if (lit.pill) {
    const bg = await js(`(${RGB})(${JSON.stringify(lit.pill.bg)})`)
    const color = await js(`(${RGB})(${JSON.stringify(lit.pill.color)})`)
    const bc = await js(`(${RGB})(${JSON.stringify(lit.pill.bc)})`)
    // 底、边、字同源：三者色相接近（绿通道最高），底最淡
    const greenest = (c) => c && c[1] > c[0] && c[1] > c[2]
    check('胶囊字色为 live 绿系', greenest(color), lit.pill.color)
    check('胶囊边色为 live 绿系', greenest(bc), lit.pill.bc)
    check('胶囊底色为半透明淡底', bg && bg.length === 4 && bg[3] < 0.4, lit.pill.bg)
  }
  check('运行中圆点带光环', /rgb/.test(lit.halo || ''), lit.halo)
  check('状态圆点 7px', lit.dotW === '7px', lit.dotW)
  check('端口按钮在页头且用 accent 色', !!lit.port, lit.port && `${lit.port.text} ${lit.port.color}`)

  // hover 抬升：直接量 transform 矩阵的位移量
  const hover = await js(`(()=>{const c=document.querySelector('article.surface-card');
    const before=getComputedStyle(c).transform;
    c.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));
    return {before}})()`)
  check('静止态无位移', hover.before === 'none' || /matrix\(1, 0, 0, 1, 0, 0\)/.test(hover.before),
    hover.before)

  console.log('\n=== 3. 工作台 KPI 概览 ===')
  await goto('工作台')
  const kpiGrid = await js(`(()=>{
    const heading=document.querySelector('#kpi-heading');
    const grid=heading?.nextElementSibling;
    const cards=[...(grid?.querySelectorAll(':scope > article.surface-card')??[])];
    const rects=cards.map(card=>card.getBoundingClientRect());
    const rows=[...new Set(rects.map(rect=>Math.round(rect.top)))].length;
    const columns=[...new Set(rects.map(rect=>Math.round(rect.left)))].length;
    const values=cards.map(card=>[...card.querySelectorAll('*')].find(node=>
      /mono/i.test(getComputedStyle(node).fontFamily)&&parseFloat(getComputedStyle(node).fontSize)>=20));
    return {
      count:cards.length,
      rows,
      columns,
      minHeight:rects.length?Math.min(...rects.map(rect=>rect.height)):0,
      minValueSize:values.length?Math.min(...values.map(value=>value?parseFloat(getComputedStyle(value).fontSize):0)):0,
      details:cards.filter(card=>card.querySelector('[data-kpi-detail]')?.textContent.trim()).length
    }
  })()`)
  check('工作台保留六张 KPI 卡片', kpiGrid.count === 6, `${kpiGrid.count} 张`)
  check('1500px 工作台 KPI 为三列', kpiGrid.columns === 3, `${kpiGrid.columns} 列`)
  check('1500px 工作台 KPI 为两行', kpiGrid.rows === 2, `${kpiGrid.rows} 行`)
  check('KPI 卡片高度至少 136px', kpiGrid.minHeight >= 136, `${kpiGrid.minHeight.toFixed(1)}px`)
  check('KPI 主读数至少 30px', kpiGrid.minValueSize >= 30, `${kpiGrid.minValueSize}px`)
  check('每张 KPI 都有运行上下文', kpiGrid.details === 6, `${kpiGrid.details} / ${kpiGrid.count}`)

  // 宽屏也要维持三列，两行六张卡片；auto-fit 会在可用空间变大后悄然扩成四列。
  const initialZoom = win.webContents.getZoomFactor()
  win.setBounds({ width: 2000, height: 940 })
  win.webContents.setZoomFactor(0.5)
  await sleep(300)
  const wideKpi = await js(`(()=>{
    const grid=document.querySelector('#kpi-heading')?.nextElementSibling
    const columns=[...new Set([...grid.querySelectorAll(':scope > article.surface-card')]
      .map(card=>Math.round(card.getBoundingClientRect().left)))].length
    return { columns, viewport: window.innerWidth, gridWidth: Math.round(grid.getBoundingClientRect().width) }
  })()`)
  check('超宽工作台 KPI 仍为三列', wideKpi.columns === 3,
    `${wideKpi.columns} 列，视口 ${wideKpi.viewport}px，网格 ${wideKpi.gridWidth}px`)
  win.webContents.setZoomFactor(initialZoom)
  win.setBounds({ width: 1500, height: 940 })
  await sleep(300)

  console.log('\n=== 4. 迷你负载条 ===')
  // 负载轨与归属徽标都长在监听表的行上，行要等一轮采集回执。固定 sleep 曾经「通过」
  // 只是因为上一节恰好耗了足够久 —— 换个断言顺序就假失败。等到真的有行再量。
  for (let i = 0; i < 40; i++) {
    const rows = await js(`document.querySelectorAll('main tbody tr, main ul > li').length`)
    if (rows > 3) break
    await sleep(500)
  }
  await sleep(600)
  const bars = await js(`(()=>{const t=document.querySelector('.load-track');
    if(!t)return null;const s=getComputedStyle(t);const f=t.querySelector('.load-fill');
    const fs=f?getComputedStyle(f):null;
    return {h:s.height,br:s.borderRadius,ov:s.overflow,
      fillBg:fs?fs.backgroundColor:null,fillW:f?f.style.width:null,
      count:document.querySelectorAll('.load-track').length}})()`)
  check('负载轨存在', !!bars, bars ? `${bars.count} 条` : '未找到')
  if (bars) {
    check('负载轨高 3px', bars.h === '3px', bars.h)
    check('负载轨圆角裁剪', bars.ov === 'hidden', bars.ov)
    check('填充有宽度百分比', /%$/.test(bars.fillW || ''), bars.fillW)
    check('表格与侧栏共用同一轨（≥6 条）', bars.count >= 6, `${bars.count} 条`)
  }

  const kpi = await js(`(()=>{const c=document.querySelector('main article.surface-card');
    const t=c.querySelector('.icon-tile-sm');const ts=t?getComputedStyle(t):null;
    const v=[...c.querySelectorAll('*')].find(x=>/mono/i.test(getComputedStyle(x).fontFamily)
      && parseFloat(getComputedStyle(x).fontSize)>=20);
    const vs=v?getComputedStyle(v):null;
    return {tile:ts?{w:ts.width,h:ts.height,bg:ts.backgroundColor,color:ts.color}:null,
      val:vs?{fs:parseFloat(vs.fontSize),fw:vs.fontWeight,vn:vs.fontVariantNumeric}:null}})()`)
  check('KPI 图标瓦片 40×40', kpi.tile && kpi.tile.w === '40px' && kpi.tile.h === '40px',
    kpi.tile && `${kpi.tile.w}×${kpi.tile.h}`)
  check('KPI 读数 ≥ 30px 等宽', kpi.val && kpi.val.fs >= 30, kpi.val && `${kpi.val.fs}px`)
  check('KPI 读数字重 700', kpi.val && kpi.val.fw === '700', kpi.val && kpi.val.fw)
  // tabular-nums 让每轮刷新数字不跳动，是这块的关键
  check('KPI 读数用 tabular-nums', kpi.val && /tabular-nums/.test(kpi.val.vn),
    kpi.val && kpi.val.vn)

  const ownership = await js(`(()=>{const p=[...document.querySelectorAll('main .status-pill')]
    .find(x=>/受控|外部/.test(x.textContent));
    return p?{text:p.textContent.trim(),br:getComputedStyle(p).borderRadius}:null})()`)
  check('归属徽标已改用状态胶囊', ownership && parseFloat(ownership.br) >= 20,
    ownership && `${ownership.text} ${ownership.br}`)

  console.log('\n=== 5. 分段控件 ===')
  const seg = await js(`(()=>{const g=document.querySelector('.segmented');
    if(!g)return null;const gs=getComputedStyle(g);
    const items=[...g.querySelectorAll('.segmented-item')];
    const on=items.find(x=>x.getAttribute('aria-checked')==='true'||x.getAttribute('aria-selected')==='true');
    const off=items.find(x=>x!==on);
    const os=on?getComputedStyle(on):null;const fs=off?getComputedStyle(off):null;
    return {groupBg:gs.backgroundColor,groupBr:gs.borderRadius,n:items.length,
      onBg:os?os.backgroundColor:null,onShadow:os?os.boxShadow:null,onColor:os?os.color:null,
      offBg:fs?fs.backgroundColor:null,offColor:fs?fs.color:null,
      cardBg:getComputedStyle(document.querySelector('article.surface-card')).backgroundColor}})()`)
  check('分段控件存在', !!seg, seg ? `${seg.n} 项` : '未找到')
  if (seg) {
    check('选中项底色 = 卡片色（浮起）', seg.onBg === seg.cardBg, `${seg.onBg} vs ${seg.cardBg}`)
    check('未选中项底透明（凹槽露出）', /rgba\(0, 0, 0, 0\)|transparent/.test(seg.offBg), seg.offBg)
    check('凹槽底色深于选中项', seg.groupBg !== seg.onBg, `${seg.groupBg} vs ${seg.onBg}`)
    check('选中项有投影', /rgb/.test(seg.onShadow || ''), seg.onShadow)
    check('选中项文字强于未选中', seg.onColor !== seg.offColor, `${seg.onColor} vs ${seg.offColor}`)
  }

  console.log('\n=== 6. 各视图一致性 ===')
  for (const [label, min] of [['诊断', 2], ['设置', 4], ['终端', 2]]) {
    await goto(label)
    // 诊断的面板要等 entry.diagnose 回执才渲染（读 package.json、查端口占用、探 PATH），
    // 固定 sleep 抓到的是收集中的空壳。轮询到数量达标或超时，再断言。
    let n = 0
    for (let i = 0; i < 40; i++) {
      n = await js(`document.querySelectorAll('main .surface-card').length`)
      if (n >= min) break
      await sleep(500)
    }
    check(`${label} 已改用统一卡片（≥${min}）`, n >= min, `${n} 处`)
    const legacy = await js(`document.querySelectorAll('main [class*="rounded-[12px]"][class*="border-line"]').length`)
    check(`${label} 无遗留手写卡片`, legacy === 0, `${legacy} 处`)
  }

  // 页头在每个视图都成立
  for (const label of ['工作台', '启动台', '诊断', '设置', '终端']) {
    await goto(label)
    const ok = await js(`(()=>{const h=document.querySelector('h1');
      return !!h && !!h.querySelector('.romanized') && parseFloat(getComputedStyle(h).fontSize)>=28})()`)
    check(`${label} 页头为展示型标题`, ok)
  }

  console.log('\n=== 7. 浅色主题成立 ===')
  await js(`window.mile.settings.patch({theme:'light'})`)
  await sleep(1200)
  await goto('启动台')
  const light = await js(`(()=>{const c=document.querySelector('article.surface-card');
    const s=getComputedStyle(c);const b=getComputedStyle(document.body);
    const t=c.querySelector('.icon-tile');
    const lum=(x)=>{const m=x.match(/[\\d.]+/g);return m?(+m[0]*0.299+ +m[1]*0.587+ +m[2]*0.114):null};
    return {body:lum(b.backgroundColor),card:lum(s.backgroundColor),
      tileBg:getComputedStyle(t).backgroundColor,cardBg:s.backgroundColor}})()`)
  check('浅色主题画布为亮底', light.body > 200, String(light.body))
  check('浅色主题卡片仍与画布可分', light.card !== light.body, `${light.card} vs ${light.body}`)
  check('浅色主题瓦片仍混入状态色', light.tileBg !== light.cardBg,
    `${light.tileBg} vs ${light.cardBg}`)

  console.log('\n=== 8. 按钮文字对比度（两套主题 × 启用/禁用）===')
  /**
   * 逐个按钮量合成后的真实对比度，不看截图。三处曾经踩过的坑都写进实现里：
   *
   * 1) 祖先链上的 opacity 会把按钮连字一起压向背后底色，必须自己合成，
   *    否则 disabled:opacity-45 造成的 1.26:1 会被算成「文字/底色都没变」。
   * 2) 导航项的可见内容是纯 SVG，textContent 来自那个 opacity-0 的 tooltip ——
   *    拿它当按钮文字会量出一个不存在的问题。只取按钮自己的直接文字节点。
   * 3) 按钮的 background/color 带 120ms 过渡，切主题后立刻采样会读到插值中的
   *    中间色（量出两套 token 里都不存在的中灰）。等过渡跑完再读。
   */
  const CONTRAST = `(() => {
    const parse=(c)=>{const m=c.match(/[\\d.]+/g).map(Number);
      return {r:m[0],g:m[1],b:m[2],a:m.length>3?m[3]:1}};
    const over=(f,b)=>({r:f.r*f.a+b.r*(1-f.a),g:f.g*f.a+b.g*(1-f.a),b:f.b*f.a+b.b*(1-f.a),a:1});
    const bgOf=(el)=>{let acc={r:0,g:0,b:0,a:0};
      for(let n=el;n;n=n.parentElement){const c=parse(getComputedStyle(n).backgroundColor);
        if(c.a===0)continue;acc=acc.a===0?c:over(acc,c);if(acc.a>=0.999)break}
      return acc.a===0?{r:255,g:255,b:255,a:1}:acc};
    const chainOpacity=(el)=>{let o=1;
      for(let n=el;n;n=n.parentElement)o*=Number(getComputedStyle(n).opacity);return o};
    const lum=(c)=>{const f=(v)=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)};
      return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b)};
    const ratio=(a,b)=>{const[x,y]=[lum(a),lum(b)].sort((p,q)=>q-p);
      return Math.round(((x+0.05)/(y+0.05))*100)/100};
    const out=[];
    for(const btn of document.querySelectorAll('button')){
      if(!btn.getClientRects().length)continue;
      const own=[...btn.childNodes].filter((n)=>n.nodeType===3)
        .map((n)=>n.textContent.trim()).join('');
      if(!own)continue;
      const cs=getComputedStyle(btn);
      const behind=bgOf(btn.parentElement);
      const o=chainOpacity(btn);
      const flat=(c)=>over({...c,a:c.a*o},behind);
      out.push({name:own.slice(0,14),disabled:btn.disabled,
        ratio:ratio(flat(parse(cs.color)),flat(parse(cs.backgroundColor)))});
    }
    return out;
  })()`

  for (const theme of ['light', 'dark']) {
    await js(`window.mile.settings.patch({theme:'${theme}'})`)
    for (let i = 0; i < 40; i++) {
      if (await js(`document.documentElement.dataset.theme === '${theme}'`)) break
      await sleep(100)
    }
    await sleep(500)
    await goto('启动台')
    const rows = await js(CONTRAST)
    const bad = rows.filter((r) => r.ratio < 4.5)
    // 空数组上跑 filter 会得到空数组，看着像通过 —— 先要求真的量到了按钮
    check(`${theme} 量到可见文字按钮`, rows.length >= 8, `${rows.length} 个`)
    check(`${theme} 全部按钮文字 ≥ 4.5:1`, rows.length >= 8 && bad.length === 0,
      bad.map((r) => `${r.name}${r.disabled ? '(禁用)' : ''}=${r.ratio}`).join(' ') ||
        `最低 ${Math.min(...rows.map((r) => r.ratio))}`)
    // 禁用态必须单独验：整块压 opacity 是最容易悄悄回归的写法
    const off = rows.filter((r) => r.disabled)
    check(`${theme} 禁用按钮文字仍 ≥ 4.5:1`,
      off.length > 0 && off.every((r) => r.ratio >= 4.5),
      off.map((r) => `${r.name}=${r.ratio}`).join(' ') || '没量到禁用按钮')
  }
  await js(`window.mile.settings.patch({theme:'dark'})`)

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`)
  }
  app.exit(fail === 0 ? 0 : 1)
})
