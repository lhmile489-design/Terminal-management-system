/**
 * M11 验证：端口回退时捕获的是实听端口，不是「被占用的那个」。
 *
 * 缺陷现场：两个项目都默认 3000（Vite 的 VITE_APP_PORT=3000、Next 的默认值），
 * 先起的占住 3000，后起的自己退到 3001 并打印
 *   ⚠ Port 3000 is in use by process 14944, using available port 3001 instead.
 * 而 PORT_PATTERNS 里的 `port\s+(\d+)` 会在这一块里先撞上 3000。两张卡片于是都
 * 显示 :3000，且第二条的 expectedPort 被写成 3000 —— 卡片端口、浏览器打开地址、
 * 重启前的「等端口释放」、预检的端口冲突判定四处同时指向别人的服务。
 *
 * 验证口径必须是「实听端口」而不是「不等于某个数」：
 * 断言拿 readListenPorts 的口径（window.mile.scanner.snapshot）交叉核对，
 * 确认捕获到的端口真的在监听表里、且属于本次起的那个 PID。只断言「不是 3000」
 * 会被「捕获失败返回 null」蒙过去 —— 那也不是 3000。
 *
 * 夹具自己占一个端口再回退，所以「告警端口」与「实听端口」必然不同，
 * 不依赖运行机器上 3000 的实际状态。
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const FIX = join(__dirname, 'fixture')

const SANDBOX = join(tmpdir(), `mile-m11p-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
app.setPath('appData', SANDBOX)
const CONFIG = join(SANDBOX, 'mile-terminal', 'config.json')

/** 夹具告警行里出现的端口 —— 它被夹具自己占住，绝不该被当成实听端口 */
const DECOY = 45870

const CONFIG_VERSION = Number(
  /CONFIG_VERSION\s*=\s*(\d+)/.exec(
    readFileSync(join(ROOT, 'src', 'shared', 'types.ts'), 'utf8')
  )?.[1]
)

writeFileSync(
  CONFIG,
  JSON.stringify(
    {
      version: 1,
      entries: [
        {
          id: 'svc',
          kind: 'service',
          name: '端口回退服务',
          path: FIX,
          framework: 'node',
          packageManager: 'npm',
          script: 'fallback',
          scripts: { fallback: 'node busy-server.cjs' },
          env: {},
          registerOnly: false,
          pinned: false,
          order: 0,
          createdAt: Date.now()
        }
      ],
      ignoredListeners: [],
      settings: { scanIntervalMs: 2000 }
    },
    null,
    2
  ),
  'utf8'
)

/*
 * 夹具的 package.json 要真有 fallback 这个键：assertScriptDeclared 启动前重读磁盘，
 * 只写进沙箱配置的脚本一律被拒。结束时还原，否则会影响别的 harness。
 */
