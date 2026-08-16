import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join, relative, isAbsolute, resolve } from 'node:path'
import {
  SERVICE_ICON_IDS,
  type EditableEntryField,
  type EntryDiagnosis,
  type EntryEdit,
  type EntryRuntime,
  type EntryStartResult,
  type EntryStatus,
  type Framework,
  type LaunchEntry,
  type NewLaunchEntry,
  type PackageManager,
  type PortHolder,
  type PrecheckResult,
  type ServiceIcon
} from '@shared/types'
import { readListenPorts, type ListenRow } from '../lib/winProcess'
import type { ConfigStore } from './ConfigStore'
import type { DetectService } from './DetectService'
import { PrecheckService, resolveCwd, whichAny } from './PrecheckService'
import type { EntryExpectation, ScannerService } from './ScannerService'
import type { SessionService } from './SessionService'
import type { OwnershipService } from './OwnershipService'

/** 端口捕获正则，PRD §8.4 */
const PORT_PATTERNS = [
  /http:\/\/localhost:(\d+)/i,
  /http:\/\/127\.0\.0\.1:(\d+)/i,
  /Local:\s+https?:\/\/[^\s:]+:(\d+)/i,
  /listening on\D*(\d+)/i,
  /port\s+(\d+)/i
]

/**
 * 「这个端口被占了」这句话里的端口号是它**没抢到**的那个，不是它实际在听的。
 *
 * 实测 Next 16 在 3000 被占时打印
 * `Port 3000 is in use by process 14944, using available port 3001 instead.`，
 * 而 `port\s+(\d+)` 会在这一块里先撞上 3000。于是两个项目都被记成 :3000：卡片端口、
 * 「浏览器打开」的地址、重启前等待释放的端口、预检的端口冲突判定全部指向别人的服务。
 *
 * 只把这句话本身遮掉，不丢整行 —— ConPTY 用绝对光标定位换行，告警与紧随其后的
 * `Local: http://localhost:3001` 可能同处一块且剥掉转义后粘成一行，按行丢会把真端口
 * 一起丢掉。遮掉之后同一行剩下的 `using available port 3001 instead` 正好命中通用
 * 正则，拿到的是真端口。
 */
const PORT_TAKEN = /port\s+\d+\s+is\s+in\s+use|address already in use/gi

/** 脚本名只允许这些字符：它最终要经过 cmd.exe 解析，& | ^ 等会改变命令语义 */
const SAFE_SCRIPT = /^[A-Za-z0-9_.:\-+]+$/

const PM_BINARIES: Record<PackageManager, string[]> = {
  npm: ['npm.cmd', 'npm.exe'],
  pnpm: ['pnpm.cmd', 'pnpm.exe'],
  yarn: ['yarn.cmd', 'yarn.exe'],
  bun: ['bun.exe']
}

/** 任务产物目录的常见约定，按序探测，PRD §4.2 */
const OUTPUT_DIR_CANDIDATES = ['dist', 'build', 'out', '.next', '.output', 'release']

/** 可编辑字段白名单，PRD §4.6。未列出的键在 sanitizeEdit 里被静默丢弃 */
const EDITABLE = new Set<EditableEntryField>([
  'name', 'category', 'pinned', 'kind', 'path', 'cwd', 'script', 'scripts',
  'framework', 'packageManager', 'env', 'icon', 'expectedPort', 'outputDir', 'registerOnly'
])

/** 决定「这张卡片是谁」的字段，运行中不可改，PRD §4.6 */
const IDENTITY_FIELDS = ['kind', 'path', 'cwd', 'script', 'packageManager', 'expectedPort', 'env'] as const

const PACKAGE_MANAGERS = new Set<PackageManager>(['npm', 'pnpm', 'yarn', 'bun'])
const SERVICE_ICONS = new Set<ServiceIcon>(SERVICE_ICON_IDS)
const CATEGORY_MAX_LENGTH = 40

const FRAMEWORKS = new Set<Framework>([
  'next', 'nuxt', 'angular', 'vue-vite', 'vue-cli', 'react-vite', 'react-cra',
  'svelte', 'electron', 'hexo', 'node',
  'hugo', 'jekyll', 'django', 'fastapi', 'flask', 'streamlit', 'python',
  'docker-compose', 'go', 'rust', 'static', 'unknown'
])

