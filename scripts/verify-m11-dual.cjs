/**
 * M11 验证：同一端口被两个条目分别以 IPv4 / IPv6 占住时，应用不能说「空闲」。
 *
 * 缺陷现场：两个项目都默认 3000，一个绑 0.0.0.0（Vite 的 vite.config 写死
 * host: '0.0.0.0'），另一个绑 ::（Next / Node 默认）。**两边 bind 都成功**，
 * 谁都不会打印端口回退告警 —— 所以这不是「端口捕获抓错了」，捕获到的 3000
 * 两边都是真的。真正坏的是后面四处：
 *
 *   1. PrecheckService.portItem 用 find 取第一个占用者。命中的那行恰好是自己时，
 *      结论成了「:3000 空闲」（实测第二条起来后仍然这么报）。
 *   2. ScannerService.countConflicts 同样 find，两条同抢一个端口只数出 1。
 *   3. EntryService.findPortHolder 取 netstat 第一行，诊断「谁占着我的端口」
 *      答成「我自己」。
 *   4. 卡片两张都写 :3000、没有任何差异，而 localhost:3000 只通向其中一个。
 *
 * 验证口径：先用真实 netstat 确认「两个 PID 真的同时在听同一端口」（否则整个
 * 前提不成立，后面的断言会因为「压根没撞上」而全体空过），再逐项核对应用的说法。
 * 夹具各自只绑一个地址族，绑不上直接退出，不猜端口、不回退。
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { execFileSync } = require('node:child_process')

const ROOT = join(__dirname, '..')
const FIX = join(__dirname, 'fixture')
const PORT = 39100

const SANDBOX = join(tmpdir(), `mile-m11d-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
app.setPath('appData', SANDBOX)
const CONFIG = join(SANDBOX, 'mile-terminal', 'config.json')

const entry = (id, name, script, order) => ({
  id,
  kind: 'service',
  name,
  path: FIX,
  framework: 'node',
  packageManager: 'npm',
  script,
  scripts: {},
  env: { MILE_DUAL_PORT: String(PORT) },
  expectedPort: PORT,
  registerOnly: false,
  pinned: false,
  order,
  createdAt: Date.now()
})

writeFileSync(
  CONFIG,
  JSON.stringify(
    {
      version: 1,
      entries: [entry('v4', 'IPv4 服务', 'dual4', 0), entry('v6', 'IPv6 服务', 'dual6', 1)],
      ignoredListeners: [],
      settings: { scanIntervalMs: 2000 }
    },
    null,
    2
  ),
  'utf8'
)

/*
 * 夹具的 package.json 要真有这两个脚本：assertScriptDeclared 启动前重读磁盘，
 * 只写进沙箱配置的脚本一律被拒。结束时还原，否则会影响别的 harness。
 */
const PKG = join(FIX, 'package.json')
const PKG_ORIGINAL = readFileSync(PKG, 'utf8')
{
  const pkg = JSON.parse(PKG_ORIGINAL)
  pkg.scripts = {
    ...pkg.scripts,
    dual4: 'node dual-server.cjs 4',
    dual6: 'node dual-server.cjs 6'
  }
  writeFileSync(PKG, JSON.stringify(pkg, null, 2), 'utf8')
}

