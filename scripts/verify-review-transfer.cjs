/**
 * 配置导入导出（2.3.0）。
 *
 * 换机器、重装系统时要能把条目和工作组带走。约定：
 *   1. 导出：主进程弹保存框写 JSON。环境变量只带变量名（值清空），不带自定义图片。
 *   2. 导入：先把当前配置备份成 config.before-import-*.json，再合并：
 *      - 同目录同脚本已登记的条目跳过；目录不存在的跳过并写明原因（新条目照样走 entry:add 校验）
 *      - 工作组按名称合并：已有同名组就复用，没有就新建
 *      - startAfter 按新 id 重新映射（被跳过的重复条目映射到已有条目）
 *      - 忽略规则与关注关键字取并集；设置不覆盖
 *      - 环境变量不写入，结果里列出哪些条目需要重填
 *   3. 格式不对的文件直接拒绝，配置不变；取消选择框返回 null。
 *   4. 渲染层只调无参的 export / import，给不出任何路径。
 *
 * 保存 / 打开对话框用 Module._load 拦截，只换「用户选了哪个文件」。
 *
 *   npm run build
 *   npx electron scripts/verify-review-transfer.cjs
 */
const Module = require('node:module')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const FIX = join(ROOT, 'scripts', 'fixture').replace(/\\/g, '/')
const FIXT = join(ROOT, 'scripts', 'fixture-task').replace(/\\/g, '/')
const SANDBOX = join(tmpdir(), `mile-review-transfer-${process.pid}`)
const DIR = join(SANDBOX, 'mile-terminal')
const CONFIG = join(DIR, 'config.json')
const EXPORT = join(SANDBOX, 'export.json')
const IMPORT = join(SANDBOX, 'import.json')
const NEWPROJ = join(SANDBOX, 'new-proj').replace(/\\/g, '/')

let saveResult = { canceled: false, filePath: EXPORT }
let openResult = { canceled: false, filePaths: [IMPORT] }
const realLoad = Module._load
Module._load = function (request, ...rest) {
  const loaded = realLoad.call(this, request, ...rest)
  if (request !== 'electron') return loaded
  const dialog = new Proxy(loaded.dialog, {
    get: (target, key) => {
      if (key === 'showSaveDialog') return () => Promise.resolve(saveResult)
      if (key === 'showOpenDialog') return () => Promise.resolve(openResult)
      return target[key]
    }
  })
  return new Proxy(loaded, {
    get: (target, key) => (key === 'dialog' ? dialog : target[key]),
    has: (target, key) => key in target
  })
}

const { app, BrowserWindow } = require('electron')
mkdirSync(DIR, { recursive: true })
mkdirSync(NEWPROJ, { recursive: true })
writeFileSync(join(NEWPROJ, 'package.json'), JSON.stringify({ name: 'new-proj', scripts: { dev: 'node x.js' } }), 'utf8')
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)

const now = Date.now()
const SECRET = 'MILE_SECRET_TRANSFER_77aa'
writeFileSync(CONFIG, JSON.stringify({
  version: 12,
  entries: [
    { id: 'e1', kind: 'service', name: '甲服务', path: FIX, framework: 'node', packageManager: 'npm', script: 'dev',
      scripts: { dev: 'node server.cjs' }, env: { SECRET_TOKEN: SECRET }, registerOnly: false, pinned: false, order: 0, createdAt: now, groupId: 'g1' },
    { id: 'e2', kind: 'task', name: '乙任务', path: FIXT, framework: 'node', packageManager: 'npm', script: 'build',
      scripts: { build: 'node make.cjs' }, env: {}, registerOnly: false, pinned: false, order: 1, createdAt: now, groupId: 'g1', startAfter: ['e1'] }
  ],
  groups: [{ id: 'g1', name: '组甲', description: '', env: 'dev', order: 0, createdAt: now }],
  ignoredListeners: [{ processName: 'foo.exe', port: 1234 }],
  groupOverrides: [],
  watchedKeywords: ['ffmpeg'],
  settings: { scanIntervalMs: 2000, theme: 'light', externalTerminal: 'wt', terminalFontSize: 13, scrollback: 5000, killOwnedOnQuit: true, closeToTray: false, notifyOnTaskDone: true, hideFromTaskbar: false, notifyOnCrash: true, notifyOnlyWhenBackground: true, globalHotkey: false }
}, null, 2), 'utf8')