const FIELD_LABEL: Partial<Record<EditableEntryField, string>> = {
  icon: '服务图标',
  kind: '类型',
  path: '项目目录',
  cwd: '子目录',
  script: '脚本',
  packageManager: '包管理器',
  expectedPort: '端口',
  env: '环境变量',
  name: '名称',
  category: '分类',
  pinned: '置顶',
  registerOnly: '仅登记'
}

function fieldLabel(field: EditableEntryField): string {
  return FIELD_LABEL[field] ?? field
}

function normalizeCategory(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('分类必须是字符串')
  const category = value.trim()
  if (!category) return undefined
  if (category.length > CATEGORY_MAX_LENGTH) {
    throw new Error(`分类不能超过 ${CATEGORY_MAX_LENGTH} 个字符`)
  }
  if (/[\u0000-\u001F\u007F]/.test(category)) throw new Error('分类不能包含控制字符')
  return category
}

/** env / scripts 是对象，改与不改要按内容比，引用比会把「重新选了同一个脚本」也算成改动 */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 任务退出码到状态，PRD §4.6。130 是脚本自报的用户取消，与失败区分开 */
const TASK_CANCELED_CODE = 130

/** 服务启动 60s 未捕获端口但进程存活，转 running（端口未知），PRD §4.3 */
const PORT_CAPTURE_TIMEOUT_MS = 60_000
const PORT_RELEASE_TIMEOUT_MS = 5000
const ERROR_LINE = /\b(error|ERR!|failed|Cannot find|EADDRINUSE)\b/i

interface Watch {
  entryId: string
  /** 端口捕获只看会话开头的输出，避免把用户后续输入里的数字当端口 */
  captured: boolean
  timer: NodeJS.Timeout | null
  firstErrorLine?: string
  /**
   * 用户从界面中止过。taskkill 会让任务以非零码退出，不记这一笔就会显示「失败」，
   * 而 PRD §4.6 要求区分「我停的」和「它自己崩的」。
   */
  stoppedByUser?: boolean
}

/**
 * 启动台，PRD §4。
 *
 * 安全约束（PRD §11）：命令一律 file + args 数组形式；脚本名必须是该项目
 * package.json scripts 的键且通过字符白名单；工作目录必须落在条目登记路径内；
 * 停止前经 OwnershipService 重校验归属。
 */
export class EntryService extends EventEmitter {
  private runtimes = new Map<string, EntryRuntime>()
  private watches = new Map<string, Watch>()
  /** 会话退出后留档，供诊断面板回顾 —— watches 在退出时就清了 */
  private lastErrorLine = new Map<string, string>()
  private lastRunMs = new Map<string, number>()
  private precheck: PrecheckService

  constructor(
    private config: ConfigStore,
    detect: DetectService,
    private sessions: SessionService,
    private scanner: ScannerService,
    private ownership: OwnershipService
  ) {
    super()
    this.precheck = new PrecheckService(detect)
    this.sessions.on('data', ({ id, chunk }: { id: string; chunk: string }) =>
      this.absorb(id, chunk)
    )
    this.sessions.on('exit', ({ id, exitCode }: { id: string; exitCode: number }) =>
      this.onSessionExit(id, exitCode)
    )
  }

  // ── CRUD 与排序 ─────────────────────────────────────────────────────────

  list(): LaunchEntry[] {
    return [...this.config.get().entries].sort(byOrder)
  }

  get(id: string): LaunchEntry | null {
    return this.config.get().entries.find((e) => e.id === id) ?? null
  }

  add(input: NewLaunchEntry): LaunchEntry {
    const entries = this.config.get().entries
    const { category: rawCategory, ...rest } = input
    const category = normalizeCategory(rawCategory)
    const entry: LaunchEntry = {
      ...rest,
      ...(category ? { category } : {}),
      id: randomUUID(),
      pinned: input.pinned ?? false,
      registerOnly: input.registerOnly ?? false,
      order: entries.length,
      createdAt: Date.now()
    }
    this.commit([...entries, entry])
    return entry
  }

  update(id: string, patch: Partial<LaunchEntry>): LaunchEntry | null {
    const entries = this.config.get().entries
    const target = entries.find((e) => e.id === id)
    if (!target) return null

    // id / createdAt / order 不接受渲染层覆盖，order 只能走 reorder
    const next: LaunchEntry = {
      ...target,
      ...patch,
      id: target.id,
      createdAt: target.createdAt,
      order: target.order
    }
    this.commit(entries.map((e) => (e.id === id ? next : e)))
    return next
  }

