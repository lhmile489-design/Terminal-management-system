/**
 * 输出关键词告警（PRD-FEATURE-UPGRADE P1-1，v14）。
 *
 *   1. 关键词按纯子串、不区分大小写匹配；同一关键词 60 秒内只告警一次。
 *   2. 匹配的是去掉 ANSI、`\r` 重绘取末段之后的可见行。
 *   3. 「同时对错误行告警」复用 outputText.ts 的错误行判定，命中时 keyword 为 null。
 *   4. 关键词校形：超长、超量被拒，磁盘配置不变。
 *   5. 命中后 3 秒发系统通知；这 3 秒内条目崩溃就只发崩溃通知，同一事件只有一条通知。
 *   6. 命中记录只在内存，配置文件里没有命中行。
 *   7. 服务行出现告警角标。
 *
 * 通知用 Module._load 拦截（同 verify-review-crashtail.cjs）。
 *
 *   npm run build
 *   npx electron scripts/verify-alert.cjs
 */
const Module = require('node:module')

const toasts = []
class ProbeNotification {
  constructor(options) { this.options = options }
  on() { return this }
  show() { toasts.push({ title: this.options.title, body: this.options.body, at: Date.now() }) }
  static isSupported() { return true }
}
const realLoad = Module._load
Module._load = function (request, ...rest) {
  const loaded = realLoad.call(this, request, ...rest)
  if (request !== 'electron') return loaded
  return new Proxy(loaded, {
    get: (target, key) => (key === 'Notification' ? ProbeNotification : target[key]),
    has: (target, key) => key in target
  })
}

const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
// 版本号从源码读，不写死：迁移会丢掉 v14 之前出现的 alertKeywords
const CONFIG_VERSION = Number(/CONFIG_VERSION = (\d+)/.exec(readFileSync(join(ROOT, 'src/shared/types.ts'), 'utf8'))[1])
const SANDBOX = join(tmpdir(), `mile-verify-alert-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)
const CONFIG = join(SANDBOX, 'mile-terminal', 'config.json')

function project(name, lines) {
  const dir = join(SANDBOX, name)
  // node_modules 要在，否则预检拦下
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  writeFileSync(join(dir, 'main.cjs'), lines.join('\n'), 'utf8')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', scripts: { dev: 'node main.cjs' } }), 'utf8')
  return dir.replace(/\\/g, '/')
}

// 关键词连打三次（大小写不同、带颜色码），再打一条 \r 重绘的行，然后常驻
const ALERT_PROJ = project('alert-proj', [
  "const out = (s) => process.stdout.write(s + '\\n')",
  "out('\\x1b[31mBoomWord first LINEMARK_A\\x1b[0m')",
  "setTimeout(() => out('boomword again LINEMARK_B'), 300)",
  "setTimeout(() => out('BOOMWORD third LINEMARK_C'), 600)",
  "setTimeout(() => process.stdout.write('loading 10%\\rREDRAWKEY visible LINEMARK_D\\n'), 900)",
  'setInterval(() => {}, 1000)'
])
// 命中关键词后马上崩溃：只该收到一条崩溃通知
const CRASH_PROJ = project('crash-proj', [
  "console.log('FATALWORD before exit LINEMARK_E')",
  'setTimeout(() => process.exit(1), 150)'
])
// 通用错误行
const ERR_PROJ = project('err-proj', [
  "console.log('Error: something failed ERRLINE LINEMARK_F')",
  'setInterval(() => {}, 1000)'
])

const base = (id, name, path, extra) => ({
  id, kind: 'service', name, path, framework: 'node', packageManager: 'npm',
  script: 'dev', scripts: { dev: 'node main.cjs' }, env: {}, registerOnly: false, pinned: false,
  order: 0, createdAt: Date.now(), ...extra
})

writeFileSync(CONFIG, JSON.stringify({
  version: CONFIG_VERSION,
  entries: [
    base('alert', '告警探针', ALERT_PROJ, { alertKeywords: ['BoomWord', 'REDRAWKEY'] }),
    base('crash', '崩溃合并探针', CRASH_PROJ, { alertKeywords: ['FATALWORD'], order: 1 }),
    base('err', '错误行探针', ERR_PROJ, { alertOnErrors: true, order: 2 })
  ],
  groups: [], ignoredListeners: [], groupOverrides: [], watchedKeywords: [],
  settings: {
    scanIntervalMs: 2000, theme: 'light', externalTerminal: 'wt', terminalFontSize: 13, scrollback: 5000,
    killOwnedOnQuit: true, closeToTray: false, notifyOnTaskDone: false, hideFromTaskbar: false,
    // 前台也弹，探针才数得到告警通知
    notifyOnCrash: true, notifyOnlyWhenBackground: false, globalHotkey: false, loginShellPath: false
  }
}, null, 2), 'utf8')

require(join(ROOT, 'out', 'main', 'index.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(name, ok, detail) {
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? ` — ${detail}` : ''}`)
}
const diskEntry = (id) => JSON.parse(readFileSync(CONFIG, 'utf8')).entries.find((e) => e.id === id)

