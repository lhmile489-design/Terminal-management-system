/**
 * 服务页键盘约定（2026-10-27 审查修复）。
 *
 * Ctrl+Tab 切详情标签，但焦点在输入框里时必须让给输入框：以前 typing 判断排在
 * Ctrl+Tab 分支之后，配置表单里按 Ctrl+Tab 会被吃掉并切走标签。
 *
 * 先验前提：焦点不在输入框时 Ctrl+Tab 确实能切标签 —— 否则「输入框里没切」
 * 可能只是因为快捷键整个失效了。
 *
 *   npm run build
 *   npx electron scripts/verify-review-keys.cjs
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const SANDBOX = join(tmpdir(), `mile-review-keys-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)

const FIX = join(ROOT, 'scripts', 'fixture').replace(/\\/g, '/')
writeFileSync(
  join(SANDBOX, 'mile-terminal', 'config.json'),
  JSON.stringify({
    version: 1,
    entries: [{
      id: 'a', kind: 'service', name: '键盘探针服务', path: FIX, framework: 'node', packageManager: 'npm',
      script: 'dev', scripts: { dev: 'node server.cjs' }, env: {}, registerOnly: false, pinned: false, order: 0, createdAt: Date.now()
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

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  win.setBounds({ width: 1280, height: 800 })
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const waitFor = async (code, ms = 6000) => {
    for (let t = 0; t < ms; t += 100) { if (await js(code)) return true; await sleep(100) }
    return false
  }
  const activeTab = () => js(`(document.querySelector('.svc-detail [role="tab"][aria-selected="true"]')||{textContent:''}).textContent.trim()`)
  /** 从 target 派发 Ctrl+Tab，返回是否被 preventDefault */
  const ctrlTab = (targetExpr) => js(`(()=>{const t=${targetExpr};if(!t)return null;
    const ev=new KeyboardEvent('keydown',{key:'Tab',ctrlKey:true,bubbles:true,cancelable:true});
    t.dispatchEvent(ev);return ev.defaultPrevented})()`)

  await waitFor(`!!document.querySelector('nav[aria-label="主导航"]')`, 30000)
  await js(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'2',ctrlKey:true,bubbles:true,cancelable:true}));true`)
  await waitFor(`(document.querySelector('main h1')||{}).textContent==='服务'`)
  await waitFor(`!!document.querySelector('[data-entry-id="a"]')`)
  await js(`document.querySelector('[data-entry-id="a"]').click();true`)
  check('前提：详情已打开', await waitFor(`!!document.querySelector('.svc-detail [role="tab"]')`))

  console.log('\n=== 1. 焦点不在输入框：Ctrl+Tab 切标签 ===')
  await js(`document.activeElement&&document.activeElement.blur();true`)
  const before = await activeTab()
  const prevented = await ctrlTab('document.body')
  await sleep(150)
  const after = await activeTab()
  check('前提：Ctrl+Tab 从页面上切了标签', prevented === true && before !== after, `${before} → ${after}`)

  console.log('\n=== 2. 焦点在配置表单输入框：Ctrl+Tab 让给输入框 ===')
  const clicked = await js(`(()=>{const t=[...document.querySelectorAll('.svc-detail [role="tab"]')].find(x=>x.textContent.trim()==='配置');if(!t)return false;t.click();return true})()`)
  check('点到了「配置」标签', clicked)
  const hasInput = await waitFor(`!!document.querySelector('.svc-detail input:not([type="checkbox"]):not([disabled])')`)
  check('前提：配置表单里有可编辑输入框', hasInput)
  await js(`document.querySelector('.svc-detail input:not([type="checkbox"]):not([disabled])').focus();true`)
  const tabBefore = await activeTab()
  const inInput = await ctrlTab(`document.querySelector('.svc-detail input:not([type="checkbox"]):not([disabled])')`)
  await sleep(150)
  const tabAfter = await activeTab()
  check('输入框里的 Ctrl+Tab 没被 preventDefault', inInput === false, String(inInput))
  check('输入框里的 Ctrl+Tab 没有切走标签', tabBefore === '配置' && tabAfter === '配置', `${tabBefore} → ${tabAfter}`)

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`)
  }
  app.exit(fail === 0 ? 0 : 1)
})
