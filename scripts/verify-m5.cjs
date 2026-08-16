/**
 * M5 验证：诊断面板数据、修复入口、产物目录白名单。
 *
 * 真实主进程 + 真实构建产物，不 mock —— 要证明的是主进程给出的诊断数据准确，
 * 且路径白名单真的挡得住渲染层构造的任意路径。
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, rmSync, existsSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const FIXTURE = join(__dirname, 'fixture')
const TASK_FIXTURE = join(__dirname, 'fixture-task')

// 隔离 appData：绝不覆盖用户真实的 config.json。ConfigStore 从 appData 取路径，
// 在 require 主进程之前改掉即可。
const SANDBOX = join(tmpdir(), `mile-m5-${process.pid}`)
mkdirSync(SANDBOX, { recursive: true })
app.setPath('appData', SANDBOX)

/** 通道名与 src/shared/channels.ts 保持一致，harness 不引 TS 源码 */
const Channels = {
  entryEdit: 'entry:edit',
  entryStart: 'entry:start',
  entryDiagnose: 'entry:diagnose',
  entryOutputDir: 'entry:outputDir',
  entryOpenPackageJson: 'entry:openPackageJson',
  entryRuntimes: 'entry:runtimes'
}

let pass = 0
let fail = 0
function check(label, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`PASS ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail++
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 任务型夹具：跑完即退出，并产出 dist 目录 */
function seedTaskFixture() {
  mkdirSync(TASK_FIXTURE, { recursive: true })
  mkdirSync(join(TASK_FIXTURE, 'node_modules'), { recursive: true })
  writeFileSync(
    join(TASK_FIXTURE, 'package.json'),
    JSON.stringify(
      {
        name: 'mile-fixture-task',
        version: '0.0.0',
        private: true,
        // cancel / boom 供 M8 验任务完成状态。这个夹具由本脚本按内容重建，
        // 漏写一项就会把 M8 依赖的脚本悄悄删掉，表现为「单独跑 M8 好的，跑完全套就红」
        scripts: {
          build: 'node make.cjs',
          lint: 'node -e "0"',
          cancel: 'node cancel.cjs',
          boom: 'node -e "process.exit(2)"'
        }
      },
      null,
      2
    ),
    'utf8'
  )
  // 产物目录由任务自己造，验证「跑完才有产物」
  writeFileSync(
    join(TASK_FIXTURE, 'make.cjs'),
    [
      "const { mkdirSync, writeFileSync } = require('node:fs')",
      "const { join } = require('node:path')",
      "mkdirSync(join(__dirname, 'dist'), { recursive: true })",
      "writeFileSync(join(__dirname, 'dist', 'out.txt'), 'built', 'utf8')",
      "console.log('build done')"
    ].join('\n'),
    'utf8'
  )
  // M8 用它验「130 = 用户取消」，一并在这里造，否则夹具被重建后 M8 找不到脚本
  writeFileSync(
    join(TASK_FIXTURE, 'cancel.cjs'),
    ["console.log('user canceled')", 'process.exit(130)'].join('\n'),
    'utf8'
  )
  rmSync(join(TASK_FIXTURE, 'dist'), { recursive: true, force: true })
}

function seedConfig() {
  const dir = join(app.getPath('appData'), 'mile-terminal')
  mkdirSync(dir, { recursive: true })
  const now = Date.now()
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify(
      {
        version: 1,
        entries: [
          {
            id: 'm5-service',
            kind: 'service',
            name: 'Fixture Dev',
            path: FIXTURE,
            framework: 'node',
            packageManager: 'npm',
            script: 'dev',
            scripts: { dev: 'node server.cjs', 'build & calc.exe': 'echo pwned' },
            env: { MILE_SECRET_TOKEN: 'super-secret-value-do-not-leak' },
            registerOnly: false,
            pinned: false,
            order: 0,
            createdAt: now
          },
          {
            id: 'm5-task',
            kind: 'task',
            name: 'Fixture Build',
            path: TASK_FIXTURE,
            framework: 'node',
            packageManager: 'npm',
            script: 'build',
            scripts: { build: 'node make.cjs', lint: 'node -e "0"' },
            env: {},
            registerOnly: false,
            pinned: false,
            order: 1,
            createdAt: now
          },
          {
            id: 'm5-badscript',
            kind: 'service',
            name: '脚本不存在的条目',
            path: FIXTURE,
            framework: 'node',
            packageManager: 'npm',
            script: 'no-such-script',
            scripts: { dev: 'node server.cjs' },
            env: {},
            registerOnly: false,
            pinned: false,
            order: 2,
            createdAt: now
          }
        ],
        ignoredListeners: [],
        settings: {
          scanIntervalMs: 2000,
          theme: 'dark',
          externalTerminal: 'wt',
          terminalFontSize: 13,
          scrollback: 5000,
          killOwnedOnQuit: true,
          closeToTray: false
        }
      },
      null,
      2
    ),
    'utf8'
  )
}

/** 直接走 ipcMain 注册的 handler，等价于渲染层 invoke */
async function callIpc(channel, ...args) {
  const handler = ipcMain._invokeHandlers.get(channel)
  if (!handler) throw new Error(`没有注册 handler: ${channel}`)
  return await handler({}, ...args)
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await fn()) return true
    } catch {
      /* 还没就绪 */
    }
    await sleep(300)
  }
  console.log(`  (超时 ${timeoutMs}ms 等待 ${label})`)
  return false
}

async function checks(win) {
  console.log('=== 诊断：环境快照只出键名 ===')
  const d1 = await callIpc(Channels.entryDiagnose, 'm5-service')
  check('诊断返回环境变量键名', d1.envKeys.includes('MILE_SECRET_TOKEN'), JSON.stringify(d1.envKeys))
  check(
    '诊断结果不含环境变量的值',
    !JSON.stringify(d1).includes('super-secret-value-do-not-leak'),
    '整个 payload 里搜不到密钥串'
  )
  check('诊断给出 Node 版本', /^\d+\./.test(d1.node), d1.node)
  check(
    '诊断给出包管理器路径',
    typeof d1.packageManagerPath === 'string' && d1.packageManagerPath.length > 0,
    d1.packageManagerPath
  )
  check('未运行过时无退出码', d1.lastExitCode === undefined, String(d1.lastExitCode))
  check('服务型条目不给产物目录', d1.outputDir === null)

  console.log('\n=== 诊断：预检复查随条目状态变化 ===')
  const dBad = await callIpc(Channels.entryDiagnose, 'm5-badscript')
  const scriptItem = dBad.precheck.items.find((i) => i.id === 'script')
  check('脚本缺失项判 fail', scriptItem?.level === 'fail', scriptItem?.detail)
  check(
    '脚本缺失给出「选择其他脚本」入口',
    scriptItem?.fix?.action === 'pickScript',
    scriptItem?.fix?.label
  )

  console.log('\n=== 修复入口：pickScript 写回后预检转 pass ===')
  await callIpc(Channels.entryEdit, 'm5-badscript', { script: 'dev' })
  const dFixed = await callIpc(Channels.entryDiagnose, 'm5-badscript')
  const fixedItem = dFixed.precheck.items.find((i) => i.id === 'script')
  check('改用已声明脚本后转 pass', fixedItem?.level === 'pass', fixedItem?.detail)

  console.log('\n=== 修复入口：resolvePort 写回预期端口 ===')
  await callIpc(Channels.entryEdit, 'm5-service', { expectedPort: 45999 })
  const dPort = await callIpc(Channels.entryDiagnose, 'm5-service')
  check('诊断回报被查询的端口', dPort.port === 45999, String(dPort.port))
  check('空闲端口的 portHolder 为 null', dPort.portHolder === null)

  console.log('\n=== 路径白名单 ===')
  // 不真的调 openPackageJson —— 那会拉起关联编辑器。只验证「不存在的 id 不放行」，
  // 以及白名单函数本身的判定（openPath 的放行逻辑走 knownPath）。
  check(
    '不存在的条目 id 不放行',
    (await callIpc(Channels.entryOpenPackageJson, '不存在的id')) === false
  )

  // outputDir 只接受已登记条目：任意 id 一律 null，等于渲染层拿不到越界路径
  check('未知条目取不到产物目录', (await callIpc(Channels.entryOutputDir, '../../../etc')) === null)

  console.log('\n=== 任务：跑完产出 dist 并可打开 ===')
  const before = await callIpc(Channels.entryOutputDir, 'm5-task')
  check('任务运行前无产物目录', before === null, String(before))

  const started = await callIpc(Channels.entryStart, 'm5-task')
  check('任务启动通过预检', started.ok === true, JSON.stringify(started.precheck.items.filter((i) => i.level === 'fail').map((i) => i.label)))

  const done = await waitFor(
    async () => {
      const rts = await callIpc(Channels.entryRuntimes)
      return rts.find((r) => r.entryId === 'm5-task')?.status === 'succeeded'
    },
    60_000,
    '任务转 succeeded'
  )
  const taskRuntime = (await callIpc(Channels.entryRuntimes)).find((r) => r.entryId === 'm5-task')
  check('任务按退出码转 succeeded', done, JSON.stringify(taskRuntime))

  const after = await callIpc(Channels.entryOutputDir, 'm5-task')
  check('任务成功后探测到 dist', after !== null && after.endsWith('dist'), String(after))
  check('产物目录确实存在于磁盘', !!after && existsSync(after))

  console.log('\n=== 诊断：会话回顾在会话结束后仍可用 ===')
  const dTask = await callIpc(Channels.entryDiagnose, 'm5-task')
  check('会话退出后仍有退出码', dTask.lastExitCode === 0, String(dTask.lastExitCode))
  check('会话退出后仍有运行时长', typeof dTask.lastRunMs === 'number', `${dTask.lastRunMs}ms`)
  check('任务型条目回报产物目录', typeof dTask.outputDir === 'string', String(dTask.outputDir))

  console.log('\n=== 界面：诊断视图渲染五段 ===')
  await waitFor(() => win.webContents.executeJavaScript(`!!document.querySelector('nav')`), 30_000, '外壳挂载')
  const navigated = await win.webContents.executeJavaScript(
    `(() => {
      const b = [...document.querySelector('nav').querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === '诊断');
      if (!b) return false;
      b.click();
      return true;
    })()`,
    true
  )
  check('导航到诊断视图', navigated)

  // 服务型条目只有四段（产物目录对服务无意义），这是设计如此。
  // 先验服务型的四段，再切到任务型条目验第五段 —— 否则「五段」这个断言
  // 会在服务型条目上永远失败，或者被我改成 >=4 而放过真正的缺失。
  const serviceSections = await waitFor(
    () =>
      win.webContents.executeJavaScript(
        `document.querySelectorAll('section[aria-labelledby^="diagnose-"]').length >= 5`,
        true
      ),
    25_000,
    '服务型条目的四段 + 选择器'
  )
  const serviceHeadings = await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('section[aria-labelledby^="diagnose-"] h2')].map((h) => h.textContent.trim())`,
    true
  )
  check('服务型条目渲染四段（无产物目录）', serviceSections, JSON.stringify(serviceHeadings))
  check(
    '服务型条目不出现产物目录段',
    !serviceHeadings.some((h) => h.includes('产物目录')),
    '产物目录只对任务型有意义'
  )

  const bodyText = await win.webContents.executeJavaScript(
    `document.body.textContent.replace(/\\s+/g, ' ')`,
    true
  )
  check('界面展示环境变量键名', bodyText.includes('MILE_SECRET_TOKEN'))
  check('界面不展示环境变量值', !bodyText.includes('super-secret-value-do-not-leak'))
  check('界面标明只显示键名', bodyText.includes('只显示键名'))

  // 切到任务型条目，验第五段真的会出现，且打开按钮带标签
  const switched = await win.webContents.executeJavaScript(
    `(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('Fixture Build'));
      if (!b) return false;
      b.click();
      return true;
    })()`,
    true
  )
  check('切换到任务型条目', switched)

  const taskSections = await waitFor(
    () =>
      win.webContents.executeJavaScript(
        `[...document.querySelectorAll('section[aria-labelledby^="diagnose-"] h2')].some((h) => h.textContent.includes('产物目录'))`,
        true
      ),
    25_000,
    '任务型条目的产物目录段'
  )
  const taskHeadings = await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('section[aria-labelledby^="diagnose-"] h2')].map((h) => h.textContent.trim())`,
    true
  )
  check('任务型条目渲染五段（含产物目录）', taskSections, JSON.stringify(taskHeadings))
  check(
    '界面展示探测到的产物目录路径',
    await win.webContents.executeJavaScript(
      `document.body.textContent.includes('fixture-task\\\\dist')`,
      true
    ),
    String(after)
  )
  check(
    '产物目录有打开入口',
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('button')].some((b) => b.textContent.includes('打开产物目录'))`,
      true
    )
  )

  const clipped = await win.webContents.executeJavaScript(
    `(() => {
      const secs = [...document.querySelectorAll('section[aria-labelledby^="diagnose-"]')];
      return secs.flatMap((s) => [...s.querySelectorAll('*')]).filter((el) => el.scrollWidth > el.clientWidth + 1).length;
    })()`,
    true
  )
  check('诊断区块无文字截断', clipped === 0, `${clipped} 个溢出元素`)

  const unlabeled = await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('button')].filter((b) => !b.getAttribute('aria-label') && !b.textContent.trim() && !b.getAttribute('title')).length`,
    true
  )
  check('图标按钮无 aria-label 缺失', unlabeled === 0, `${unlabeled} 个无标签按钮`)

  console.log(`\n===== M5 结果：PASS ${pass} / FAIL ${fail} =====`)
}

seedTaskFixture()
seedConfig()
require(join(ROOT, 'out/main/index.js'))

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    console.log('FAIL 没有取到窗口')
    app.exit(1)
    return
  }
  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r))
    await sleep(3000)
    await checks(win)
  } catch (err) {
    console.log('HARNESS ERROR', err)
    fail++
  }
  // 沙箱清理是尽力而为：Electron 退出时仍持有 appData 下的缓存句柄，
  // 删不掉会抛 EPERM。它在 tmpdir 里，留着无害，绝不能因此把结果判成失败。
  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`)
  }
  app.exit(fail === 0 ? 0 : 1)
})
