/**
 * 环境变量的值不下发渲染层（2026-10-28 复审修复）。
 *
 * 以前 entry:list / entry:changed / add / edit 的回执都带完整 env，渲染层内存里
 * 持有所有密钥的明文，和 CLAUDE.md「渲染层拿不到环境变量的值」对不上。
 *
 * 现在：出口一律把值抹成空串（键名保留，表单仍能列出有哪些变量）；
 * 编辑用合并补丁：字符串 = 设置/覆盖，null = 删除，没提的键保持原值。
 * 真实的值只在磁盘配置和主进程里。
 *
 *   npm run build
 *   npx electron scripts/verify-review-env.cjs
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const FIX = join(ROOT, 'scripts', 'fixture').replace(/\\/g, '/')
const SANDBOX = join(tmpdir(), `mile-review-env-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)
const CONFIG = join(SANDBOX, 'mile-terminal', 'config.json')

const SECRET_A = 'MILE_SECRET_ALPHA_9f3a'
const SECRET_B = 'MILE_SECRET_BETA_77c1'
const SECRET_C = 'MILE_SECRET_GAMMA_0e5d'
const SECRET_D = 'MILE_SECRET_DELTA_4b82'

writeFileSync(
  CONFIG,
  JSON.stringify({
    version: 1,
    entries: [{
      id: 'e1', kind: 'service', name: '密钥探针', path: FIX, framework: 'node', packageManager: 'npm',
      script: 'dev', scripts: { dev: 'node server.cjs' }, env: { TOKEN_A: SECRET_A, TOKEN_B: SECRET_B },
      registerOnly: false, pinned: false, order: 0, createdAt: Date.now()
    }],
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
const disk = () => JSON.parse(readFileSync(CONFIG, 'utf8')).entries.find((e) => e.id === 'e1')
const leaks = (v) => /MILE_SECRET_/.test(JSON.stringify(v))

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  const js = (code) => win.webContents.executeJavaScript(code, true)

  // 记录主进程推给窗口的条目广播
  const broadcasts = []
  const realSend = win.webContents.send.bind(win.webContents)
  win.webContents.send = (channel, ...args) => {
    if (channel === 'entry:changed') broadcasts.push(args[0])
    return realSend(channel, ...args)
  }

  console.log('\n=== 1. 出口不带值 ===')
  const list = await js(`window.mile.entry.list()`)
  const e1 = list.find((e) => e.id === 'e1')
  check('前提：磁盘上确有密钥', disk().env.TOKEN_A === SECRET_A)
  check('entry:list 不含密钥值', !leaks(list), leaks(list) ? '泄漏' : '干净')
  check('entry:list 仍列出变量名', e1 && 'TOKEN_A' in e1.env && 'TOKEN_B' in e1.env, e1 ? Object.keys(e1.env).join(',') : '无')

  console.log('\n=== 2. 合并补丁 ===')
  const edited = await js(`window.mile.entry.edit('e1', { env: { TOKEN_C: ${JSON.stringify(SECRET_C)} } })
    .then(e => e, err => ({ error: String(err) }))`)
  check('edit 回执不含密钥值', !leaks(edited), edited.error || (leaks(edited) ? '泄漏' : '干净'))
  check('新键写进磁盘', disk().env.TOKEN_C === SECRET_C)
  check('没提的旧键保持原值', disk().env.TOKEN_A === SECRET_A && disk().env.TOKEN_B === SECRET_B,
    JSON.stringify(Object.keys(disk().env)))

  await js(`window.mile.entry.edit('e1', { env: { TOKEN_A: ${JSON.stringify(SECRET_D)} } })`)
  check('字符串值覆盖旧值', disk().env.TOKEN_A === SECRET_D)

  await js(`window.mile.entry.edit('e1', { env: { TOKEN_B: null } })`)
  check('null 删除该键', !('TOKEN_B' in disk().env), JSON.stringify(Object.keys(disk().env)))
  check('删除一个键不影响其他键', disk().env.TOKEN_A === SECRET_D && disk().env.TOKEN_C === SECRET_C)

  const bad = await js(`window.mile.entry.edit('e1', { env: { 'BAD;KEY': 'x' } }).then(() => 'ACCEPTED', e => 'REJECTED')`)
  check('非法变量名仍被拒', bad === 'REJECTED', bad)
  const badVal = await js(`window.mile.entry.edit('e1', { env: { TOKEN_A: 123 } }).then(() => 'ACCEPTED', e => 'REJECTED')`)
  check('非字符串值仍被拒', badVal === 'REJECTED', badVal)
  check('被拒的补丁没改动磁盘', disk().env.TOKEN_A === SECRET_D)

  console.log('\n=== 3. 广播与新增 ===')
  check('前提：收到过条目广播', broadcasts.length > 0, `${broadcasts.length} 条`)
  check('entry:changed 广播不含密钥值', !broadcasts.some(leaks), broadcasts.some(leaks) ? '泄漏' : '干净')

  const added = await js(`window.mile.entry.add({
    kind: 'service', name: '新增探针', path: ${JSON.stringify(FIX)}, framework: 'node', packageManager: 'npm',
    script: 'dev', scripts: { dev: 'node server.cjs' }, env: { NEW_TOKEN: ${JSON.stringify(SECRET_A)}, DROP_ME: null },
    registerOnly: false, pinned: false
  }).then(e => e, err => ({ error: String(err) }))`)
  check('add 回执不含密钥值', !leaks(added), added.error || (leaks(added) ? '泄漏' : '干净'))
  const addedDisk = JSON.parse(readFileSync(CONFIG, 'utf8')).entries.find((e) => e.name === '新增探针')
  check('add 把值写进磁盘', addedDisk && addedDisk.env.NEW_TOKEN === SECRET_A, addedDisk ? JSON.stringify(addedDisk.env) : '无')
  check('add 里 null 的键被丢弃', addedDisk && !('DROP_ME' in addedDisk.env))

  const reordered = await js(`window.mile.entry.reorder(['e1'])`)
  check('reorder 回执不含密钥值', !leaks(reordered))

  console.log('\n=== 4. 诊断仍只给键名 ===')
  const diag = await js(`window.mile.entry.diagnose('e1')`)
  check('诊断带 envKeys', Array.isArray(diag.envKeys) && diag.envKeys.includes('TOKEN_A'), JSON.stringify(diag.envKeys))
  check('诊断不含密钥值', !leaks(diag))

  console.log('\n=== 5. 面板打开期间别处新增的变量，保存时不被删掉 ===')
  const waitFor = async (code, ms = 8000) => {
    for (let t = 0; t < ms; t += 150) { if (await js(code)) return true; await sleep(150) }
    return false
  }
  await js(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'2',ctrlKey:true,bubbles:true,cancelable:true}));true`)
  await waitFor(`!!document.querySelector('.svc-row[data-entry-id="e1"]')`)
  await js(`(async()=>{document.querySelector('.svc-row[data-entry-id="e1"]').click();await new Promise(s=>setTimeout(s,300));
    const t=[...document.querySelectorAll('.svc-detail [role="tab"]')].find(x=>x.textContent.includes('配置'));t&&t.click();return true})()`)
  check('前提：配置面板已打开', await waitFor(`!!document.querySelector('.svc-config')`))
  // 面板已挂载之后，从别处（这里直接走 IPC，等价于托盘或另一处编辑）新增一个变量
  await js(`window.mile.entry.edit('e1', { env: { EXT_KEY: 'external' } })`)
  check('前提：外部新增已落盘', disk().env.EXT_KEY === 'external')
  await sleep(300)
  // 只改名称，然后保存
  await js(`(()=>{const i=[...document.querySelectorAll('.svc-config input')].find(x=>x.value==='密钥探针');
    const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,'密钥探针改名');
    i.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
  check('前提：出现保存按钮', await waitFor(`[...document.querySelectorAll('.svc-savebar button')].some(b=>b.textContent.trim()==='保存')`))
  await js(`[...document.querySelectorAll('.svc-savebar button')].find(b=>b.textContent.trim()==='保存').click();true`)
  for (let i = 0; i < 40 && disk().name !== '密钥探针改名'; i++) await sleep(150)
  check('前提：改名已保存', disk().name === '密钥探针改名', disk().name)
  check('外部新增的变量没被删掉', disk().env.EXT_KEY === 'external', JSON.stringify(Object.keys(disk().env)))
  check('原有变量也都在', disk().env.TOKEN_A === SECRET_D && disk().env.TOKEN_C === SECRET_C)

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`)
  }
  app.exit(fail === 0 ? 0 : 1)
})
