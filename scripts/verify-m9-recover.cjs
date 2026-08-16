/**
 * M9 备份恢复校验，PRD §8。同样要「带着坏文件启动」，所以与只读保护分开进程跑。
 *
 * 场景：主配置写坏了，但上一份良好版本还在 .bak 里。此时必须从 .bak 恢复，
 * 并立刻写回主文件 —— 只在内存里恢复的话，下次启动还得再走一遍这条路，
 * 而那时的 .bak 可能已经被别的写入轮转掉了。
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const FIX = join(__dirname, 'fixture')
const SANDBOX = join(tmpdir(), `mile-m9rec-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
app.setPath('appData', SANDBOX)
const CONFIG = join(SANDBOX, 'mile-terminal', 'config.json')
const BAK = join(SANDBOX, 'mile-terminal', 'config.json.bak')

/* 目标版本号从源码取，不写死 —— 见 verify-m9.cjs 同处注释 */
const CONFIG_VERSION = Number(
  /CONFIG_VERSION\s*=\s*(\d+)/.exec(readFileSync(join(ROOT, 'src/shared/types.ts'), 'utf8'))[1]
)

const now = Date.now()
// 备份里是好的 v1 数据，带一个可辨识的条目名
const GOOD = {
  version: 1,
  entries: [
    {
      id: 'rescued',
      kind: 'service',
      name: '从备份救回的条目',
      path: FIX,
      framework: 'node',
      packageManager: 'npm',
      script: 'dev',
      scripts: { dev: 'node server.cjs' },
      env: {},
      registerOnly: false,
      pinned: false,
      order: 0,
      createdAt: now
    }
  ],
  ignoredListeners: [],
  settings: {
    scanIntervalMs: 2000,
    theme: 'light',
    externalTerminal: 'wt',
    terminalFontSize: 13,
    scrollback: 5000,
    killOwnedOnQuit: true,
    closeToTray: false
  }
}
writeFileSync(CONFIG, '{ "entries": [ { "id": "svc"', 'utf8')
writeFileSync(BAK, JSON.stringify(GOOD, null, 2), 'utf8')

require(join(ROOT, 'out', 'main', 'index.js'))

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

  console.log('\n=== 主配置损坏时从 .bak 恢复，PRD §8 ===')
  const entries = await js(`window.mile.entry.list()`)
  check('用户条目从备份救回来了',
    entries.length === 1 && entries[0].id === 'rescued',
    entries.map((e) => e.name).join(' | ') || '空')

  const settings = await js(`window.mile.settings.get()`)
  check('备份里的用户设置一并恢复', settings.theme === 'light', settings.theme)

  // 恢复后必须立刻写回主文件，否则下次启动还要再赌 .bak 还在
  const disk = JSON.parse(readFileSync(CONFIG, 'utf8'))
  check('恢复内容已写回主配置文件', disk.entries.length === 1 && disk.entries[0].id === 'rescued',
    JSON.stringify(disk.entries.map((e) => e.id)))
  check(`写回时顺带完成 v1 → v${CONFIG_VERSION} 迁移`, disk.version === CONFIG_VERSION,
    `version=${disk.version}`)
  check('迁移补出了 v2 的新字段',
    Array.isArray(disk.groupOverrides) && Array.isArray(disk.watchedKeywords),
    `${JSON.stringify(disk.groupOverrides)} / ${JSON.stringify(disk.watchedKeywords)}`)

  await js(`window.mile.settings.patch({ terminalFontSize: 17 })`)
  await new Promise((r) => setTimeout(r, 600))
  check('恢复后新的写入能落盘',
    JSON.parse(readFileSync(CONFIG, 'utf8')).settings.terminalFontSize === 17,
    String(JSON.parse(readFileSync(CONFIG, 'utf8')).settings.terminalFontSize))

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`)
  }
  app.exit(fail === 0 ? 0 : 1)
})