  /**
   * 用户编辑，PRD §4.6。与 update() 分开是有意的：update() 是内部通道，
   * spawnSession 用它写 lastStartedAt、absorb 用它回填 expectedPort，字段是代码给的。
   * edit() 收的是界面输入，必须逐字段校验并挡住运行中改身份。
   */
  async edit(id: string, patch: EntryEdit): Promise<LaunchEntry> {
    const target = this.get(id)
    if (!target) throw new Error(`条目不存在：${id}`)

    const clean = this.sanitizeEdit(target, patch)

    // 命令、工作目录、端口与类型决定「这张卡片是谁」，运行中改了会让停止与归属对不上
    const runtime = this.runtimes.get(id)
    if (runtime && isLive(runtime.status)) {
      const locked = IDENTITY_FIELDS.filter((f) => f in clean && !same(clean[f], target[f]))
      if (locked.length > 0) {
        throw new Error(`${target.name} 正在运行，${locked.map(fieldLabel).join('、')}需要先停止再改`)
      }
    }

    // 换了目录就必须重认脚本表：留着旧 scripts 会让「脚本已声明」的校验参照错的项目
    if (clean.path !== undefined && normalizePath(clean.path) !== normalizePath(target.path)) {
      if (!(await isDirectory(clean.path))) throw new Error(`目录不存在：${clean.path}`)
    }

    if (clean.script !== undefined && clean.script !== null) {
      if (!SAFE_SCRIPT.test(clean.script)) {
        throw new Error(`脚本名含非法字符：${clean.script}`)
      }
      const scripts = clean.scripts ?? target.scripts
      if (typeof scripts[clean.script] !== 'string') {
        throw new Error(`${clean.script} 不在该项目的 scripts 中`)
      }
    }

    const next = this.update(id, clean)
    if (!next) throw new Error(`条目不存在：${id}`)
    return next
  }

