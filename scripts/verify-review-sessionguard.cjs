/**
 * 一个条目同一时刻只挂一个会话（2026-10-30 审查修复 C1）。
 *
 * runtimes 按 entryId 存。以前条目运行中时还能再开「执行其他脚本」「安装依赖」，
 * 第二个会话会覆盖 runtime.sessionId：旧会话成了 stop() 找不到的孤儿，它退出时
 * 还会把新会话的运行态改写成 stopped / crashed。现在：
 *   1. 条目处于 precheck / starting / running / stopping 时，runScript 与 install 被拒，
 *      运行态与会话都不变。
 *   2. 停止之后，同一条目可以正常执行其他脚本。
 *   3. 重启后旧会话的退出不会改写新会话的运行态（onSessionExit / absorb 校验 sessionId）。
 *
 * 第 3 节走真实 restart()：旧会话先退出、新会话再起，正常情况下迟到的退出事件不多。
 * 那条竞争窗口靠反向对照（临时去掉 isCurrentSession 校验）确认，不靠这里凑巧通过。
 *
 *   npm run build
 *   npx electron scripts/verify-review-sessionguard.cjs
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const SANDBOX = join(tmpdir(), `mile-review-sessionguard-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)
const CONFIG = join(SANDBOX, 'mile-terminal', 'config.json')
const CONFIG_VERSION = Number(/CONFIG_VERSION\s*=\s*(\d+)/.exec(readFileSync(join(ROOT, 'src', 'shared', 'types.ts'), 'utf8'))[1])

// 常驻服务：随机端口监听，打印 localhost 地址供端口捕获，一直不退出
const PROJ = join(SANDBOX, 'guard-proj')
// node_modules 目录要在，否则预检把它拦下
mkdirSync(join(PROJ, 'node_modules'), { recursive: true })
writeFileSync(join(PROJ, 'serve.cjs'), [
  "const http = require('node:http')",
  "const s = http.createServer((_q, r) => r.end('ok'))",
  "s.listen(0, '127.0.0.1', () => console.log('ready at http://localhost:' + s.address().port))"
].join('\n'), 'utf8')
const SCRIPTS = { dev: 'node serve.cjs', other: "node -e \"console.log('OTHER_DONE')\"" }
writeFileSync(join(PROJ, 'package.json'), JSON.stringify({ name: 'guard-proj', version: '1.0.0', scripts: SCRIPTS }), 'utf8')

writeFileSync(CONFIG, JSON.stringify({
  version: CONFIG_VERSION,
  entries: [{
    id: 'guard', kind: 'service', name: '会话互斥探针', path: PROJ.replace(/\\/g, '/'), framework: 'node', packageManager: 'npm',
    script: 'dev', scripts: SCRIPTS, env: {}, registerOnly: false, pinned: false, order: 0, createdAt: Date.now()
  }],
  groups: [], ignoredListeners: [], groupOverrides: [], watchedKeywords: [],
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

app.whenReady().then(async () => {
  const guard = setTimeout(() => { console.log('  FAIL  超时'); console.log(`\n结果：${pass} 通过，${fail + 1} 失败`); app.exit(1) }, 150000)
  const win = BrowserWindow.getAllWindows()[0]
  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r))
    const js = (code) => win.webContents.executeJavaScript(code, true)
    const waitFor = async (code, ms = 10000) => {
      for (let t = 0; t < ms; t += 200) { if (await js(code)) return true; await sleep(200) }
      return false
    }
    const rt = () => js(`window.mile.entry.runtimes().then(r=>r.find(x=>x.entryId==='guard')||null)`)
    // 渲染层拿到的是包装过的错误，只比消息子串
    const tryCall = (code) => js(`(${code}).then(()=>({ok:true}),e=>({ok:false,msg:String(e&&e.message||e)}))`)
    const liveSessions = () => js(`window.mile.session.list().then(l=>l.filter(s=>s.projectId==='guard'&&s.status!=='stopped'&&s.status!=='crashed').map(s=>s.id))`)
    await waitFor(`!!document.querySelector('nav[aria-label="主导航"]')`, 30000)

    console.log('\n=== 1. 运行中再开会话被拒 ===')
    await js(`window.mile.entry.start('guard')`)
    const up = await waitFor(`window.mile.entry.runtimes().then(r=>{const x=r.find(x=>x.entryId==='guard');return !!x&&x.status==='running'&&!!x.port})`, 30000)
    check('前提：服务进入 running 并捕获到端口', up)
    const before = await rt()
    check('前提：运行态带 sessionId', !!(before && before.sessionId), before && before.sessionId)

    const runR = await tryCall(`window.mile.entry.runScript('guard','other')`)
    check('runScript 被拒', !runR.ok, runR.msg)
    check('拒绝原因是「正在运行中」', /正在运行中/.test(runR.msg || ''), runR.msg)
    const instR = await tryCall(`window.mile.entry.install('guard')`)
    check('install 被拒', !instR.ok, instR.msg)
    check('拒绝原因是「正在运行中」', /正在运行中/.test(instR.msg || ''), instR.msg)

    await sleep(1500)
    const after = await rt()
    check('sessionId 没被覆盖', !!after && after.sessionId === before.sessionId, `${before.sessionId} → ${after && after.sessionId}`)
    check('状态仍是 running', !!after && after.status === 'running', after && after.status)
    check('端口没变', !!after && after.port === before.port, `${before.port} → ${after && after.port}`)
    const live1 = await liveSessions()
    check('该条目只有 1 个活会话', live1.length === 1 && live1[0] === before.sessionId, JSON.stringify(live1))

    console.log('\n=== 2. 停止后可以执行其他脚本 ===')
    await js(`window.mile.entry.stop('guard')`)
    check('服务停下', await waitFor(`window.mile.entry.runtimes().then(r=>{const x=r.find(x=>x.entryId==='guard');return !x||!['precheck','starting','running','stopping'].includes(x.status)})`, 15000))
    const runR2 = await tryCall(`window.mile.entry.runScript('guard','other')`)
    check('停止后 runScript 放行', runR2.ok, runR2.msg)
    const other = runR2.ok ? await rt() : null
    check('脚本开了新会话', !!(other && other.sessionId && other.sessionId !== before.sessionId), other && other.sessionId)
    check('脚本跑完退出', await waitFor(`window.mile.entry.runtimes().then(r=>{const x=r.find(x=>x.entryId==='guard');return !!x&&!['precheck','starting','running','stopping'].includes(x.status)})`, 30000))
    const otherDone = await rt()
    check('退出码 0 判为 stopped', !!otherDone && otherDone.status === 'stopped', otherDone && `${otherDone.status} / exit ${otherDone.exitCode}`)

    console.log('\n=== 3. 重启后旧会话不改写新运行态 ===')
    await js(`window.mile.entry.start('guard')`)
    check('前提：再次进入 running', await waitFor(`window.mile.entry.runtimes().then(r=>{const x=r.find(x=>x.entryId==='guard');return !!x&&x.status==='running'&&!!x.port})`, 30000))
    const old = await rt()
    const restarted = await tryCall(`window.mile.entry.restart('guard')`)
    check('restart 成功', restarted.ok, restarted.msg)
    check('新会话进入 running', await waitFor(`window.mile.entry.runtimes().then(r=>{const x=r.find(x=>x.entryId==='guard');return !!x&&x.status==='running'&&!!x.port&&x.sessionId!==${JSON.stringify(old.sessionId)}})`, 30000))
    const fresh = await rt()
    check('sessionId 换成新的', !!fresh && !!fresh.sessionId && fresh.sessionId !== old.sessionId, `${old.sessionId} → ${fresh && fresh.sessionId}`)
    // 旧会话的退出、末尾输出、端口捕获超时都在这几秒里落地
    await sleep(4000)
    const settled = await rt()
    check('几秒后仍是 running', !!settled && settled.status === 'running', settled && settled.status)
    check('几秒后 sessionId 仍是新会话', !!settled && settled.sessionId === fresh.sessionId, settled && settled.sessionId)
    const sessions = await js(`window.mile.session.list().then(l=>l.filter(s=>s.projectId==='guard').map(s=>({id:s.id,status:s.status})))`)
    const oldMeta = sessions.find((s) => s.id === old.sessionId)
    check('旧会话已结束', !!oldMeta && (oldMeta.status === 'stopped' || oldMeta.status === 'crashed'), JSON.stringify(oldMeta))
    const live3 = await liveSessions()
    check('该条目只有 1 个活会话', live3.length === 1 && live3[0] === fresh.sessionId, JSON.stringify(live3))

    console.log('\n=== 4. 运行中仍不放行第二个会话 ===')
    const runR3 = await tryCall(`window.mile.entry.runScript('guard','other')`)
    check('重启后的运行中 runScript 被拒', !runR3.ok && /正在运行中/.test(runR3.msg || ''), runR3.msg)
    await js(`window.mile.entry.stop('guard')`)
    await waitFor(`window.mile.entry.runtimes().then(r=>{const x=r.find(x=>x.entryId==='guard');return !x||!['precheck','starting','running','stopping'].includes(x.status)})`, 15000)
  } catch (err) {
    console.log('HARNESS ERROR', err)
    fail++
  }
  clearTimeout(guard)
  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`) }
  app.exit(fail === 0 ? 0 : 1)
})
