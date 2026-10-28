/**
 * M11 验证：添加条目后列表不重复。
 *
 * 这一条必须从 DOM 驱动，不能调 window.mile.entry.add —— 缺陷不在主进程，而在
 * 渲染层 store：EntryService.add 里的 emit('changed') 广播比 invoke 回执先到，
 * store 若无条件 push 就会多出一条，界面上是两张一模一样的卡片，点一下某张卡片
 * 触发下一次广播才收敛回一张。走 preload 通道验不到这个，那条路根本不过 store。
 *
 * 目录选择器由主进程替换掉：真实的 showOpenDialog 是模态原生窗口，harness 点不动。
 * 替换的只是「用户选了哪个目录」，识别、校验、落盘全走真实实现。
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const FIXTURE = join(__dirname, 'fixture')

const SANDBOX = join(tmpdir(), `mile-m11-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
app.setPath('appData', SANDBOX)
const CONFIG = join(SANDBOX, 'mile-terminal', 'config.json')

// 空列表起步，这样「添加一条后应当只有一条」不依赖任何既有条目
writeFileSync(
  CONFIG,
  JSON.stringify({ version: 1, entries: [], ignoredListeners: [], settings: {} }, null, 2),
  'utf8'
)

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
  ipcMain.removeHandler('dialog:pickDirectory')
  ipcMain.handle('dialog:pickDirectory', () => FIXTURE)

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

    /** 按可见文案或 aria-label 点按钮，返回是否点到 —— 点不到要判失败，不能静默跳过 */
    const click = (label) =>
      js(`(() => {
        const b = [...document.querySelectorAll('button')].find((x) =>
          ((x.textContent || '').trim() === ${JSON.stringify(label)}) ||
          x.getAttribute('aria-label') === ${JSON.stringify(label)})
        if (!b) return false
        b.click()
        return true
      })()`)

    /** 轮询到出现为止，不用固定 sleep —— 识别要读磁盘，快慢不定 */
    const waitFor = async (expr, ms = 8000) => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        if (await js(expr)) return true
        await sleep(120)
      }
      return false
    }

    console.log('\n=== 1. 从 DOM 走完整添加流程 ===')
    // UI-REFACTOR 阶段 4：启动台并入服务页，添加对话框改版（选目录是一个大按钮，提交按钮在对话框底部）
    check('切到服务页', await click('服务'))
    await waitFor(`(document.querySelector('main h1')||{}).textContent==='服务'`)
    check('打开添加服务对话框', await click('添加服务'))
    check('对话框已挂载', await waitFor(`!!document.querySelector('.add-dialog[role="dialog"]')`))
    check('触发目录选择', await js(`(()=>{const b=document.querySelector('.add-dialog .add-drop');if(!b)return false;b.click();return true})()`))
    check(
      '识别结果已回填',
      await waitFor(
        `(document.querySelector('[role="dialog"]')||{textContent:''}).textContent.includes('识别结果')`
      )
    )
    // 提交按钮只在对话框底部找，工具条上也有一个「添加服务」
    // 同一帧里连点两次：防重复提交靠同步锁，只点一次测不到
    check('提交（同一帧连点两次）', await js(`(()=>{const b=[...document.querySelectorAll('.add-dialog .add-foot button')].find(x=>x.textContent.trim()==='添加服务');if(!b||b.disabled)return false;b.click();b.click();return true})()`))
    check('对话框已关闭', await waitFor(`!document.querySelector('.add-dialog')`))
    check('添加后自动打开新条目的详情', await waitFor(`!!document.querySelector('.svc-detail') && !!document.querySelector('.svc-row[aria-selected="true"]')`))

    console.log('\n=== 2. 列表里只有一条 ===')
    // 断言带计数，空选择器不能静默通过
    await waitFor(`document.querySelectorAll('.svc-row').length > 0`)
    const cards = await js(`document.querySelectorAll('.svc-row').length`)
    check('服务页只有一行', cards === 1, `rows=${cards}`)

    const head = await js(`(() => {
      const b = [...document.querySelectorAll('[role="radiogroup"][aria-label="类型"] [role="radio"]')]
        .find((x) => (x.textContent || '').trim().startsWith('全部'))
      return b ? b.textContent.trim() : ''
    })()`)
    check('「全部」计数为 1', /^全部\s*1$/.test(head), `head=${JSON.stringify(head)}`)

    const storeIds = await js(`window.mile.entry.list().then((l) => l.map((e) => e.id).join(','))`)
    const ids = storeIds ? storeIds.split(',') : []
    check('主进程侧也只有一条', ids.length === 1, `ids=${ids.length}`)

    const disk = JSON.parse(readFileSync(CONFIG, 'utf8')).entries
    check('磁盘上只有一条', disk.length === 1, `disk=${disk.length}`)
    check('行数与磁盘条数一致', cards === disk.length, `${cards} vs ${disk.length}`)
  } catch (err) {
    console.log('HARNESS ERROR', err)
    fail++
  }

  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`)
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
})