require(join(ROOT, 'out', 'main', 'index.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(name, ok, detail) {
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? ` — ${detail}` : ''}`)
}
const disk = () => JSON.parse(readFileSync(CONFIG, 'utf8'))
const same = (a, b) => String(a || '').replace(/\\/g, '/').toLowerCase() === String(b || '').replace(/\\/g, '/').toLowerCase()

app.whenReady().then(async () => {
  const guard = setTimeout(() => { console.log('  FAIL  超时'); console.log(`\n结果：${pass} 通过，${fail + 1} 失败`); app.exit(1) }, 90000)
  const win = BrowserWindow.getAllWindows()[0]
  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r))
    const js = (code) => win.webContents.executeJavaScript(code, true)
    const call = (m) => js(`(window.mile.config && window.mile.config.${m} ? window.mile.config.${m}() : Promise.reject(new Error('没有 config.${m}'))).then(r => ({ ok: true, r }), e => ({ ok: false, error: String(e) }))`)

    console.log('\n=== 1. 导出 ===')
    const ex = await call('export')
    check('导出成功', ex.ok && ex.r && same(ex.r.path, EXPORT), JSON.stringify(ex))
    const raw = existsSync(EXPORT) ? readFileSync(EXPORT) : Buffer.alloc(0)
    check('无 BOM', raw.length > 0 && !(raw[0] === 0xef && raw[1] === 0xbb))
    const file = raw.length ? JSON.parse(raw.toString('utf8')) : {}
    check('带格式标记', file.format === 'mile-terminal-export', file.format)
    check('两个条目、一个组都在', (file.entries || []).length === 2 && (file.groups || []).length === 1)
    check('环境变量的值没导出', !raw.toString('utf8').includes(SECRET))
    check('环境变量名还在', (file.entries || []).some((e) => e.env && 'SECRET_TOKEN' in e.env))
    check('关注关键字与忽略规则在', JSON.stringify(file.watchedKeywords) === '["ffmpeg"]' && (file.ignoredListeners || []).length === 1)

    console.log('\n=== 2. 导入合并 ===')
    const before = readFileSync(CONFIG, 'utf8')
    const imp = JSON.parse(JSON.stringify(file))
    imp.groups.push({ id: 'gx', name: '组乙', description: '', env: 'sandbox', order: 1, createdAt: now })
    imp.entries.push(
      { id: 'n1', kind: 'service', name: '新服务', path: NEWPROJ, framework: 'node', packageManager: 'npm', script: 'dev',
        scripts: { dev: 'node x.js' }, env: { API_KEY: '' }, registerOnly: false, pinned: false, order: 2, createdAt: now, groupId: 'gx', startAfter: [file.entries[0].id] },
      { id: 'n2', kind: 'service', name: '目录不在了', path: join(SANDBOX, 'gone').replace(/\\/g, '/'), framework: 'node', packageManager: 'npm', script: null,
        scripts: {}, env: {}, registerOnly: true, pinned: false, order: 3, createdAt: now }
    )
    imp.ignoredListeners.push({ processName: 'foo.exe', port: 1234 }, { processName: 'bar.exe', port: 80 })
    imp.watchedKeywords.push('redis')
    imp.settings = { ...imp.settings, theme: 'dark' }
    writeFileSync(IMPORT, JSON.stringify(imp), 'utf8')

    const im = await call('import')
    check('导入成功', im.ok && im.r, JSON.stringify(im).slice(0, 300))
    const r = im.r || {}
    const backups = readdirSync(DIR).filter((n) => /^config\.before-import-.*\.json$/.test(n))
    check('导入前留了备份', backups.length === 1 && readFileSync(join(DIR, backups[0]), 'utf8') === before, backups.join(','))
    check('结果写明备份位置', !!r.backup && backups.length === 1 && r.backup.endsWith(backups[0]), r.backup)
    const d = disk()
    const n1 = d.entries.find((e) => e.name === '新服务')
    const gB = d.groups.find((g) => g.name === '组乙')
    check('新条目加进来了', !!n1)
    check('新组建出来了', !!gB && gB.env === 'sandbox')
    check('同名组没重复建', d.groups.filter((g) => g.name === '组甲').length === 1)
    check('新条目归进新组', !!n1 && !!gB && n1.groupId === gB.id)
    check('startAfter 映射到已有的甲服务', !!n1 && JSON.stringify(n1.startAfter) === '["e1"]', n1 && JSON.stringify(n1.startAfter))
    check('同目录同脚本的条目没重复加', d.entries.filter((e) => same(e.path, FIX)).length === 1 && d.entries.filter((e) => same(e.path, FIXT)).length === 1)
    check('目录不存在的被跳过并写明原因', (r.skipped || []).some((s) => s.name === '目录不在了' && /目录/.test(s.reason)), JSON.stringify(r.skipped))
    check('重复的也在跳过列表里', (r.skipped || []).some((s) => s.name === '甲服务'), JSON.stringify(r.skipped))
    check('环境变量没写入', !!n1 && Object.keys(n1.env || {}).length === 0)
    check('结果列出要重填变量的条目', (r.envToRefill || []).some((x) => x.name === '新服务' && x.keys.includes('API_KEY')), JSON.stringify(r.envToRefill))
    check('原有条目的密钥还在', d.entries.find((e) => e.id === 'e1').env.SECRET_TOKEN === SECRET)
    check('忽略规则取并集', d.ignoredListeners.length === 2)
    check('关注关键字取并集', d.watchedKeywords.includes('ffmpeg') && d.watchedKeywords.includes('redis'), JSON.stringify(d.watchedKeywords))
    check('设置没被覆盖', d.settings.theme === 'light', d.settings.theme)
    check('界面列表收到新条目', await js(`window.mile.entry.list().then(l => l.some(e => e.name === '新服务'))`))

    console.log('\n=== 3. 坏文件与取消 ===')
    const snap = readFileSync(CONFIG, 'utf8')
    writeFileSync(IMPORT, JSON.stringify({ hello: 'world' }), 'utf8')
    const bad = await call('import')
    check('格式不对被拒', !bad.ok && /格式|不是/.test(bad.error), bad.error)
    writeFileSync(IMPORT, '{ not json', 'utf8')
    const bad2 = await call('import')
    check('JSON 坏了被拒', !bad2.ok, bad2.error)
    check('被拒后配置没变', readFileSync(CONFIG, 'utf8') === snap)
    openResult = { canceled: true, filePaths: [] }
    const cancel = await call('import')
    check('取消导入返回 null', cancel.ok && cancel.r === null, JSON.stringify(cancel))
    saveResult = { canceled: true }
    const cancel2 = await call('export')
    check('取消导出返回 null', cancel2.ok && cancel2.r === null, JSON.stringify(cancel2))

    console.log('\n=== 4. 设置页入口 ===')
    await js(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'4',ctrlKey:true,bubbles:true,cancelable:true}));true`)
    await sleep(600)
    check('设置页有导出与导入按钮', await js(`!!document.querySelector('[data-config-export]') && !!document.querySelector('[data-config-import]')`))
  } catch (err) {
    console.log('HARNESS ERROR', err)
    fail++
  }
  clearTimeout(guard)
  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`) }
  app.exit(fail === 0 ? 0 : 1)
})
