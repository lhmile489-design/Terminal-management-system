/**
 * 一次性冒烟验证：技术栈 tab + 卡片/列表视图切换。用完即删。
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const FIXTURE = join(__dirname, 'fixture')
const SANDBOX = join(tmpdir(), `mile-uitab-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
app.setPath('appData', SANDBOX)

const now = Date.now()
const mk = (id, name, framework, kind) => ({
  id, kind, name, path: FIXTURE, framework, packageManager: 'npm',
  script: kind === 'service' ? 'dev' : 'build',
  scripts: { dev: 'x', build: 'x' }, env: {}, registerOnly: false,
  pinned: false, order: 0, createdAt: now
})

writeFileSync(
  join(SANDBOX, 'mile-terminal', 'config.json'),
  JSON.stringify({
    version: 1,
    entries: [
      mk('a', 'React 服务', 'react-vite', 'service'),
      mk('b', 'React CRA 任务', 'react-cra', 'task'),
      mk('c', 'Vue 服务', 'vue-vite', 'service'),
      mk('d', 'Spring 服务', 'spring-boot', 'service'),
      mk('e', 'Node 服务', 'node', 'service')
    ],
    ignoredListeners: [], settings: {}
  }, null, 2),
  'utf8'
)

require(join(ROOT, 'out', 'main', 'index.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  win.setBounds({ width: 1500, height: 940 })
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const click = (label) => js(`(() => {
    const b=[...document.querySelectorAll('button')].find(x=>((x.textContent||'').trim()===${JSON.stringify(label)})||x.getAttribute('aria-label')===${JSON.stringify(label)}||x.getAttribute('data-stack-tab')===${JSON.stringify(label)});
    if(!b)return false; b.click(); return true; })()`)
  const waitFor = async (expr, ms=8000) => {
    const d=Date.now()+ms; while(Date.now()<d){ if(await js(expr))return true; await sleep(120)} return false }

  try {
    check('切到启动台', await click('启动台'))
    check('卡片渲染', await waitFor(`document.querySelectorAll('article[data-entry-id]').length >= 3`))

    console.log('\n=== 技术栈 tab 自动生成 ===')
    const tabLabels = await js(`[...document.querySelectorAll('[data-stack-tab]')].map(x=>x.getAttribute('data-stack-tab'))`)
    console.log('  tabs =', JSON.stringify(tabLabels))
    check('有 React tab', tabLabels.includes('React'))
    check('有 Vue tab', tabLabels.includes('Vue'))
    check('有 Java tab', tabLabels.includes('Java'))
    check('有 Node tab', tabLabels.includes('Node'))
    check('react-vite 与 react-cra 归并为一个 React tab', tabLabels.filter(t=>t==='React').length === 1)

    console.log('\n=== 点 React tab 筛选 ===')
    check('点击 React tab', await click('React'))
    await sleep(300)
    const afterReact = await js(`[...document.querySelectorAll('[data-entry-id]')].map(x=>x.getAttribute('data-entry-id')).sort().join(',')`)
    console.log('  可见条目 =', afterReact)
    check('只剩 React 的两个条目(a,b)', afterReact === 'a,b', afterReact)

    console.log('\n=== 点 Java tab 筛选 ===')
    check('点击 Java tab', await click('Java'))
    await sleep(300)
    const afterJava = await js(`[...document.querySelectorAll('[data-entry-id]')].map(x=>x.getAttribute('data-entry-id')).join(',')`)
    check('只剩 Spring 条目(d)', afterJava === 'd', afterJava)

    console.log('\n=== 回到全部 + 列表视图切换 ===')
    check('点全部', await click('全部'))
    await sleep(200)
    check('切列表视图', await click('列表视图'))
    check('列表容器出现', await waitFor(`document.querySelectorAll('[data-entry-list]').length > 0`))
    const rows = await js(`document.querySelectorAll('[data-entry-row]').length`)
    check('列表行渲染(应为5)', rows === 5, `rows=${rows}`)
    check('卡片网格已消失', await js(`document.querySelectorAll('article[data-entry-id]').length === 0`))

    check('切回卡片视图', await click('卡片视图'))
    await sleep(200)
    check('卡片重新出现', await js(`document.querySelectorAll('article[data-entry-id]').length === 5`))
  } catch (err) {
    console.log('HARNESS ERROR', err)
    fail++
  }

  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch {}
  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
})
