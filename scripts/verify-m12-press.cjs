/**
 * M12 验证：按钮按下时有位移反馈，且不牺牲既有的对比度/禁用态纪律。
 *
 * 缺陷现场：所有按钮的 className 里只有 transition-colors，没有任何 active 态 ——
 * 点下去元素一动不动，只有颜色在变，手感很硬。
 *
 * 这个 harness 最容易写错的地方是「怎么让元素真的进入 :active」：
 *
 *   - `el.dispatchEvent(new MouseEvent('mousedown'))` **不会**让元素命中 :active。
 *     合成事件不改变渲染引擎的用户交互状态，getComputedStyle 读回来的还是基态
 *     transform: none。照这么写，六条断言会全部「因为量的是基态」而假绿 ——
 *     无论源码里有没有 active 规则，结果都一样。
 *   - 必须走 CDP 的 Input.dispatchMouseEvent（webContents.sendInputEvent），
 *     它进的是真实输入管线，:active 才会生效。
 *
 * 所以每条位移断言都配了一次「基态对照」：同一个元素在没按下时必须是
 * transform: none。基态与按下态量到同一个值时，说明按压根本没生效（或者探针没
 * 按下去），断言应当红 —— 而不是恰好等于期望值。
 *
 * 另外量了两件容易回归的事：
 *   1. 挂上 .pressable 后 transition-property 里必须仍然含 color/background-color。
 *      .pressable 的 transition 是简写，且本文件无 layer，会盖过 Tailwind 的
 *      transition-colors（在 @layer utilities 里）。漏写就会把 hover 变色变成硬切。
 *   2. 禁用按钮按下去不能有位移 —— 有动静会让人以为点成了。
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const SANDBOX = join(tmpdir(), `mile-m12-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
app.setPath('appData', SANDBOX)

const FIX = join(ROOT, 'scripts', 'fixture').replace(/\\/g, '/')
const now = Date.now()
const mk = (id, name, order, registerOnly = false) => ({
  id,
  kind: 'service',
  name,
  path: FIX,
  framework: 'node',
  packageManager: 'npm',
  script: 'dev',
  scripts: { dev: 'node server.cjs' },
  env: {},
  registerOnly,
  pinned: false,
  order,
  createdAt: now
})

writeFileSync(
  join(SANDBOX, 'mile-terminal', 'config.json'),
  JSON.stringify(
    {
      version: 1,
      entries: [
        mk('a', '个人博客', 0),
        // 仅登记条目的启动按钮是禁用的 —— 靠它量「禁用态不给按压反馈」
        mk('z', '只登记不启动', 1, true)
      ],
      ignoredListeners: [],
      settings: { scanIntervalMs: 2000, theme: 'dark' }
    },
    null,
    2
  ),
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

    const goto = async (label) => {
      await js(`(()=>{const b=[...document.querySelector('nav').querySelectorAll('button')]
        .find(x=>x.getAttribute('aria-label')===${JSON.stringify(label)});b&&b.click();return true})()`)
      for (let i = 0; i < 30; i++) {
        const h = await js(`document.querySelector('h1').textContent.trim()`)
        if (h.startsWith(label)) return true
        await sleep(120)
      }
      return false
    }

    /*
     * 用真实输入管线按住元素中心，读按下瞬间的计算值，再松开。
     * transition 的按下段是 60ms，采样前留 140ms 让它跑完 —— 否则读到的是
     * 插值中的中间态（会量出一个既不是 1 也不是 0.96 的缩放，看着像「有反馈」
     * 但数值对不上任何一档，属于「量到的不是稳定态」）。
     */
    const pressAndRead = async (selectorJs) => {
      const box = await js(`(()=>{const el=${selectorJs};if(!el)return null;
        const r=el.getBoundingClientRect();
        if(r.width===0||r.height===0)return null;
        return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`)
      if (!box) return null

      const idle = await js(`(()=>{const el=${selectorJs};if(!el)return null;
        const cs=getComputedStyle(el);
        return {transform:cs.transform,transition:cs.transitionProperty,bg:cs.backgroundColor}})()`)

      /*
       * 按下再松开就是一次真实点击 —— 不拦的话探针会真的把服务启动起来、真的切走
       * 视图，后面几节量的就不是原来那张卡了（第一版正是这样：第 1 节点了「启动」、
       * 第 2 节点了「诊断」，到第 6 节目标按钮已经不在 DOM 里）。
       *
       * 试过「移到 (2,2) 再松开」来躲开 click：不行。那样元素的 :active 不会解除 ——
       * 实测松开后 START 仍是 matrix(0.96,…,0.96)，且这个卡住的按下态会污染后面所有
       * 小节（第 2/4 节量到 scale=1 是因为鼠标还被按着，第 7 节量到 2.51:1 量的是
       * 按下态的底色，都不是真缺陷）。所以必须在原地松开，改从 click 这一层拦。
       *
       * window 的捕获阶段早于 React 19 挂在根容器上的委托监听，stopPropagation
       * 足以让 onClick 收不到。只拦 click：拦 mousedown 会连 :active 一起按不出来。
       */
      await js(`(()=>{window.__mileEat=(e)=>{e.stopImmediatePropagation();e.preventDefault()};
        window.addEventListener('click',window.__mileEat,true);return true})()`)

      win.webContents.sendInputEvent({
        type: 'mouseDown',
        x: box.x,
        y: box.y,
        button: 'left',
        clickCount: 1
      })
      await sleep(140)
      const down = await js(`(()=>{const el=${selectorJs};if(!el)return null;
        const cs=getComputedStyle(el);
        return {transform:cs.transform,bg:cs.backgroundColor,active:el.matches(':active')}})()`)

      win.webContents.sendInputEvent({
        type: 'mouseUp',
        x: box.x,
        y: box.y,
        button: 'left',
        clickCount: 1
      })
      await sleep(220)
      // 顺手量「松开后确实不再是 :active」：卡住的按下态会让后续小节全部量错
      const up = await js(`(()=>{const el=${selectorJs};if(!el)return null;
        return {transform:getComputedStyle(el).transform,active:el.matches(':active')}})()`)
      await js(`(()=>{window.removeEventListener('click',window.__mileEat,true);return true})()`)
      return { idle, down, up }
    }

    /**
     * matrix(a,b,c,d,e,f) → {scale:a, ty:f}；none 视为未变形。
     *
     * 注意 ty 不等于 CSS 里写的 translateY 值：`scale(.96) translateY(1px)` 是
     * 先缩放再平移，矩阵里的 f = 0.96 × 1 = 0.96。所以 .pressable 量到 0.96、
     * .pressable-flat（无缩放）量到 1.0 —— 两个不同的数都是对的。
     * 断言因此按「缩放后的期望位移」比，不硬套 1px。
     */
    const decode = (t) => {
      if (!t || t === 'none') return { scale: 1, ty: 0 }
      const m = t.match(/[-\d.]+/g)
      if (!m) return { scale: 1, ty: 0 }
      const n = m.map(Number)
      return n.length >= 6 ? { scale: n[0], ty: n[5] } : { scale: 1, ty: 0 }
    }

    console.log('\n=== 1. 卡片主按钮（.btn-primary）按下有位移 ===')
    if (!(await goto('启动台'))) throw new Error('没能切到启动台')
    await sleep(400)

    const START = `[...document.querySelectorAll('main article')]
      .find(a=>a.dataset.entryId==='a')
      ?.querySelector('button[aria-label="启动"]')`

    const primary = await pressAndRead(START)
    check('量到了启动按钮', primary !== null)
    if (primary) {
      // 基态对照：不按下时必须没有变形。基态就带变形的话，下面的断言不成立
      const idleT = decode(primary.idle.transform)
      check(
        '启动按钮基态无变形（对照）',
        idleT.scale === 1 && Math.abs(idleT.ty) < 0.05,
        primary.idle.transform
      )
      check('按下时元素真的命中 :active（探针有效）', primary.down.active === true)
      const d = decode(primary.down.transform)
      check('按下时缩放到 0.96', Math.abs(d.scale - 0.96) < 0.005, `scale=${d.scale}`)
      check('按下时下沉 1px（矩阵里为 0.96×1）', Math.abs(d.ty - 0.96) < 0.02, `ty=${d.ty}`)
      check('松开后弹回原位', decode(primary.up.transform).scale === 1, primary.up.transform)
      // 松开后还卡在 :active 说明探针没真正松手，后面几节量到的都是按下态
      check('松开后解除 :active（探针没卡住）', primary.up.active === false)
      /*
       * 主按钮额外压一档底色。这条要跟基态比，不能只判「读到了颜色」——
       * 那样无论有没有 :active 规则都会通过。
       */
      check(
        '按下时底色与基态不同（额外压了一档）',
        primary.down.bg !== primary.idle.bg,
        `基态 ${primary.idle.bg} → 按下 ${primary.down.bg}`
      )
    }

    console.log('\n=== 2. 次级图标按钮也有反馈 ===')
    const DIAG = `[...document.querySelectorAll('main article')]
      .find(a=>a.dataset.entryId==='a')
      ?.querySelector('button[aria-label="诊断"]')`
    const secondary = await pressAndRead(DIAG)
    check('量到了诊断按钮', secondary !== null)
    if (secondary) {
      check(
        '诊断按钮基态无变形（对照）',
        decode(secondary.idle.transform).scale === 1,
        secondary.idle.transform
      )
      const d = decode(secondary.down.transform)
      check('诊断按钮按下缩放到 0.96', Math.abs(d.scale - 0.96) < 0.005, `scale=${d.scale}`)
      check('诊断按钮按下下沉 1px（矩阵里为 0.96×1）', Math.abs(d.ty - 0.96) < 0.02, `ty=${d.ty}`)
      /*
       * .pressable 是 transition 简写，会盖掉 Tailwind 的 transition-colors。
       * 漏了配色属性的话按钮 hover 变色就成硬切了 —— 这条专防那次回归。
       */
      const props = secondary.idle.transition
      check(
        'transition 同时含 transform 与配色属性',
        props.includes('transform') &&
          props.includes('color') &&
          props.includes('background-color'),
        props
      )
    }

    console.log('\n=== 3. 禁用按钮不给按压反馈 ===')
    const DISABLED = `[...document.querySelectorAll('main article')]
      .find(a=>a.dataset.entryId==='z')
      ?.querySelector('button[aria-label="启动"]')`
    const off = await pressAndRead(DISABLED)
    check(
      '量到了禁用的启动按钮',
      off !== null &&
        (await js(`${DISABLED}?.disabled === true`)) === true,
      off && off.idle.transform
    )
    if (off) {
      check(
        '禁用按钮按下无位移',
        decode(off.down.transform).scale === 1 && Math.abs(decode(off.down.transform).ty) < 0.05,
        off.down.transform
      )
    }

    console.log('\n=== 4. 宽条目用 pressable-flat，只下沉不缩放 ===')
    const HINT = `[...document.querySelectorAll('button')]
      .find(b=>b.className.includes('pressable-flat'))`
    const flat = await pressAndRead(HINT)
    check('量到了 pressable-flat 按钮', flat !== null)
    if (flat) {
      check('flat 基态无变形（对照）', decode(flat.idle.transform).scale === 1, flat.idle.transform)
      const d = decode(flat.down.transform)
      check('flat 按下不缩放', Math.abs(d.scale - 1) < 0.005, `scale=${d.scale}`)
      check('flat 按下下沉 1px（无缩放，矩阵里就是 1）', Math.abs(d.ty - 1) < 0.02, `ty=${d.ty}`)
    }

    console.log('\n=== 5. 覆盖面：可见按钮都挂了按压反馈 ===')
    /*
     * 只数「有 pressable 类」不算量到东西 —— 类名写错、CSS 没生成也照样通过。
     * 这里量的是计算值：transition-property 里有没有 transform。
     * 白名单是窗口控件与侧栏展开条：它们贴着窗口边缘，缩放会露出底下的画布，
     * 按压靠底色表达，故不要求 transform。
     */
    const coverage = await js(`(()=>{
      const skip=['最小化','还原','最大化','关闭','展开实时动态']
      const out={total:0,missing:[]}
      for(const b of document.querySelectorAll('button')){
        if(!b.getClientRects().length)continue
        const label=(b.getAttribute('aria-label')||b.textContent||'').trim().slice(0,12)
        if(skip.includes(label))continue
        out.total++
        if(!getComputedStyle(b).transitionProperty.includes('transform'))out.missing.push(label)
      }
      return out
    })()`)
    check('量到了足够多的可见按钮', coverage.total >= 12, `${coverage.total} 个`)
    check(
      '全部可见按钮的 transition 都含 transform',
      coverage.total >= 12 && coverage.missing.length === 0,
      coverage.missing.join(' | ') || '无遗漏'
    )

    console.log('\n=== 6. reduced-motion 下退化为无位移 ===')
    /*
     * 用 CDP 的 Emulation.setEmulatedMedia 模拟 prefers-reduced-motion。
     * 不能只检查 CSS 文本里有那段 @media —— 那是「读源码」，不是量行为。
     */
    // attach 是同步的、不返回 Promise，已附加时会直接抛
    try {
      win.webContents.debugger.attach('1.3')
    } catch {
      /* 已附加 */
    }
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    })
    const reduced = await pressAndRead(START)
    check(
      'reduced-motion 下按下无位移',
      reduced !== null && reduced.down.active === true && decode(reduced.down.transform).scale === 1,
      reduced && `${reduced.down.transform} active=${reduced && reduced.down.active}`
    )
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] })
    win.webContents.debugger.detach()

    console.log('\n=== 7. 加了按压反馈没有破坏对比度纪律 ===')
    /*
     * 复用 m7 的合成算法：祖先链上的 opacity 与半透明底都要合成后再算，
     * 且按钮文字只取自己的直接文字节点（纯 SVG 按钮的 textContent 来自
     * opacity-0 的 tooltip，拿它会量出一个不存在的问题）。
     */
    const CONTRAST = `(() => {
      /*
       * color-mix() 的计算值不是 rgb()，是 color(srgb 0.83 0.84 0.86) —— 分量在
       * 0..1，不是 0..255。照 rgb 的老办法乘进 lum() 会把一个浅底当成纯黑：
       * 实测深色模式 hover 中的启动按钮被算成 1.09:1（rgb(11,15,20) 配 srgb 0.83），
       * 而它其实是深字浅底、对比度很高。这是探针的缺陷，不是配色回归。
       *
       * 本节的按钮处在 hover 态（松手后指针还停在按钮中心），hover 底色正是
       * color-mix 出来的，所以这条路径只有本 harness 会走到 —— m7 量的是基态。
       */
      const parse=(c)=>{const m=c.match(/[\\d.]+/g).map(Number);
        const k=c.startsWith('color(')?255:1;
        return {r:m[0]*k,g:m[1]*k,b:m[2]*k,a:m.length>3?m[3]:1}};
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
          cls:btn.className.slice(0,40),raw:cs.color+' on '+cs.backgroundColor,
          hover:btn.matches(':hover'),active:btn.matches(':active'),
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
      const rows = await js(CONTRAST)
      const bad = rows.filter((r) => r.ratio < 4.5)
      check(`${theme} 量到可见文字按钮`, rows.length >= 8, `${rows.length} 个`)
      check(
        `${theme} 全部按钮文字仍 ≥ 4.5:1`,
        rows.length >= 8 && bad.length === 0,
        bad
          .map(
            (r) =>
              `${r.name}${r.disabled ? '(禁用)' : ''}=${r.ratio} [${r.raw}] hover=${r.hover} active=${r.active} cls=${r.cls}`
          )
          .join(' ') ||
          `最低 ${Math.min(...rows.map((r) => r.ratio))}`
      )
      const offRows = rows.filter((r) => r.disabled)
      check(
        `${theme} 禁用按钮文字仍 ≥ 4.5:1`,
        offRows.length > 0 && offRows.every((r) => r.ratio >= 4.5),
        offRows.map((r) => `${r.name}=${r.ratio}`).join(' ') || '没量到禁用按钮'
      )
    }
    await js(`window.mile.settings.patch({theme:'dark'})`)
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