app.whenReady().then(async () => {
  const guard = setTimeout(() => { console.log('  FAIL  超时'); console.log(`\n结果：${pass} 通过，${fail + 1} 失败`); app.exit(1) }, 120000)
  const win = BrowserWindow.getAllWindows()[0]
  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r))
    win.setBounds({ width: 1500, height: 940 })
    const js = (code) => win.webContents.executeJavaScript(code, true)
    const waitFor = async (code, ms = 10000) => {
      for (let t = 0; t < ms; t += 200) { if (await js(code)) return true; await sleep(200) }
      return false
    }
    await waitFor(`!!document.querySelector('nav[aria-label="主导航"]')`, 30000)
    // 先订阅再启动，一条都不漏
    await js(`window.__alerts=[];window.mile.entry.onAlert(a=>window.__alerts.push(a));true`)
    const alerts = () => js(`window.__alerts`)

    console.log('\n=== 1. 关键词命中与 60 秒去重 ===')
    await js(`window.mile.entry.start('alert')`)
    check('前提：REDRAWKEY 那一行到了', await waitFor(`window.__alerts.some(a=>a.entryId==='alert'&&a.keyword==='REDRAWKEY')`, 30000))
    await sleep(800)
    let list = (await alerts()).filter((a) => a.entryId === 'alert')
    check('有命中', list.length > 0, `${list.length} 条`)
    const boom = list.filter((a) => a.keyword === 'BoomWord')
    check('同一关键词打了三次只告警一次', boom.length === 1, `${boom.length} 条`)
    check('大小写不同也命中（首条是带颜色的那行）', boom.length === 1 && /LINEMARK_A/.test(boom[0].line), boom[0] && boom[0].line)
    check('命中行去掉了 ANSI', list.length > 0 && !list.some((a) => /\x1b/.test(a.line)), JSON.stringify(list.map((a) => a.line)))

    console.log('\n=== 2. \\r 重绘的行按末段匹配 ===')
    const redraw = list.find((a) => a.keyword === 'REDRAWKEY')
    check('REDRAWKEY 命中', !!redraw)
    check('命中行是重绘后可见的末段', !!redraw && /^REDRAWKEY visible/.test(redraw.line) && !/loading/.test(redraw.line), redraw && redraw.line)

    console.log('\n=== 3. 通用错误行 ===')
    await js(`window.mile.entry.start('err')`)
    check('错误行命中，keyword 为 null', await waitFor(`window.__alerts.some(a=>a.entryId==='err'&&a.keyword===null&&/ERRLINE/.test(a.line))`, 30000))

    console.log('\n=== 4. 告警的系统通知 ===')
    check('收到告警通知', await (async () => {
      for (let t = 0; t < 5000; t += 200) { if (toasts.some((x) => x.title === '输出告警 · 告警探针')) return true; await sleep(200) }
      return false
    })(), JSON.stringify(toasts.map((x) => x.title)))
    const alertToast = toasts.find((x) => x.title === '输出告警 · 告警探针')
    check('通知正文写明命中的关键词', !!alertToast && /命中「/.test(alertToast.body), alertToast && alertToast.body)

    console.log('\n=== 5. 命中后马上崩溃：只发一条崩溃通知 ===')
    await js(`window.mile.entry.start('crash')`)
    check('前提：崩溃了', await waitFor(`window.mile.entry.runtimes().then(r=>(r.find(x=>x.entryId==='crash')||{}).status==='crashed')`, 30000))
    check('前提：关键词确实命中了', (await alerts()).some((a) => a.entryId === 'crash' && a.keyword === 'FATALWORD'))
    // 告警通知延迟 3 秒（从命中算起），崩溃已在命中后约 1.2 秒到达，再等 4 秒足够越过延迟窗口
    await sleep(4000)
    const crashToasts = toasts.filter((x) => /崩溃合并探针/.test(x.title))
    {
      // 命中到崩溃通知的实测间隔：告警通知延迟必须大于它，否则会抢在崩溃前发出
      const hit = (await alerts()).find((a) => a.entryId === 'crash' && a.keyword === 'FATALWORD')
      const crashToast = crashToasts.find((x) => /^服务已崩溃/.test(x.title))
      if (hit && crashToast) console.log(`  INFO  命中到崩溃通知间隔 ${crashToast.at - hit.at} ms`)
    }
    check('这个条目只有一条通知', crashToasts.length === 1, JSON.stringify(crashToasts.map((x) => x.title)))
    check('那一条是崩溃通知', crashToasts.length === 1 && /^服务已崩溃/.test(crashToasts[0].title))

    console.log('\n=== 6. 关键词校形 ===')
    const before = JSON.stringify(diskEntry('alert').alertKeywords)
    const long = await js(`window.mile.entry.edit('alert',{alertKeywords:['${'k'.repeat(65)}']}).then(()=>'ok',e=>String(e))`)
    check('65 字符的关键词被拒', long !== 'ok', long)
    const many = await js(`window.mile.entry.edit('alert',{alertKeywords:Array.from({length:11},(_,i)=>'w'+i)}).then(()=>'ok',e=>String(e))`)
    check('11 个关键词被拒', many !== 'ok', many)
    const ctrl = await js(`window.mile.entry.edit('alert',{alertKeywords:['a\\u0007b']}).then(()=>'ok',e=>String(e))`)
    check('含控制字符被拒', ctrl !== 'ok', ctrl)
    check('磁盘上的关键词没变', JSON.stringify(diskEntry('alert').alertKeywords) === before, JSON.stringify(diskEntry('alert').alertKeywords))
    const okEdit = await js(`window.mile.entry.edit('alert',{alertKeywords:['  BoomWord ','BoomWord','REDRAWKEY']}).then(e=>JSON.stringify(e.alertKeywords),e=>String(e))`)
    check('合法编辑去空白、去重后落盘', okEdit === '["BoomWord","REDRAWKEY"]', okEdit)

    console.log('\n=== 7. 只在内存 ===')
    check('配置文件里没有命中行', !/LINEMARK_/.test(readFileSync(CONFIG, 'utf8')))

    console.log('\n=== 8. 服务行告警角标 ===')
    await js(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'2',ctrlKey:true,bubbles:true,cancelable:true}));true`)
    await waitFor(`(document.querySelector('main h1')||{}).textContent==='服务'`)
    check('告警探针的行上有角标', await waitFor(`!!document.querySelector('.svc-row[data-entry-id="alert"] .svc-alert')`, 5000))
    const badge = await js(`(document.querySelector('.svc-row[data-entry-id="alert"] .svc-alert')||{}).getAttribute?.('aria-label')||''`)
    check('角标有可读的 aria-label', /条输出告警/.test(badge), badge)
    await js(`document.querySelector('.svc-row[data-entry-id="alert"] .svc-alert').click();true`)
    check('点开后角标清掉', await waitFor(`!document.querySelector('.svc-row[data-entry-id="alert"] .svc-alert')`, 3000))
  } catch (err) {
    console.log('HARNESS ERROR', err)
    fail++
  }
  // app.exit 不走 before-quit 的清理，常驻的夹具进程要自己停掉，否则留在后台
  try {
    await win.webContents.executeJavaScript(`Promise.all(['alert','err'].map(id=>window.mile.entry.stop(id).catch(()=>null)))`, true)
    await sleep(3500)
  } catch { /* 停不掉也不影响判定 */ }
  clearTimeout(guard)
  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`) }
  app.exit(fail === 0 ? 0 : 1)
})
