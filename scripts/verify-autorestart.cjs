/**
 * dev 环境崩溃自动重启（PRD-FEATURE-UPGRADE P0-2）。
 *
 *   1. 崩溃后按 2 / 8 / 30 秒退避重启，10 分钟内满 3 次就放弃并发通知。
 *   2. 等待重启时服务行显示倒计时，「取消」撤掉排队中的重启。
 *   3. 对照：手动停止、退出码 0 都不触发重启。
 *   4. prod 组条目开启自动重启被拒且磁盘不变；已开启的条目所在组事后改成 prod，崩溃不重启。
 *   5. 退出流程：killOwnedOnQuit 杀掉的会话不会被当成崩溃去拉起新会话。
 *
 * 每个夹具启动时往自己目录的 starts.txt 追加一行，「起了几次」按行数数，不靠推理。
 * 通知用 Module._load 拦截（同 verify-alert.cjs）。
 *
 *   npm run build
 *   npx electron scripts/verify-autorestart.cjs
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
const { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
// 版本号从源码读，不写死：迁移会丢掉 v14 之前出现的 autoRestart
const CONFIG_VERSION = Number(/CONFIG_VERSION = (\d+)/.exec(readFileSync(join(ROOT, 'src/shared/types.ts'), 'utf8'))[1])
const SANDBOX = join(tmpdir(), `mile-verify-autorestart-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)
const CONFIG = join(SANDBOX, 'mile-terminal', 'config.json')

const STARTS = (name) => join(SANDBOX, name, 'starts.txt')
function project(name, tail) {
  const dir = join(SANDBOX, name)
  // node_modules 要在，否则预检拦下
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  writeFileSync(join(dir, 'main.cjs'), [
    "require('fs').appendFileSync(require('path').join(__dirname, 'starts.txt'), process.pid + '\\n')",
    "console.log('fixture up')",
    tail
  ].join('\n'), 'utf8')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', scripts: { dev: 'node main.cjs' } }), 'utf8')
  return dir.replace(/\\/g, '/')
}
const CRASH = 'setTimeout(() => process.exit(1), 1000)'
const LONG = 'setInterval(() => {}, 1000)'
const CLEAN = 'setTimeout(() => process.exit(0), 1000)'

const base = (id, name, path, extra) => ({
  id, kind: 'service', name, path, framework: 'node', packageManager: 'npm',
  script: 'dev', scripts: { dev: 'node main.cjs' }, env: {}, registerOnly: false, pinned: false,
  order: 0, createdAt: Date.now(), ...extra
})

writeFileSync(CONFIG, JSON.stringify({
  version: CONFIG_VERSION,
  entries: [
    base('crash', '退避探针', project('crash', CRASH), { autoRestart: true, order: 0 }),
    base('cancel', '取消探针', project('cancel', CRASH), { autoRestart: true, order: 1 }),
    base('stopme', '手动停止探针', project('stopme', LONG), { autoRestart: true, order: 2 }),
    base('clean', '正常退出探针', project('clean', CLEAN), { autoRestart: true, order: 3 }),
    base('p', '生产拒开探针', project('p', CRASH), { order: 4 }),
    base('switch', '改环境探针', project('switch', CRASH), { autoRestart: true, groupId: 'gdev', order: 5 }),
    base('quitter', '退出探针', project('quitter', LONG), { autoRestart: true, order: 6 })
  ],
  groups: [{ id: 'gdev', name: '开发组', env: 'dev', createdAt: Date.now(), order: 0 }],
  ignoredListeners: [], groupOverrides: [], watchedKeywords: [],
  settings: {
    scanIntervalMs: 2000, theme: 'light', externalTerminal: 'wt', terminalFontSize: 13, scrollback: 5000,
    killOwnedOnQuit: true, closeToTray: false, notifyOnTaskDone: false, hideFromTaskbar: false,
    // 前台也弹，探针才数得到「已停止自动重启」通知
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
const starts = (name) => (existsSync(STARTS(name)) ? readFileSync(STARTS(name), 'utf8').split('\n').filter(Boolean).length : 0)
const diskEntry = (id) => JSON.parse(readFileSync(CONFIG, 'utf8')).entries.find((e) => e.id === id)
const finish = () => {
  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`) }
  app.exit(fail === 0 ? 0 : 1)
}

app.whenReady().then(async () => {
  const guard = setTimeout(() => { console.log('  FAIL  超时'); fail++; finish() }, 300000)
  const win = BrowserWindow.getAllWindows()[0]
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const rt = async (id) => (await js(`window.mile.entry.runtimes()`)).find((r) => r.entryId === id) || {}
  const waitRt = async (id, pred, ms) => {
    for (let t = 0; t < ms; t += 300) { const r = await rt(id); if (pred(r)) return r; await sleep(300) }
    return null
  }
  const waitFor = async (code, ms = 10000) => {
    for (let t = 0; t < ms; t += 200) { if (await js(code)) return true; await sleep(200) }
    return false
  }
  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r))
    win.setBounds({ width: 1500, height: 940 })
    await waitFor(`!!document.querySelector('nav[aria-label="主导航"]')`, 30000)
    await js(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'2',ctrlKey:true,bubbles:true,cancelable:true}));true`)
    await waitFor(`(document.querySelector('main h1')||{}).textContent==='服务'`)

    console.log('\n=== 1. 退避重启 3 次后放弃 ===')
    await js(`window.mile.entry.start('crash')`)
    const first = await waitRt('crash', (r) => !!r.autoRestart, 30000)
    check('崩溃后排了重启', !!first, JSON.stringify(first && first.autoRestart))
    check('第 1 / 3 次', !!first && first.autoRestart.attempt === 1 && first.autoRestart.max === 3)
    const lead = first ? first.autoRestart.nextAt - Date.now() : -1
    check('第一次退避约 2 秒', lead > 0 && lead <= 2500, `${lead} ms`)
    const rowText = await js(`(document.querySelector('.svc-row[data-entry-id="crash"] .svc-restart[data-auto-restart="pending"]')||{}).textContent||''`)
    check('服务行显示倒计时', /秒后重启/.test(rowText) && /第 1 \/ 3 次/.test(rowText), rowText)
    const seen = new Set()
    let gaveUp = null
    for (let t = 0; t < 120000; t += 300) {
      const r = await rt('crash')
      if (r.autoRestart) seen.add(r.autoRestart.attempt)
      if (r.autoRestartGaveUp) { gaveUp = r; break }
      await sleep(300)
    }
    check('依次出现第 1、2、3 次', [1, 2, 3].every((n) => seen.has(n)), JSON.stringify([...seen]))
    check('最后标记放弃', !!gaveUp)
    check('放弃时没有排队中的重启', !!gaveUp && !gaveUp.autoRestart)
    check('共起了 4 次（1 次手动 + 3 次自动）', starts('crash') === 4, `${starts('crash')} 次`)
    check('收到「已停止自动重启」通知', toasts.some((x) => /^已停止自动重启 · 退避探针/.test(x.title)), JSON.stringify(toasts.map((x) => x.title)))
    check('服务行显示已停止自动重启', await waitFor(`!!document.querySelector('.svc-row[data-entry-id="crash"] .svc-restart[data-auto-restart="gave-up"]')`, 3000))
    await sleep(3000)
    check('放弃后不再起', starts('crash') === 4, `${starts('crash')} 次`)

    console.log('\n=== 2. 取消排队中的重启 ===')
    await js(`window.mile.entry.start('cancel')`)
    check('前提：排了重启', !!(await waitRt('cancel', (r) => !!r.autoRestart, 30000)))
    const clicked = await js(`(()=>{const b=document.querySelector('.svc-row[data-entry-id="cancel"] .svc-restart-cancel');if(!b)return false;b.click();return true})()`)
    check('服务行有「取消」按钮', clicked)
    check('取消后不再排队', !!(await waitRt('cancel', (r) => !r.autoRestart, 3000)))
    await sleep(4000)
    check('取消后没有再起', starts('cancel') === 1, `${starts('cancel')} 次`)

    console.log('\n=== 3. 对照：手动停止、退出码 0 ===')
    await js(`window.mile.entry.start('stopme')`)
    for (let t = 0; t < 20000 && starts('stopme') === 0; t += 300) await sleep(300)
    check('前提：夹具起来了', starts('stopme') === 1)
    await js(`window.mile.entry.stop('stopme')`)
    const stopped = await waitRt('stopme', (r) => r.status === 'stopped', 15000)
    check('手动停止后状态 stopped', !!stopped, JSON.stringify(await rt('stopme')))
    await sleep(3000)
    check('手动停止不排重启', !(await rt('stopme')).autoRestart)
    check('手动停止后没有再起', starts('stopme') === 1, `${starts('stopme')} 次`)

    await js(`window.mile.entry.start('clean')`)
    check('退出码 0 状态 stopped', !!(await waitRt('clean', (r) => r.status === 'stopped', 20000)), JSON.stringify(await rt('clean')))
    await sleep(3000)
    check('退出码 0 不排重启', !(await rt('clean')).autoRestart)
    check('退出码 0 后没有再起', starts('clean') === 1, `${starts('clean')} 次`)

    console.log('\n=== 4. 生产环境 ===')
    const prod = await js(`window.mile.group.add({name:'生产组',env:'prod'})`)
    const rejected = await js(`window.mile.entry.edit('p',{groupId:${JSON.stringify(prod.id)},autoRestart:true}).then(()=>'ok',e=>String(e))`)
    check('prod 组条目开启自动重启被拒', rejected !== 'ok' && /生产/.test(rejected), rejected)
    const p = diskEntry('p')
    check('被拒后磁盘不变', p.autoRestart === undefined && p.groupId === undefined, JSON.stringify({ autoRestart: p.autoRestart, groupId: p.groupId }))

    await js(`window.mile.group.patch('gdev',{env:'prod'})`)
    await js(`window.mile.entry.start('switch')`)
    check('前提：改环境探针崩溃了', !!(await waitRt('switch', (r) => r.status === 'crashed', 30000)))
    await sleep(4000)
    check('所在组改成 prod 后崩溃不排重启', !(await rt('switch')).autoRestart)
    check('改成 prod 后没有再起', starts('switch') === 1, `${starts('switch')} 次`)

    console.log('\n=== 5. 退出流程不拉起新会话 ===')
    await js(`window.mile.entry.start('quitter')`)
    for (let t = 0; t < 20000 && starts('quitter') === 0; t += 300) await sleep(300)
    check('前提：退出探针在跑', starts('quitter') === 1)
  } catch (err) {
    console.log('HARNESS ERROR', err)
    fail++
    clearTimeout(guard)
    finish()
    return
  }

  // will-quit 只在 before-quit 放行（进程树已终止）之后才触发。在这里拦住退出再数。
  // 窗口要 12 秒：反向对照（去掉 beginQuit）实测多出的那次在 will-quit 后约 4 秒才出现
  // （2 秒退避 + 预检 + npm 链条启动），3.5 秒的窗口会让这条断言假绿
  app.once('will-quit', (e) => {
    e.preventDefault()
    const at = Date.now()
    const timer = setInterval(() => {
      console.log(`  INFO  will-quit 后 ${Math.round((Date.now() - at) / 1000)} 秒：quitter 起了 ${starts('quitter')} 次`)
    }, 1000)
    setTimeout(() => {
      clearInterval(timer)
      check('退出期间没有拉起新会话', starts('quitter') === 1, `${starts('quitter')} 次`)
      clearTimeout(guard)
      finish()
    }, 12000)
  })
  app.quit()
})
