/**
 * 总览顶部「待办条」（2.2.0）。
 *
 * 以前总览只有统计磁贴：端口冲突写「去诊断里看」，失败的服务要自己翻服务页才找得到。
 * 现在总览顶部把需要处理的事合成一行行可点的待办：
 *   1. 什么都没有时显示「一切正常」。
 *   2. 某个服务的预期端口被别的进程占了：一行，点「查看诊断」跳到该服务的诊断标签。
 *   3. 服务启动被预检拦下：一行，点「查看诊断」跳过去。
 *   4. 端口采集失败：一行，带「重试」。
 *   5. 处理掉之后对应的行消失。
 *
 * 占端口用一个独立的 node 子进程（它是外部进程，不归本应用）；采集失败用 Module._load
 * 拦截 netstat（同 verify-review-scanner.cjs）。
 *
 *   npm run build
 *   npx electron scripts/verify-review-todo.cjs
 */
const Module = require('node:module')

let failNetstat = false
const realLoad = Module._load
Module._load = function (request, ...rest) {
  const mod = realLoad.call(this, request, ...rest)
  if (request !== 'node:child_process' && request !== 'child_process') return mod
  return new Proxy(mod, {
    get(target, key) {
      if (key !== 'execFile') return Reflect.get(target, key)
      return function (file, ...args) {
        if (failNetstat && /netstat\.exe$/i.test(String(file))) {
          const cb = args.find((a) => typeof a === 'function')
          setImmediate(() => cb(new Error('探针：netstat 被拦截失败')))
          return { kill() {}, on() {} }
        }
        return target.execFile(file, ...args)
      }
    }
  })
}

const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { spawn } = require('node:child_process')

const ROOT = join(__dirname, '..')
const FIX = join(ROOT, 'scripts', 'fixture').replace(/\\/g, '/')
const SANDBOX = join(tmpdir(), `mile-review-todo-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)

const PORT = 47000 + (process.pid % 1500)
const now = Date.now()
const mk = (id, name, order, extra = {}) => ({
  id, kind: 'service', name, path: FIX, framework: 'node', packageManager: 'npm',
  script: 'dev', scripts: { dev: 'node server.cjs' }, env: {}, registerOnly: false, pinned: false,
  order, createdAt: now, ...extra
})
writeFileSync(
  join(SANDBOX, 'mile-terminal', 'config.json'),
  JSON.stringify({
    version: 9,
    entries: [
      mk('ok', '正常服务', 0),
      mk('busy', '端口被占服务', 1, { expectedPort: PORT }),
      // 目录不存在：预检必然拦下
      mk('bad', '预检必挂服务', 2, { path: join(SANDBOX, 'no-such-dir').replace(/\\/g, '/') })
    ],
    groups: [],
    ignoredListeners: [],
    settings: { scanIntervalMs: 2000, theme: 'light', externalTerminal: 'wt', terminalFontSize: 13, scrollback: 5000, killOwnedOnQuit: true, closeToTray: false }
  }, null, 2),
  'utf8'
)

require(join(ROOT, 'out', 'main', 'index.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(name, ok, detail) {
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? ` — ${detail}` : ''}`)
}

let blocker = null
app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  win.setBounds({ width: 1400, height: 900 })
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const waitFor = async (code, ms = 10000) => {
    for (let t = 0; t < ms; t += 200) { if (await js(code)) return true; await sleep(200) }
    return false
  }
  const items = () => js(`[...document.querySelectorAll('[data-todo] [data-todo-item]')].map(e=>e.dataset.todoItem+':'+e.textContent.trim())`)
  const goDash = async () => {
    await js(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'1',ctrlKey:true,bubbles:true,cancelable:true}));true`)
    await waitFor(`(document.querySelector('main h1')||{}).textContent==='总览'`)
  }
  await waitFor(`!!document.querySelector('nav[aria-label="主导航"]')`, 30000)
  await goDash()

  console.log('\n=== 1. 没有待办 ===')
  check('待办条存在', await waitFor(`!!document.querySelector('[data-todo]')`))
  check('显示一切正常', await waitFor(`/一切正常/.test((document.querySelector('[data-todo]')||{}).textContent||'')`), JSON.stringify(await items()))

  console.log('\n=== 2. 预期端口被外部进程占用 ===')
  blocker = spawn(process.execPath, ['-e', `require('http').createServer((q,s)=>s.end('x')).listen(${PORT},'127.0.0.1')`], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore', windowsHide: true
  })
  check('出现端口冲突待办', await waitFor(`[...document.querySelectorAll('[data-todo-item="conflict"]')].some(e=>e.textContent.includes('端口被占服务')&&e.textContent.includes(':${PORT}'))`, 40000), JSON.stringify(await items()))
  check('不再显示一切正常', !(await js(`/一切正常/.test(document.querySelector('[data-todo]').textContent)`)))
  check('点「查看诊断」', await js(`(()=>{const r=[...document.querySelectorAll('[data-todo-item="conflict"]')].find(e=>e.textContent.includes('端口被占服务'));const b=r&&[...r.querySelectorAll('button')].find(x=>x.textContent.includes('查看诊断'));if(!b)return false;b.click();return true})()`))
  check('跳到服务页并打开该服务的诊断', await waitFor(`(document.querySelector('main h1')||{}).textContent==='服务' && (document.querySelector('.svc-row[data-entry-id="busy"]')||{getAttribute:()=>null}).getAttribute('aria-selected')==='true' && /诊断/.test((document.querySelector('.svc-detail [role="tab"][aria-selected="true"]')||{}).textContent||'')`))

  console.log('\n=== 3. 预检拦下 ===')
  await js(`window.mile.entry.start('bad')`)
  await goDash()
  check('出现预检未通过待办', await waitFor(`[...document.querySelectorAll('[data-todo-item="fault"]')].some(e=>e.textContent.includes('预检必挂服务'))`), JSON.stringify(await items()))

  console.log('\n=== 4. 采集失败 ===')
  failNetstat = true
  check('出现采集失败待办', await waitFor(`!!document.querySelector('[data-todo-item="scan"]')`, 20000), JSON.stringify(await items()))
  check('带「重试」按钮', await js(`!![...document.querySelectorAll('[data-todo-item="scan"] button')].find(b=>b.textContent.includes('重试'))`))
  failNetstat = false
  await js(`[...document.querySelectorAll('[data-todo-item="scan"] button')].find(b=>b.textContent.includes('重试'))?.click();true`)
  check('恢复后采集失败的行消失', await waitFor(`!document.querySelector('[data-todo-item="scan"]')`, 20000), JSON.stringify(await items()))

  console.log('\n=== 5. 处理掉后消失 ===')
  blocker.kill()
  blocker = null
  check('占用进程退出后冲突行消失', await waitFor(`![...document.querySelectorAll('[data-todo-item="conflict"]')].some(e=>e.textContent.includes('端口被占服务'))`, 40000), JSON.stringify(await items()))
  await js(`window.mile.entry.edit('bad', { path: ${JSON.stringify(FIX)} })`)
  await js(`window.mile.entry.start('bad')`)
  check('改好目录重新启动后预检行消失', await waitFor(`![...document.querySelectorAll('[data-todo-item="fault"]')].some(e=>e.textContent.includes('预检必挂服务'))`, 30000), JSON.stringify(await items()))
  await js(`window.mile.entry.stop('bad').catch(()=>null)`)

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`) }
  app.exit(fail === 0 ? 0 : 1)
})

process.on('exit', () => { try { blocker?.kill() } catch { /* 已退出 */ } })
