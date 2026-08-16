/**
 * M9 只读保护校验，PRD §8。单独一个进程跑，因为它要的是「带着坏文件启动」——
 * 判定发生在 ConfigStore 构造时，主进程起来之后再改文件已经晚了。
 *
 * 验的是最坏情况下的取舍：主配置和 .bak 都读不出来时，宁可这一次运行不落盘，
 * 也不能拿空配置去覆盖用户原来的条目。用户的数据可能还救得回来，覆盖了就没了。
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const SANDBOX = join(tmpdir(), `mile-m9ro-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
app.setPath('appData', SANDBOX)
const CONFIG = join(SANDBOX, 'mile-terminal', 'config.json')
const BAK = join(SANDBOX, 'mile-terminal', 'config.json.bak')

// 两份都写成解析不出来的内容：截断的 JSON 是真实的断电/写盘中断留下的样子
const BROKEN = '{ "version": 2, "entries": [ { "id": "svc", "na'
const BROKEN_BAK = 'not json at all'
writeFileSync(CONFIG, BROKEN, 'utf8')
writeFileSync(BAK, BROKEN_BAK, 'utf8')

require(join(ROOT, 'out', 'main', 'index.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) {
    pass++
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  const js = (code) => win.webContents.executeJavaScript(code, true)

  console.log('\n=== 主配置与备份都损坏时进入只读保护，PRD §8 ===')
  // 应用本身要能起来：拒绝启动只会让用户连修的入口都没有
  check('应用仍然正常启动', !!win, '窗口已加载')
  const entries = await js(`window.mile.entry.list()`)
  check('本次运行以空配置在内存里工作', Array.isArray(entries) && entries.length === 0,
    `${entries.length} 条`)

  // 关键：写入路径必须整条哑掉，而不是「先失败一次再覆盖」
  await js(`window.mile.settings.patch({ terminalFontSize: 19 }).catch(()=>null)`)
  await sleep(600)
  await js(`window.mile.scanner.setWatchedKeywords(['ffmpeg']).catch(()=>null)`)
  await sleep(600)

  check('损坏的主配置未被覆盖（原始字节保留）',
    readFileSync(CONFIG, 'utf8') === BROKEN,
    JSON.stringify(readFileSync(CONFIG, 'utf8').slice(0, 40)))
  check('损坏的备份未被覆盖', readFileSync(BAK, 'utf8') === BROKEN_BAK,
    readFileSync(BAK, 'utf8').slice(0, 40))

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`)
  }
  app.exit(fail === 0 ? 0 : 1)
})
