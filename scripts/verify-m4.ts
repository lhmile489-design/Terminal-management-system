import { app } from 'electron'
import type { EntryRuntime } from '../src/shared/types'
import { ConfigStore } from '../src/main/services/ConfigStore'
import { OwnershipService } from '../src/main/services/OwnershipService'
import { ScannerService } from '../src/main/services/ScannerService'
import { SessionService } from '../src/main/services/SessionService'
import { DetectService } from '../src/main/services/DetectService'
import { EntryService } from '../src/main/services/EntryService'
import { satisfies } from '../src/main/lib/semver'
import { readListenPorts } from '../src/main/lib/winProcess'

import { join } from 'node:path'

const WEB = 'E:\\WebApp'
const VUE_VITE = `${WEB}\\Elaina-website-project\\Elaina-admin-project`
const NEXT = `${WEB}\\lhmile-website-project\\lhmile_blog_react`
const REACT_VITE = `${WEB}\\new-web-app\\milestar-website`
const NO_DEPS = `${WEB}\\kimi-k3`
/** 受控夹具：engines 必然不符、含恶意脚本名、dev server 绑 IPv4 并可被树终止 */
const FIXTURE = join(__dirname, 'fixture')
/** monorepo 根：有 packageManager 字段、无 dev 脚本 */
const MONO = join(__dirname, 'fixture-mono')