  /**
   * 只放行白名单字段，并逐个校验值域 —— 越界的键静默丢弃，非法的值直接抛错。
   * 返回值里的 undefined 是「显式清空」，`{...target, ...clean}` 展开时会真的把旧值覆盖掉。
   */
  private sanitizeEdit(target: LaunchEntry, patch: EntryEdit): Partial<LaunchEntry> {
    if (patch === null || typeof patch !== 'object') throw new Error('编辑内容必须是对象')
    const out: Partial<LaunchEntry> = {}

    for (const key of Object.keys(patch) as EditableEntryField[]) {
      if (!EDITABLE.has(key)) continue
      const value = patch[key]
      if (value === undefined) continue

      switch (key) {
        case 'name': {
          const name = String(value).trim()
          if (!name) throw new Error('名称不能为空')
          if (name.length > 60) throw new Error('名称不能超过 60 字')
          out.name = name
          break
        }
        case 'category':
          out.category = normalizeCategory(value)
          break
        case 'kind':
          if (value !== 'service' && value !== 'task') throw new Error(`类型非法：${String(value)}`)
          out.kind = value
          break
        case 'icon': {
          if (value === null) {
            out.icon = undefined
            break
          }
          const nextKind = patch.kind ?? target.kind
          if (nextKind !== 'service') throw new Error('任务不能设置服务卡片图标')
          if (typeof value !== 'string' || !SERVICE_ICONS.has(value as ServiceIcon)) {
            throw new Error(`服务图标非法：${String(value)}`)
          }
          out.icon = value as ServiceIcon
          break
        }
        case 'path': {
          const path = String(value)
          if (!isAbsolute(path)) throw new Error('项目目录必须是绝对路径')
          out.path = path
          break
        }
        case 'cwd': {
          // 空串等于「用项目根」，落盘存 undefined 而不是空字符串，免得 join 出个多余分隔符
          const cwd = String(value).trim()
          if (isAbsolute(cwd)) throw new Error('子目录必须是相对路径')
          if (cwd.split(/[\\/]/).includes('..')) throw new Error('子目录不能跳出项目根')
          out.cwd = cwd || undefined
          break
        }
        case 'script':
          if (value !== null && typeof value !== 'string') throw new Error('脚本名必须是字符串')
          out.script = value as string | null
          break
        case 'scripts': {
          if (value === null || typeof value !== 'object') throw new Error('脚本表必须是对象')
          const scripts = value as Record<string, unknown>
          if (Object.values(scripts).some((v) => typeof v !== 'string')) {
            throw new Error('脚本表的值必须是字符串')
          }
          out.scripts = scripts as Record<string, string>
          break
        }
        case 'framework':
          if (!FRAMEWORKS.has(value as Framework)) throw new Error(`框架非法：${String(value)}`)
          out.framework = value as Framework
          break
        case 'packageManager':
          if (!PACKAGE_MANAGERS.has(value as PackageManager)) {
            throw new Error(`包管理器非法：${String(value)}`)
          }
          out.packageManager = value as PackageManager
          break
        case 'env': {
          if (value === null || typeof value !== 'object') throw new Error('环境变量必须是对象')
          const env = value as Record<string, unknown>
          for (const [k, v] of Object.entries(env)) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`环境变量名非法：${k}`)
            if (typeof v !== 'string') throw new Error(`环境变量 ${k} 的值必须是字符串`)
          }
          out.env = env as Record<string, string>
          break
        }
        case 'expectedPort': {
          // 任务不监听端口，PRD §4.6 明确强制为空 —— 留着会让诊断去查一个永不出现的端口
          const kind = out.kind ?? target.kind
          if (value === null) {
            out.expectedPort = undefined
            break
          }
          if (kind === 'task') throw new Error('任务不设置端口')
          const port = Number(value)
          if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error(`端口必须是 1–65535 的整数：${String(value)}`)
          }
          out.expectedPort = port
          break
        }
        case 'outputDir': {
          if (value === null) {
            out.outputDir = undefined
            break
          }
          // 只收相对路径：knownPath() 把产物目录算进 shell.openPath 的白名单，
          // 允许绝对路径等于让渲染层往白名单里塞任意位置，PRD §11
          const dir = String(value).trim()
          if (isAbsolute(dir)) throw new Error('产物目录必须是相对项目根的路径')
          if (dir.split(/[\\/]/).includes('..')) throw new Error('产物目录不能跳出项目根')
          out.outputDir = dir || undefined
          break
        }
        case 'registerOnly':
        case 'pinned':
          if (typeof value !== 'boolean') throw new Error(`${fieldLabel(key)}必须是布尔值`)
          out[key] = value
          break
      }
    }

    // 类型改成任务就一并清掉端口，否则旧端口会留在配置里继续参与冲突计算
    if (out.kind === 'task') {
      out.expectedPort = undefined
      out.icon = undefined
    }
    return out
  }

  remove(id: string): void {
    const runtime = this.runtimes.get(id)
    if (runtime?.sessionId) this.sessions.kill(runtime.sessionId)
    this.runtimes.delete(id)
    this.commit(this.config.get().entries.filter((e) => e.id !== id))
  }

  /** 按传入的 id 顺序重排；未列出的条目保持在后面 */
  reorder(ids: string[]): LaunchEntry[] {
    const entries = this.config.get().entries
    const rank = new Map(ids.map((id, i) => [id, i]))
    const sorted = [...entries].sort(
      (a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER)
    )
    this.commit(sorted.map((e, i) => ({ ...e, order: i })))
    return this.list()
  }

  private commit(entries: LaunchEntry[]): void {
    this.config.patch({ entries })
    this.emit('changed', this.list())
  }

  // ── 运行态 ──────────────────────────────────────────────────────────────

  runtimeList(): EntryRuntime[] {
    return [...this.runtimes.values()]
  }

  /**
   * shell.openPath 白名单：目标是否为某条目的工作目录或其产物目录。
   * 采集快照只含正在监听的进程 cwd，停止状态的条目不在其中，所以需要这一路。
   */
  knownPath(target: string): boolean {
    const want = normalizePath(target)
    return this.list().some((e) => {
      const cwd = resolveCwd(e)
      if (normalizePath(cwd) === want) return true
      const out = e.outputDir
      return !!out && normalizePath(isAbsolute(out) ? out : join(cwd, out)) === want
    })
  }

  /** 条目的 package.json 路径，供「在编辑器中打开」用，路径由主进程拼 */
  packageJsonPath(id: string): string | null {
    const entry = this.get(id)
    return entry ? join(resolveCwd(entry), 'package.json') : null
  }

  /**
   * 任务产物目录，PRD §4.2。条目已配置则用它，否则按常见约定探测。
   * 只做目录存在性检查，不读内容。返回 null 表示还没有产物可看。
   */
  async outputDir(id: string): Promise<string | null> {
    const entry = this.get(id)
    if (!entry) return null
    const cwd = resolveCwd(entry)

    const candidates = entry.outputDir
      ? [isAbsolute(entry.outputDir) ? entry.outputDir : join(cwd, entry.outputDir)]
      : OUTPUT_DIR_CANDIDATES.map((d) => join(cwd, d))

    for (const dir of candidates) {
      if (await isDirectory(dir)) return dir
    }
    return null
  }

  /** 条目预期端口，供 ScannerService 算冲突与回填 entryId */
  expectations(): EntryExpectation[] {
    return this.list().map((e) => {
      const runtime = this.runtimes.get(e.id)
      return {
        id: e.id,
        port: runtime?.port ?? e.expectedPort,
        cwd: resolveCwd(e),
        pid: runtime?.pid,
        sessionId: runtime?.sessionId
      }
    })
  }

  private setRuntime(entryId: string, patch: Partial<EntryRuntime>): EntryRuntime {
    const current: EntryRuntime =
      this.runtimes.get(entryId) ?? { entryId, status: 'idle', portUnknown: false }
    const next = { ...current, ...patch }
    this.runtimes.set(entryId, next)
    this.emit('runtime', next)
    return next
  }

  // ── 预检与启动 ──────────────────────────────────────────────────────────

  async runPrecheck(id: string): Promise<PrecheckResult> {
    const entry = this.get(id)
    if (!entry) throw new Error(`条目不存在：${id}`)
    const result = await this.precheck.run(entry, this.scanner.snapshot())
    this.setRuntime(id, { precheck: result })
    return result
  }

  async start(id: string): Promise<EntryStartResult> {
    const entry = this.get(id)
    if (!entry) throw new Error(`条目不存在：${id}`)

    const existing = this.runtimes.get(id)
    if (existing && isLive(existing.status)) {
      return { ok: true, precheck: existing.precheck ?? { ok: true, items: [] }, runtime: existing }
    }

    this.setRuntime(id, { status: 'precheck', exitCode: undefined, portUnknown: false })
    const precheck = await this.precheck.run(entry, this.scanner.snapshot())
    if (!precheck.ok) {
      this.setRuntime(id, { status: 'blocked', precheck })
      return { ok: false, precheck }
    }

    try {
      const runtime = await this.spawnSession(entry, entry.script as string, 'dev', precheck)
      return { ok: true, precheck, runtime }
    } catch (err) {
      // spawn 抛错（非法脚本名、cwd 越界、包管理器缺失）时必须退出 precheck 态，
      // 否则条目永远停在「运行中」的判定里，后续启动会被直接短路掉
      this.setRuntime(id, { status: 'blocked', precheck })
      throw err
    }
  }

  /**
   * 执行条目 package.json 里的某个已声明脚本，供命令面板的「脚本」分组用，PRD §9.5。
   *
   * 只收 entryId + 脚本名：可执行文件与参数仍由 spawnSession 按数组形式拼，渲染层
   * 给不出命令。脚本名走 SAFE_SCRIPT 字符白名单 + 必须存在于磁盘 package.json 的
   * 双重校验，与 start() 同一条路径，不另开口子。
   */
  async runScript(id: string, script: string): Promise<EntryRuntime> {
    const entry = this.get(id)
    if (!entry) throw new Error(`条目不存在：${id}`)
    const existing = this.runtimes.get(id)
    if (existing && isLive(existing.status)) {
      throw new Error(`${entry.name} 正在运行中，先停止再执行其他脚本`)
    }
    // 归为 build 型：跑完即止，按退出码判成败，不做端口捕获
    return await this.spawnSession(entry, script, 'build')
  }

  /** 依赖安装必须由用户显式发起，PRD §5.2 */
  async install(id: string): Promise<EntryRuntime> {
    const entry = this.get(id)
    if (!entry) throw new Error(`条目不存在：${id}`)
    return await this.spawnSession(entry, null, 'install')
  }

  private async spawnSession(
    entry: LaunchEntry,
    script: string | null,
    kind: 'dev' | 'build' | 'install',
    precheck?: PrecheckResult
  ): Promise<EntryRuntime> {
    const cwd = resolveCwd(entry)
    this.assertInsideEntry(entry, cwd)

    if (script !== null) {
      if (!SAFE_SCRIPT.test(script)) {
        throw new Error(`脚本名含非法字符，拒绝执行：${script}`)
      }
      await this.assertScriptDeclared(cwd, script)
    }

    const pm = await whichAny(PM_BINARIES[entry.packageManager])
    if (!pm) throw new Error(`PATH 中找不到 ${entry.packageManager}`)

    // npm.cmd/pnpm.cmd 是批处理文件，CreateProcess 不能直接执行，必须经 cmd.exe。
    // 参数仍以数组传入由 node-pty 负责转义，脚本名另有白名单，不做字符串拼接。
    const args = ['/d', '/s', '/c', pm, ...(script === null ? ['install'] : ['run', script])]

    const session = this.sessions.create({
      kind,
      cwd,
      projectId: entry.id,
      title: `${entry.name} · ${script ?? 'install'}`,
      file: process.env.ComSpec ?? 'cmd.exe',
      args,
      env: entry.env
    })

    this.update(entry.id, { lastStartedAt: Date.now() })
    // 新会话开始就清掉上轮留档，否则诊断会把旧错误行挂在这次运行上
    this.lastErrorLine.delete(entry.id)

    const runtime = this.setRuntime(entry.id, {
      status: kind === 'install' ? 'running' : 'starting',
      sessionId: session.id,
      pid: session.pid,
      port: undefined,
      portUnknown: false,
      startedAt: session.startedAt,
      exitCode: undefined,
      precheck
    })

    if (kind === 'dev' && entry.kind === 'service') {
      const watch: Watch = { entryId: entry.id, captured: false, timer: null }
      watch.timer = setTimeout(() => this.onCaptureTimeout(entry.id), PORT_CAPTURE_TIMEOUT_MS)
      this.watches.set(session.id, watch)
    } else {
      this.watches.set(session.id, { entryId: entry.id, captured: true, timer: null })
    }

    return runtime
  }

  /** 工作目录必须落在条目登记路径内，防止 cwd 被改成任意位置，PRD §11 */
  private assertInsideEntry(entry: LaunchEntry, cwd: string): void {
    const rel = relative(entry.path, cwd)
    if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
      throw new Error(`工作目录 ${cwd} 不在条目路径 ${entry.path} 内`)
    }
  }

  /** 脚本只能来自该项目 package.json 的 scripts 键，启动时再确认一次 */
  private async assertScriptDeclared(cwd: string, script: string): Promise<void> {
    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>
    }
    if (typeof pkg.scripts?.[script] !== 'string') {
      throw new Error(`${script} 不在 package.json scripts 中，拒绝执行`)
    }
  }

  // ── 停止与重启 ──────────────────────────────────────────────────────────

  async stop(id: string): Promise<EntryRuntime> {
    const runtime = this.runtimes.get(id)
    if (!runtime?.sessionId || !runtime.pid) {
      return this.setRuntime(id, { status: 'stopped' })
    }

    // 终止前重校验归属：从判定到执行之间 PID 可能被回收复用，PRD §6.3 步骤 4
    const table = await this.scanner.table([runtime.pid])
    await this.ownership.assertKillable(runtime.pid, table)

    const watch = this.watches.get(runtime.sessionId)
    if (watch) watch.stoppedByUser = true

    this.setRuntime(id, { status: 'stopping' })
    this.sessions.stop(runtime.sessionId)
    return this.runtimes.get(id) as EntryRuntime
  }

  async restart(id: string): Promise<EntryStartResult> {
    const entry = this.get(id)
    if (!entry) throw new Error(`条目不存在：${id}`)

    const port = this.runtimes.get(id)?.port ?? entry.expectedPort
    /*
     * 先记下「本条目自己的监听 PID」，停完只等这些消失。
     *
     * 同一端口可能还有另一个条目在听（IPv4 / IPv6 各绑一个都会成功）。按端口整体
     * 等释放的话，那一直不放手的是别人，本条目却要白等 5 秒再报「端口未释放」——
     * 既慢又指错了人。
     */
    const own = this.ownListenPids(id)
    await this.stop(id)
    await this.waitSessionExit(id)
    if (port) await this.waitPortReleased(port, own)
    return await this.start(id)
  }

  private waitSessionExit(id: string, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    return new Promise((resolve) => {
      const poll = (): void => {
        const status = this.runtimes.get(id)?.status
        if (!status || !isLive(status) || Date.now() > deadline) return resolve()
        setTimeout(poll, 200)
      }
      poll()
    })
  }

  /**
   * 本条目正在监听的 PID 集合。
   *
   * 真正监听端口的常是 cmd.exe → npm → node 链条末端的 node.exe，而条目记的是根
   * PID，所以不能只看 runtime.pid。采集快照已按会话归属把 entryId 回填到叶子进程，
   * 直接用那份结论。
   */
  private ownListenPids(id: string): Set<number> {
    const own = new Set<number>()
    const pid = this.runtimes.get(id)?.pid
    if (pid) own.add(pid)
    for (const l of this.scanner.snapshot()?.listeners ?? []) {
      if (l.entryId === id) own.add(l.pid)
    }
    return own
  }

  /**
   * 轮询确认端口释放，最多 5s；未释放只告警不重试，PRD §6.3 步骤 3。
   *
   * 只关心 own 里的 PID 是否放手：同端口的另一个监听者（IPv4/IPv6 双绑）不该让
   * 本条目的重启卡满 5 秒。own 为空时退回「端口上没有任何监听」的旧口径。
   */
  private async waitPortReleased(
    port: number,
    own: ReadonlySet<number> = new Set()
  ): Promise<boolean> {
    const deadline = Date.now() + PORT_RELEASE_TIMEOUT_MS
    const held = (rows: ListenRow[]): boolean =>
      own.size > 0
        ? rows.some((r) => r.port === port && own.has(r.pid))
        : rows.some((r) => r.port === port)

    while (Date.now() < deadline) {
      if (!held(await readListenPorts())) return true
      await sleep(250)
    }
    this.emit('warning', `端口 :${port} 在 5 秒内未释放，重启后可能仍被占用`)
    return false
  }

  // ── 会话输出与退出 ──────────────────────────────────────────────────────

  private absorb(sessionId: string, chunk: string): void {
    const watch = this.watches.get(sessionId)
    if (!watch) return

    if (!watch.firstErrorLine) {
      const line = chunk.split(/\r?\n/).find((l) => ERROR_LINE.test(l))
      if (line) watch.firstErrorLine = stripAnsi(line).trim().slice(0, 200)
    }

    if (watch.captured) return
    const port = capturePort(chunk)
    if (!port) return

    watch.captured = true
    if (watch.timer) clearTimeout(watch.timer)
    watch.timer = null

    this.setRuntime(watch.entryId, { status: 'running', port, portUnknown: false })
    this.update(watch.entryId, { expectedPort: port })
  }

  private onCaptureTimeout(entryId: string): void {
    const runtime = this.runtimes.get(entryId)
    if (!runtime || runtime.status !== 'starting') return
    // 进程还活着就不判失败，只标端口未知
    this.setRuntime(entryId, { status: 'running', portUnknown: true })
  }

  private onSessionExit(sessionId: string, exitCode: number): void {
    const watch = this.watches.get(sessionId)
    if (!watch) return
    if (watch.timer) clearTimeout(watch.timer)
    this.watches.delete(sessionId)

    // 先留档再清运行态，诊断面板要在会话消失后仍能回顾
    if (watch.firstErrorLine) this.lastErrorLine.set(watch.entryId, watch.firstErrorLine)
    const startedAt = this.runtimes.get(watch.entryId)?.startedAt
    if (startedAt) this.lastRunMs.set(watch.entryId, Date.now() - startedAt)

    const entry = this.get(watch.entryId)
    const status: EntryStatus =
      entry?.kind === 'task'
        ? taskStatus(exitCode, watch.stoppedByUser === true)
        : exitCode === 0 || watch.stoppedByUser
          ? 'stopped'
          : 'crashed'

    this.setRuntime(watch.entryId, {
      status,
      exitCode,
      pid: undefined,
      port: undefined,
      portUnknown: false
    })
    this.update(watch.entryId, { lastExitCode: exitCode })

    /*
     * 任务完成通知挂在这里而不是 'runtime' 事件上，PRD §4.7。
     *
     * 「历史不重复推送」是结构性的，不靠去重表：本方法由 sessions 的 exit 驱动，
     * watches 在上面已经删掉，所以一个会话只可能走到这一次；而 runtimes 是内存
     * Map、从不从配置回填，重启后没有任何旧的完成态可供重放。
     * 若改挂 'runtime'，absorb() 里的端口捕获也会触发 setRuntime，就得另加去重。
     */
    if (entry?.kind === 'task' && !watch.stoppedByUser) {
      this.emit('taskDone', { entryId: entry.id, name: entry.name, status, exitCode })
    }
  }

  // ── 诊断 ────────────────────────────────────────────────────────────────

  async diagnose(id: string): Promise<EntryDiagnosis> {
    const entry = this.get(id)
    if (!entry) throw new Error(`条目不存在：${id}`)

    const precheck = await this.precheck.run(entry, this.scanner.snapshot())
    const runtime = this.runtimes.get(id)
    const port = runtime?.port ?? entry.expectedPort ?? null

    // 端口现状要现查，不能用采集快照 —— 快照最多滞后一个采集周期，
    // 而诊断的用途正是「刚失败，现在到底谁占着」。
    /*
     * 排除本条目自己的监听 PID，再问「谁占着这个端口」。
     *
     * 同一端口能被 IPv4 与 IPv6 两个进程同时占住，原来的实现取 netstat 第一行，
     * 在这种情况下常常答成「我自己」—— 而这恰恰是最需要诊断的时刻。
     */
    const holder = port ? await this.findPortHolder(port, this.ownListenPids(id)) : null

    return {
      entryId: id,
      precheck,
      port,
      portHolder: holder,
      lastExitCode: entry.lastExitCode,
      lastStartedAt: entry.lastStartedAt,
      lastRunMs: this.lastRunMs.get(id),
      // 会话已退出时 watches 已清空，改从退出时留档的记录取，
      // 否则「崩溃后诊断」永远看不到错误行 —— 那正是最需要它的时刻。
      firstErrorLine: this.lastErrorLine.get(id),
      node: process.versions.node,
      packageManager: entry.packageManager,
      packageManagerPath: await whichAny(PM_BINARIES[entry.packageManager]),
      // 只给键名，绝不含值 —— 避免泄露 token 与密钥，PRD §4.4
      envKeys: Object.keys(entry.env ?? {}),
      outputDir: entry.kind === 'task' ? await this.outputDir(id) : null
    }
  }

  /** 现查端口占用者（跳过 exclude 里的自有 PID），并用归属服务判定受控还是外部 */
  private async findPortHolder(
    port: number,
    exclude: ReadonlySet<number> = new Set()
  ): Promise<PortHolder | null> {
    const rows = await readListenPorts()
    const row = rows.find((r) => r.port === port && !exclude.has(r.pid))
    if (!row) return null

    const table = await this.scanner.table([row.pid])
    const verdict = this.ownership.verify(row.pid, table)
    const entryId = verdict.ownership === 'owned'
      ? this.entryIdForSession(verdict.sessionId, row.pid)
      : undefined
    return {
      pid: row.pid,
      processName: table.byPid.get(row.pid)?.name ?? '未知进程',
      ownership: verdict.ownership,
      ...(entryId ? { entryId } : {})
    }
  }

  /**
   * 监听端口相同不能作为条目归属依据。受控进程的会话 id 来自归属服务的父链验证，
   * 再映射到运行态是唯一能安全用于「停止它」的链路；扫描快照只作同 PID 的后备展示。
   */
  private entryIdForSession(sessionId: string | undefined, pid: number): string | undefined {
    if (sessionId) {
      const runtime = [...this.runtimes.values()].find((item) => item.sessionId === sessionId)
      if (runtime && this.get(runtime.entryId)) return runtime.entryId
    }
    return this.scanner.snapshot()?.listeners.find((listener) => listener.pid === pid)?.entryId
  }
}

