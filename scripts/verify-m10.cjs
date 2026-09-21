/**
 * M10 校验，PRD §4.7 / §4.8 / §8.6：日志中心、任务完成通知、标记文件识别。
 *
 * 三段都有「看着对但其实没量到东西」的陷阱，所以每段都先确认量的是真东西：
 *
 * 1. 识别扩展：只断言 framework 不够 —— 那只证明字符串对上了。命令形状固定的语言
 *    （Python/Go/Rust 及 Django/FastAPI/Flask/Streamlit）要求 registerOnly === false
 *    且探测出 detectedLaunchMode；推不出命令形状的生态（Jekyll/Hugo/docker-compose/
 *    static）仍要求 registerOnly === true —— 识别成那些却允许启动，等于替用户构造命令。
 *
 * 2. 通知：electron.Notification 是不可配置的 getter，改不动。用 Module._load
 *    代理在加载主进程包之前换掉它，这样数出来的是真的 show() 次数，而不是
 *    「代码里有 new Notification 这一句」。
 *
 * 3. 日志中心：行是从真实 pty 输出切出来的，不注入假数据。因此每条断言前先
 *    等到目标行出现，再量分级、搜索与筛选 —— 固定 sleep 会把「没跑完」误判成
 *    「没这行」。空集合断言一律带 length > 0 门槛：[].every(...) 是 true。
 */
const Module = require('node:module')

// ── 通知探针：必须在 require 主进程包之前装好 ────────────────────────────────
const toasts = []
class ProbeNotification {
  constructor(options) {
    this.options = options
  }
  on() {
    return this
  }
  show() {
    toasts.push({ title: this.options.title, body: this.options.body })
  }
  static isSupported() {
    return true
  }
}

const realLoad = Module._load
Module._load = function (request, ...rest) {
  const loaded = realLoad.call(this, request, ...rest)
  if (request !== 'electron') return loaded
  // 只换 Notification，其余键透传 —— 主进程包用同一个 electron 对象取 app/ipcMain
  return new Proxy(loaded, {
    get: (target, key) => (key === 'Notification' ? ProbeNotification : target[key]),
    has: (target, key) => key in target
  })
}

const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, rmSync, readFileSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const FIX = join(__dirname, 'fixture')
const FIXT = join(__dirname, 'fixture-task')

// 版本号从 src/shared/types.ts 读，别写死 —— 见 CLAUDE.md「改 CONFIG_VERSION 时」
const CONFIG_VERSION = Number(
  /CONFIG_VERSION\s*=\s*(\d+)/.exec(readFileSync(join(ROOT, 'src/shared/types.ts'), 'utf8'))?.[1]
)

