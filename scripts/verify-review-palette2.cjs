/**
 * 命令面板补全（2.2.0）。
 *
 * 以前面板里对一个服务只有「启动 / 停止」一项，整组动作一个都没有。现在：
 *   1. 搜到服务时，除启停外还有「重启」（仅运行中的服务）、「查看详情」「打开目录」
 *      「在此目录开终端」「在外部终端打开」。
 *   2. 搜到工作组时有「启动全部」「停止全部」，生产环境照样先确认。
 *   3. 点「查看详情」切到服务页并选中该服务；点「在此目录开终端」新开会话并切到终端页；
 *      点「打开目录」只发出已登记目录（拦截记录，不真的打开资源管理器）。
 *   4. 空查询时不刷出这一大串，只给内置动作（回归）。
 *
 *   npm run build
 *   npx electron scripts/verify-review-palette2.cjs
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const FIX = join(ROOT, 'scripts', 'fixture').replace(/\\/g, '/')
const SANDBOX = join(tmpdir(), `mile-review-palette2-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)

const now = Date.now()
const mk = (id, name, order, groupId) => ({
  id, kind: 'service', name, path: FIX, framework: 'node', packageManager: 'npm',
  script: 'dev', scripts: { dev: 'node server.cjs' }, env: {}, registerOnly: false, pinned: false,
  order, createdAt: now, ...(groupId ? { groupId } : {})
})
writeFileSync(
  join(SANDBOX, 'mile-terminal', 'config.json'),
  JSON.stringify({
    version: 9,
    entries: [mk('a', '甲服务', 0, 'g1'), mk('b', '乙服务', 1, 'g1')],
    groups: [{ id: 'g1', name: '面板测试组', description: '', env: 'dev', order: 0, createdAt: now }],
    ignoredListeners: [],
    settings: { scanIntervalMs: 2000, theme: 'light', externalTerminal: 'wt', terminalFontSize: 13, scrollback: 5000, killOwnedOnQuit: true, closeToTray: false }
  }, null, 2),
  'utf8'
)

// 拦下「打开目录」：只记录请求，不真的拉起资源管理器
const OPENED = []
{
  const { ipcMain } = require('electron')
  const on = ipcMain.on.bind(ipcMain)
  ipcMain.on = (ch, fn) => (ch === 'shell:openPath' ? on(ch, (_e, p) => OPENED.push(p)) : on(ch, fn))
}
require(join(ROOT, 'out', 'main', 'index.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(name, ok, detail) {
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? ` — ${detail}` : ''}`)
}

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  win.setBounds({ width: 1400, height: 900 })
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const waitFor = async (code, ms = 8000) => {
    for (let t = 0; t < ms; t += 150) { if (await js(code)) return true; await sleep(150) }
    return false
  }
  const status = (id) => js(`window.mile.entry.runtimes().then(r => (r.find(x => x.entryId === ${JSON.stringify(id)}) || {}).status || 'idle')`)
  const h1 = () => js(`(document.querySelector('main h1')||{textContent:''}).textContent.trim()`)
  await waitFor(`!!document.querySelector('nav[aria-label="主导航"]')`, 30000)

  const open = async (q) => {
    if (!(await js(`!!document.querySelector('[role="dialog"][aria-label="命令面板"]')`))) {
      await js(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true,cancelable:true}));true`)
      await waitFor(`!!document.querySelector('[aria-label="命令面板输入"]')`, 3000)
    }
    await js(`(()=>{const i=document.querySelector('[aria-label="命令面板输入"]');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,${JSON.stringify(q)});i.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
    await sleep(200)
    return js(`[...document.querySelectorAll('#palette-results [role="option"]')].map(b=>b.textContent.trim())`)
  }
  const pick = (label) => js(`(()=>{const b=[...document.querySelectorAll('#palette-results [role="option"]')].find(x=>x.textContent.includes(${JSON.stringify(label)}));if(!b)return false;b.click();return true})()`)
  const has = (opts, label) => opts.some((o) => o.includes(label))

  console.log('\n=== 1. 搜到服务：完整动作 ===')
  const o1 = await open('甲服务')
  check('前提：有候选', o1.length > 0, o1.join(' | '))
  for (const l of ['启动 甲服务', '查看详情 甲服务', '打开目录 甲服务', '在此目录开终端 甲服务', '在外部终端打开 甲服务']) {
    check(`含「${l}」`, has(o1, l), o1.join(' | '))
  }
  check('没运行时不给「重启」', !has(o1, '重启 甲服务'))

  console.log('\n=== 2. 搜到工作组：整组启停 ===')
  const o2 = await open('面板测试组')
  check('含「启动全部 · 面板测试组」', has(o2, '启动全部 · 面板测试组'), o2.join(' | '))
  check('含「停止全部 · 面板测试组」', has(o2, '停止全部 · 面板测试组'), o2.join(' | '))
  check('点「启动全部」', await pick('启动全部 · 面板测试组'))
  check('组内两个服务都起来了', await waitFor(`window.mile.entry.runtimes().then(r=>['a','b'].every(id=>(r.find(x=>x.entryId===id)||{}).status==='running'))`, 30000),
    `${await status('a')},${await status('b')}`)

  console.log('\n=== 3. 运行中的服务有「重启」===')
  const o3 = await open('甲服务')
  check('运行中给「停止」与「重启」', has(o3, '停止 甲服务') && has(o3, '重启 甲服务'), o3.join(' | '))

  console.log('\n=== 4. 停止全部 ===')
  await open('面板测试组')
  check('点「停止全部」', await pick('停止全部 · 面板测试组'))
  check('组内服务都停了', await waitFor(`window.mile.entry.runtimes().then(r=>['a','b'].every(id=>!['running','starting','stopping'].includes((r.find(x=>x.entryId===id)||{}).status)))`, 30000),
    `${await status('a')},${await status('b')}`)

  console.log('\n=== 5. 查看详情 / 打开目录 / 在此目录开终端 ===')
  const o5 = await open('乙服务')
  check('点「查看详情」', await pick('查看详情 乙服务'), o5.join(' | '))
  check('切到服务页并选中乙服务', await waitFor(`(document.querySelector('main h1')||{}).textContent==='服务' && (document.querySelector('.svc-row[data-entry-id="b"]')||{getAttribute:()=>null}).getAttribute('aria-selected')==='true'`), await h1())

  const before = OPENED.length
  await open('乙服务')
  check('点「打开目录」', await pick('打开目录 乙服务'))
  await sleep(300)
  check('只发出登记目录', OPENED.length === before + 1 && OPENED[OPENED.length - 1] === FIX, OPENED.slice(before).join(' | '))

  const n0 = (await js(`window.mile.session.list()`)).length
  await open('乙服务')
  check('点「在此目录开终端」', await pick('在此目录开终端 乙服务'))
  check('切到终端页', await waitFor(`(document.querySelector('main h1')||{}).textContent==='终端'`))
  const sess = await js(`window.mile.session.list()`)
  const last = sess[sess.length - 1]
  check('新开了一个会话，开在条目目录', sess.length === n0 + 1 && last && last.cwd.replace(/\\/g, '/').toLowerCase() === FIX.toLowerCase(), last && last.cwd)

  console.log('\n=== 6. 空查询只给内置动作 ===')
  const o6 = await open('')
  check('空查询不刷出次要动作与整组动作', !o6.some((o) => /^(重启|查看详情|打开目录|在此目录开终端|在外部终端打开|启动全部|停止全部)/.test(o)), o6.join(' | '))
  check('空查询仍有内置动作', has(o6, '添加服务'), o6.join(' | '))

  await js(`(async()=>{for(const s of await window.mile.session.list())await window.mile.session.stop(s.id).catch(()=>{});return true})()`).catch(() => null)
  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`) }
  app.exit(fail === 0 ? 0 : 1)
})
