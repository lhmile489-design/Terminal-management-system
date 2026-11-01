/**
 * 总览启动确认与重启假成功（2026-11-01 审查修复）。
 *
 *   1. 总览「服务操作台」启动 prod 工作组的条目要先弹确认：取消则不启动，确认才启动。
 *      以前这里直接调 store.start，绕过了 startEntry 里的 confirmEnv（Q14）。
 *   2. 条目处于 stopping 时 start() 抛错，不再当成「已在运行」返回 ok。
 *   3. 停止拖过 8 秒时 restart() 报错并且不起新会话。以前它会照常调 start()，
 *      start() 把 stopping 当运行中短路返回旧 runtime，界面显示「重启成功」，
 *      旧进程随后退出，实际什么都没起来。
 *   4. 正常重启仍然成功、换新会话。
 *
 * 第 3 节靠在主进程里把 taskkill 推迟 12 秒来造「停得慢」：patch 的是 child_process.execFile，
 * 平台层调用时按属性取，换掉的只是「taskkill 多久返回」，归属校验与状态机走真实实现。
 * 夹具服务忽略 SIGINT，Ctrl+C 停不掉它，只能等 3 秒后的树终止。
 *
 *   npm run build
 *   npx electron scripts/verify-review-restartguard.cjs
 */
const { app, BrowserWindow } = require('electron')
const childProcess = require('node:child_process')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const SANDBOX = join(tmpdir(), `mile-review-restartguard-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
// appData 与 userData（localStorage 所在）都指向沙箱，必须在 require 主进程包之前
app.setPath('appData', SANDBOX)
app.setPath('userData', join(SANDBOX, 'user'))
const CONFIG = join(SANDBOX, 'mile-terminal', 'config.json')
const CONFIG_VERSION = Number(/CONFIG_VERSION\s*=\s*(\d+)/.exec(readFileSync(join(ROOT, 'src', 'shared', 'types.ts'), 'utf8'))[1])

// 慢停开关：开着时 taskkill 推迟 12 秒才真正执行
let slowKill = false
const realExecFile = childProcess.execFile
childProcess.execFile = function patchedExecFile(file, ...rest) {
  if (slowKill && /taskkill(\.exe)?$/i.test(String(file))) {
    setTimeout(() => realExecFile.call(childProcess, file, ...rest), 12000)
    return undefined
  }
  return realExecFile.call(childProcess, file, ...rest)
}

const NAME = '重启探针'
const PROJ = join(SANDBOX, 'restart-proj')
mkdirSync(join(PROJ, 'node_modules'), { recursive: true })
writeFileSync(join(PROJ, 'serve.cjs'), [
  "process.on('SIGINT', () => {})",
  "const s = require('node:http').createServer((q, r) => r.end('ok'))",
  "s.listen(0, '127.0.0.1', () => console.log('ready at http://localhost:' + s.address().port))"
].join('\n'), 'utf8')
const SCRIPTS = { dev: 'node serve.cjs' }
writeFileSync(join(PROJ, 'package.json'), JSON.stringify({ name: 'restart-proj', version: '1.0.0', scripts: SCRIPTS }), 'utf8')

const now = Date.now()
writeFileSync(CONFIG, JSON.stringify({
  version: CONFIG_VERSION,
  entries: [{
    id: 'rg', kind: 'service', name: NAME, path: PROJ.replace(/\\/g, '/'), framework: 'node', packageManager: 'npm',
    script: 'dev', scripts: SCRIPTS, env: {}, registerOnly: false, pinned: false, order: 0, createdAt: now, groupId: 'gp'
  }],
  groups: [{ id: 'gp', name: '生产组', env: 'prod', order: 0, createdAt: now }],
  ignoredListeners: [], groupOverrides: [], watchedKeywords: [],
  settings: { scanIntervalMs: 2000, theme: 'light', externalTerminal: 'wt', terminalFontSize: 13, scrollback: 5000, killOwnedOnQuit: true, closeToTray: false, notifyOnTaskDone: false, hideFromTaskbar: false, notifyOnCrash: false, notifyOnlyWhenBackground: true, globalHotkey: false }
}, null, 2), 'utf8')

require(join(ROOT, 'out', 'main', 'index.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(name, ok, detail) {
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? ` — ${detail}` : ''}`)
}

const LIVE = "['precheck','starting','running','stopping']"

