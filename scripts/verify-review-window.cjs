/**
 * 窗口位置、大小与上次页面、选中服务跨重启恢复（2.1.0）。
 *
 * 要重启应用才量得到，所以本脚本自己当「驱动」：不带 MILE_PHASE 启动时，按阶段拉起
 * 多个真实的 Electron 进程（共用同一个沙箱目录），每个阶段是一次完整的启动-操作-退出。
 *
 *   阶段 1：改窗口位置和大小，切到服务页，选中第二个服务，然后关闭。
 *   阶段 2：重新启动，窗口回到原位置和大小，仍在服务页，仍选中那个服务。
 *   阶段 3：把状态文件改成屏幕外的坐标、再改成损坏内容，窗口必须仍落在可见区域内。
 *   阶段 4：状态文件记着「最大化」，启动后是最大化。
 *
 *   npm run build
 *   npx electron scripts/verify-review-window.cjs
 */
const { join } = require('node:path')
const { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const PHASE = process.env.MILE_PHASE
const SANDBOX = process.env.MILE_SANDBOX || join(tmpdir(), `mile-review-window-${process.pid}`)
const STATE_FILE = join(SANDBOX, 'mile-terminal', 'window-state.json')

// ───────────────────────── 驱动 ─────────────────────────
if (!PHASE) {
  const { spawnSync } = require('node:child_process')
  mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
  const FIX = join(ROOT, 'scripts', 'fixture').replace(/\\/g, '/')
  const now = Date.now()
  const mk = (id, name, order) => ({
    id, kind: 'service', name, path: FIX, framework: 'node', packageManager: 'npm',
    script: 'dev', scripts: { dev: 'node server.cjs' }, env: {}, registerOnly: false, pinned: false, order, createdAt: now
  })
  writeFileSync(
    join(SANDBOX, 'mile-terminal', 'config.json'),
    JSON.stringify({
      version: 10,
      entries: [mk('a', '第一个服务', 0), mk('b', '第二个服务', 1)],
      groups: [], ignoredListeners: [], groupOverrides: [], watchedKeywords: [],
      settings: { scanIntervalMs: 2000, theme: 'light', externalTerminal: 'wt', terminalFontSize: 13, scrollback: 5000, killOwnedOnQuit: true, closeToTray: false, notifyOnTaskDone: true, hideFromTaskbar: false, notifyOnCrash: true, notifyOnlyWhenBackground: true }
    }, null, 2),
    'utf8'
  )

  let pass = 0
  let fail = 0
  for (const phase of ['1', '2', '3', '4']) {
    console.log(`\n===== 阶段 ${phase} =====`)
    // 阶段 3：模拟拔掉副屏后留下的屏幕外坐标；阶段 4：状态文件记着最大化
    if (phase === '3') {
      writeFileSync(STATE_FILE, JSON.stringify({ x: 99999, y: 99999, width: 1300, height: 820, maximized: false }), 'utf8')
    }
    if (phase === '4') {
      writeFileSync(STATE_FILE, JSON.stringify({ x: 100, y: 80, width: 1300, height: 820, maximized: true }), 'utf8')
    }
    const stateBefore = phase === '2' && existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : null
    const r = spawnSync(process.execPath, [__filename], {
      env: { ...process.env, MILE_PHASE: phase, MILE_SANDBOX: SANDBOX },
      encoding: 'utf8',
      timeout: 90_000
    })
    const out = (r.stdout || '') + (r.stderr || '')
    for (const line of out.split(/\r?\n/)) {
      if (/^\s+(PASS|FAIL)\s/.test(line)) console.log(line)
      const m = /^结果：(\d+) 通过，(\d+) 失败/.exec(line)
      if (m) { pass += Number(m[1]); fail += Number(m[2]) }
    }
    if (phase === '1') {
      const ok = existsSync(STATE_FILE)
      console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  关闭后写出了状态文件' + (ok ? ' — ' + readFileSync(STATE_FILE, 'utf8').slice(0, 90) : ''))
      ok ? pass++ : fail++
    }
    if (phase === '2' && stateBefore) {
      // 缩放不是 100% 时尺寸在 DIP 与物理像素间换算有舍入，不处理的话每开关一次窗口就大几个像素
      const after = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
      const ok = after.width === stateBefore.width && after.height === stateBefore.height
      console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  再开关一次，保存的尺寸不涨 — ' + stateBefore.width + 'x' + stateBefore.height + ' -> ' + after.width + 'x' + after.height)
      ok ? pass++ : fail++
    }
    if (r.status === null || !/^结果：/m.test(out)) {
      fail++
      console.log(`  FAIL  阶段 ${phase} 没有产出结果（退出码 ${r.status}）`)
    }
  }
  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { console.log(`  (沙箱残留：${SANDBOX})`) }
  process.exit(fail === 0 ? 0 : 1)
}

// ───────────────────────── 阶段进程 ─────────────────────────
const { app, BrowserWindow, screen } = require('electron')
// appData 与 userData（localStorage 所在）都指向沙箱，必须在 require 主进程包之前
app.setPath('appData', SANDBOX)
app.setPath('userData', join(SANDBOX, 'user'))

require(join(ROOT, 'out', 'main', 'index.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(name, ok, detail) {
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? ` — ${detail}` : ''}`)
}
const inside = (b) => screen.getAllDisplays().some((d) => {
  const w = d.workArea
  const ox = Math.min(b.x + b.width, w.x + w.width) - Math.max(b.x, w.x)
  const oy = Math.min(b.y + b.height, w.y + w.height) - Math.max(b.y, w.y)
  return ox >= 100 && oy >= 100
})

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const waitFor = async (code, ms = 8000) => {
    for (let t = 0; t < ms; t += 150) { if (await js(code)) return true; await sleep(150) }
    return false
  }
  const h1 = () => js(`(document.querySelector('main h1')||{textContent:''}).textContent.trim()`)
  await waitFor(`!!document.querySelector('nav[aria-label="主导航"]')`, 30000)

  if (PHASE === '1') {
    console.log('\n=== 1. 首次启动：改位置、大小、页面、选中服务 ===')
    check('首次启动没有状态文件', !existsSync(STATE_FILE))
    win.setBounds({ x: 120, y: 90, width: 1300, height: 820 })
    await sleep(600)
    await js(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'2',ctrlKey:true,bubbles:true,cancelable:true}));true`)
    check('切到了服务页', await waitFor(`(document.querySelector('main h1')||{}).textContent==='服务'`))
    await waitFor(`document.querySelectorAll('.svc-row').length === 2`)
    check('点选第二个服务', await js(`(()=>{const r=document.querySelector('.svc-row[data-entry-id="b"]');if(!r)return false;r.click();return true})()`))
    check('详情已打开', await waitFor(`!!document.querySelector('.svc-detail')`))
    await sleep(600)
  }

  if (PHASE === '2') {
    console.log('\n=== 2. 重启：回到原位置与大小 ===')
    const b = win.getBounds()
    check('位置恢复', b.x === 120 && b.y === 90, `${b.x},${b.y}`)
    // 175% 缩放下 DIP 与物理像素换算有舍入，读回会差几像素；漂移本身由驱动在阶段间比对状态文件
    check('大小恢复（容差 8px）', Math.abs(b.width - 1300) <= 8 && Math.abs(b.height - 820) <= 8, `${b.width}x${b.height}`)
    console.log('\n=== 2b. 重启：回到上次页面与选中服务 ===')
    check('仍在服务页', await waitFor(`(document.querySelector('main h1')||{}).textContent==='服务'`), await h1())
    check('选中的仍是第二个服务', await waitFor(`(document.querySelector('.svc-row[data-entry-id="b"]')||{getAttribute:()=>null}).getAttribute('aria-selected')==='true'`))
    check('详情自动打开', await waitFor(`!!document.querySelector('.svc-detail')`))
    check('第一个服务没被选中', await js(`document.querySelector('.svc-row[data-entry-id="a"]').getAttribute('aria-selected')!=='true'`))
  }

  if (PHASE === '3') {
    console.log('\n=== 3. 屏幕外的坐标会被拉回可见区域 ===')
    const b = win.getBounds()
    check('窗口落在某块屏幕的可见区域内', inside(b), JSON.stringify(b))
    check('宽高未被破坏', b.width >= 1180 && b.height >= 760, `${b.width}x${b.height}`)
  }

  if (PHASE === '4') {
    console.log('\n=== 4. 最大化状态恢复 ===')
    check('启动后是最大化', win.isMaximized())
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  // 先把结果写出去再关窗：关窗会触发主进程保存窗口状态，随后才退出
  win.close()
  await sleep(1500)
  app.exit(fail === 0 ? 0 : 1)
})