function byOrder(a: LaunchEntry, b: LaunchEntry): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
  return a.order - b.order
}

function isLive(status: EntryStatus): boolean {
  return status === 'precheck' || status === 'starting' || status === 'running' || status === 'stopping'
}

/**
 * 任务完成状态，PRD §4.6。
 *
 * 「用户中止」优先于退出码：taskkill 掉的任务退出码是什么全看它当时在干什么，
 * 按码判会把用户自己按的停止显示成失败。130 只在任务自然退出时才作数 ——
 * 那是脚本主动 exit 130 报告的用户取消。
 */
function taskStatus(exitCode: number, stoppedByUser: boolean): EntryStatus {
  if (stoppedByUser) return 'stopped'
  if (exitCode === 0) return 'succeeded'
  if (exitCode === TASK_CANCELED_CODE) return 'canceled'
  return 'failed'
}

function capturePort(chunk: string): number | null {
  const text = stripAnsi(chunk).replace(PORT_TAKEN, ' ')
  for (const re of PORT_PATTERNS) {
    const m = text.match(re)
    if (!m) continue
    const port = Number(m[1])
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port
  }
  return null
}

/** Vite 的 Local: 行带颜色码，不剥掉会打断端口正则 */
const ANSI = /\[[0-9;?]*[a-zA-Z]/g

function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

/** Windows 路径比较：大小写不敏感，且要消掉 `a\b\..\b` 这类等价写法 */
function normalizePath(target: string): string {
  return resolve(target).replace(/[\\/]+$/, '').toLowerCase()
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory()
  } catch {
    return false
  }
}
