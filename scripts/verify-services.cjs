/**
 * 阶段 4 服务页校验，docs/UI/UI-REFACTOR.md §3.3 / Q8 / Q10 / Q12 / Q14 / Q20。
 *
 * 只量真实 DOM 与运行时状态：工作组磁贴分段、类型筛选与搜索、详情分栏与列表收窄、
 * 五个标签、记住上次标签、prod 整组启动先确认、单个启停、成员行「⋯」菜单、仅登记标记。
 *
 *   npm run build
 *   npx electron scripts/verify-services.cjs
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const SANDBOX = join(tmpdir(), `mile-svc-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
app.setPath('appData', SANDBOX)

const FIX = join(ROOT, 'scripts', 'fixture').replace(/\\/g, '/')
const FIXT = join(ROOT, 'scripts', 'fixture-task').replace(/\\/g, '/')
const now = Date.now()
const mk = (id, name, kind, path, script, scripts, order, registerOnly = false) => ({
  id, kind, name, path, framework: 'node', packageManager: 'npm',
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
  win.webContents.on('console-message', (e) => { const m = e.message || ''; if (/error|Error|Uncaught/.test(m)) console.log('  [renderer] ' + m.slice(0, 300)) })
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const waitFor = async (code, ms = 6000) => {
    for (let t = 0; t < ms; t += 100) { if (await js(code)) return true; await sleep(100) }
    return false
  }
  const key = (k, mods = {}) => js(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)},bubbles:true,cancelable:true,...${JSON.stringify(mods)}}));true`)
  /** 在 scope 内按可读名称（aria-label 或文字）点按钮 */
  const press = (scope, label) => js(`(()=>{const r=document.querySelector(${JSON.stringify(scope)});if(!r)return false;
    const b=[...r.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')||x.textContent||'').trim().includes(${JSON.stringify(label)}));
    if(!b||b.disabled)return false;b.focus();b.click();return true})()`)
  const visibleRows = () => js(`[...document.querySelectorAll('.svc-row')].map(r=>r.dataset.entryId)`)
  const setSearch = (v) => js(`(()=>{const i=document.querySelector('input[aria-label="搜索服务"]');
    const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,${JSON.stringify(v)});
    i.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
  const status = (id) => js(`window.mile.entry.list().then(()=>true)`).then(() =>
    js(`(document.querySelector('[data-entry-id="${id}"] .ui-dot')||{dataset:{}}).dataset.tone||''`))

  await waitFor(`!!document.querySelector('nav[aria-label="主导航"]')`, 30000)

  // 工作组走 IPC 建，避免配置迁移把手写的 groups 丢掉
  const ids = await js(`(async()=>{
    const mall=await window.mile.group.add({name:'商城项目',env:'dev'});
    const site=await window.mile.group.add({name:'官网生产',env:'prod'});
    await window.mile.entry.edit('a',{groupId:mall.id});
    await window.mile.entry.edit('d',{groupId:mall.id});
    await window.mile.entry.edit('b',{groupId:site.id});
    return {mall:mall.id,site:site.id}})()`)

  console.log('\n=== 1. 工作组分段 ===')
  await key('1', { ctrlKey: true })
  const onPage = await waitFor(`(document.querySelector('main h1')||{}).textContent==='服务'`)
  check('Ctrl+1 进入服务页', onPage)
  await sleep(300)
  const kinds = await js(`Object.fromEntries([...document.querySelectorAll('.svc-row')].map(r=>[r.dataset.entryId,(r.querySelector('.svc-kind')||{textContent:''}).textContent]))`)
  check('每行标注任务或服务', kinds.d === '任务' && kinds.a === '服务' && kinds.b === '服务', JSON.stringify(kinds))
  await waitFor(`document.querySelectorAll('[data-group-id]').length>=3`)
  const tiles = await js(`[...document.querySelectorAll('[data-group-id]')].map(t=>t.getAttribute('aria-label'))`)
  check('两个工作组 + 未分组三块磁贴', tiles.length === 3, tiles.join('、'))
  check('「未分组」排在最后', tiles[tiles.length - 1] === '未分组', tiles.join('、'))
  const inMall = await js(`[...document.querySelectorAll('[data-group-id="${ids.mall}"] .svc-row')].map(r=>r.dataset.entryId)`)
  check('成员按 groupId 归到对应磁贴', inMall.join() === 'a,d', inMall.join())
  const cols0 = await js(`getComputedStyle(document.querySelector('.svc-groups')).gridTemplateColumns.split(' ').length`)
  check('没打开详情时磁贴排 2 列', cols0 === 2, `${cols0} 列`)
  const regOnly = await js(`(document.querySelector('[data-entry-id="e"]')||{textContent:''}).textContent.includes('仅登记')`)
  check('仅登记条目显示「仅登记」而不是启动按钮', regOnly)

  console.log('\n=== 2. 类型筛选与搜索 ===')
  await press('[role="radiogroup"][aria-label="类型"]', '任务')
  await sleep(200)
  check('「任务」只剩任务条目', (await visibleRows()).join() === 'd', (await visibleRows()).join())
  await press('[role="radiogroup"][aria-label="类型"]', '全部')
  await setSearch('博客')
  await sleep(200)
  check('搜索「博客」只剩一行', (await visibleRows()).join() === 'a', (await visibleRows()).join())
  await setSearch('')
  await sleep(200)
  check('清空搜索后全部回来', (await visibleRows()).length === 4, (await visibleRows()).join())

  console.log('\n=== 3. 详情分栏 ===')
  await js(`document.querySelector('[data-entry-id="a"]').click();true`)
  const opened = await waitFor(`!!document.querySelector('.svc-detail')`)
  check('点成员行打开详情', opened)
  check('选中行 aria-selected', await js(`document.querySelector('[data-entry-id="a"]').getAttribute('aria-selected')==='true'`))
  const listW = await js(`Math.round(document.querySelector('.ui-split-list').getBoundingClientRect().width)`)
  check('列表收窄到约 360px', Math.abs(listW - 360) <= 2, `${listW}px`)
  const cols1 = await js(`getComputedStyle(document.querySelector('.svc-groups')).gridTemplateColumns.split(' ').length`)
  check('打开详情后磁贴变 1 列', cols1 === 1, `${cols1} 列`)
  const tabs = await js(`[...document.querySelectorAll('.svc-detail [role="tab"]')].map(t=>t.textContent.trim())`)
  check('非 Java 条目有 4 个标签（无「构建」）', tabs.length === 4 && !tabs.some((t) => t.startsWith('构建')), tabs.join('、'))
  for (const t of ['输出', '诊断', '配置', '概览']) {
    await press('.svc-detail [role="tablist"]', t)
    await sleep(150)
    const sel = await js(`(document.querySelector('.svc-detail [role="tab"][aria-selected="true"]')||{textContent:''}).textContent.trim()`)
    check(`切到「${t}」`, sel.startsWith(t), sel)
  }
  const diagHasPanel = await (async () => {
    await press('.svc-detail [role="tablist"]', '诊断')
    return waitFor(`!!document.querySelector('.svc-detail [role="tabpanel"]') && document.querySelector('.svc-detail [role="tabpanel"]').textContent.length>4`)
  })()
  check('「诊断」标签拿到预检结果', diagHasPanel)

  console.log('\n=== 4. 记住上次的标签（Q20） ===')
  await press('.svc-detail [role="tablist"]', '输出')
  await js(`document.querySelector('[data-entry-id="b"]').click();true`)
  await sleep(300)
  const keptTab = await js(`(document.querySelector('.svc-detail [role="tab"][aria-selected="true"]')||{textContent:''}).textContent.trim()`)
  check('换服务后仍停在「输出」', keptTab.startsWith('输出'), keptTab)
  const detailName = await js(`(document.querySelector('.svc-detail-title')||{textContent:''}).textContent.trim()`)
  check('详情跟着换到新选中的服务', detailName === '公司文档站', detailName)

  console.log('\n=== 5. prod 整组启动先确认（Q14） ===')
  await press(`[data-group-id="${ids.site}"]`, '全部启动')
  const dlg = await waitFor(`!!document.querySelector('[role="alertdialog"]')`)
  check('prod 组整组启动弹出确认', dlg)
  const focusCancel = await js(`(document.activeElement||{textContent:''}).textContent.trim()`)
  check('默认焦点在「取消」', focusCancel === '取消', focusCancel)
  await key('Escape')
  await sleep(600)
  check('取消后没有启动', (await status('b')) !== 'live', await status('b'))

  console.log('\n=== 6. 单个启停 ===')
  await press('[data-entry-id="a"]', '启动')
  const running = await waitFor(`(document.querySelector('[data-entry-id="a"] .ui-dot')||{dataset:{}}).dataset.tone==='live'`, 15000)
  check('点「启动」后状态点变为运行中', running, await status('a'))
  const count = await js(`(document.querySelector('[data-group-id="${ids.mall}"] .svc-count')||{textContent:''}).textContent.trim()`)
  check('组头计数更新为 1/1', /1\s*\/\s*1/.test(count), count)
  const tone = await js(`document.querySelector('[data-group-id="${ids.mall}"]').dataset.tone||''`)
  check('全部运行时磁贴描边转成功色', tone === 'live', tone)
  await press('[data-entry-id="a"]', '停止')
  const stopped = await waitFor(`(document.querySelector('[data-entry-id="a"] .ui-dot')||{dataset:{}}).dataset.tone!=='live'`, 15000)
  check('点「停止」后不再运行', stopped, await status('a'))

  console.log('\n=== 7. 成员行「⋯」菜单 ===')
  await press('[data-entry-id="a"]', '更多操作')
  const menuOk = await waitFor(`!!document.querySelector('[role="menu"]')`)
  check('打开菜单', menuOk)
  const items = await js(`[...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].map(m=>m.textContent.trim())`)
  for (const l of ['重启', '强制关闭', '查看输出', '诊断', '打开目录', '移除']) check(`菜单含「${l}」`, items.includes(l), items.join('、'))
  check('焦点进入菜单', await js(`!!document.activeElement.closest('[role="menu"]')`))
  await key('Escape')
  await sleep(200)
  check('Esc 关闭菜单', !(await js(`!!document.querySelector('[role="menu"]')`)))

  console.log('\n=== 8. 关闭详情 ===')
  await press('.svc-detail', '关闭详情')
  await sleep(300)
  check('关闭后详情消失', !(await js(`!!document.querySelector('.svc-detail')`)))
  const cols2 = await js(`getComputedStyle(document.querySelector('.svc-groups')).gridTemplateColumns.split(' ').length`)
  check('关闭后磁贴回到 2 列', cols2 === 2, `${cols2} 列`)

  console.log('\n=== 配置标签直接编辑（Q13）===')
  const nameInput = `[...document.querySelectorAll('.svc-detail label')].find(l=>l.textContent.trim().startsWith('名称'))?.querySelector('input')`
  const setName = (v) => js(`(()=>{const i=${nameInput};if(!i)return false;
    const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,${JSON.stringify(v)});
    i.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
  await js(`document.querySelector('[data-entry-id="a"]').click();true`)
  await waitFor(`!!document.querySelector('.svc-detail')`)
  await press('.svc-detail', '配置')
  check('配置标签里有可编辑的名称输入框', await waitFor(`!!(${nameInput})`))
  check('未改动时没有保存条', !(await js(`!!document.querySelector('.svc-savebar')`)))
  await setName('个人博客2')
  check('改动后出现保存条', await waitFor(`!!document.querySelector('.svc-savebar')`))

  await js(`document.querySelector('[data-entry-id="b"]').click();true`)
  check('有未保存改动时切换服务先确认', await waitFor(`!!document.querySelector('[role="alertdialog"]')`))
  await press('[role="alertdialog"]', '取消')
  await waitFor(`!document.querySelector('[role="alertdialog"]')`)
  check('取消后仍停在原服务', await js(`document.querySelector('[data-entry-id="a"]').getAttribute('aria-selected')==='true'`))
  check('取消后改动还在', (await js(`(${nameInput})?.value`)) === '个人博客2')

  await press('.svc-savebar', '放弃')
  check('放弃后保存条消失', await waitFor(`!document.querySelector('.svc-savebar')`))
  check('放弃后回到已保存的值', (await js(`(${nameInput})?.value`)) === '个人博客', await js(`(${nameInput})?.value`))

  await setName('个人博客-改')
  await waitFor(`!!document.querySelector('.svc-savebar')`)
  await press('.svc-savebar', '保存')
  const saved = await waitFor(`window.mile.entry.list().then(l=>l.find(e=>e.id==='a')?.name==='个人博客-改')`)
  check('保存后写进主进程配置', saved)
  check('保存后保存条消失', await waitFor(`!document.querySelector('.svc-savebar')`))
  // 常用 / 高级分组（Q13）
  const grp = await js(`(()=>{const a=document.querySelector('.svc-detail details.svc-adv');if(!a)return null;
    const labels=(root)=>[...root.querySelectorAll('label')].map(l=>l.textContent.trim().slice(0,4));
    return {open:a.open,adv:a.textContent.includes('环境变量'),nameOutside:!a.contains(document.querySelector('.svc-detail input:not([type=number])'))}})()`)
  check('配置分「常用 / 高级」，高级默认折叠', !!grp && grp.open === false, JSON.stringify(grp))
  check('环境变量放在「高级」里', !!grp && grp.adv)
  check('名称在「常用」里，不用展开就能改', !!grp && grp.nameOutside)
  check('列表行显示新名称', await waitFor(`document.querySelector('[data-entry-id="a"]').textContent.includes('个人博客-改')`))

  console.log('\n=== 列表键盘操作（Q15）===')
  // 回到干净状态：关掉详情、焦点离开按钮，单键快捷键才会生效
  await press('.svc-detail', '关闭详情')
  await sleep(300)
  await js(`document.activeElement&&document.activeElement.blur();true`)
  await key('Escape')
  await sleep(150)
  check('详情已关时 Esc 清掉键盘光标', !(await js(`!!document.querySelector('[data-cursor]')`)))
  const cursor = () => js(`(()=>{const r=document.querySelector('.svc-row[data-cursor]');if(r)return r.dataset.entryId;
    const h=document.querySelector('.svc-group-head[data-cursor]');return h?'g:'+h.closest('[data-group-id]').dataset.groupId:null})()`)
  await key('ArrowDown')
  await sleep(150)
  check('↓ 先落到第一个组头', (await cursor()) === `g:${ids.mall}`, await cursor())
  await key('ArrowDown')
  await sleep(150)
  check('再 ↓ 落到组内第一个成员', (await cursor()) === 'a', await cursor())
  await key('ArrowDown')
  await key('ArrowUp')
  await sleep(150)
  check('↑ 回到上一行', (await cursor()) === 'a', await cursor())
  await key('Enter')
  await waitFor(`!!document.querySelector('.svc-detail')`)
  check('Enter 打开详情', await js(`!!document.querySelector('.svc-detail')`))
  await key('ArrowDown')
  await sleep(250)
  check('详情打开时方向键换服务，详情跟随', (await js(`(document.querySelector('.svc-detail-title')||{textContent:''}).textContent.trim()`)) === '清理构建缓存',
    await js(`(document.querySelector('.svc-detail-title')||{textContent:''}).textContent.trim()`))
  const tabNow = () => js(`(document.querySelector('.svc-detail [role="tab"][aria-selected="true"]')||{textContent:''}).textContent.trim()`)
  const before = await tabNow()
  await key('Tab', { ctrlKey: true })
  await sleep(200)
  check('Ctrl+Tab 切到下一个标签', (await tabNow()) !== before, `${before} → ${await tabNow()}`)
  await key('ArrowUp')
  await sleep(250)
  // 前面的点击测试停过 a，等它真正停下（停止中按 Space 不会再发一次停止）
  const dotA = `(document.querySelector('[data-entry-id="a"] .ui-dot')||{dataset:{}}).dataset.tone`
  await waitFor(`${dotA}==='idle'`, 10000)
  await key(' ')
  const spaceOk = await waitFor(`${dotA}==='live'`, 8000)
  check('Space 启动选中的服务', spaceOk, await js(dotA))
  await key(' ')
  check('再按 Space 停止', await waitFor(`(document.querySelector('[data-entry-id="a"] .ui-dot')||{dataset:{}}).dataset.tone!=='live'`, 8000))
  await key('Escape')
  await sleep(250)
  check('Esc 关闭详情', !(await js(`!!document.querySelector('.svc-detail')`)))
  // 焦点在搜索框里时方向键交给输入框
  await js(`document.querySelector('input[aria-label="搜索服务"]').focus();true`)
  const c0 = await cursor()
  // 真实按键的 target 是焦点元素，这里同样派发到 activeElement
  await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));true`)
  await sleep(150)
  check('焦点在搜索框里时方向键不移动光标', (await cursor()) === c0, `${c0} → ${await cursor()}`)
  await js(`document.activeElement.blur();true`)

  console.log('\n=== 布局：控件不贴边、组头一行、名称与副标题分行 ===')
  await js(`document.activeElement&&document.activeElement.blur();true`)
  await key('Escape'); await key('Escape'); await sleep(250)
  const TIGHT = `(()=>{const out=[];for(const el of document.querySelectorAll('main button, main input, main select, main [role="tab"]')){
    if(!el.getClientRects().length)continue;const tile=el.closest('.ui-tile');if(!tile)continue;
    const a=el.getBoundingClientRect(),b=tile.getBoundingClientRect();
    // 滚出可视区的控件不算贴边：它被滚动容器裁掉了，看不见
    let sc=el.parentElement,cut=false,vclip=false;while(sc&&sc!==tile){const o=getComputedStyle(sc).overflowY;if(o==='auto'||o==='scroll'){const c=sc.getBoundingClientRect();if(a.bottom<=c.top||a.top>=c.bottom)cut=true;else if(a.top<c.top||a.bottom>c.bottom)vclip=true;break}sc=sc.parentElement}
    if(cut)continue;
    const d=vclip?Math.min(a.left-b.left,b.right-a.right):Math.min(a.left-b.left,b.right-a.right,a.top-b.top,b.bottom-a.bottom);
    if(d<8)out.push(((el.getAttribute('aria-label')||el.textContent||el.tagName).trim().slice(0,12))+'='+Math.round(d))}return out})()`
  const t0 = await js(TIGHT)
  check('列表视图没有贴边控件（≥ 8px）', t0.length === 0, t0.join('，') || '0 个')
  const head = await js(`(()=>{const h=document.querySelector('[data-group-id="${ids.mall}"] .svc-group-head');const t=h.querySelector('.ui-tile-title').getBoundingClientRect();
    const b=h.querySelector('button').getBoundingClientRect();const r=h.getBoundingClientRect();
    return {h:Math.round(r.height),dy:Math.round(Math.abs((t.top+t.height/2)-(b.top+b.height/2))),left:Math.round(t.left-r.left)}})()`)
  check('组头一行：标题与整组按钮垂直居中对齐', head.dy <= 4 && head.h <= 56, JSON.stringify(head))
  const nm = await js(`(()=>{const n=document.querySelector('[data-entry-id="a"] .svc-row-name');const b=n.querySelector('b').getBoundingClientRect(),s=n.querySelector('span').getBoundingClientRect();return {nameBottom:Math.round(b.bottom),subTop:Math.round(s.top)}})()`)
  check('成员行名称与副标题分两行', nm.subTop >= nm.nameBottom - 1, JSON.stringify(nm))
  await js(`document.querySelector('[data-entry-id="a"]').click();true`)
  await waitFor(`!!document.querySelector('.svc-detail')`)
  for (const t of ['概览', '输出', '诊断', '配置']) {
    await js(`[...document.querySelectorAll('.svc-detail [role="tab"]')].find(x=>x.textContent.includes('${t}')).click();true`)
    await sleep(400)
    const tt = await js(TIGHT)
    check(`详情「${t}」没有贴边控件`, tt.length === 0, tt.join('，') || '0 个')
  }
  await press('.svc-detail', '关闭详情')
  await sleep(250)

  console.log('\n=== 总览服务操作台：按打开次数排序、最多 5 个、无左侧图标 ===')
  await js(`localStorage.setItem('mile.launchCount',JSON.stringify({b:9,e:5}));true`)
  await key('2', { ctrlKey: true })
  await waitFor(`!!document.querySelector('section[aria-labelledby="my-services-panel-heading"] li')`)
  const ops = await js(`[...document.querySelectorAll('section[aria-labelledby="my-services-panel-heading"] li')].map(li=>({t:li.textContent,img:!!li.querySelector('img, [data-glyph], .entry-glyph')}))`)
  check('打开次数最多的排第一', /公司文档站/.test(ops[0] && ops[0].t), ops.map((o) => o.t.slice(0, 6)).join('、'))
  check('次多的排第二', /只登记/.test(ops[1] && ops[1].t))
  check('最多显示 5 个', ops.length <= 5, `${ops.length} 个`)
  check('列表项左侧不再有图标', ops.every((o) => !o.img))

  console.log('\n=== 运行状态筛选 ===')
  await js(`document.activeElement&&document.activeElement.blur();true`)
  await key('Escape'); await key('Escape'); await sleep(200)
  await key('1', { ctrlKey: true }); await sleep(300)
  const pickStatus = (v) => js(`(()=>{const s=document.querySelector('select[aria-label="运行状态"]');if(!s)return false;
    const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;set.call(s,${JSON.stringify(v)});
    s.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
  check('工具条有运行状态筛选', await pickStatus('all'))
  const allRows = (await visibleRows()).length
  await pickStatus('running'); await sleep(300)
  const runRows = (await visibleRows()).length
  check('筛「运行中」后行数减少', runRows < allRows, `${allRows} → ${runRows}`)
  const empty = await js(`!!document.querySelector('.svc-empty-row')&&[...document.querySelectorAll('main button')].some(b=>b.textContent.trim()==='清除筛选')`)
  check('筛空时给提示和「清除筛选」，不是空白', runRows > 0 || empty)
  await pickStatus('stopped'); await sleep(300)
  const stopRows = await visibleRows()
  check('筛「已停止」只剩未运行条目', stopRows.length > 0 && stopRows.length <= allRows, stopRows.join(','))
  await pickStatus('all'); await sleep(300)
  check('切回「全部状态」行数复原', (await visibleRows()).length === allRows)

  console.log('\n=== 添加对话框 ===')
  await press('main', '添加服务')
  check('打开添加对话框', await waitFor(`!!document.querySelector('.add-dialog[role="dialog"]')`, 2000))
  const addDlg = await js(`(()=>{const d=document.querySelector('.add-dialog');const s=getComputedStyle(d);const sc=getComputedStyle(document.querySelector('.add-scrim'));
    return {shadow:s.boxShadow,radius:s.borderRadius,blur:sc.backdropFilter,focusIn:d.contains(document.activeElement),drop:!!d.querySelector('.add-drop')}})()`)
  check('对话框有浮层阴影', !!addDlg.shadow && addDlg.shadow !== 'none', addDlg.shadow.slice(0, 60))
  check('遮罩模糊', /blur/.test(addDlg.blur || ''), addDlg.blur)
  check('打开后焦点在对话框内', addDlg.focusIn)
  check('未选目录时显示选择目录的大按钮', addDlg.drop)
  const addBtn = await js(`(()=>{const b=[...document.querySelectorAll('.add-dialog button')].find(x=>x.textContent.trim()==='添加服务');return b?b.disabled:null})()`)
  check('未选目录时「添加服务」禁用', addBtn === true, String(addBtn))
  await key('Escape'); await sleep(300)
  check('Esc 关闭对话框', !(await js(`!!document.querySelector('.add-dialog')`)))

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`) }
  app.exit(fail === 0 ? 0 : 1)
})
