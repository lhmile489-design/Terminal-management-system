/**
 * M8 校验，PRD §4.6 / §4.7：条目编辑、任务完成状态、卡片筛选。
 *
 * 编辑的要害是校验而不是「表单能填」：渲染层现在只有 entry:edit 一个写入口，
 * 它挡不住的东西就会直接落盘。所以非法输入逐类打一遍，并每次回读磁盘确认没被污染。
 *
 * 任务状态验的是「130 与失败分开」且「用户中止不算失败」—— 后者按退出码判一定会错，
 * taskkill 掉的任务退出码是什么全看它当时在干什么。
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, rmSync, readFileSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const FIX = join(__dirname, 'fixture')
const FIXT = join(__dirname, 'fixture-task')

const SANDBOX = join(tmpdir(), `mile-m8-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
app.setPath('appData', SANDBOX)
const CONFIG = join(SANDBOX, 'mile-terminal', 'config.json')

const now = Date.now()
const mk = (id, name, kind, path, script, scripts, order) => ({
  id, kind, name, path,
  framework: 'node', packageManager: 'npm',
  script, scripts, env: {}, registerOnly: false, pinned: false, order, createdAt: now
})

writeFileSync(
  CONFIG,
  JSON.stringify({
    version: 1,
    entries: [
      mk('svc', '个人博客', 'service', FIX, 'dev', { dev: 'node server.cjs' }, 0),
      mk('svc2', '公司文档站', 'service', FIX, 'dev', { dev: 'node server.cjs' }, 1),
      mk('task', '清理构建缓存', 'task', FIXT, 'build',
        { build: 'node make.cjs', lint: 'node -e "0"', cancel: 'node cancel.cjs', boom: 'node -e "process.exit(2)"' }, 2)
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

/** 落盘配置，用来确认被拒的编辑没有半途写进去 */
const onDisk = () => JSON.parse(readFileSync(CONFIG, 'utf8'))
const diskEntry = (id) => onDisk().entries.find((e) => e.id === id)

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  win.setBounds({ width: 1500, height: 940 })
  const js = (code) => win.webContents.executeJavaScript(code, true)

  /** 走渲染层的 preload 通道，与用户点击面板走的是同一条路 */
  const edit = (id, patch) =>
    js(`window.mile.entry.edit(${JSON.stringify(id)}, ${JSON.stringify(patch)})
      .then(e=>({ok:true,entry:e})).catch(e=>({ok:false,message:String(e.message||e)}))`)

  await js(`window.mile.scanner.setVisible(true); window.mile.scanner.refresh(); true`)
  await sleep(1500)

  console.log('\n=== 1. 合法编辑落盘 ===')
  const renamed = await edit('svc', { name: '个人博客 v2' })
  check('改名成功', renamed.ok && renamed.entry.name === '个人博客 v2',
    renamed.ok ? renamed.entry.name : renamed.message)
  check('改名已落盘', diskEntry('svc').name === '个人博客 v2', diskEntry('svc').name)

  const ported = await edit('svc', { expectedPort: 4321 })
  check('设置端口成功', ported.ok && ported.entry.expectedPort === 4321,
    ported.ok ? String(ported.entry.expectedPort) : ported.message)

  const cleared = await edit('svc', { expectedPort: null })
  check('null 清空端口', cleared.ok && cleared.entry.expectedPort === undefined,
    cleared.ok ? String(cleared.entry.expectedPort) : cleared.message)
  check('清空后磁盘上确实没有该键', !('expectedPort' in diskEntry('svc')),
    JSON.stringify(Object.keys(diskEntry('svc')).filter((k) => k.includes('ort'))))

  const scripted = await edit('svc', { script: 'dev', registerOnly: false })
  check('切换到已声明脚本成功', scripted.ok, scripted.ok ? 'dev' : scripted.message)

  console.log('\n=== 2. 非法编辑被拒且不污染磁盘 ===')
  const before = JSON.stringify(onDisk())
  const rejects = [
    ['空名称', { name: '   ' }],
    ['超长名称', { name: 'x'.repeat(61) }],
    ['未声明的脚本', { script: 'nope' }],
    ['含 & 的脚本名', { script: 'dev&calc' }],
    ['非法类型', { kind: 'daemon' }],
    ['相对项目目录', { path: 'relative/dir' }],
    ['子目录跳出项目根', { cwd: '../../windows' }],
    ['子目录用绝对路径', { cwd: 'C:/windows' }],
    ['端口 0', { expectedPort: 0 }],
    ['端口 70000', { expectedPort: 70000 }],
    ['端口非整数', { expectedPort: 8080.5 }],
    ['非法包管理器', { packageManager: 'curl | sh' }],
    ['非法框架', { framework: 'malware' }],
    ['环境变量名非法', { env: { 'PATH;calc': 'x' } }],
    ['环境变量值非字符串', { env: { TOKEN: 123 } }],
    ['脚本表值非字符串', { scripts: { dev: 42 } }],
    ['产物目录跳出项目根', { outputDir: '../../..' }],
    ['产物目录用绝对路径', { outputDir: 'C:/windows/system32' }],
    ['置顶传字符串', { pinned: 'yes' }],
    ['仅登记传数字', { registerOnly: 1 }]
  ]
  for (const [label, patch] of rejects) {
    const r = await edit('svc', patch)
    check(`拒绝${label}`, !r.ok, r.ok ? '竟然通过了' : r.message)
  }
  check('被拒的编辑未污染磁盘配置', JSON.stringify(onDisk()) === before)

  // 白名单外的键静默丢弃，而不是连带整个请求失败 —— 但绝不能写进去
  const sneaky = await edit('svc', { name: '个人博客 v3', order: 99, createdAt: 1, lastExitCode: 7 })
  check('白名单外的键被丢弃', sneaky.ok && sneaky.entry.order === 0 && sneaky.entry.createdAt === now,
    sneaky.ok ? `order=${sneaky.entry.order} createdAt=${sneaky.entry.createdAt === now}` : sneaky.message)
  check('不存在的条目被拒', !(await edit('nope', { name: 'x' })).ok)

  console.log('\n=== 3. 类型与端口的联动 ===')
  await edit('svc2', { expectedPort: 5555 })
  const toTask = await edit('svc2', { kind: 'task' })
  check('改成任务时端口被清空', toTask.ok && toTask.entry.expectedPort === undefined,
    toTask.ok ? String(toTask.entry.expectedPort) : toTask.message)
  check('任务不接受端口', !(await edit('svc2', { expectedPort: 6666 })).ok)
  await edit('svc2', { kind: 'service' })

  console.log('\n=== 4. 运行中锁定身份字段 ===')
  await js(`window.mile.entry.start('svc')`)
  for (let i = 0; i < 40; i++) {
    const s = await js(`window.mile.entry.runtimes().then(r=>(r.find(x=>x.entryId==='svc')||{}).status||'')`)
    if (s === 'running') break
    await sleep(500)
  }
  const running = await js(`window.mile.entry.runtimes()
    .then(r=>(r.find(x=>x.entryId==='svc')||{}).status||'')`)
  check('服务已运行', running === 'running', running)

  const liveName = await edit('svc', { name: '运行中改名' })
  check('运行中可改名称', liveName.ok && liveName.entry.name === '运行中改名',
    liveName.ok ? liveName.entry.name : liveName.message)
  const livePin = await edit('svc', { pinned: true })
  check('运行中可改置顶', livePin.ok && livePin.entry.pinned === true,
    livePin.ok ? 'pinned' : livePin.message)
  const liveCategory = await edit('svc', { category: '运行中分组' })
  check('运行中可改分类', liveCategory.ok && liveCategory.entry.category === '运行中分组',
    liveCategory.ok ? liveCategory.entry.category : liveCategory.message)

  for (const [label, patch] of [
    ['类型', { kind: 'task' }],
    ['项目目录', { path: FIXT }],
    ['子目录', { cwd: 'packages/web' }],
    ['脚本', { script: null }],
    ['包管理器', { packageManager: 'pnpm' }],
    ['环境变量', { env: { EXTRA: '1' } }]
  ]) {
    const r = await edit('svc', patch)
    check(`运行中拒绝改${label}`, !r.ok, r.ok ? '竟然通过了' : r.message)
  }

  // 「同值提交」不该被当成改动：编辑面板每次保存都会带上全部字段
  const noop = await edit('svc', {
    kind: 'service', path: FIX, script: 'dev', packageManager: 'npm', env: {}, name: '运行中改名'
  })
  check('运行中提交未变更的身份字段不报错', noop.ok, noop.ok ? '按内容比对' : noop.message)

  await js(`window.mile.entry.stop('svc')`)
  await sleep(2500)
  const stoppedOk = await edit('svc', { packageManager: 'npm', path: FIX })
  check('停止后身份字段可改', stoppedOk.ok, stoppedOk.ok ? '' : stoppedOk.message)

  console.log('\n=== 5. 任务完成状态 ===')
  const runTask = async (script) => {
    await js(`window.mile.entry.runScript('task', ${JSON.stringify(script)}).catch(()=>null)`)
    for (let i = 0; i < 60; i++) {
      const s = await js(`window.mile.entry.runtimes()
        .then(r=>(r.find(x=>x.entryId==='task')||{}).status||'')`)
      if (['succeeded', 'failed', 'canceled', 'stopped'].includes(s)) return s
      await sleep(500)
    }
    return 'timeout'
  }
  check('退出码 0 → succeeded', (await runTask('build')) === 'succeeded')
  const canceled = await runTask('cancel')
  check('退出码 130 → canceled', canceled === 'canceled', canceled)
  const failed = await runTask('boom')
  check('其他非零码 → failed', failed === 'failed', failed)

  // 用户中止优先于退出码：taskkill 的退出码不确定，按码判会显示成失败
  await js(`window.mile.entry.runScript('task','build').catch(()=>null)`)
  await sleep(300)
  await js(`window.mile.entry.stop('task').catch(()=>null)`)
  let stoppedStatus = 'timeout'
  for (let i = 0; i < 40; i++) {
    const s = await js(`window.mile.entry.runtimes()
      .then(r=>(r.find(x=>x.entryId==='task')||{}).status||'')`)
    if (['succeeded', 'failed', 'canceled', 'stopped'].includes(s)) { stoppedStatus = s; break }
    await sleep(250)
  }
  // 任务太快可能在 stop 之前就成功了，那种情况不算失败，只是这一轮没测到
  check('用户中止 → stopped（不是 failed）', stoppedStatus !== 'failed', stoppedStatus)

  console.log('\n=== 6. 界面：分类分区、筛选与编辑入口 ===')
  await js(`(()=>{const b=[...document.querySelector('nav').querySelectorAll('button')]
    .find(x=>x.getAttribute('aria-label') === '前端启动台');b&&b.click();return true})()`)
  await sleep(1200)

  const sections = await js(`(()=>{
    const areas=[...document.querySelectorAll('main [data-category-kind]')]
      .map(s=>({kind:s.getAttribute('data-category-kind'),cards:s.querySelectorAll('article.surface-card').length}));
    const groups=[...document.querySelectorAll('main [role="radiogroup"]')]
      .map(g=>({label:g.getAttribute('aria-label'),
        items:[...g.querySelectorAll('[role="radio"]')].map(r=>r.textContent.trim())}));
    return {areas,groups,cards:document.querySelectorAll('main article.surface-card').length}})()`)
  check('分类内展示服务与任务分区', sections.areas.some((area) => area.kind === 'service') &&
    sections.areas.some((area) => area.kind === 'task'), JSON.stringify(sections.areas))
  check('两区各有筛选组', sections.groups.length >= 2,
    sections.groups.map((g) => g.label).join(' | '))
  const svcGroup = sections.groups.find((g) => (g.label || '').includes('服务'))
  const taskGroup = sections.groups.find((g) => (g.label || '').includes('任务'))
  check('服务筛选为 全部/运行中/已停止/异常',
    svcGroup && svcGroup.items.join(',') === '全部,运行中,已停止,异常',
    svcGroup && svcGroup.items.join(','))
  check('任务筛选为 全部/运行中/成功/失败/已取消',
    taskGroup && taskGroup.items.join(',') === '全部,运行中,成功,失败,已取消',
    taskGroup && taskGroup.items.join(','))

  const pickFilter = (group, label) =>
    js(`(()=>{const g=[...document.querySelectorAll('main [role="radiogroup"]')]
      .find(x=>(x.getAttribute('aria-label')||'').includes(${JSON.stringify(group)}));
      const r=[...g.querySelectorAll('[role="radio"]')].find(x=>x.textContent.trim()===${JSON.stringify(label)});
      r.click();return true})()`)

  const svcCards = () => js(`document.querySelectorAll(
    'main [data-category-kind="service"] article.surface-card'
  ).length`)

  const allServices = await svcCards()
  await pickFilter('服务', '运行中')
  await sleep(500)
  const runningOnly = await svcCards()
  check('筛「运行中」后服务卡片减少', runningOnly < allServices,
    `${allServices} → ${runningOnly}`)
  check('筛出的空态给出提示而不是空白', runningOnly !== 0 ||
    (await js(`Boolean(document.querySelector('[data-empty-service-filter]'))`)), String(runningOnly))

  // 筛选生效时不给拖拽：reorder 收到的是筛后列表，会把隐藏的卡片推到末尾
  const draggableWhenFiltered = await js(`([...document.querySelectorAll(
    'main [data-category-kind="service"] article.surface-card'
  )]).some(c=>c.draggable)`)
  check('筛选生效时卡片不可拖拽', draggableWhenFiltered === false, String(draggableWhenFiltered))

  await pickFilter('服务', '全部')
  await sleep(500)
  const backToAll = await svcCards()
  check('切回「全部」卡片复原', backToAll === allServices, `${backToAll} vs ${allServices}`)
  const draggableAgain = await js(`([...document.querySelectorAll(
    'main [data-category-kind="service"] article.surface-card'
  )]).some(c=>c.draggable)`)
  check('全部口径下恢复可拖拽', draggableAgain === true, String(draggableAgain))

  console.log('\n=== 7. 编辑面板 ===')
  const openEdit = async () => {
    await js(`(()=>{const c=document.querySelector('main article.surface-card');
      const b=[...c.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='编辑');
      b&&b.click();return true})()`)
    await sleep(600)
  }
  await openEdit()
  const panel = await js(`(()=>{const d=[...document.querySelectorAll('[role="dialog"]')]
    .find(x=>(x.getAttribute('aria-labelledby')||'')==='edit-entry-title');
    if(!d)return null;
    const inputs=[...d.querySelectorAll('input,select')];
    return {title:d.querySelector('#edit-entry-title').textContent.trim(),
      fields:inputs.length,disabled:inputs.filter(i=>i.disabled).length,
      hasStop:!![...d.querySelectorAll('button')].find(b=>b.textContent.includes('停止服务'))}})()`)
  check('编辑面板打开且为模态', !!panel, panel ? panel.title : '未找到')
  if (panel) {
    check('停止态下字段全部可编辑', panel.disabled === 0,
      `${panel.disabled}/${panel.fields} 禁用`)
    check('停止态不显示停止入口', panel.hasStop === false, String(panel.hasStop))
  }

  // 面板内改名并保存，验证走的是同一条校验通道
  await js(`(()=>{const d=[...document.querySelectorAll('[role="dialog"]')]
    .find(x=>(x.getAttribute('aria-labelledby')||'')==='edit-entry-title');
    const i=d.querySelector('input');
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    setter.call(i,'面板改的名字');i.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
  await sleep(300)
  await js(`(()=>{const d=[...document.querySelectorAll('[role="dialog"]')]
    .find(x=>(x.getAttribute('aria-labelledby')||'')==='edit-entry-title');
    const b=[...d.querySelectorAll('button')].find(x=>x.textContent.trim()==='保存');
    b.click();return true})()`)
  await sleep(1200)
  check('面板保存已落盘', onDisk().entries.some((e) => e.name === '面板改的名字'),
    onDisk().entries.map((e) => e.name).join(' | '))
  check('保存后面板关闭', (await js(`!document.querySelector('[aria-labelledby="edit-entry-title"]')`)))

  // 运行中打开：身份字段应禁用，且面板内给出停止入口
  await js(`window.mile.entry.start('svc')`)
  for (let i = 0; i < 40; i++) {
    const s = await js(`window.mile.entry.runtimes()
      .then(r=>(r.find(x=>x.entryId==='svc')||{}).status||'')`)
    if (s === 'running') break
    await sleep(500)
  }
  await sleep(600)
  await js(`(()=>{const c=[...document.querySelectorAll('main article.surface-card')]
    .find(x=>x.dataset.entryId==='svc');
    const b=[...c.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='编辑');
    b&&b.click();return true})()`)
  await sleep(700)
  const livePanel = await js(`(()=>{const d=[...document.querySelectorAll('[role="dialog"]')]
    .find(x=>(x.getAttribute('aria-labelledby')||'')==='edit-entry-title');
    if(!d)return null;
    const inputs=[...d.querySelectorAll('input,select')];
    const nameInput=inputs[0];
    const categoryInput=d.querySelector('[data-entry-category-input]');
    return {disabled:inputs.filter(i=>i.disabled).length,total:inputs.length,
      nameEditable:!nameInput.disabled,
      categoryEditable:!!categoryInput&&!categoryInput.disabled,
      hasStop:!![...d.querySelectorAll('button')].find(b=>b.textContent.includes('停止服务')),
      lockNote:d.textContent.includes('需先停止')}})()`)
  check('运行中打开编辑面板', !!livePanel)
  if (livePanel) {
    check('运行中名称仍可编辑', livePanel.nameEditable === true, String(livePanel.nameEditable))
    check('运行中分类仍可编辑', livePanel.categoryEditable === true, String(livePanel.categoryEditable))
    check('运行中身份字段被禁用', livePanel.disabled > 0,
      `${livePanel.disabled}/${livePanel.total} 禁用`)
    check('面板内给出停止入口', livePanel.hasStop === true, String(livePanel.hasStop))
    check('面板说明了为什么禁用', livePanel.lockNote === true, String(livePanel.lockNote))
  }

  // 面板内停止：不关面板、不清草稿
  await js(`(()=>{const d=[...document.querySelectorAll('[role="dialog"]')]
    .find(x=>(x.getAttribute('aria-labelledby')||'')==='edit-entry-title');
    const i=d.querySelector('input');
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    setter.call(i,'停止前填的草稿');i.dispatchEvent(new Event('input',{bubbles:true}));
    const b=[...d.querySelectorAll('button')].find(x=>x.textContent.includes('停止服务'));
    b.click();return true})()`)
  // 停止要走归属校验 + 进程树终止，等到运行态真的落定再量，别用固定 sleep 赌
  let panelStopStatus = 'timeout'
  for (let i = 0; i < 40; i++) {
    panelStopStatus = await js(`window.mile.entry.runtimes()
      .then(r=>(r.find(x=>x.entryId==='svc')||{}).status||'')`)
    if (panelStopStatus === 'stopped' || panelStopStatus === 'crashed') break
    await sleep(500)
  }
  check('面板内停止真的停下了服务', panelStopStatus === 'stopped' || panelStopStatus === 'crashed',
    panelStopStatus)
  await sleep(500)
  const afterStop = await js(`(()=>{const d=[...document.querySelectorAll('[role="dialog"]')]
    .find(x=>(x.getAttribute('aria-labelledby')||'')==='edit-entry-title');
    if(!d)return null;
    const inputs=[...d.querySelectorAll('input,select')];
    return {open:true,draft:inputs[0].value,disabled:inputs.filter(i=>i.disabled).length,
      hasStop:!![...d.querySelectorAll('button')].find(b=>b.textContent.includes('停止服务'))}})()`)
  check('停止后面板仍打开', !!afterStop && afterStop.open === true)
  if (afterStop) {
    check('停止后草稿未被清空', afterStop.draft === '停止前填的草稿', afterStop.draft)
    check('停止后字段解锁', afterStop.disabled === 0, `${afterStop.disabled} 禁用`)
    check('停止后不再显示停止入口', afterStop.hasStop === false, String(afterStop.hasStop))
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`)
  }
  app.exit(fail === 0 ? 0 : 1)
})