require(join(ROOT, 'out', 'main', 'index.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0

function check(label, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail++
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 真实 netstat 里 :PORT 上的 LISTENING PID，用来确认前提成立 */
function listeningPids() {
  const out = execFileSync('netstat.exe', ['-ano'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  })
  const pids = new Set()
  for (const line of out.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue
    const f = line.trim().split(/\s+/)
    if (f.length < 4) continue
    const local = f[1]
    if (Number(local.slice(local.lastIndexOf(':') + 1)) !== PORT) continue
    pids.add(Number(f[f.length - 1]))
  }
  return pids
}

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    console.log('FAIL 没有取到窗口')
    app.exit(1)
    return
  }

  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r))
    win.setBounds({ width: 1500, height: 940 })
    const js = (code) => win.webContents.executeJavaScript(code, true)

    const runtime = (id) =>
      js(
        `window.mile.entry.runtimes().then(r=>JSON.stringify(r.find(x=>x.entryId===${JSON.stringify(id)})||null))`
      ).then((s) => JSON.parse(s))

    // 采集前 ~10s 快照为 null，portItem 会静默「跳过」；不等热就量等于什么都没量
    let warm = false
    for (let i = 0; i < 60; i++) {
      if (await js(`window.mile.scanner.snapshot().then(s=>!!s)`)) {
        warm = true
        break
      }
      await sleep(500)
    }
    console.log('\n=== 1. 两个条目分别绑 IPv4 / IPv6 的同一端口 ===')
    check('采集快照已就绪', warm)

    for (const id of ['v4', 'v6']) {
      const res = await js(
        `window.mile.entry.start(${JSON.stringify(id)}).then(r=>JSON.stringify({ok:r.ok,
          fails:r.precheck.items.filter(i=>i.level==='fail').map(i=>i.id)}))`
      ).then((s) => JSON.parse(s))
      check(`${id} 启动成功`, res.ok === true, `fail 项：${res.fails.join(',') || '无'}`)

      let rt = null
      for (let i = 0; i < 100; i++) {
        rt = await runtime(id)
        if (rt && typeof rt.port === 'number') break
        await sleep(200)
      }
      check(`${id} 捕获到端口 ${PORT}`, rt && rt.port === PORT, `port=${rt && rt.port}`)
    }

    // 前提核验：两个 PID 真的同时在听。不成立则后面的断言会「因为没撞上」而空过
    let pids = new Set()
    for (let i = 0; i < 40; i++) {
      pids = listeningPids()
      if (pids.size >= 2) break
      await sleep(400)
    }
    check(
      `真实 netstat 里 :${PORT} 上有两个 PID（前提成立）`,
      pids.size >= 2,
      `PID：${[...pids].join(', ') || '无'}`
    )

    // 等采集把两个新 PID 都纳进监听表（未知 PID 触发 ~3.5s 的 CIM 刷新）
    let onPort = []
    for (let i = 0; i < 40; i++) {
      onPort = await js(
        `window.mile.scanner.snapshot().then(s=>JSON.stringify(s?s.listeners
          .filter(l=>l.ports.includes(${PORT})).map(l=>({pid:l.pid,entryId:l.entryId})):[]))`
      ).then((s) => JSON.parse(s))
      if (onPort.filter((l) => l.entryId).length >= 2) break
      await js(`window.mile.scanner.refresh()`)
      await sleep(900)
    }
    check(
      '监听表里同端口的两条都回填了 entryId',
      onPort.filter((l) => l.entryId).length >= 2,
      JSON.stringify(onPort)
    )

    console.log('\n=== 2. 预检不再说「空闲」 ===')
    for (const id of ['v4', 'v6']) {
      const item = await js(
        `window.mile.entry.precheck(${JSON.stringify(id)}).then(r=>JSON.stringify(r.items.find(i=>i.id==='port')))`
      ).then((s) => JSON.parse(s))
      check(
        `${id} 的 port 预检判为 warn 而非 pass`,
        item.level === 'warn',
        `${item.level} / ${item.detail}`
      )
      check(
        `${id} 的预检明确指出被占用`,
        typeof item.detail === 'string' && !item.detail.includes('空闲'),
        item.detail
      )
      check(`${id} 的预检给出 resolvePort 修复入口`, item.fix?.action === 'resolvePort',
        JSON.stringify(item.fix ?? null))
    }

    console.log('\n=== 3. 冲突计数把两条都算上 ===')
    let conflicts = 0
    for (let i = 0; i < 30; i++) {
      conflicts = await js(
        `window.mile.scanner.snapshot().then(s=>s?s.portConflicts:0)`
      )
      if (conflicts >= 2) break
      await js(`window.mile.scanner.refresh()`)
      await sleep(900)
    }
    check('portConflicts 为 2（两条都在冲突里）', conflicts === 2, `portConflicts=${conflicts}`)

    console.log('\n=== 4. 诊断指向对方而不是自己 ===')
    for (const id of ['v4', 'v6']) {
      const rt = await runtime(id)
      const d = await js(
        `window.mile.entry.diagnose(${JSON.stringify(id)}).then(d=>JSON.stringify({port:d.port,holder:d.portHolder}))`
      ).then((s) => JSON.parse(s))
      check(`${id} 诊断报出了占用者`, d.holder !== null, JSON.stringify(d.holder))
      check(
        `${id} 的占用者不是自己的根 PID`,
        d.holder !== null && d.holder.pid !== rt.pid,
        `holder=${d.holder && d.holder.pid} self=${rt.pid}`
      )
      // 占用者必须是真实在听这个端口的 PID，不能是随便挑的一个
      check(
        `${id} 的占用者确实在 netstat 的 :${PORT} 上`,
        d.holder !== null && listeningPids().has(d.holder.pid),
        `holder=${d.holder && d.holder.pid}`
      )
      check(
        `${id} 的占用者精确关联到另一条目`,
        d.holder !== null && d.holder.entryId === (id === 'v4' ? 'v6' : 'v4'),
        JSON.stringify(d.holder)
      )
    }

    console.log('\n=== 5. 卡片把「端口重合」写成文字 ===')
    await js(`(()=>{const b=[...document.querySelector('nav').querySelectorAll('button')]
      .find(x=>x.getAttribute('aria-label')==='启动台');b&&b.click();return true})()`)

    let cards = []
    for (let i = 0; i < 40; i++) {
      cards = await js(`JSON.stringify([...document.querySelectorAll('main article')]
        .filter(a=>a.dataset.entryId==='v4'||a.dataset.entryId==='v6')
        .map(a=>{
          const b=[...a.querySelectorAll('button')].find(x=>/^:\\d+$/.test((x.textContent||'').trim()))
          return {
            id: a.dataset.entryId,
            port: b ? (b.textContent||'').trim() : null,
            shared: b ? b.dataset.shared === 'true' : false,
            text: a.textContent.includes('端口重合'),
            title: b ? (b.getAttribute('title')||'') : ''
          }
        }))`).then((s) => JSON.parse(s))
      if (cards.length === 2 && cards.every((c) => c.text)) break
      await sleep(400)
    }
    check('两张卡片都渲染出来了', cards.length === 2, JSON.stringify(cards.map((c) => c.id)))
    check(
      `两张卡片都显示 :${PORT}`,
      cards.length === 2 && cards.every((c) => c.port === `:${PORT}`),
      cards.map((c) => c.port).join(' | ')
    )
    check(
      '两张卡片都带「端口重合」文字（不只靠颜色）',
      cards.length === 2 && cards.every((c) => c.text),
      cards.map((c) => `${c.id}:${c.text}`).join(' | ')
    )
    check(
      '端口胶囊带 data-shared 标记',
      cards.length === 2 && cards.every((c) => c.shared),
      cards.map((c) => `${c.id}:${c.shared}`).join(' | ')
    )
    check(
      '悬停提示说明 localhost 只通向其中一个',
      cards.length === 2 && cards.every((c) => c.title.includes('只会打开其中一个')),
      cards[0]?.title ?? ''
    )

    console.log('\n=== 6. 修复动作只停止诊断出的另一条 ===')
    await js(`document.querySelector('article[data-entry-id="v4"] button[aria-label="诊断"]')?.click()`)
    let clickedFix = false
    for (let i = 0; i < 40; i++) {
      clickedFix = await js(`(()=>{
        const button=[...document.querySelectorAll('button')]
          .find(x=>(x.textContent||'').trim()==='停止它')
        if(!button)return false
        button.click()
        return true
      })()`)
      if (clickedFix) break
      await sleep(300)
    }
    check('v4 的端口修复入口已触发', clickedFix)

    let v6Stopped = ''
    for (let i = 0; i < 60; i++) {
      const r = await runtime('v6')
      v6Stopped = r ? r.status : ''
      if (['stopped', 'crashed'].includes(v6Stopped)) break
      await sleep(200)
    }
    const v4AfterFix = await runtime('v4')
    check('v4 的修复动作停止 v6 而不是自己', ['stopped', 'crashed'].includes(v6Stopped), v6Stopped)
    check('v4 在修复动作后仍保持运行', v4AfterFix?.status === 'running', v4AfterFix?.status)

    console.log('\n=== 7. 停掉一条后重合标记消失 ===')
    let cleared = false
    for (let i = 0; i < 40; i++) {
      cleared = await js(`(()=>{
        const a=[...document.querySelectorAll('main article')].find(x=>x.dataset.entryId==='v4')
        return !!a && !a.textContent.includes('端口重合')
      })()`)
      if (cleared) break
      await sleep(400)
    }
    check('剩下的那条不再标端口重合', cleared)

    await js(`window.mile.entry.stop('v4').catch(()=>null)`)
    let stopped = ''
    for (let i = 0; i < 60; i++) {
      const r = await runtime('v4')
      stopped = r ? r.status : ''
      if (['stopped', 'crashed'].includes(stopped)) break
      await sleep(200)
    }
    check('会话已停止', ['stopped', 'crashed'].includes(stopped), stopped)
    await js(`window.mile.entry.stop('v6').catch(()=>null)`)
  } catch (err) {
    console.log('HARNESS ERROR', err)
    fail++
  }

  writeFileSync(PKG, PKG_ORIGINAL, 'utf8')
  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`)
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
})