app.whenReady().then(async () => {
  const guard = setTimeout(() => { console.log('  FAIL  超时'); console.log(`\n结果：${pass} 通过，${fail + 1} 失败`); app.exit(1) }, 180000)
  const win = BrowserWindow.getAllWindows()[0]
  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r))
    win.setBounds({ width: 1500, height: 940 })
    const js = (code) => win.webContents.executeJavaScript(code, true)
    const waitFor = async (code, ms = 10000) => {
      for (let t = 0; t < ms; t += 200) { if (await js(code)) return true; await sleep(200) }
      return false
    }
    const rt = () => js(`window.mile.entry.runtimes().then(r=>r.find(x=>x.entryId==='rg')||null)`)
    const tryCall = (code) => js(`(${code}).then(()=>({ok:true}),e=>({ok:false,msg:String(e&&e.message||e)}))`)
    const liveSessions = () => js(`window.mile.session.list().then(l=>l.filter(s=>s.projectId==='rg'&&s.status!=='stopped'&&s.status!=='crashed').map(s=>s.id))`)
    const isRunning = `window.mile.entry.runtimes().then(r=>{const x=r.find(x=>x.entryId==='rg');return !!x&&x.status==='running'&&!!x.port})`
    const isDown = `window.mile.entry.runtimes().then(r=>{const x=r.find(x=>x.entryId==='rg');return !x||!${LIVE}.includes(x.status)})`
    await waitFor(`!!document.querySelector('nav[aria-label="主导航"]')`, 30000)

    console.log('\n=== 1. 总览启动 prod 条目先确认 ===')
    await js(`document.querySelector('nav button[aria-label="总览"]').click(); true`)
    const rowSel = `[...document.querySelectorAll('li')].find(li=>li.textContent.includes(${JSON.stringify(NAME)}))`
    const startBtn = `(${rowSel})?.querySelector('button[aria-label="启动"]')`
    check('前提：总览行里有启动按钮', await waitFor(`!!${startBtn}`, 15000))
    const dialogBtn = (label) => `[...(document.querySelector('[role="alertdialog"]')?.querySelectorAll('button')??[])].find(b=>b.textContent.trim()===${JSON.stringify(label)})`

    await js(`${startBtn}.click(); true`)
    check('点启动后弹出确认框', await waitFor(`!!document.querySelector('[role="alertdialog"]')`, 5000))
    const title = await js(`document.querySelector('[role="alertdialog"] h2')?.textContent ?? ''`)
    check('确认框标题写明生产环境', title.includes('生产环境'), title)
    check('确认前条目没有启动', !(await rt()) || (await rt()).status === 'idle', (await rt())?.status)
    await js(`${dialogBtn('取消')}.click(); true`)
    check('取消后确认框关闭', await waitFor(`!document.querySelector('[role="alertdialog"]')`, 5000))
    await sleep(1500)
    const afterCancel = await rt()
    check('取消后仍未启动', !afterCancel || afterCancel.status === 'idle', afterCancel?.status)
    check('取消后没有会话', (await liveSessions()).length === 0)

    await js(`${startBtn}.click(); true`)
    check('再次点启动又弹确认', await waitFor(`!!document.querySelector('[role="alertdialog"]')`, 5000))
    await js(`${dialogBtn('确认启动')}.click(); true`)
    check('确认后进入 running', await waitFor(isRunning, 30000))

    console.log('\n=== 2. 停止中拒绝 start ===')
    await js(`window.mile.entry.stop('rg')`)
    const stopping = await rt()
    check('前提：stop 返回后处于 stopping', !!stopping && stopping.status === 'stopping', stopping?.status)
    const startDuring = await tryCall(`window.mile.entry.start('rg')`)
    check('stopping 时 start 被拒', !startDuring.ok && /正在停止中/.test(startDuring.msg), startDuring.msg)
    check('之后正常停下', await waitFor(isDown, 15000))

    console.log('\n=== 3. 停止拖过 8 秒时重启报错、不起新会话 ===')
    await js(`window.mile.entry.start('rg')`)
    check('前提：再次进入 running', await waitFor(isRunning, 30000))
    const old = await rt()
    slowKill = true
    const t0 = Date.now()
    const slow = await tryCall(`window.mile.entry.restart('rg')`)
    const took = Date.now() - t0
    check('restart 失败而不是假成功', !slow.ok && /没有停下/.test(slow.msg), slow.msg)
    check('等满了停止上限才报错', took >= 8000, `${took}ms`)
    const mid = await rt()
    check('sessionId 仍是旧会话', !!mid && mid.sessionId === old.sessionId, `${old.sessionId} → ${mid && mid.sessionId}`)
    check('报错时仍处于 stopping', !!mid && mid.status === 'stopping', mid?.status)
    const liveMid = await liveSessions()
    check('没有起第二个会话', liveMid.length <= 1 && liveMid.every((id) => id === old.sessionId), JSON.stringify(liveMid))
    // 推迟的 taskkill 执行后旧会话退出
    check('旧会话最终停下', await waitFor(isDown, 25000))
    slowKill = false
    const after3 = await rt()
    check('落到 stopped，不是假装在跑', !!after3 && after3.status === 'stopped', after3?.status)

    console.log('\n=== 4. 正常重启仍然成功 ===')
    await js(`window.mile.entry.start('rg')`)
    check('前提：进入 running', await waitFor(isRunning, 30000))
    const before4 = await rt()
    const ok4 = await tryCall(`window.mile.entry.restart('rg')`)
    check('restart 成功', ok4.ok, ok4.msg)
    check('新会话进入 running', await waitFor(`window.mile.entry.runtimes().then(r=>{const x=r.find(x=>x.entryId==='rg');return !!x&&x.status==='running'&&!!x.port&&x.sessionId!==${JSON.stringify(before4.sessionId)}})`, 30000))
    const live4 = await liveSessions()
    check('该条目只有 1 个活会话', live4.length === 1, JSON.stringify(live4))
  } catch (err) {
    fail++
    console.log('HARNESS ERROR', err)
  }
  clearTimeout(guard)
  slowKill = false
  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`) }
  app.exit(fail ? 1 : 0)
})