const SANDBOX = join(tmpdir(), `mile-m10-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
app.setPath('appData', SANDBOX)
const CONFIG = join(SANDBOX, 'mile-terminal', 'config.json')

/** 识别用的探测目录，一个生态一个 —— 都不放 package.json，走 fallback 分支 */
const PROBES = join(SANDBOX, 'probes')

const now = Date.now()
const mk = (id, name, kind, path, script, scripts, order) => ({
  id,
  kind,
  name,
  path,
  framework: 'node',
  packageManager: 'npm',
  script,
  scripts,
  env: {},
  registerOnly: false,
  pinned: false,
  order,
  createdAt: now
})

// version: 1 是有意的 —— 顺带验 v1 → v3 迁移会补上 notifyOnTaskDone。
// settings 里刻意不写 notifyOnTaskDone，否则迁移那一步就没什么可证明的了。
writeFileSync(
  CONFIG,
  JSON.stringify(
    {
      version: 1,
      entries: [
        mk('svc', '个人博客', 'service', FIX, 'dev', { dev: 'node server.cjs' }, 0),
        mk(
          'task',
          '清理构建缓存',
          'task',
          FIXT,
          'build',
          {
            build: 'node make.cjs',
            lint: 'node -e "0"',
            cancel: 'node cancel.cjs',
            boom: 'node -e "process.exit(2)"',
            noisy: 'node noisy.cjs'
          },
          1
        )
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
    },
    null,
    2
  ),
  'utf8'
)

/*
 * 夹具的 package.json 由本脚本补上 noisy 脚本再跑。
 *
 * 不能只写进沙箱配置的 scripts —— EntryService.assertScriptDeclared 启动前会重读
 * 磁盘上的 package.json，配置里有、磁盘上没有的脚本一律拒绝执行。而 verify-m5
 * 会按内容重建这个夹具（不含 noisy），所以只能每次自己补，并在结束时还原。
 */
const TASK_PKG = join(FIXT, 'package.json')
const TASK_PKG_ORIGINAL = readFileSync(TASK_PKG, 'utf8')
{
  const pkg = JSON.parse(TASK_PKG_ORIGINAL)
  pkg.scripts = { ...pkg.scripts, noisy: 'node noisy.cjs' }
  writeFileSync(TASK_PKG, JSON.stringify(pkg, null, 2), 'utf8')
}

/**
 * 日志夹具：一次输出覆盖三个级别、一个中文错误、\r 原地重写的进度条与
 * 一段带颜色转义的行。分级、去转义与进度条折叠都靠它验，不注入假日志行。
 */
const NOISY = [
  "const w = (s) => process.stdout.write(s)",
  "w('M10PLAIN compiled ok\\n')",
  "w('M10WARN warning: api is deprecated\\n')",
  "w('M10FAIL Error: something exploded\\n')",
  "w('M10CN 构建失败：缺少依赖\\n')",
  // \r 原地重写：整块留下来就是三条几乎一样的行，只应留最后一次重绘
  "w('M10PROG 10%\\rM10PROG 60%\\rM10PROG done\\n')",
  // 颜色转义必须被剥掉，否则界面上会显示成方块
  "w('\\x1b[31mM10COLOR red text\\x1b[0m\\n')",
  // 末行不带换行，靠会话退出时收尾 —— 错误摘要常常正在这一行
  "w('M10TAIL no trailing newline')"
].join('\n')
writeFileSync(join(FIXT, 'noisy.cjs'), NOISY, 'utf8')

/** 一个探测目录一组文件，键为相对路径，值为内容；以 / 结尾表示建目录 */
function probe(name, files) {
  const dir = join(PROBES, name)
  mkdirSync(dir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    if (rel.endsWith('/')) {
      mkdirSync(join(dir, rel), { recursive: true })
      continue
    }
    writeFileSync(join(dir, rel), content, 'utf8')
  }
  return dir
}

const PROBE_CASES = [
  ['django', probe('django', { 'manage.py': '# django', 'docker-compose.yml': 'services: {}' })],
  ['fastapi', probe('fastapi', { 'requirements.txt': 'fastapi==0.110.0\nuvicorn\n' })],
  ['streamlit', probe('streamlit', { 'requirements.txt': 'streamlit>=1.30\n' })],
  ['flask', probe('flask', { 'requirements.txt': 'Flask==3.0.0\n' })],
  ['python', probe('python', { 'requirements.txt': 'requests\nrich\n' })],
  ['go', probe('go', { 'go.mod': 'module example.com/app\n\ngo 1.22\n' })],
  ['rust', probe('rust', { 'Cargo.toml': '[package]\nname = "app"\n' })],
  ['jekyll', probe('jekyll', { '_config.yml': 'title: blog\n' })],
  ['hugo', probe('hugo', { 'hugo.toml': 'baseURL = "/"\n', 'content/': '' })],
  ['docker-compose', probe('compose', { 'docker-compose.yml': 'services:\n  web: {}\n' })],
  ['static', probe('static', { 'index.html': '<h1>hi</h1>' })],
  ['unknown', probe('bare', { 'notes.txt': 'nothing recognizable' })]
]

// 命令形状固定、已可启动的语言生态（其余标记仍仅登记）
const LAUNCHABLE_PROBES = new Set(['django', 'fastapi', 'streamlit', 'flask', 'python', 'go', 'rust'])

// 反例：Hugo 要求配置 + 目录约定同时在。光有 config.toml 太通用，
// 若它被认成 Hugo，那条规则就是在靠文件名猜。
const CONF_ONLY = probe('conf-only', { 'config.toml': 'title = "something"\n' })
// flask-login 不是 flask：包名边界没卡住的话这里会误报
const FLASK_LOOKALIKE = probe('flask-lookalike', { 'requirements.txt': 'flask-login==0.6.3\n' })

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

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  win.setBounds({ width: 1500, height: 940 })
  const js = (code) => win.webContents.executeJavaScript(code, true)

  await js(`window.mile.scanner.setVisible(true); window.mile.scanner.refresh(); true`)
  await sleep(1200)

  console.log('\n=== 0. 探针本身可信 ===')
  // 先证明探针装上了。它没生效的话，「没弹通知」这类断言全都会假通过。
  check('Notification 探针已替换真实实现', toasts.length === 0 && typeof ProbeNotification.isSupported === 'function')

  console.log('\n=== 1. 标记文件识别（PRD §8.6）===')
  const detect = (path) => js(`window.mile.entry.detect(${JSON.stringify(path)})`)

  for (const [expected, dir] of PROBE_CASES) {
    const r = await detect(dir)
    check(`识别为 ${expected}`, r.framework === expected, `${r.framework} @ ${r.name}`)
    // 识别到了不等于能启动。命令形状固定的语言（Python/Go/Rust 及 Django/FastAPI/Flask/
    // Streamlit）已可启动，走 EntryService 的第 N 条命令构造路径；推不出命令形状的生态
    // （Jekyll/Hugo/docker-compose/static/unknown）仍必须仅登记，否则就是在替用户猜命令。
    if (LAUNCHABLE_PROBES.has(expected)) {
      check(
        `${expected} 可启动（非仅登记）`,
        r.registerOnly === false && r.hasPackageJson === false && !!r.detectedLaunchMode,
        `registerOnly=${r.registerOnly} launchMode=${r.detectedLaunchMode}`
      )
    } else {
      check(
        `${expected} 标记为仅登记`,
        r.registerOnly === true && r.hasPackageJson === false,
        `registerOnly=${r.registerOnly}`
      )
    }
    check(`${expected} 不推断任何脚本`, r.devScript === null && r.buildScript === null &&
      Object.keys(r.scripts).length === 0, `devScript=${r.devScript} scripts=${Object.keys(r.scripts).length}`)
  }

  const confOnly = await detect(CONF_ONLY)
  check('光有 config.toml 不算 Hugo', confOnly.framework !== 'hugo', confOnly.framework)
  const lookalike = await detect(FLASK_LOOKALIKE)
  check('flask-login 不被当成 Flask', lookalike.framework !== 'flask', lookalike.framework)

  // 优先级：Django 仓库常常也带 compose 文件，这时仍应显示 Django
  const django = await detect(PROBE_CASES[0][1])
  check('框架标记优先于 docker-compose', django.framework === 'django', django.framework)

  // 有 package.json 的项目不该落到标记表，且必须仍然可启动
  const npmProject = await detect(FIX)
  check('有 package.json 时不走标记识别', npmProject.hasPackageJson === true &&
    npmProject.registerOnly === false, `${npmProject.framework} registerOnly=${npmProject.registerOnly}`)

  // 识别出的框架必须是条目校验认的值，否则「能识别但存不进去」
  const frameworks = [...new Set(PROBE_CASES.map(([f]) => f))]
  const rejected = []
  for (const f of frameworks) {
    const r = await js(`window.mile.entry.edit('svc', { framework: ${JSON.stringify(f)} })
      .then(()=>null).catch(e=>String(e.message||e))`)
    if (r) rejected.push(`${f}: ${r}`)
  }
  check('新增框架全部通过条目校验', frameworks.length > 0 && rejected.length === 0, rejected.join(' | '))
  await js(`window.mile.entry.edit('svc', { framework: 'node' })`)

  // 界面侧的映射表漏一项就会渲染出 undefined。这一段必须站在启动台上量 ——
  // 工作台没有条目卡片，卡片找不到时 out[f] 会是 null，断言就会空过。
  await js(`(()=>{const b=[...document.querySelector('nav').querySelectorAll('button')]
    .find(x=>x.getAttribute('aria-label')==='前端启动台');b&&b.click();return true})()`)
  await sleep(1200)
  const cardPresent = await js(`!![...document.querySelectorAll('main article.surface-card')]
    .find(c=>c.dataset.entryId==='svc')`)
  check('启动台上找到被测卡片', cardPresent === true, String(cardPresent))

  const labels = await js(`(async()=>{
    const list = ${JSON.stringify(frameworks)};
    const out = {};
    for (const f of list) {
      await window.mile.entry.edit('svc', { framework: f });
      await new Promise(r=>setTimeout(r,120));
      const card = [...document.querySelectorAll('main article.surface-card')]
        .find(c=>c.dataset.entryId==='svc');
      out[f] = card ? card.textContent.includes('undefined') : null;
    }
    return out })()`)
  const measured = Object.values(labels).filter((v) => v !== null).length
  check('每个框架都量到了卡片文案', measured === frameworks.length,
    `${measured}/${frameworks.length}`)
  const undefinedLabels = Object.entries(labels).filter(([, bad]) => bad === true).map(([f]) => f)
  check('框架标签无 undefined 渲染', measured === frameworks.length && undefinedLabels.length === 0,
    undefinedLabels.join(',') || '全部有标签')
  await js(`window.mile.entry.edit('svc', { framework: 'node' })`)

  console.log('\n=== 2. 配置迁移与通知开关（PRD §4.7）===')
  const migrated = onDisk()
  check(`配置版本已升到 ${CONFIG_VERSION}`, migrated.version === CONFIG_VERSION, String(migrated.version))
  check('迁移补上 notifyOnTaskDone', migrated.settings.notifyOnTaskDone === true,
    String(migrated.settings.notifyOnTaskDone))
  check('迁移不动既有设置', migrated.settings.scanIntervalMs === 2000 &&
    migrated.settings.theme === 'dark', `${migrated.settings.scanIntervalMs}/${migrated.settings.theme}`)

  for (const bad of ['yes', 1, null, {}]) {
    const r = await js(`window.mile.settings.patch({ notifyOnTaskDone: ${JSON.stringify(bad)} })
      .then(()=>'通过了').catch(e=>String(e.message||e))`)
    check(`拒绝 notifyOnTaskDone = ${JSON.stringify(bad)}`, r !== '通过了', r)
  }

  console.log('\n=== 3. 任务完成通知真的弹了 ===')
  const runTask = async (script) => {
    await js(`window.mile.entry.runScript('task', ${JSON.stringify(script)}).catch(()=>null)`)
    for (let i = 0; i < 80; i++) {
      const s = await js(`window.mile.entry.runtimes()
        .then(r=>(r.find(x=>x.entryId==='task')||{}).status||'')`)
      if (['succeeded', 'failed', 'canceled', 'stopped', 'crashed'].includes(s)) return s
      await sleep(250)
    }
    return 'timeout'
  }

  toasts.length = 0
  const okStatus = await runTask('build')
  await sleep(400)
  check('任务成功 → 状态 succeeded', okStatus === 'succeeded', okStatus)
  check('任务成功弹出一条通知', toasts.length === 1, JSON.stringify(toasts))
  check('通知标题带条目名与结果', toasts.length === 1 && toasts[0].title.includes('清理构建缓存') &&
    toasts[0].title.includes('任务完成'), toasts.length ? toasts[0].title : '无')
  check('通知正文说明退出码', toasts.length === 1 && toasts[0].body.includes('0'),
    toasts.length ? toasts[0].body : '无')

  toasts.length = 0
  const failStatus = await runTask('boom')
  await sleep(400)
  check('任务失败 → 状态 failed', failStatus === 'failed', failStatus)
  check('任务失败也弹通知', toasts.length === 1, JSON.stringify(toasts))
  check('失败通知标题为「任务失败」', toasts.length === 1 && toasts[0].title.includes('任务失败'),
    toasts.length ? toasts[0].title : '无')

  toasts.length = 0
  const cancelStatus = await runTask('cancel')
  await sleep(400)
  check('退出码 130 → canceled', cancelStatus === 'canceled', cancelStatus)
  check('取消通知标题为「任务已取消」', toasts.length === 1 &&
    toasts[0].title.includes('任务已取消'), toasts.length ? toasts[0].title : '无')

  // 关掉开关就不该再弹。开关是每次现读配置的，不缓存
  await js(`window.mile.settings.patch({ notifyOnTaskDone: false })`)
  check('开关已落盘为 false', onDisk().settings.notifyOnTaskDone === false)
  toasts.length = 0
  const mutedStatus = await runTask('build')
  await sleep(600)
  check('关掉开关后任务仍正常完成', mutedStatus === 'succeeded', mutedStatus)
  check('关掉开关后不弹通知', toasts.length === 0, JSON.stringify(toasts))
  await js(`window.mile.settings.patch({ notifyOnTaskDone: true })`)

  // 服务停止不是「任务完成」，不该弹
  toasts.length = 0
  await js(`window.mile.entry.start('svc')`)
  for (let i = 0; i < 40; i++) {
    const s = await js(`window.mile.entry.runtimes()
      .then(r=>(r.find(x=>x.entryId==='svc')||{}).status||'')`)
    if (s === 'running') break
    await sleep(500)
  }
  await js(`window.mile.entry.stop('svc').catch(()=>null)`)
  for (let i = 0; i < 40; i++) {
    const s = await js(`window.mile.entry.runtimes()
      .then(r=>(r.find(x=>x.entryId==='svc')||{}).status||'')`)
    if (s === 'stopped' || s === 'crashed') break
    await sleep(500)
  }
  await sleep(600)
  check('服务停止不弹任务通知', toasts.length === 0, JSON.stringify(toasts))

  // 用户中止任务不算完成 —— taskkill 的退出码不确定，按码判会误报「失败」
  toasts.length = 0
  await js(`window.mile.entry.runScript('task','noisy').catch(()=>null)`)
  await sleep(250)
  await js(`window.mile.entry.stop('task').catch(()=>null)`)
  let userStop = 'timeout'
  for (let i = 0; i < 40; i++) {
    userStop = await js(`window.mile.entry.runtimes()
      .then(r=>(r.find(x=>x.entryId==='task')||{}).status||'')`)
    if (['succeeded', 'failed', 'canceled', 'stopped', 'crashed'].includes(userStop)) break
    await sleep(250)
  }
  await sleep(600)
  // 任务极快，可能在 stop 抵达前就跑完了；那种情况下弹一条是正确的，只是这轮没测到
  check(
    '用户中止的任务不弹通知',
    userStop === 'succeeded' ? toasts.length === 1 : toasts.length === 0,
    `${userStop} / toasts=${toasts.length}`
  )

  console.log('\n=== 4. 日志中心：主进程聚合（PRD §4.8）===')
  const query = (q = {}) => js(`window.mile.log.query(${JSON.stringify(q)})`)

  // 先跑一轮 noisy，等目标行真的出现再量 —— 固定 sleep 会把「还没跑完」当成「没这行」
  await js(`window.mile.log.clear(); true`)
  await runTask('noisy')
  let noisy = null
  for (let i = 0; i < 40; i++) {
    noisy = await query({ limit: 500 })
    if (noisy.lines.some((l) => l.text.includes('M10TAIL'))) break
    await sleep(250)
  }
  const texts = noisy.lines.map((l) => l.text)
  check('日志已聚合出行', noisy.lines.length > 0, `${noisy.lines.length} 行`)

  const find = (marker) => noisy.lines.find((l) => l.text.includes(marker))
  check('普通输出为 info', find('M10PLAIN') && find('M10PLAIN').level === 'info',
    find('M10PLAIN') ? find('M10PLAIN').level : '未找到')
  check('warning 行为 warn', find('M10WARN') && find('M10WARN').level === 'warn',
    find('M10WARN') ? find('M10WARN').level : '未找到')
  check('Error 行为 error', find('M10FAIL') && find('M10FAIL').level === 'error',
    find('M10FAIL') ? find('M10FAIL').level : '未找到')
  check('中文「失败」也判为 error', find('M10CN') && find('M10CN').level === 'error',
    find('M10CN') ? find('M10CN').level : '未找到')

  // 颜色转义必须已经剥掉：留着会在界面上显示成方块
  const colored = find('M10COLOR')
  check('ANSI 转义被剥离', !!colored && !/\x1b|\[31m/.test(colored.text),
    colored ? JSON.stringify(colored.text) : '未找到')

  // \r 原地重写只留最后一次重绘，否则一个进度条能刷出几百条几乎一样的行
  const progress = noisy.lines.filter((l) => l.text.includes('M10PROG'))
  check('进度条折叠为一行', progress.length === 1, `${progress.length} 行：${progress.map((p) => p.text).join(' / ')}`)
  check('进度条保留最后一次重绘', progress.length === 1 && progress[0].text.includes('done'),
    progress.length ? progress[0].text : '无')

  // 末行没有换行，靠会话退出收尾。漏了这一步最后一行永远不出现
  check('无换行的末行也被收进来', !!find('M10TAIL'), texts.slice(-3).join(' | '))

  /*
   * ConPTY 换行常用绝对光标定位（\x1b[<行>;1H）而不是 \n，只按 \n 切会把两条逻辑行粘成一条。
   * 一行里出现两个标记就说明粘上了 —— 实测粘的是 npm 的 `> node noisy.cjs` 与紧随的首行输出。
   */
  const MARKERS = ['M10PLAIN', 'M10WARN', 'M10FAIL', 'M10CN', 'M10PROG', 'M10COLOR', 'M10TAIL']
  const glued = noisy.lines.filter((l) => MARKERS.filter((m) => l.text.includes(m)).length > 1)
  check('没有两条输出被粘成一行', glued.length === 0,
    glued.length ? glued.map((l) => JSON.stringify(l.text)).join(' | ') : '无')
  const banner = noisy.lines.find((l) => l.text.includes('node noisy.cjs'))
  check('npm 回显自成一行，未粘上首行输出',
    !!banner && !MARKERS.some((m) => banner.text.includes(m)),
    banner ? JSON.stringify(banner.text) : '未找到 npm 回显')

  /*
   * npm 的转轮进度必须是关掉的。它用 \r 反复重绘同一行，会把紧挨着的、没有换行
   * 结尾的真实输出擦掉 —— 那正是「末行时有时无」的成因，也会留下一堆转轮噪声行。
   */
  const spinner = noisy.lines.filter((l) => /^[⠀-⣿\s]+$/.test(l.text))
  check('日志里没有只含转轮字符的噪声行', spinner.length === 0,
    spinner.length ? spinner.map((l) => JSON.stringify(l.text)).join(' ') : '无')

  console.log('\n=== 5. 日志筛选在主进程完成 ===')
  const errorsOnly = await query({ level: 'error', limit: 500 })
  check('按级别筛出的行数大于零', errorsOnly.lines.length > 0, `${errorsOnly.lines.length} 行`)
  check('按级别筛后全部命中', errorsOnly.lines.length > 0 &&
    errorsOnly.lines.every((l) => l.level === 'error'),
    [...new Set(errorsOnly.lines.map((l) => l.level))].join(','))
  check('按级别筛比全量少', errorsOnly.lines.length < noisy.lines.length,
    `${errorsOnly.lines.length} < ${noisy.lines.length}`)

  const searched = await query({ text: 'M10COLOR', limit: 500 })
  check('关键字命中大于零', searched.lines.length > 0, `${searched.lines.length} 行`)
  check('关键字筛后全部包含该词', searched.lines.length > 0 &&
    searched.lines.every((l) => l.text.includes('M10COLOR')), `${searched.lines.length} 行`)

  // 关键字只做纯文本包含，不构造正则 —— 用户输个 ( 不该让查询抛异常
  const regexish = await js(`window.mile.log.query({ text: '(unclosed[' })
    .then(r=>({ok:true,n:r.lines.length})).catch(e=>({ok:false,message:String(e.message||e)}))`)
  check('正则元字符按纯文本处理而不抛', regexish.ok === true,
    regexish.ok ? `命中 ${regexish.n}` : regexish.message)

  check('来源会话列表非空', noisy.sources.length > 0, JSON.stringify(noisy.sources.map((s) => s.title)))
  const oneSource = noisy.sources[0]
  const bySession = await query({ sessionId: oneSource.sessionId, limit: 500 })
  check('按会话筛出的行数大于零', bySession.lines.length > 0, `${bySession.lines.length} 行`)
  check('按会话筛后全部同源', bySession.lines.length > 0 &&
    bySession.lines.every((l) => l.sessionId === oneSource.sessionId), oneSource.sessionId)
  check('日志行带上条目归属', bySession.lines.length > 0 &&
    bySession.lines.every((l) => l.entryId === 'task'),
    [...new Set(bySession.lines.map((l) => l.entryId))].join(','))

  const unknownSession = await query({ sessionId: 'no-such-session', limit: 500 })
  check('不存在的会话筛出空集', unknownSession.lines.length === 0 && unknownSession.total === 0)

  // total 是命中总数，可能大于返回的那一屏 —— 界面靠它显示「300 / 1200」
  const capped = await query({ limit: 3 })
  check('limit 限制返回条数', capped.lines.length <= 3, `${capped.lines.length} 行`)
  check('total 反映命中总数而非返回数', capped.total >= capped.lines.length,
    `total=${capped.total} lines=${capped.lines.length}`)
  check('返回按时间正序', capped.lines.length > 1 &&
    capped.lines.every((l, i) => i === 0 || l.seq > capped.lines[i - 1].seq),
    capped.lines.map((l) => l.seq).join('<'))

  console.log('\n=== 6. 日志查询条件校形 ===')
  for (const [label, q] of [
    ['非法级别', { level: 'fatal' }],
    ['级别传数字串', { level: '1' }],
    ['查询条件为字符串', '全部']
  ]) {
    const r = await js(`window.mile.log.query(${JSON.stringify(q)})
      .then(()=>'通过了').catch(e=>String(e.message||e))`)
    check(`拒绝${label}`, r !== '通过了', r)
  }
  // 超界 limit 由 LogService 自己收敛，不该抛错让界面白屏
  const wildLimit = await js(`window.mile.log.query({ limit: 999999 })
    .then(r=>({ok:true,n:r.lines.length,cap:r.capacity})).catch(e=>({ok:false,message:String(e.message||e)}))`)
  check('超界 limit 被收敛而非抛错', wildLimit.ok === true &&
    wildLimit.n <= wildLimit.cap, wildLimit.ok ? `${wildLimit.n} ≤ ${wildLimit.cap}` : wildLimit.message)

  console.log('\n=== 7. 日志中心界面 ===')
  const navTo = (label) =>
    js(`(()=>{const b=[...document.querySelector('nav').querySelectorAll('button')]
      .find(x=>x.getAttribute('aria-label')===${JSON.stringify(label)});
      if(!b)return false;b.click();return true})()`)
  check('导航轨有「日志」入口', (await navTo('日志')) === true)
  await sleep(1500)

  const ui = await js(`(()=>{
    const stream=document.querySelector('main [role="log"]');
    const group=[...document.querySelectorAll('main [role="radiogroup"]')]
      .find(g=>(g.getAttribute('aria-label')||'').includes('级别'));
    return {
      hasStream:!!stream,
      rows:stream?stream.querySelectorAll('li').length:-1,
      levels:group?[...group.querySelectorAll('[role="radio"]')].map(r=>r.textContent.trim()):[],
      hasSessionSelect:!!document.querySelector('main select[aria-label="按会话筛选"]'),
      hasSearch:!!document.querySelector('main input[aria-label="搜索日志内容"]'),
      followLabel:(()=>{const b=[...document.querySelectorAll('main button')]
        .find(x=>/跟随中|已暂停/.test(x.textContent));return b?b.textContent.trim():null})(),
      eyebrows:[...document.querySelectorAll('main h2')].map(h=>h.textContent.trim())
    }})()`)
  check('渲染出日志流容器', ui.hasStream === true)
  check('日志流有行', ui.rows > 0, `${ui.rows} 行`)
  check('级别筛选为 全部/错误/警告/普通', ui.levels.join(',') === '全部,错误,警告,普通', ui.levels.join(','))
  check('提供会话下拉', ui.hasSessionSelect === true)
  check('提供关键字搜索框', ui.hasSearch === true)
  check('默认处于跟随状态', ui.followLabel === '跟随中', String(ui.followLabel))
  check('分区标题为筛选与日志流', ui.eyebrows.some((h) => h.includes('筛选')) &&
    ui.eyebrows.some((h) => h.includes('日志流')), ui.eyebrows.join(' | '))

  // 点「错误」应真的少掉行，而不只是按钮选中态变了
  const pickLevel = (label) =>
    js(`(()=>{const g=[...document.querySelectorAll('main [role="radiogroup"]')]
      .find(x=>(x.getAttribute('aria-label')||'').includes('级别'));
      const r=[...g.querySelectorAll('[role="radio"]')].find(x=>x.textContent.trim()===${JSON.stringify(label)});
      r.click();return true})()`)
  const rowCount = () => js(`document.querySelectorAll('main [role="log"] li').length`)

  const allRows = await rowCount()
  await pickLevel('错误')
  // 筛选走一次 IPC 往返，要等界面真换过来再量
  let errRows = allRows
  for (let i = 0; i < 20; i++) {
    errRows = await rowCount()
    if (errRows !== allRows) break
    await sleep(250)
  }
  check('筛「错误」后行数减少', errRows < allRows && errRows > 0, `${allRows} → ${errRows}`)
  const errChecked = await js(`(()=>{const g=[...document.querySelectorAll('main [role="radiogroup"]')]
    .find(x=>(x.getAttribute('aria-label')||'').includes('级别'));
    const r=[...g.querySelectorAll('[role="radio"]')].find(x=>x.textContent.trim()==='错误');
    return r.getAttribute('aria-checked')})()`)
  check('选中态同步到 aria-checked', errChecked === 'true', String(errChecked))

  await pickLevel('全部')
  let backRows = errRows
  for (let i = 0; i < 20; i++) {
    backRows = await rowCount()
    if (backRows >= allRows) break
    await sleep(250)
  }
  check('切回「全部」行数复原', backRows >= allRows, `${errRows} → ${backRows}`)

  // 搜索框：输入后界面应只剩命中的行
  await js(`(()=>{const i=document.querySelector('main input[aria-label="搜索日志内容"]');
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    setter.call(i,'M10COLOR');i.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
  let searchRows = backRows
  for (let i = 0; i < 20; i++) {
    searchRows = await rowCount()
    if (searchRows > 0 && searchRows < backRows) break
    await sleep(250)
  }
  check('搜索后只剩命中行', searchRows > 0 && searchRows < backRows, `${backRows} → ${searchRows}`)
  const searchText = await js(`[...document.querySelectorAll('main [role="log"] li')]
    .every(li=>li.textContent.includes('M10COLOR'))`)
  check('界面上的行确实都含关键字', searchRows > 0 && searchText === true, String(searchText))

  await js(`(()=>{const b=document.querySelector('main button[aria-label="清空搜索"]');
    if(!b)return false;b.click();return true})()`)
  await sleep(1200)
  const clearedRows = await rowCount()
  check('清空搜索后行数回来', clearedRows > searchRows, `${searchRows} → ${clearedRows}`)

  console.log('\n=== 8. 清空日志 ===')
  await js(`(()=>{const b=[...document.querySelectorAll('main button')]
    .find(x=>x.textContent.includes('清空日志'));b.click();return true})()`)
  let afterClear = clearedRows
  for (let i = 0; i < 20; i++) {
    afterClear = await rowCount()
    if (afterClear === 0) break
    await sleep(250)
  }
  check('清空后界面无行', afterClear === 0, `${afterClear} 行`)
  const emptied = await query({ limit: 500 })
  check('清空后主进程也无行', emptied.lines.length === 0 && emptied.total === 0,
    `${emptied.lines.length}/${emptied.total}`)
  check('清空后给出空态文案而不是空白',
    await js(`document.querySelector('main [role="log"]').textContent.trim().length > 0`))

  // 清空只是清历史，不该断开采集：再跑一轮应重新出现行
  await runTask('build')
  let regrown = 0
  for (let i = 0; i < 40; i++) {
    regrown = (await query({ limit: 500 })).lines.length
    if (regrown > 0) break
    await sleep(250)
  }
  check('清空后仍继续采集新输出', regrown > 0, `${regrown} 行`)

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try {
    // 夹具还原：noisy 是本脚本加的，留着会让其他脚本看到一个不属于它们的脚本
    writeFileSync(TASK_PKG, TASK_PKG_ORIGINAL, 'utf8')
    rmSync(join(FIXT, 'noisy.cjs'), { force: true })
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`)
  }
  app.exit(fail === 0 ? 0 : 1)
})
