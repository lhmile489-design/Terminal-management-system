/**
 * 崩溃现场留档（2.3.0）。
 *
 * 以前服务崩了，诊断里只有「首个错误行」，而且两套错误判定不一致：
 * 日志中心认 exception，诊断认不出 RuntimeException 这类带前缀的类名。现在：
 *   1. 会话退出时留下最后 30 行可见输出（去掉 ANSI），诊断里能看到、能复制。
 *   2. 记下最后一个错误行；日志中心与诊断用同一套判定，Java 异常类名也算错误。
 *   3. 崩溃的系统通知正文带上最后一个错误行。
 *   4. 只在内存里：配置文件里没有这些输出。
 *
 * 通知用 Module._load 拦截（同 verify-review-notify.cjs）。
 *
 *   npm run build
 *   npx electron scripts/verify-review-crashtail.cjs
 */
const Module = require('node:module')

const toasts = []
class ProbeNotification {
  constructor(options) { this.options = options }
  on() { return this }
  show() { toasts.push({ title: this.options.title, body: this.options.body }) }
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
const SANDBOX = join(tmpdir(), `mile-review-crashtail-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)
const CONFIG = join(SANDBOX, 'mile-terminal', 'config.json')

// 崩溃项目：打 40 行带颜色的输出，再打一个 Java 风格的异常，最后一行收尾，退出码 1
const PROJ = join(SANDBOX, 'crash-proj')
// node_modules 目录要在，否则预检把它拦下，根本跑不到崩溃
mkdirSync(join(PROJ, 'node_modules'), { recursive: true })
writeFileSync(join(PROJ, 'crash.cjs'), [
  "for (let i = 1; i <= 40; i++) console.log('\\x1b[32mTAILMARK_' + String(i).padStart(2, '0') + '\\x1b[0m')",
  "console.log('Exception in thread \"main\" java.lang.RuntimeException: boom-probe')",
  "console.log('TAILMARK_END')",
  'setTimeout(() => process.exit(1), 200)'
].join('\n'), 'utf8')
writeFileSync(join(PROJ, 'package.json'), JSON.stringify({ name: 'crash-proj', version: '1.0.0', scripts: { dev: 'node crash.cjs' } }), 'utf8')

writeFileSync(CONFIG, JSON.stringify({
  version: 12,
  entries: [{
    id: 'crash', kind: 'service', name: '崩溃留档探针', path: PROJ.replace(/\\/g, '/'), framework: 'node', packageManager: 'npm',
    script: 'dev', scripts: { dev: 'node crash.cjs' }, env: {}, registerOnly: false, pinned: false, order: 0, createdAt: Date.now()
  }],
  groups: [], ignoredListeners: [], groupOverrides: [], watchedKeywords: [],
  settings: { scanIntervalMs: 2000, theme: 'light', externalTerminal: 'wt', terminalFontSize: 13, scrollback: 5000, killOwnedOnQuit: true, closeToTray: false, notifyOnTaskDone: false, hideFromTaskbar: false, notifyOnCrash: true, notifyOnlyWhenBackground: true, globalHotkey: false }
}, null, 2), 'utf8')

require(join(ROOT, 'out', 'main', 'index.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(name, ok, detail) {
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? ` — ${detail}` : ''}`)
}

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

    console.log('\n=== 1. 窗口收起时崩溃 ===')
    win.hide()
    await sleep(300)
    await js(`window.mile.entry.start('crash')`)
    check('前提：服务崩溃了', await waitFor(`window.mile.entry.runtimes().then(r=>(r.find(x=>x.entryId==='crash')||{}).status==='crashed')`, 30000))
    await sleep(600)

    console.log('\n=== 2. 诊断里的退出前输出 ===')
    const d = await js(`window.mile.entry.diagnose('crash')`)
    const tail = Array.isArray(d.tailLines) ? d.tailLines : []
    check('有退出前输出', tail.length > 0, `${tail.length} 行`)
    check('最多 30 行', tail.length > 0 && tail.length <= 30, `${tail.length} 行`)
    check('最后一行是收尾输出', tail[tail.length - 1] === 'TAILMARK_END', JSON.stringify(tail.slice(-2)))
    check('最早的输出被截掉了', !tail.includes('TAILMARK_01'))
    check('去掉了 ANSI 颜色', tail.length > 0 && !tail.some((l) => /\x1b/.test(l)), JSON.stringify(tail.find((l) => /\x1b/.test(l))))
    check('最后错误行是那条 RuntimeException', /RuntimeException: boom-probe/.test(d.lastErrorLine || ''), d.lastErrorLine)
    check('首个错误行也认出来了', /RuntimeException/.test(d.firstErrorLine || ''), d.firstErrorLine)

    console.log('\n=== 3. 日志中心用同一套判定 ===')
    const logs = await js(`window.mile.log.query({ level: 'error', limit: 500 })`)
    check('日志中心把这一行标成错误', logs.lines.some((l) => /RuntimeException: boom-probe/.test(l.text)), `${logs.lines.length} 行`)

    console.log('\n=== 4. 崩溃通知带错误行 ===')
    const crashToast = toasts.find((t) => /崩溃留档探针/.test(t.title || ''))
    check('收到崩溃通知', !!crashToast, JSON.stringify(toasts))
    check('通知正文带最后错误行', !!crashToast && /RuntimeException/.test(crashToast.body || ''), crashToast && crashToast.body)

    console.log('\n=== 5. 只在内存，不落盘 ===')
    check('配置文件里没有输出内容', !/TAILMARK|boom-probe/.test(readFileSync(CONFIG, 'utf8')))

    console.log('\n=== 6. 诊断标签显示退出前输出 ===')
    win.show()
    await js(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'2',ctrlKey:true,bubbles:true,cancelable:true}));true`)
    await waitFor(`(document.querySelector('main h1')||{}).textContent==='服务'`)
    await js(`document.querySelector('.svc-row[data-entry-id="crash"]').click();true`)
    await waitFor(`!!document.querySelector('.svc-detail')`)
    await js(`(()=>{const t=[...document.querySelectorAll('.svc-detail [role="tab"]')].find(x=>x.textContent.includes('诊断'));t&&t.click();return true})()`)
    check('有「退出前输出」区块', await waitFor(`!!document.querySelector('[data-crash-tail]')`, 8000))
    check('区块里有收尾输出', await js(`(document.querySelector('[data-crash-tail]')||{textContent:''}).textContent.includes('TAILMARK_END')`))
    check('区块有复制按钮', await js(`!![...document.querySelectorAll('[data-crash-tail] button')].find(b=>/复制/.test(b.getAttribute('aria-label')||''))`))
    check('显示最后错误行', await js(`/最后错误行/.test(document.querySelector('.svc-detail').textContent)`))
  } catch (err) {
    console.log('HARNESS ERROR', err)
    fail++
  }
  clearTimeout(guard)
  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`) }
  app.exit(fail === 0 ? 0 : 1)
})