const PKG = join(FIX, 'package.json')
const PKG_ORIGINAL = readFileSync(PKG, 'utf8')
{
  const pkg = JSON.parse(PKG_ORIGINAL)
  pkg.scripts = { ...pkg.scripts, fallback: 'node busy-server.cjs' }
  // engines.node 是 >=99 的哨兵，只出 warn 不拦启动，保持原样不动
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

    const runtime = () =>
      js(`window.mile.entry.runtimes().then(r=>JSON.stringify(r.find(x=>x.entryId==='svc')||null))`)
        .then((s) => JSON.parse(s))

    console.log('\n=== 1. 起一个会回退端口的服务 ===')
    const started = await js(
      `window.mile.entry.start('svc').then(r=>JSON.stringify({ok:r.ok,items:(r.precheck&&r.precheck.items||[])
        .filter(i=>i.level==='fail').map(i=>i.id)}))`
    ).then((s) => JSON.parse(s))
    check('预检通过并启动', started.ok === true, `fail 项：${started.items.join(',') || '无'}`)

    // 轮询到捕获为止，不用固定 sleep —— 夹具要先占端口再回退，快慢不定
    let rt = null
    for (let i = 0; i < 100; i++) {
      rt = await runtime()
      if (rt && typeof rt.port === 'number') break
      await sleep(200)
    }
    check('捕获到了端口', rt && typeof rt.port === 'number', `port=${rt && rt.port}`)

    console.log('\n=== 2. 捕获到的是实听端口 ===')
    // 先取夹具自报的真端口：它把 MILE_REAL_PORT 打进了输出流
    let reported = null
    for (let i = 0; i < 60; i++) {
      const text = await js(
        `window.mile.log.query({ limit: 400 }).then(r=>r.lines.map(l=>l.text).join('\\n'))`
      )
      const m = /MILE_REAL_PORT=(\d+)/.exec(text)
      if (m) {
        reported = Number(m[1])
        break
      }
      await sleep(200)
    }
    check('夹具自报了实听端口', typeof reported === 'number', `reported=${reported}`)
    check(
      '捕获端口等于夹具实听端口',
      typeof reported === 'number' && rt.port === reported,
      `captured=${rt && rt.port} reported=${reported}`
    )
    check('捕获端口不是告警行里的被占端口', rt && rt.port !== DECOY, `captured=${rt && rt.port}`)

    // 交叉核对监听表：只断言「不等于 DECOY」会被「捕获失败得到 null」蒙过去
    let listed = null
    for (let i = 0; i < 40; i++) {
      const snap = await js(
        `window.mile.scanner.snapshot().then(s=>JSON.stringify(s?s.listeners.map(l=>({pid:l.pid,ports:l.ports})):[]))`
      ).then((s) => JSON.parse(s))
      if (snap.length > 0 && snap.some((l) => l.ports.includes(rt.port))) {
        listed = snap
        break
      }
      await js(`window.mile.scanner.refresh()`)
      await sleep(700)
    }
    check(
      '捕获端口出现在真实监听表里',
      Array.isArray(listed) && listed.length > 0 && listed.some((l) => l.ports.includes(rt.port)),
      `监听项 ${listed ? listed.length : 0} 个`
    )
    const decoyRow = (listed ?? []).find((l) => l.ports.includes(DECOY))
    check(
      '被占端口确实也在监听（证明告警行不是空谈）',
      !!decoyRow,
      decoyRow ? `:${DECOY} by pid ${decoyRow.pid}` : `监听表里没有 :${DECOY}`
    )

    console.log('\n=== 3. 写回条目的也是实听端口 ===')
    const entry = await js(
      `window.mile.entry.list().then(l=>JSON.stringify(l.find(e=>e.id==='svc')))`
    ).then((s) => JSON.parse(s))
    check('expectedPort 写回实听端口', entry.expectedPort === rt.port,
      `expectedPort=${entry.expectedPort} runtime=${rt.port}`)

    const disk = JSON.parse(readFileSync(CONFIG, 'utf8'))
    const diskEntry = disk.entries.find((e) => e.id === 'svc')
    check('磁盘上落的也是实听端口', diskEntry.expectedPort === rt.port,
      `disk=${diskEntry.expectedPort}`)
    check('配置版本已迁移', disk.version === CONFIG_VERSION,
      `${disk.version} / ${CONFIG_VERSION}`)

    console.log('\n=== 4. 界面显示的端口一致 ===')
    await js(`(()=>{const b=[...document.querySelector('nav').querySelectorAll('button')]
      .find(x=>x.getAttribute('aria-label') === '前端启动台');b&&b.click();return true})()`)
    /*
     * 量端口胶囊按钮本身，不拿整卡文案套正则。
     *
     * 第一版写的是 /:(\d{2,5})\b/，在真实 DOM 上恒不匹配：卡片文案是
     * `...运行中:20387Node · npm run fallback`，端口紧接着 `Node`，数字与字母
     * 之间没有 \b。这是「断言失败但代码是对的」，量错了东西。
     */
    const cardPort = await (async () => {
      for (let i = 0; i < 40; i++) {
        const raw = await js(`(()=>{
          const c = [...document.querySelectorAll('main article')].find(x=>x.dataset.entryId==='svc')
          if (!c) return ''
          const b = [...c.querySelectorAll('button')]
            .find(x=>/^:\\d+$/.test((x.textContent||'').trim()))
          return b ? (b.textContent||'').trim() : ''
        })()`)
        if (raw) return Number(raw.slice(1))
        await sleep(200)
      }
      return null
    })()
    check('卡片上量到了端口', typeof cardPort === 'number', `card=${cardPort}`)
    check('卡片端口与运行态一致', cardPort === rt.port, `card=${cardPort} runtime=${rt.port}`)

    console.log('\n=== 5. 收尾停止 ===')
    await js(`window.mile.entry.stop('svc').catch(()=>null)`)
    let stopped = ''
    for (let i = 0; i < 60; i++) {
      const r = await runtime()
      stopped = r ? r.status : ''
      if (['stopped', 'crashed'].includes(stopped)) break
      await sleep(200)
    }
    check('会话已停止', ['stopped', 'crashed'].includes(stopped), stopped)
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