let pass = 0
let fail = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++
    console.log(`PASS ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail++
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(
  label: string,
  predicate: () => boolean,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(250)
  }
  console.log(`  (超时 ${timeoutMs}ms 等待 ${label})`)
  return false
}

async function main(): Promise<void> {
  console.log('=== semver（engines.node 比对，不 spawn node）===')
  check('20.19.0 不满足 >=22.12.0', satisfies('20.19.0', '>=22.12.0') === false)
  check('22.20.1 满足 >=22.12.0', satisfies('22.20.1', '>=22.12.0') === true)
  check(
    '20.19.0 不满足 ^22.18.0 || >=24.12.0',
    satisfies('20.19.0', '^22.18.0 || >=24.12.0') === false
  )
  check(
    '22.20.0 满足 ^22.18.0 || >=24.12.0',
    satisfies('22.20.0', '^22.18.0 || >=24.12.0') === true
  )
  check(
    '20.19.0 满足 ^20.19.0 || >=22.12.0',
    satisfies('20.19.0', '^20.19.0 || >=22.12.0') === true
  )
  check('无法解析时返回 null', satisfies('20.19.0', 'garbage') === null)

  console.log('\n=== DetectService（只读识别）===')
  const detect = new DetectService()

  const vue = await detect.detect(VUE_VITE)
  check('Vue+Vite 框架识别', vue.framework === 'vue-vite', vue.framework)
  check('Vue+Vite dev 脚本', vue.devScript === 'dev', String(vue.devScript))
  check('Vue+Vite 包管理器（package-lock → npm）', vue.packageManager === 'npm', vue.packageManager)
  check('scripts 快照非空', Object.keys(vue.scripts).length > 5, `${Object.keys(vue.scripts).length} 项`)

  const next = await detect.detect(NEXT)
  check('Next.js 优先于 react', next.framework === 'next', next.framework)

  const react = await detect.detect(REACT_VITE)
  check('React+Vite 框架识别', react.framework === 'react-vite', react.framework)
  check('build 脚本推断', react.buildScript === 'build', String(react.buildScript))

  const noPkg = await detect.detect('E:\\WebApp\\__不存在的目录__')
  check('无 package.json → registerOnly', noPkg.registerOnly && noPkg.framework === 'unknown')

  const noDeps = await detect.detect(NO_DEPS)
  check('无前端依赖 → node', noDeps.framework === 'node', noDeps.framework)
  check(
    'start 脚本可作 dev 候选（PRD §8.3 顺序）',
    noDeps.devScript === 'start' && noDeps.monorepoHint === false,
    `devScript=${noDeps.devScript}`
  )

  const mono = await detect.detect(MONO)
  check('monorepo 根无 dev 脚本 → monorepoHint 且不猜测', mono.monorepoHint && mono.devScript === null)
  check('packageManager 字段优先于锁文件', mono.packageManager === 'pnpm', mono.packageManager)
  check('给出指定子包的提示', mono.warnings.some((w) => w.includes('monorepo')), mono.warnings.join(' / '))

  console.log('\n=== 装配主进程服务 ===')
  const config = new ConfigStore()
  // 从干净状态开始，避免上次运行残留条目干扰
  config.patch({ entries: [] })

  const ownership = new OwnershipService()
  const sessions = new SessionService(ownership)
  const scanner = new ScannerService(ownership, config)
  const entries = new EntryService(config, detect, sessions, scanner, ownership)
  scanner.setExpectationSource(() => entries.expectations())
  scanner.start()

  await waitFor('首次采集', () => scanner.snapshot() !== null, 40_000)
  check('采集产出快照', scanner.snapshot() !== null, `${scanner.snapshot()?.listeners.length} 个监听进程`)

  console.log('\n=== EntryService CRUD 与持久化 ===')
  const svc = entries.add({
    kind: 'service',
    name: 'Elaina Admin',
    path: VUE_VITE,
    framework: vue.framework,
    packageManager: vue.packageManager,
    script: vue.devScript,
    scripts: vue.scripts,
    env: {},
    registerOnly: false,
    pinned: false
  })
  check('新增条目', entries.list().length === 1 && entries.list()[0].id === svc.id)

  const task = entries.add({
    kind: 'task',
    name: 'Milestar 打包',
    path: REACT_VITE,
    framework: react.framework,
    packageManager: react.packageManager,
    script: react.buildScript,
    scripts: react.scripts,
    env: {},
    registerOnly: false,
    pinned: false
  })
  check('新增任务条目', entries.list().length === 2)

  entries.update(svc.id, { pinned: true })
  check('置顶排在前', entries.list()[0].id === svc.id)
  entries.update(svc.id, { pinned: false })

  entries.reorder([task.id, svc.id])
  check('重排生效', entries.list()[0].id === task.id, entries.list().map((e) => e.name).join(' | '))
  entries.reorder([svc.id, task.id])

  check('持久化到磁盘', new ConfigStore().get().entries.length === 2)

  // 夹具的 scripts 里**确实声明**了 "build & calc.exe"，所以预检会放行，
  // 拦截必须由 spawn 前的字符白名单完成 —— 这正是要验证的那一层。
  const evil = entries.add({
    kind: 'task',
    name: '注入尝试',
    path: FIXTURE,
    framework: 'node',
    packageManager: 'npm',
    script: 'build & calc.exe',
    scripts: { 'build & calc.exe': 'echo pwned' },
    env: {},
    registerOnly: false,
    pinned: false
  })
  const evilPre = await entries.runPrecheck(evil.id)
  check('恶意脚本名已声明时预检放行（拦截靠白名单）', evilPre.items.find((i) => i.id === 'script')?.level === 'pass')

  let injectionBlocked = false
  let injectionMessage = ''
  try {
    await entries.start(evil.id)
  } catch (err) {
    injectionBlocked = true
    injectionMessage = (err as Error).message
  }
  check('拒绝含 & 的脚本名（命令注入防护）', injectionBlocked, injectionMessage)

  // 条目里声明了、磁盘 package.json 里没有 —— 预检这一层就该拦住
  entries.update(evil.id, { script: 'nonexistent', scripts: { nonexistent: 'echo x' } })
  const undeclared = await entries.start(evil.id)
  check(
    '拒绝未在磁盘 package.json 声明的脚本',
    undeclared.ok === false &&
      undeclared.precheck.items.find((i) => i.id === 'script')?.level === 'fail'
  )
  entries.remove(evil.id)

  console.log('\n=== PrecheckService ===')
  const vuePre = await entries.runPrecheck(svc.id)
  console.log(
    vuePre.items.map((i) => `  [${i.level}] ${i.label}${i.detail ? ` — ${i.detail}` : ''}`).join('\n')
  )
  check('预检 9 项齐备', vuePre.items.length === 9, `${vuePre.items.length} 项`)
  check('可启动项目预检通过', vuePre.ok === true)

  // 夹具声明 engines.node >=99.0.0，必然不满足 —— 这是 warn 不是 fail，不该阻止启动
  const engineEntry = entries.add({
    kind: 'service',
    name: 'engines 不符',
    path: FIXTURE,
    framework: 'node',
    packageManager: 'npm',
    script: 'dev',
    scripts: { dev: 'node server.cjs' },
    env: {},
    registerOnly: false,
    pinned: false
  })
  const enginePre = await entries.runPrecheck(engineEntry.id)
  const nodeItem = enginePre.items.find((i) => i.id === 'node')
  check(
    'engines.node 不符出 warn 而非 fail',
    nodeItem?.level === 'warn',
    `${nodeItem?.detail}`
  )
  check('warn 不阻止启动', enginePre.ok === true)
  check(
    'Node 版本不符给出查看要求入口',
    nodeItem?.fix?.action === 'showNodeRequirement',
    nodeItem?.fix?.label
  )
  entries.remove(engineEntry.id)

  const broken = entries.add({
    kind: 'service',
    name: '目录不存在',
    path: 'E:\\WebApp\\__不存在的目录__',
    framework: 'unknown',
    packageManager: 'npm',
    script: 'dev',
    scripts: {},
    env: {},
    registerOnly: false,
    pinned: false
  })
  const brokenPre = await entries.runPrecheck(broken.id)
  check(
    '目录不存在 → fail 且短路',
    !brokenPre.ok && brokenPre.items.length === 1 && brokenPre.items[0].level === 'fail'
  )
  check(
    '给出重新选择目录的修复入口',
    brokenPre.items[0].fix?.action === 'pickDirectory',
    brokenPre.items[0].fix?.label
  )
  entries.remove(broken.id)

  const noNm = entries.add({
    kind: 'task',
    name: '依赖未安装',
    path: NO_DEPS,
    framework: 'node',
    packageManager: 'npm',
    script: 'build',
    scripts: noDeps.scripts,
    env: {},
    registerOnly: false,
    pinned: false
  })
  const noNmPre = await entries.runPrecheck(noNm.id)
  const nmItem = noNmPre.items.find((i) => i.id === 'nodeModules')
  check('node_modules 缺失 → fail', nmItem?.level === 'fail')
  check(
    '不自动安装，给显式安装会话入口',
    nmItem?.fix?.action === 'createInstallSession',
    nmItem?.fix?.label
  )
  const blockedStart = await entries.start(noNm.id)
  check('预检不通过则不启动', blockedStart.ok === false)
  check('状态转 blocked', entries.runtimeList().find((r) => r.entryId === noNm.id)?.status === 'blocked')
  entries.remove(noNm.id)

  console.log('\n=== 启动服务与端口捕获 ===')
  const live = entries.add({
    kind: 'service',
    name: 'Fixture Dev',
    path: FIXTURE,
    framework: 'node',
    packageManager: 'npm',
    script: 'dev',
    scripts: { dev: 'node server.cjs' },
    env: {},
    registerOnly: false,
    pinned: false
  })
  const started = await entries.start(live.id)
  check('启动返回 ok', started.ok === true)
  const runtime = (): EntryRuntime | undefined =>
    entries.runtimeList().find((r) => r.entryId === live.id)
  check('会话已创建', !!runtime()?.sessionId, `pid ${runtime()?.pid}`)

  await waitFor('端口捕获', () => runtime()?.port !== undefined, 60_000)
  const port = runtime()?.port
  check('从输出流捕获端口（Local: 行带 ANSI）', typeof port === 'number', port ? `:${port}` : '未捕获')
  check('状态转 running', runtime()?.status === 'running', runtime()?.status)

  if (port) {
    const listening = await readListenPorts()
    check(
      '端口确实在监听',
      listening.some((l) => l.port === port),
      `netstat 命中 ${listening.filter((l) => l.port === port).length} 行`
    )
    check('expectedPort 已写回条目', entries.get(live.id)?.expectedPort === port)
  }

  console.log('\n=== IPv6-only 监听可见性（netstat -p TCP 只出 IPv4 的回归防护）===')
  const v6 = await readListenPorts()
  check(
    '采集覆盖 IPv6 监听',
    v6.length > 0,
    `共 ${v6.length} 个 (pid, port)`
  )

  console.log('\n=== 归属与监听表联动 ===')
  scanner.refresh()
  await waitFor(
    '监听表出现受控行',
    () => (scanner.snapshot()?.listeners ?? []).some((l) => l.ownership === 'owned'),
    30_000
  )
  const ownedRows = (scanner.snapshot()?.listeners ?? []).filter((l) => l.ownership === 'owned')
  check('dev server 判为 owned', ownedRows.length > 0, `${ownedRows.length} 行`)
  check(
    '受控行回填 entryId',
    ownedRows.some((l) => l.entryId === live.id),
    ownedRows.map((l) => `${l.pid}:${l.entryId ?? '—'}`).join(' ')
  )

  const externalRows = (scanner.snapshot()?.listeners ?? []).filter((l) => l.ownership === 'external')
  check('外部进程仍判 external', externalRows.length > 0, `${externalRows.length} 行`)

  console.log('\n=== portConflicts（M3 遗留）===')
  const conflictEntry = entries.add({
    kind: 'service',
    name: '端口冲突探测',
    path: REACT_VITE,
    framework: 'react-vite',
    packageManager: 'npm',
    script: 'dev',
    scripts: react.scripts,
    env: {},
    // 指向正在被上面那个服务占用的端口
    expectedPort: port,
    registerOnly: false,
    pinned: false
  })
  scanner.refresh()
  await waitFor('冲突计数刷新', () => (scanner.snapshot()?.portConflicts ?? 0) > 0, 20_000)
  check(
    'portConflicts 不再恒为 0',
    (scanner.snapshot()?.portConflicts ?? 0) > 0,
    `portConflicts=${scanner.snapshot()?.portConflicts}`
  )
  const conflictPre = await entries.runPrecheck(conflictEntry.id)
  const portItem = conflictPre.items.find((i) => i.id === 'port')
  check('预检报出端口被占用', portItem?.level === 'warn', portItem?.detail)
  check('占用者受控时给「停止它」', portItem?.fix?.action === 'resolvePort', portItem?.fix?.label)
  entries.remove(conflictEntry.id)

  console.log('\n=== 拒绝终止外部进程 ===')
  const victim = externalRows[0]
  if (victim) {
    let refused = false
    let refuseMessage = ''
    try {
      const table = await scanner.table([victim.pid])
      await ownership.assertKillable(victim.pid, table)
    } catch (err) {
      refused = true
      refuseMessage = (err as Error).message
    }
    check('assertKillable 拒绝 external', refused, refuseMessage)
  } else {
    check('assertKillable 拒绝 external', false, '本机无外部监听进程可测')
  }

  console.log('\n=== 停止与端口释放 ===')
  await entries.stop(live.id)
  await waitFor(
    '会话退出',
    () => {
      const st = runtime()?.status
      return st === 'stopped' || st === 'crashed'
    },
    20_000
  )
  check('停止后状态收敛', ['stopped', 'crashed'].includes(runtime()?.status ?? ''), runtime()?.status)

  if (port) {
    let released = false
    for (let i = 0; i < 24; i++) {
      const rows = await readListenPorts()
      if (!rows.some((l) => l.port === port)) {
        released = true
        break
      }
      await sleep(500)
    }
    check('端口随进程树释放', released, `:${port}`)
  }

  console.log('\n=== 重启（停止 → 等端口释放 → 启动）===')
  const restarted = await entries.restart(live.id)
  check('重启返回 ok', restarted.ok === true)
  await waitFor('重启后重新捕获端口', () => runtime()?.port !== undefined, 60_000)
  check('重启后回到 running', runtime()?.status === 'running', runtime()?.status)
  check('重启后端口有值', typeof runtime()?.port === 'number', `:${runtime()?.port}`)
  await entries.stop(live.id)
  await waitFor('重启后停止', () => !['running', 'starting', 'stopping'].includes(runtime()?.status ?? ''), 20_000)

  console.log('\n=== 诊断面板 ===')
  const diag = await entries.diagnose(svc.id)
  check('诊断含预检复查', diag.precheck.items.length > 0, `${diag.precheck.items.length} 项`)
  check('诊断含 Node 版本', diag.node === process.versions.node, diag.node)
  check('envKeys 只含键名', Array.isArray(diag.envKeys))

  const tokenLeak = JSON.stringify(entries.list()) + JSON.stringify(entries.runtimeList())
  check('条目与运行态不含 runToken', !/runToken|MILE_RUN_TOKEN/.test(tokenLeak))

  console.log('\n=== 清理 ===')
  scanner.stop()
  sessions.disposeAll()
  config.patch({ entries: [] })
  check('清理后配置为空', new ConfigStore().get().entries.length === 0)

  console.log(`\n===== 结果：PASS ${pass} / FAIL ${fail} =====`)
  app.exit(fail === 0 ? 0 : 1)
}

app.whenReady().then(() => {
  main().catch((err) => {
    console.log('HARNESS ERROR', err)
    app.exit(1)
  })
})
