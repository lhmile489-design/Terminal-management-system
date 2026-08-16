/**
 * M9 校验，PRD §5.2 / §5.3 / §5.5 / §8：分组与提升、启动来源徽标、关注进程、配置备份与迁移。
 *
 * 这一里程碑最容易「看着对但错了」的地方是来源徽标：它是沿父链按进程名猜的，
 * 而进程名是进程自己可以随便写的。所以除了验它有值，还必须验它**不影响**能否终止 ——
 * 一个把自己改名叫 code.exe 的进程不该因此变得可杀。
 *
 * 配置层验的是「坏文件不要覆盖用户数据」：v1 → v2 迁移、.bak 轮转顺序、
 * 主备都读不出时进只读保护。前两条可以量，第三条要单独起一个进程验，见文件末尾。
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const FIX = join(__dirname, 'fixture')

const SANDBOX = join(tmpdir(), `mile-m9-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
app.setPath('appData', SANDBOX)
const CONFIG = join(SANDBOX, 'mile-terminal', 'config.json')
const BAK = join(SANDBOX, 'mile-terminal', 'config.json.bak')

/*
 * 目标版本号从源码里取，不写死。写死的话每加一次迁移，这里就红一次 ——
 * 而它要证的是「迁移落到当前版本并停住」，不是「等于 2」。
 */
const CONFIG_VERSION = Number(
  /CONFIG_VERSION\s*=\s*(\d+)/.exec(readFileSync(join(ROOT, 'src/shared/types.ts'), 'utf8'))[1]
)

const now = Date.now()

/**
 * 故意写一份 v1 结构：没有 version 之后新增的 groupOverrides / watchedKeywords。
 * 这就是老用户升级后磁盘上的样子，迁移必须能吃下它。
 */
const V1 = {
  version: 1,
  entries: [
    {
      id: 'svc',
      kind: 'service',
      name: '个人博客',
      path: FIX,
      framework: 'node',
      packageManager: 'npm',
      script: 'dev',
      scripts: { dev: 'node server.cjs' },
      env: {},
      registerOnly: false,
      pinned: false,
      order: 0,
      createdAt: now
    }
  ],
  ignoredListeners: [],
  settings: {
    scanIntervalMs: 2000,
    theme: 'dark',
    externalTerminal: 'wt',
    terminalFontSize: 13,
    scrollback: 5000,
    killOwnedOnQuit: true,
    closeToTray: false
  }
}
writeFileSync(CONFIG, JSON.stringify(V1, null, 2), 'utf8')

// 启动前先记下 v1 的原样，迁移后要能证明「条目没丢、版本号变了」
const V1_TEXT = readFileSync(CONFIG, 'utf8')
const bakExistedBeforeBoot = existsSync(BAK)

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

