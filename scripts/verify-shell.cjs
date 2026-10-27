/**
 * 阶段 3 外框校验，docs/UI/UI-REFACTOR.md §3.2 / §5。
 *
 * 只量真实 DOM 与焦点：标题栏高度、5 项导航、Ctrl+1..5、`?` 快捷键一览、
 * 动态抽屉的焦点进出与未读数、导航折叠与记忆、删除工作组的应用内确认弹窗（入口在服务页组菜单）。
 *
 *   npm run build
 *   npx electron scripts/verify-shell.cjs
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const SANDBOX = join(tmpdir(), `mile-shell-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
app.setPath('appData', SANDBOX)

const FIX = join(ROOT, 'scripts', 'fixture').replace(/\\/g, '/')
const now = Date.now()
writeFileSync(
  join(SANDBOX, 'mile-terminal', 'config.json'),
  JSON.stringify({
    version: 1,
    entries: [{
      id: 'a', kind: 'service', name: '个人博客', path: FIX, framework: 'node', packageManager: 'npm',
      script: 'dev', scripts: { dev: 'node server.cjs' }, env: {}, registerOnly: false, pinned: false, order: 0, createdAt: now
    }],
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
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? ` — ${detail}` : ''}`)
}

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  win.setBounds({ width: 1180, height: 760 })
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const waitFor = async (code, ms = 4000) => {
    for (let t = 0; t < ms; t += 100) { if (await js(code)) return true; await sleep(100) }
    return false
  }
  const key = (k, mods = {}) => js(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)},bubbles:true,cancelable:true,...${JSON.stringify(mods)}}));true`)
  const h1 = () => js(`(document.querySelector('main h1')||{textContent:''}).textContent.trim()`)
  const click = (sel) => js(`(()=>{const b=document.querySelector(${JSON.stringify(sel)});if(!b)return false;b.focus();b.click();return true})()`)

  await waitFor(`!!document.querySelector('nav[aria-label="主导航"]')`, 30000)
  await js(`localStorage.removeItem('mile.nav.collapsed');true`)

  await waitFor(`(document.querySelector('main h1')||{}).textContent==='总览'`)
  check('打开应用默认是总览', (await h1()) === '总览', await h1())
  console.log('\n=== 1. 外框尺寸与导航 ===')
  const tb = await js(`document.querySelector('header.ui-titlebar').getBoundingClientRect().height`)
  check('标题栏 40px', tb === 40, `${tb}px`)
  const tops = await js(`[...document.querySelectorAll('nav[aria-label="主导航"] .ui-nav-item:not([data-sub])')].map(b=>b.getAttribute('aria-label')).filter(Boolean)`)
  for (const l of ['服务', '总览', '终端', '设置', '关于']) check(`一级导航含「${l}」`, tops.includes(l), tops.join('、'))
  const navW = await js(`document.querySelector('nav[aria-label="主导航"]').getBoundingClientRect().width`)
  check('导航展开 184px', Math.round(navW) === 184, `${navW}px`)
  check('旧的常驻右栏已去掉', !(await js(`!!document.querySelector('aside')`)))

  console.log('\n=== 2. Ctrl+1..5 切换页面 ===')
  const expect = { 1: '总览', 2: '服务', 3: '终端', 4: '设置', 5: '关于' }
  for (const [n, title] of Object.entries(expect)) {
    await key(n, { ctrlKey: true })
    const ok = await waitFor(`(document.querySelector('main h1')||{textContent:''}).textContent.trim()===${JSON.stringify(title)}`, 2000)
    check(`Ctrl+${n} → ${title}`, ok, await h1())
  }
  const cur = await js(`(document.querySelector('nav [aria-current="page"]')||{}).getAttribute?.('aria-label')`)
  check('当前页在导航上标记 aria-current', cur === '关于', cur)

  console.log('\n=== 3. ? 打开快捷键一览，Esc 关闭 ===')
  await key('?', { shiftKey: true })
  check('? 打开快捷键一览', await waitFor(`!!document.querySelector('[role="dialog"] .ui-keys')`, 1500))
  await key('Escape')
  check('Esc 关闭', await waitFor(`!document.querySelector('.ui-keys')`, 1500))
  await click('nav [aria-label="设置"]')
  await waitFor(`document.querySelector('main h1')?.textContent.trim()==='设置'`)
  const typed = await js(`(()=>{const i=document.createElement('input');i.id='__t';document.querySelector('main').prepend(i);i.focus();
    i.dispatchEvent(new KeyboardEvent('keydown',{key:'?',shiftKey:true,bubbles:true,cancelable:true}));return true})()`)
  await sleep(300)
  check('焦点在输入框里时 ? 不触发', typed && !(await js(`!!document.querySelector('.ui-keys')`)))
  await js(`document.getElementById('__t')?.remove();true`)

  console.log('\n=== 4. 动态抽屉：焦点进出与未读数 ===')
  await js(`window.mile.entry.start('a');true`)
  const badge = await waitFor(`!!document.querySelector('.ui-bell-badge')`, 6000)
  check('抽屉关着时新事件出现未读数', badge, await js(`(document.querySelector('.ui-bell-badge')||{}).textContent`))
  await click('.ui-bell')
  check('点「动态」打开抽屉', await waitFor(`!!document.querySelector('aside.ui-drawer')`, 1500))
  check('焦点移进抽屉', await js(`!!document.activeElement.closest('aside.ui-drawer')`))
  check('打开后未读数清零', !(await js(`!!document.querySelector('.ui-bell-badge')`)))
  check('抽屉里有事件', await js(`document.querySelectorAll('aside.ui-drawer li').length>0`))
  await key('Escape')
  check('Esc 关闭抽屉', await waitFor(`!document.querySelector('aside.ui-drawer')`, 1500))
  check('关闭后焦点回到「动态」按钮', await js(`document.activeElement.classList.contains('ui-bell')`),
    await js(`document.activeElement.className||document.activeElement.tagName`))
  await js(`window.mile.entry.stop('a');true`)

  console.log('\n=== 5. 导航折叠与记忆 ===')
  await click('nav [aria-label="折叠导航"]')
  await sleep(350)
  const w2 = await js(`document.querySelector('nav[aria-label="主导航"]').getBoundingClientRect().width`)
  check('折叠后 56px', Math.round(w2) === 56, `${w2}px`)
  check('折叠状态写进 localStorage', (await js(`localStorage.getItem('mile.nav.collapsed')`)) === '1')
  const allNamed = await js(`[...document.querySelectorAll('nav button')].every(b=>b.getAttribute('aria-label'))`)
  check('折叠后每个导航按钮都有可读名称', allNamed)
  const icons = await js(`[...document.querySelectorAll('nav[aria-label="主导航"] .ui-nav-item')].map(b=>{const s=b.querySelector('svg').getBoundingClientRect(),r=b.getBoundingClientRect();return {w:Math.round(s.width),off:Math.round(Math.abs((s.left+s.width/2)-(r.left+r.width/2)))}})`)
  check('折叠后每个图标 ≥ 16px', icons.every((i) => i.w >= 16), icons.map((i) => i.w).join(','))
  check('折叠后图标水平居中', icons.every((i) => i.off <= 1), icons.map((i) => i.off).join(','))
  await click('nav [aria-label="展开导航"]')
  await sleep(350)
  const w3 = await js(`document.querySelector('nav[aria-label="主导航"]').getBoundingClientRect().width`)
  check('再次展开 184px', Math.round(w3) === 184, `${w3}px`)

  console.log('\n=== 6. 删除工作组用应用内确认弹窗 ===')
  await js(`window.mile.group.add({name:'验收组'})`)
  // 工作组页已并入服务页（阶段 4）：删除入口在组磁贴的「⋯」菜单里
  const openDelete = async () => {
    await click('nav [aria-label="服务"]')
    await waitFor(`!!document.querySelector('[aria-label="验收组 更多操作"]')`, 4000)
    await click('[aria-label="验收组 更多操作"]')
    await waitFor(`!!document.querySelector('[role="menu"]')`, 1500)
    await js(`(()=>{const b=[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find(x=>x.textContent.trim()==='删除工作组');if(!b)return false;b.click();return true})()`)
  }
  await openDelete()
  check('弹出 alertdialog', await waitFor(`!!document.querySelector('[role="alertdialog"]')`, 1500))
  check('默认焦点在「取消」', (await js(`document.activeElement.textContent.trim()`)) === '取消',
    await js(`document.activeElement.textContent.trim()`))
  await key('Escape')
  await sleep(300)
  check('Esc 取消后弹窗消失', !(await js(`!!document.querySelector('[role="alertdialog"]')`)))
  check('取消后工作组还在', (await js(`window.mile.group.list().then(l=>l.length)`)) === 1)
  await openDelete()
  await waitFor(`!!document.querySelector('[role="alertdialog"]')`, 1500)
  await js(`[...document.querySelectorAll('[role="alertdialog"] button')].find(b=>b.textContent.trim()==='删除工作组').click();true`)
  const gone = await waitFor(`window.mile.group.list().then(l=>l.length===0)`, 3000)
  check('确认后工作组被删除', gone)

  console.log('\n=== 7. 终端页：会话分段、全部输出并入（§3.5）===')
  const navLabels = await js(`[...document.querySelectorAll('nav[aria-label="主导航"] button')].map(b=>b.getAttribute('aria-label'))`)
  check('导航上不再有单独的「日志」', !navLabels.includes('日志'), navLabels.join('、'))
  await key('3', { ctrlKey: true })
  check('Ctrl+3 进入终端页', await waitFor(`(document.querySelector('main h1')||{}).textContent==='终端'`))
  await click('button[aria-label="新建终端会话"]')
  check('新建的 PowerShell 出现在「我的终端」段', await waitFor(`(()=>{const h=[...document.querySelectorAll('.term-sec')].find(x=>x.textContent==='我的终端');return !!h&&!!h.parentElement.querySelector('.term-sess')})()`, 8000))
  check('会话项不再把停止按钮嵌在按钮里', await js(`!document.querySelector('.term-sess button button')`))
  check('有「终端 / 全部输出」切换', await js(`[...document.querySelectorAll('main [role="radio"]')].map(r=>r.textContent).join('|').includes('全部输出')`))
  await js(`[...document.querySelectorAll('main [role="radio"]')].find(r=>r.textContent.includes('全部输出')).click();true`)
  check('全部输出标签里有日志流', await waitFor(`!!document.querySelector('main [role="log"]')`))
  const jumped = await waitFor(`window.mile.session.list().then(list=>{const live=new Set(list.map(s=>s.id));const li=[...document.querySelectorAll('main [role="log"] li')].find(x=>live.has(x.dataset.sessionId));const b=li&&li.querySelector('button:not([disabled])');if(!b)return false;b.click();return true})`, 8000)
  check('日志行可点', jumped)
  check('点日志行回到终端标签', await waitFor(`!document.querySelector('main [role="log"]') && !!document.querySelector('.term-sess[aria-current="true"]')`, 3000))
  await js(`(async()=>{const l=await window.mile.session.list();for(const s of l)await window.mile.session.stop(s.id).catch(()=>{});return true})()`).catch(() => null)

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`) }
  app.exit(fail === 0 ? 0 : 1)
})