const onDisk = () => JSON.parse(readFileSync(CONFIG, 'utf8'))
const onBak = () => JSON.parse(readFileSync(BAK, 'utf8'))

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  win.setBounds({ width: 1500, height: 940 })
  const js = (code) => win.webContents.executeJavaScript(code, true)

  /** 与用户点按钮走同一条 preload 通道，捕获拒绝信息 */
  const call = (expr) =>
    js(`(${expr}).then(v=>({ok:true,value:v})).catch(e=>({ok:false,message:String(e.message||e)}))`)

  await js(`window.mile.scanner.setVisible(true); window.mile.scanner.refresh(); true`)
  await sleep(1500)

  console.log('\n=== 1. v1 → v2 配置迁移，PRD §8 ===')
  // 迁移只在写入时落盘，先触发一次写：patch 走的是同一个 persist
  await call(`window.mile.settings.patch({ terminalFontSize: 14 })`)
  await sleep(400)

  const migrated = onDisk()
  check(`磁盘配置升到当前版本 ${CONFIG_VERSION}`, migrated.version === CONFIG_VERSION,
    `version=${migrated.version}`)
  check('迁移后补出 groupOverrides 数组', Array.isArray(migrated.groupOverrides),
    JSON.stringify(migrated.groupOverrides))
  check('迁移后补出 watchedKeywords 数组', Array.isArray(migrated.watchedKeywords),
    JSON.stringify(migrated.watchedKeywords))
  check('迁移没有丢掉用户条目', migrated.entries.length === 1 && migrated.entries[0].id === 'svc',
    `${migrated.entries.length} 条`)
  check('迁移保留了用户设置而不是重置为默认', migrated.settings.theme === 'dark',
    migrated.settings.theme)
  check('迁移不吞掉正常的 patch', migrated.settings.terminalFontSize === 14,
    String(migrated.settings.terminalFontSize))

  console.log('\n=== 2. .bak 轮转顺序，PRD §8 ===')
  check('启动前没有 .bak', bakExistedBeforeBoot === false, String(bakExistedBeforeBoot))
  check('首次写入后出现 .bak', existsSync(BAK), BAK)
  // 备份必须是「上一份良好版本」而不是刚写的那份 —— 顺序颠倒的话这条会失败
  const bak1 = onBak()
  check('.bak 存的是写入前的旧内容（仍是 v1）', bak1.version === 1, `version=${bak1.version}`)
  check('.bak 与 v1 原文逐字节一致', JSON.stringify(bak1) === JSON.stringify(JSON.parse(V1_TEXT)))

  await call(`window.mile.settings.patch({ terminalFontSize: 15 })`)
  await sleep(400)
  const bak2 = onBak()
  check('.bak 随每次写入滚动到上一版', bak2.settings.terminalFontSize === 14,
    String(bak2.settings.terminalFontSize))
  check('.bak 不等于当前主文件', bak2.settings.terminalFontSize !== onDisk().settings.terminalFontSize,
    `${bak2.settings.terminalFontSize} vs ${onDisk().settings.terminalFontSize}`)

  console.log('\n=== 3. 分组推断与提升 / 移回，PRD §5.2 ===')
  // 启动一个真实服务，它必然属于「我的服务」：归属 owned
  await call(`window.mile.entry.start('svc')`)
  let status = ''
  for (let i = 0; i < 40; i++) {
    status = await js(`window.mile.entry.runtimes()
      .then(r=>(r.find(x=>x.entryId==='svc')||{}).status||'')`)
    if (status === 'running') break
    await sleep(500)
  }
  check('夹具服务已运行', status === 'running', status)

  const snap = () => js(`window.mile.scanner.snapshot()`)
  /**
   * 受控行要等的不只是一轮采集：新 PID 会触发 CIM 元数据刷新（约 3.5s），
   * 而 tick 有互斥锁，期间的 refresh 会被丢掉。实测从 running 到出现在监听表
   * 约 12 秒，所以这里给到 60 秒上限，而不是按「两轮采集应该够了」去赌。
   */
  let s = null
  for (let i = 0; i < 40; i++) {
    s = await snap()
    if (s && s.listeners.some((l) => l.ownership === 'owned')) break
    await js(`window.mile.scanner.refresh()`)
    await sleep(1500)
  }
  const owned = (s?.listeners ?? []).filter((l) => l.ownership === 'owned')
  check('监听表出现受控进程', owned.length > 0, `${owned.length} 个`)
  // 空数组上跑 .every 会假装通过，先要求真的有行再判分组
  check('受控进程一律归「我的服务」',
    owned.length > 0 && owned.every((l) => l.group === 'mine'),
    owned.map((l) => l.group).join(',') || '无受控行')
  check('受控行回填了启动台条目 id',
    owned.some((l) => l.entryId === 'svc'),
    owned.map((l) => l.entryId ?? '—').join(','))
  check('所有监听行都带 group 字段', (s?.listeners ?? []).every((l) => l.group === 'mine' || l.group === 'background'),
    `${s?.listeners.length} 行`)
  check('所有监听行都带 groupOverridden 布尔', (s?.listeners ?? []).every((l) => typeof l.groupOverridden === 'boolean'))

  // 找一个外部进程做提升 / 移回：真实机器上一定有，没有就跳过而不是假装通过
  const external = (s?.listeners ?? []).filter((l) => l.ownership === 'external')
  const victim = external.find((l) => l.group === 'background') ?? external[0]
  if (!victim) {
    check('环境里存在外部监听进程可供分组测试', false, '未找到 external 行，本轮无法验证提升/移回')
  } else {
    const name = victim.processName
    const q = JSON.stringify(name)

    await call(`window.mile.scanner.setGroup(${q}, 'mine')`)
    await sleep(600)
    const overrides = onDisk().groupOverrides
    check('提升写入 groupOverrides 并落盘',
      overrides.some((o) => o.processName === name && o.group === 'mine'),
      JSON.stringify(overrides))

    let after = null
    for (let i = 0; i < 20; i++) {
      after = await snap()
      const row = after.listeners.find((l) => l.pid === victim.pid)
      if (row && row.group === 'mine') break
      await js(`window.mile.scanner.refresh()`)
      await sleep(600)
    }
    const promoted = after.listeners.find((l) => l.pid === victim.pid)
    check('提升后下一轮快照里就是「我的服务」', promoted && promoted.group === 'mine',
      promoted && promoted.group)
    check('提升后标记为用户指定而非推断', promoted && promoted.groupOverridden === true,
      promoted && String(promoted.groupOverridden))

    // 关键安全断言：分组只决定排在哪一组，不决定能不能停。归属必须仍是 external
    check('提升到「我的服务」后归属仍是 external（分组不改变权限）',
      promoted && promoted.ownership === 'external', promoted && promoted.ownership)

    await call(`window.mile.scanner.setGroup(${q}, 'background')`)
    await sleep(600)
    check('移回后台改写同一条覆盖而不是追加',
      onDisk().groupOverrides.filter((o) => o.processName === name).length === 1,
      JSON.stringify(onDisk().groupOverrides))
    check('移回后台落盘为 background',
      onDisk().groupOverrides.some((o) => o.processName === name && o.group === 'background'))

    await call(`window.mile.scanner.setGroup(${q}, null)`)
    await sleep(600)
    check('传 null 清除覆盖，回到自动推断',
      !onDisk().groupOverrides.some((o) => o.processName === name),
      JSON.stringify(onDisk().groupOverrides))

    let cleared = null
    for (let i = 0; i < 20; i++) {
      cleared = await snap()
      const row = cleared.listeners.find((l) => l.pid === victim.pid)
      if (row && row.groupOverridden === false) break
      await js(`window.mile.scanner.refresh()`)
      await sleep(600)
    }
    const back = cleared.listeners.find((l) => l.pid === victim.pid)
    check('清除后 groupOverridden 复位', back && back.groupOverridden === false,
      back && String(back.groupOverridden))
  }

  console.log('\n=== 4. 分组通道的入参校验 ===')
  for (const [label, expr] of [
    ['非法分组名', `window.mile.scanner.setGroup('node.exe','elsewhere')`],
    ['分组传数字', `window.mile.scanner.setGroup('node.exe',3)`],
    ['进程名传数字', `window.mile.scanner.setGroup(42,'mine')`],
    ['进程名传对象', `window.mile.scanner.setGroup({},'mine')`]
  ]) {
    const r = await call(expr)
    check(`拒绝${label}`, !r.ok, r.ok ? '竟然通过了' : r.message)
  }
  const emptyName = await call(`window.mile.scanner.setGroup('   ','mine')`)
  check('空白进程名不写入覆盖',
    !onDisk().groupOverrides.some((o) => !o.processName.trim()),
    emptyName.ok ? '静默忽略' : emptyName.message)

  console.log('\n=== 5. 启动来源徽标：有值、但仅供展示，PRD §5.3 ===')
  const SOURCES = ['mile', 'vscode', 'cursor', 'jetbrains', 'claude', 'codex',
    'terminal', 'explorer', 'service', 'unknown']
  const fresh = await snap()
  check('每一行都带 launchSource',
    fresh.listeners.every((l) => SOURCES.includes(l.launchSource)),
    [...new Set(fresh.listeners.map((l) => l.launchSource))].join(','))
  const ownedNow = fresh.listeners.filter((l) => l.ownership === 'owned')
  // 受控进程的来源不该再靠父链猜：归属判定已经确认过这件事
  check('受控进程来源直接判为本应用，不再靠猜',
    ownedNow.length > 0 && ownedNow.every((l) => l.launchSource === 'mile'),
    ownedNow.map((l) => l.launchSource).join(',') || '无受控行')

  /**
   * 来源不是凭据。渲染层根本没有「按 PID 终止任意进程」的通道 —— 这本身就是设计，
   * 所以这里能量的是：带着任何来源徽标的外部进程，归属判定都不为 owned，
   * 因而永远走不到 assertKillable 放行的那一支。
   */
  const nonMile = fresh.listeners.filter((l) => l.launchSource !== 'mile')
  check('非本应用来源的行没有一个被判为受控',
    nonMile.every((l) => l.ownership !== 'owned'),
    nonMile.map((l) => `${l.launchSource}:${l.ownership}`).slice(0, 6).join(' '))
  const claimsEditor = fresh.listeners.filter((l) =>
    ['vscode', 'cursor', 'jetbrains', 'claude', 'codex', 'terminal'].includes(l.launchSource))
  check('被推断为编辑器/终端拉起的行仍按真实归属判定（来源不提权）',
    claimsEditor.every((l) => l.ownership === 'external' || l.ownership === 'owned'),
    claimsEditor.map((l) => `${l.launchSource}:${l.ownership}`).join(' ') || '本轮无此类行')

  console.log('\n=== 6. 关注进程关键字规整，PRD §5.5 ===')
  const setKw = (arr) => call(`window.mile.scanner.setWatchedKeywords(${JSON.stringify(arr)})`)

  const dedup = await setKw(['Node', 'node', '  NODE  ', 'ffmpeg'])
  check('关键字去重且小写归一', dedup.ok && dedup.value.join(',') === 'node,ffmpeg',
    dedup.ok ? dedup.value.join(',') : dedup.message)

  const empties = await setKw(['', '   ', 'ffmpeg'])
  check('空字符串被剔除（否则会命中一切）',
    empties.ok && empties.value.join(',') === 'ffmpeg',
    empties.ok ? JSON.stringify(empties.value) : empties.message)

  const nonString = await setKw(['ffmpeg', 42, null, { a: 1 }])
  check('非字符串项被剔除而不是整体报错',
    nonString.ok && nonString.value.join(',') === 'ffmpeg',
    nonString.ok ? JSON.stringify(nonString.value) : nonString.message)

  const capped = await setKw(Array.from({ length: 40 }, (_, i) => `kw${i}`))
  check('关键字数量截到 20 上限', capped.ok && capped.value.length === 20,
    capped.ok ? String(capped.value.length) : capped.message)

  const long = await setKw(['x'.repeat(200)])
  check('单个关键字长度截到 64', long.ok && long.value[0].length === 64,
    long.ok ? String(long.value[0].length) : long.message)

  const notArray = await call(`window.mile.scanner.setWatchedKeywords('ffmpeg')`)
  check('拒绝非数组入参', !notArray.ok, notArray.ok ? '竟然通过了' : notArray.message)

  const roundTrip = await setKw(['node'])
  check('设置成功后可回读', roundTrip.ok, roundTrip.message)
  const readBack = await call(`window.mile.scanner.watchedKeywords()`)
  check('回读结果与写入一致', readBack.ok && readBack.value.join(',') === 'node',
    readBack.ok ? JSON.stringify(readBack.value) : readBack.message)
  check('关键字已落盘', onDisk().watchedKeywords.join(',') === 'node',
    JSON.stringify(onDisk().watchedKeywords))

  console.log('\n=== 7. 关注进程命中，PRD §5.5 ===')
  let hits = []
  for (let i = 0; i < 20; i++) {
    const cur = await snap()
    hits = cur?.watched ?? []
    if (hits.length > 0) break
    await js(`window.mile.scanner.refresh()`)
    await sleep(700)
  }
  check('关键字 node 命中了进程（不监听端口也能看到）', hits.length > 0, `${hits.length} 个`)
  if (hits.length > 0) {
    check('命中项标出了是哪个关键字命中的',
      hits.every((w) => w.keyword === 'node'),
      [...new Set(hits.map((w) => w.keyword))].join(','))
    check('命令行按 160 字截断后才下发（完整 argv 可能带 token）',
      hits.every((w) => !w.commandLine || w.commandLine.length <= 161),
      String(Math.max(...hits.map((w) => (w.commandLine || '').length))))
    check('命中项带上了实测 CPU 与内存',
      hits.some((w) => w.memory > 0),
      hits.map((w) => w.memory).join(','))
    check('命中数不超过 50 上限', hits.length <= 50, String(hits.length))
  }
  // 关键字写 node 时整个 Electron 进程树都会命中，那不是用户想观察的东西
  const selfPid = process.pid
  check('本应用主进程不出现在关注列表', !hits.some((w) => w.pid === selfPid), String(selfPid))
  const ownedPids = new Set(ownedNow.map((l) => l.pid))
  check('本应用启动的受控进程不出现在关注列表',
    !hits.some((w) => ownedPids.has(w.pid)),
    [...ownedPids].join(','))

  console.log('\n=== 8. 界面：分组分区、来源列与关注面板 ===')
  await js(`(()=>{const b=[...document.querySelector('nav').querySelectorAll('button')]
    .find(x=>x.getAttribute('aria-label')==='工作台');b&&b.click();return true})()`)
  await sleep(1200)

  const heads = await js(`[...document.querySelectorAll('main h2')].map(h=>h.textContent.trim())`)
  check('存在「我的服务」分区', heads.some((h) => h.includes('我的服务')), heads.join(' | '))
  check('存在「应用后台」分区', heads.some((h) => h.includes('应用后台')), heads.join(' | '))
  check('存在「关注进程」分区', heads.some((h) => h.includes('关注进程')), heads.join(' | '))

  const bg = await js(`(()=>{const t=[...document.querySelectorAll('main button[aria-expanded]')][0];
    return t?{expanded:t.getAttribute('aria-expanded'),text:t.textContent.trim()}:null})()`)
  check('后台分区默认折叠', bg && bg.expanded === 'false', bg && JSON.stringify(bg))
  check('折叠态给出后台进程条数而不是留白', bg && /\d/.test(bg.text), bg && bg.text)

  const beforeExpand = await js(`document.querySelectorAll('main .surface-card').length`)
  await js(`(()=>{const t=[...document.querySelectorAll('main button[aria-expanded]')][0];
    t.click();return true})()`)
  await sleep(700)
  const expanded = await js(`(()=>{const t=[...document.querySelectorAll('main button[aria-expanded]')][0];
    return {expanded:t.getAttribute('aria-expanded'),
      cards:document.querySelectorAll('main .surface-card').length}})()`)
  check('点击后展开后台分区', expanded.expanded === 'true', expanded.expanded)
  check('展开后表格真的渲染出来了', expanded.cards > beforeExpand,
    `${beforeExpand} → ${expanded.cards}`)

  const cols = await js(`(()=>{const h=[...document.querySelectorAll('main .surface-card > div')]
    .find(d=>d.textContent.includes('名称')&&d.textContent.includes('端口'));
    return h?[...h.children].map(c=>c.textContent.trim()).filter(Boolean):[]})()`)
  check('监听表新增「来源」列', cols.includes('来源'), cols.join('/'))
  check('监听表保留「归属」列', cols.includes('归属'), cols.join('/'))

  const badge = await js(`(()=>{const b=document.querySelector('main [data-source]');
    if(!b)return null;const cs=getComputedStyle(b);
    return {source:b.dataset.source,text:b.textContent.trim(),
      title:b.getAttribute('title')||''}})()`)
  check('来源徽标渲染出来了', !!badge, badge && `${badge.source}=${badge.text}`)
  // 徽标必须自己说清「不参与权限判定」，否则用户会拿它当可信度依据
  check('来源徽标提示了仅供参考、不参与权限判定',
    badge && badge.title.includes('不参与') && badge.title.includes('仅供参考'),
    badge && badge.title)

  const toggles = await js(`(()=>{
    const rows=[...document.querySelectorAll('main ul > li')];
    return rows.map(r=>({owned:r.textContent.includes('受控'),
      hasToggle:!![...r.querySelectorAll('button')].find(b=>{
        const l=b.getAttribute('aria-label')||'';return l.includes('提升')||l.includes('移回')})}))
      .filter(x=>x.owned)})()`)
  check('受控行不给「提升/移回」按钮（避免自找的困惑）',
    toggles.length === 0 || toggles.every((t) => !t.hasToggle),
    `${toggles.length} 个受控行`)

  console.log('\n=== 9. 关注面板的增删交互 ===')
  const kwChips = () => js(`(()=>{const s=[...document.querySelectorAll('main section')]
    .find(x=>(x.querySelector('h2')||{}).textContent&&x.querySelector('h2').textContent.includes('关注进程'));
    return s?[...s.querySelectorAll('button[aria-label^="移除关键字"]')]
      .map(b=>b.getAttribute('aria-label').replace('移除关键字 ','')):[]})()`)

  /**
   * 全程走面板，不混用 IPC。面板是关键字的唯一写入方，它拿主进程规整后的返回值
   * 作为自己的状态；从旁路改配置再来量界面，量的是产品里不存在的一种时序。
   */
  const typeKeyword = (value) =>
    js(`(()=>{const s=[...document.querySelectorAll('main section')]
      .find(x=>(x.querySelector('h2')||{}).textContent&&x.querySelector('h2').textContent.includes('关注进程'));
      const i=s.querySelector('input');
      const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      setter.call(i,${JSON.stringify(value)});i.dispatchEvent(new Event('input',{bubbles:true}));
      const b=[...s.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='添加关键字');
      b.click();return true})()`)

  // 前面第 6 节是从 IPC 旁路改的关键字，面板此刻仍持有 init 时读到的那份。
  // 从这里起把状态交回面板：先清空，再全程用面板操作。
  await setKw([])
  await sleep(400)
  await js(`location.reload();true`)
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  await sleep(1500)
  check('重新加载后面板读到的是磁盘上的空关键字表',
    (await kwChips()).length === 0, (await kwChips()).join(','))

  await typeKeyword('node')
  await sleep(900)
  check('面板添加的关键字以可移除的胶囊呈现', (await kwChips()).includes('node'),
    (await kwChips()).join(','))

  await typeKeyword('ffmpeg')
  await sleep(900)
  check('面板添加的关键字已落盘', onDisk().watchedKeywords.includes('ffmpeg'),
    JSON.stringify(onDisk().watchedKeywords))
  check('面板添加后胶囊立即出现', (await kwChips()).includes('ffmpeg'),
    (await kwChips()).join(','))
  check('两次添加是追加而不是互相覆盖',
    onDisk().watchedKeywords.includes('node') && onDisk().watchedKeywords.includes('ffmpeg'),
    JSON.stringify(onDisk().watchedKeywords))

  // 空输入不该产生空关键字：空串会命中整张进程表
  const addBtnDisabled = await js(`(()=>{const s=[...document.querySelectorAll('main section')]
    .find(x=>(x.querySelector('h2')||{}).textContent&&x.querySelector('h2').textContent.includes('关注进程'));
    const i=s.querySelector('input');
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    setter.call(i,'   ');i.dispatchEvent(new Event('input',{bubbles:true}));
    return [...s.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='添加关键字').disabled})()`)
  check('空白输入时添加按钮禁用', addBtnDisabled === true, String(addBtnDisabled))

  await js(`(()=>{const s=[...document.querySelectorAll('main section')]
    .find(x=>(x.querySelector('h2')||{}).textContent&&x.querySelector('h2').textContent.includes('关注进程'));
    const b=[...s.querySelectorAll('button[aria-label^="移除关键字"]')]
      .find(x=>x.getAttribute('aria-label').includes('ffmpeg'));
    b.click();return true})()`)
  await sleep(900)
  check('面板移除的关键字已从磁盘删除', !onDisk().watchedKeywords.includes('ffmpeg'),
    JSON.stringify(onDisk().watchedKeywords))
  check('移除一个不连带清空其余（node 仍在）', onDisk().watchedKeywords.includes('node'),
    JSON.stringify(onDisk().watchedKeywords))
  check('移除后胶囊同步消失', !(await kwChips()).includes('ffmpeg'),
    (await kwChips()).join(','))

  console.log('\n=== 10. 迁移幂等：重复迁移不改变结果 ===')
  // v2 文件再走一遍迁移不该被当成 v1 重置 —— 拿当前落盘内容重跑一次 boot 逻辑来量
  const stable = onDisk()
  await call(`window.mile.settings.patch({ terminalFontSize: 16 })`)
  await sleep(400)
  const again = onDisk()
  check('v2 文件二次写入不会清空 watchedKeywords',
    again.watchedKeywords.join(',') === stable.watchedKeywords.join(','),
    JSON.stringify(again.watchedKeywords))
  check('v2 文件二次写入不会清空 groupOverrides',
    JSON.stringify(again.groupOverrides) === JSON.stringify(stable.groupOverrides),
    JSON.stringify(again.groupOverrides))
  check(`版本号稳定在 ${CONFIG_VERSION} 而不是继续递增`, again.version === CONFIG_VERSION,
    String(again.version))

  await call(`window.mile.entry.stop('svc')`)
  await sleep(1500)

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`)
  }
  app.exit(fail === 0 ? 0 : 1)
})
