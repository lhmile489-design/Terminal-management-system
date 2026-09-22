import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, isAbsolute, resolve } from 'node:path'
import {
  SERVICE_ICON_IDS,
  isWebFramework,
  type EditableEntryField,
  type EntryDiagnosis,
  type EntryEdit,
  type EntryRuntime,
  type EntryStartResult,
  type EntryStatus,
  type Framework,
  type LaunchEntry,
  type LaunchMode,
  type MavenGoal,
  type NewLaunchEntry,
  type PackageManager,
  type PortHolder,
  type PrecheckResult,
  type ServiceIcon,
  type SpringBootLaunchMode
} from '@shared/types'
import { readListenPorts, type ListenRow } from '../lib/winProcess'
import type { ConfigStore } from './ConfigStore'
import type { DetectService } from './DetectService'
import { PrecheckService, resolveCwd, whichAny } from './PrecheckService'
import { ImageService } from './ImageService'
import type { EntryExpectation, ScannerService } from './ScannerService'
import type { SessionService } from './SessionService'
import type { OwnershipService } from './OwnershipService'

/** 端口捕获正则，PRD §8.4 */
const PORT_PATTERNS = [
  // Spring Boot / Tomcat / Netty 专用格式必须排在通用 `port \d+` 之前，
  // 否则 Spring Boot 冷启动日志里别处的 "port" 会先命中通用正则
  /Tomcat started on port\D*(\d+)/i,
  /Netty started on port\D*(\d+)/i,
  /Tomcat initialized with port\D*(\d+)/i,
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

/** Spring Boot profile 名：只允许字母、数字、下划线、连字符，与 Spring 命名约定一致 */
const SAFE_PROFILE = /^[A-Za-z0-9_-]+$/

function assertSafeProfile(profile: string | null): void {
  if (profile === null) return
  if (!SAFE_PROFILE.test(profile) || profile.length > 64) {
    throw new Error(`Profile 名非法或过长：${profile}`)
  }
}

const PM_BINARIES: Record<PackageManager, string[]> = {
  npm: ['npm.cmd', 'npm.exe'],
  pnpm: ['pnpm.cmd', 'pnpm.exe'],
  yarn: ['yarn.cmd', 'yarn.exe'],
  bun: ['bun.exe']
}

/**
 * Spring Boot 启动方式的合法枚举，sanitizeEdit 与新建校形都用它挡非法值。
 * 这五个是命令构造仅有的入口，用户改不了其中任何一条的可执行文件或子命令。
 */
const SPRING_BOOT_LAUNCH_MODES = new Set<SpringBootLaunchMode>([
  'maven-wrapper',
  'gradle-wrapper',
  'jar',
  'system-maven',
  'system-gradle'
])

/** LaunchMode → 是否为 Spring Boot 的 5 个模式（给 buildSpringBootCommand 做类型收窄） */
function isSpringBootMode(mode: LaunchMode): mode is SpringBootLaunchMode {
  return SPRING_BOOT_LAUNCH_MODES.has(mode as SpringBootLaunchMode)
}

/** wrapper 脚本文件名，硬编码常量，必须存在于条目登记目录内。用户改不了 */
const MVNW_CMD = 'mvnw.cmd'
const GRADLEW_BAT = 'gradlew.bat'

/** jar / system 模式需要的 java 可执行文件 */
const JAVA_BINARIES = ['java.exe']
/** system 模式的构建工具可执行文件 */
const SYSTEM_MAVEN_BINARIES = ['mvn.cmd', 'mvn.bat', 'mvn']
const SYSTEM_GRADLE_BINARIES = ['gradle.cmd', 'gradle.bat', 'gradle']

/** 各语言解释器 / 构建工具的可执行文件候选，经 whichAny 定位，用户不能指定 */
const PYTHON_BINARIES = ['python.exe', 'python3.exe', 'py.exe', 'python', 'python3']
const GO_BINARIES = ['go.exe', 'go']
const CARGO_BINARIES = ['cargo.exe', 'cargo']

/**
 * 全部合法的 launchMode 枚举（Spring Boot 5 个 + 各语言）。sanitizeEdit 与新建校形用它挡非法值。
 * 这些是命令构造仅有的入口，用户改不了其中任何一条的可执行文件或硬编码子命令。
 */
const LAUNCH_MODES = new Set<LaunchMode>([
  'maven-wrapper', 'gradle-wrapper', 'jar', 'system-maven', 'system-gradle',
  'python-file', 'python-module', 'uvicorn', 'flask', 'django',
  'go-run', 'cargo-run', 'cargo-run-release', 'cpp-exe'
])

/** 支持 launchMode 的框架（命令形状固定、可启动的非 npm 生态）。用于 sanitizeEdit 校验。 */
const LAUNCHABLE_FRAMEWORKS = new Set<Framework>([
  'spring-boot', 'django', 'fastapi', 'flask', 'streamlit', 'python', 'go', 'rust', 'cpp'
])

/** Python 入口文件名 / 包路径的安全字符（禁 shell 元字符，禁绝对路径由 resolveBinPath 另管） */
const SAFE_PYTHON_ENTRY = /^[A-Za-z0-9_.\-/\\]+$/
/** Python 模块名（点分标识符，如 uvicorn、app.main），不含路径分隔符 */
const SAFE_PYTHON_MODULE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*(:[A-Za-z_][A-Za-z0-9_]*)?$/
/** Go 包路径：项目内相对路径或 `.`（禁 shell 元字符） */
const SAFE_GO_PKG = /^[A-Za-z0-9_.\-/]+$/

/** 任务产物目录的常见约定，按序探测，PRD §4.2 */
const OUTPUT_DIR_CANDIDATES = ['dist', 'build', 'out', '.next', '.output', 'release']

/** 可编辑字段白名单，PRD §4.6。未列出的键在 sanitizeEdit 里被静默丢弃 */
const EDITABLE = new Set<EditableEntryField>([
  'name', 'category', 'groupId', 'pinned', 'kind', 'path', 'cwd', 'script', 'scripts',
  'framework', 'packageManager', 'env', 'icon', 'imageId', 'expectedPort', 'outputDir',
  'launchMode', 'jarPath', 'registerOnly'
])

/** 决定「这张卡片是谁」的字段，运行中不可改，PRD §4.6 */
const IDENTITY_FIELDS = ['kind', 'path', 'cwd', 'script', 'packageManager', 'expectedPort', 'env', 'launchMode', 'jarPath'] as const

const PACKAGE_MANAGERS = new Set<PackageManager>(['npm', 'pnpm', 'yarn', 'bun'])
const SERVICE_ICONS = new Set<ServiceIcon>(SERVICE_ICON_IDS)
const CATEGORY_MAX_LENGTH = 40

const FRAMEWORKS = new Set<Framework>([
  'next', 'nuxt', 'angular', 'vue-vite', 'vue-cli', 'react-vite', 'react-cra',
  'svelte', 'electron', 'hexo', 'node', 'spring-boot', 'uniapp',
  'hugo', 'jekyll', 'django', 'fastapi', 'flask', 'streamlit', 'python',
  'docker-compose', 'go', 'rust', 'cpp', 'static', 'unknown'
])

/**
 * HBuilderX cli.exe 的常见安装位置，取首个存在者。它不在 PATH，所以按绝对路径探测。
 * 顺序即优先级。测试可用 MILE_HBUILDERX_CLI 环境变量指向夹具里的假 cli，覆盖真实探测。
 */
function hbuilderxCliCandidates(): string[] {
  const override = process.env.MILE_HBUILDERX_CLI
  if (override) return [override]
  const localAppData = process.env.LOCALAPPDATA
  const list = [
    'D:\\HBuilderX\\cli.exe',
    'C:\\Program Files\\HBuilderX\\cli.exe',
    'D:\\Program Files\\HBuilderX\\cli.exe',
    'C:\\HBuilderX\\cli.exe'
  ]
  if (localAppData) list.push(join(localAppData, 'HBuilderX', 'cli.exe'))
  return list
}

function resolveHBuilderXCli(): string | null {
  for (const candidate of hbuilderxCliCandidates()) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

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
  launchMode: '启动方式',
  jarPath: 'jar 路径',
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
const ERROR_LINE = /\b(error|ERR!|failed|Cannot find|EADDRINUSE|BUILD FAILURE|APPLICATION FAILED TO START)\b/i

/** 一次启动要执行的命令，file + args 数组形式，绝不拼 shell 字符串 */
interface LaunchCommand {
  file: string
  args: string[]
  /** 会话标题里 `名称 · <title>` 的后半段 */
  title: string
}

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
  /**
   * 标记此会话是 packageWithProfile 发起的打包构建。
   * 退出码为 0 时，主进程扫描 target/ 写入 lastBuiltJar，供渲染层展示操作横幅。
   */
  isPackage?: boolean
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
  private images = new ImageService()

  constructor(
    private config: ConfigStore,
    private detect: DetectService,
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
        case 'groupId': {
          // null = 移出工作组（清空 groupId）；字符串 = 设置工作组 id
          if (value === null) {
            out.groupId = undefined
          } else {
            if (typeof value !== 'string') throw new Error('groupId 必须是字符串或 null')
            if (value.length > 64) throw new Error('groupId 过长')
            out.groupId = value
          }
          break
        }
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
        case 'imageId': {
          // 渲染层只能经 edit 清除图片（null）。设置图片走专用的 setImage(bytes)：
          // 由主进程压缩落盘并回填哈希文件名。这里拒绝任何字符串，杜绝渲染层指定
          // 任意文件名探测存在性 / 路径穿越。
          if (value !== null) {
            throw new Error('图片只能经上传设置，edit 仅接受 null 清除')
          }
          out.imageId = undefined
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
        case 'launchMode': {
          if (value === null) {
            out.launchMode = undefined
            break
          }
          // 启动方式只对命令形状固定的生态有意义，且只能是固定枚举之一
          const nextFramework = patch.framework ?? target.framework
          if (!LAUNCHABLE_FRAMEWORKS.has(nextFramework)) {
            throw new Error('该框架不支持设置启动方式')
          }
          if (typeof value !== 'string' || !LAUNCH_MODES.has(value as LaunchMode)) {
            throw new Error(`启动方式非法：${String(value)}`)
          }
          out.launchMode = value as LaunchMode
          break
        }
        case 'jarPath': {
          if (value === null) {
            out.jarPath = undefined
            break
          }
          // jarPath 现按 launchMode 承载 jar / exe / py 入口 / python 模块。存在性在启动时
          // （resolveBinPath）再查，编辑时不阻塞（用户可能还没构建）。这里只做形状与后缀校验。
          const raw = String(value).trim()
          const mode = (patch.launchMode ?? out.launchMode ?? target.launchMode) as
            | LaunchMode
            | undefined
          // python-module / uvicorn：是模块名不是路径，走标识符白名单，不做路径/后缀检查
          if (mode === 'python-module' || mode === 'uvicorn') {
            if (raw && !SAFE_PYTHON_MODULE.test(raw)) {
              throw new Error(`Python 模块名/规格非法：${raw}`)
            }
            out.jarPath = raw || undefined
            break
          }
          // 其余是项目内相对路径：相对项目根、禁 ..
          if (isAbsolute(raw)) throw new Error('路径必须是相对项目根的路径')
          if (raw.split(/[\\/]/).includes('..')) throw new Error('路径不能跳出项目根')
          // 按 mode 校验后缀：jar → .jar，cpp-exe → .exe，python-file → .py
          if (raw) {
            if (mode === 'jar' && !/\.jar$/i.test(raw)) throw new Error('jar 路径必须以 .jar 结尾')
            if (mode === 'cpp-exe' && !/\.exe$/i.test(raw)) throw new Error('可执行文件必须以 .exe 结尾')
            if (mode === 'python-file' && !/\.py$/i.test(raw)) throw new Error('入口文件必须以 .py 结尾')
            if (mode === 'python-file' && !SAFE_PYTHON_ENTRY.test(raw)) {
              throw new Error(`入口文件名含非法字符：${raw}`)
            }
          }
          out.jarPath = raw || undefined
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

  /** 获取单个条目的运行态，供主进程内部（如 entryRevealLastJar handler）使用 */
  runtimeOf(id: string): EntryRuntime | undefined {
    return this.runtimes.get(id)
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
   * 前端条目的本地 favicon，返回 base64 data URL 或 null。
   *
   * 只对前端生态尝试（isWebFramework）—— 后端目录里的 .ico 不是网站图标。
   * 路径由主进程用 resolveCwd(entry) 自己拼，渲染层只给 id；DetectService 只读文件、
   * 不联网、不执行代码，且把查找限制在项目根内（红线 1 / 4）。
   */
  async favicon(id: string): Promise<string | null> {
    const entry = this.get(id)
    if (!entry || !isWebFramework(entry.framework)) return null
    const hit = await this.detect.readFavicon(resolveCwd(entry))
    return hit ? `data:${hit.mime};base64,${hit.base64}` : null
  }

  /**
   * 设置条目自定义图片。渲染层把选中文件的原始字节交进来，主进程解码 + 压缩 + 落盘，
   * 回填哈希文件名到条目。服务与任务都可用；图片是纯展示字段，运行中也能改（不属
   * 运行身份，见 IDENTITY_FIELDS 不含 imageId）。返回新的 imageId。
   */
  async setImage(id: string, bytes: Uint8Array): Promise<string> {
    const entry = this.get(id)
    if (!entry) throw new Error(`条目不存在：${id}`)
    const { imageId } = await this.images.saveFromData(bytes)
    this.update(id, { imageId })
    return imageId
  }

  /** 清除条目自定义图片，回退到 icon / favicon / 框架字标。 */
  clearImage(id: string): LaunchEntry {
    const entry = this.get(id)
    if (!entry) throw new Error(`条目不存在：${id}`)
    // update 的 patch 里把 imageId 置 undefined 会在 {...target, ...patch} 里覆盖掉旧值
    const next = this.update(id, { imageId: undefined })
    if (!next) throw new Error(`条目不存在：${id}`)
    return next
  }

  /** 读取条目自定义图片为 data URL（显示用），无图片或读取失败返回 null。 */
  async imageDataUrl(id: string): Promise<string | null> {
    const entry = this.get(id)
    if (!entry || !entry.imageId) return null
    return this.images.read(entry.imageId)
  }

  /**
   * 用本机 HBuilderX 打开一个 uniapp 项目。命令形状固定，符合安全红线：
   *   file = 探测到的 cli.exe（用户不能指定），子命令硬编码 `project open`，
   *   路径 = resolveCwd(entry) 且经 assertInsideEntry 保证在登记目录内。
   *
   * 只对 uniapp 条目开放。它不是受管会话：不进 SessionService、不下发 runToken、
   * 不接管日志/端口/停止 —— 编译与运行态都在 HBuilderX 窗口里（方案 A 的诚实边界）。
   */
  async openInHBuilderX(id: string): Promise<boolean> {
    const entry = this.get(id)
    if (!entry) throw new Error('条目不存在')
    if (entry.framework !== 'uniapp') {
      throw new Error('仅 uniapp 项目支持用 HBuilderX 打开')
    }

    const cwd = resolveCwd(entry)
    this.assertInsideEntry(entry, cwd)

    const cli = resolveHBuilderXCli()
    if (!cli) throw new Error('未找到 HBuilderX cli.exe，请确认已安装 HBuilderX')

    // 经 cmd.exe /d /s /c 转发：与 npm 路径同理，cli 若是 .cmd/.bat 批处理无法被
    // CreateProcess 直接执行，且这样对真实 cli.exe 同样成立。参数仍以数组传入、绝不拼
    // shell 字符串；子命令 project open 固定、路径受 assertInsideEntry 约束。
    // detached + unref：HBuilderX 是独立 GUI，脱离本应用生命周期，不作为子会话跟踪。
    const comspec = process.env.ComSpec ?? 'cmd.exe'
    const child = spawn(comspec, ['/d', '/s', '/c', cli, 'project', 'open', '--path', cwd], {
      detached: true,
      stdio: 'ignore'
    })
    child.unref()
    return true
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

  /**
   * 在资源管理器里定位产物：优先找产物目录下最相关的单个文件（安装包 > 压缩包 > 可执行文件）
   * 并用 `shell.showItemInFolder` 高亮选中；找不到具体文件时 fallback 到直接打开产物目录。
   *
   * 路径全由主进程构造，渲染层只给 id —— 不接受任意路径，PRD §11。
   * 返回值供调用方判断是否成功打开（主进程 handler 调 shell.showItemInFolder / shell.openPath）。
   */
  async revealOutput(id: string): Promise<{ kind: 'file' | 'dir' | 'none'; path: string | null }> {
    const dir = await this.outputDir(id)
    if (!dir) return { kind: 'none', path: null }

    // 优先级：安装包/压缩包 > 可执行文件 > 网页入口
    const PRIORITY_EXTS = [
      ['.exe', '.msi', '.dmg', '.pkg', '.AppImage', '.deb', '.rpm'], // 安装包
      ['.zip', '.tar.gz', '.tgz', '.7z'],                            // 压缩包
      ['.jar'],                                                       // Java 产物
      ['.js', '.cjs', '.mjs'],                                        // Node 产物
      ['.html'],                                                      // 静态站入口
    ]

    let files: string[]
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      files = entries.filter((e) => e.isFile()).map((e) => e.name)
    } catch {
      // 目录刚写完可能还没刷新，fallback 到 openPath
      return { kind: 'dir', path: dir }
    }

    for (const exts of PRIORITY_EXTS) {
      const match = files.find((f) => exts.some((ext) => f.toLowerCase().endsWith(ext)))
      if (match) return { kind: 'file', path: join(dir, match) }
    }

    // 没找到特定文件就打开整个目录
    return { kind: 'dir', path: dir }
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
    const result = await this.precheck.run(entry, this.scanner.snapshot(), this.list())
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
    const precheck = await this.precheck.run(entry, this.scanner.snapshot(), this.list())
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
    // Spring Boot 没有 npm scripts，命令面板的「脚本」分组对它不成立
    if (entry.framework === 'spring-boot') {
      throw new Error('Spring Boot 条目不支持运行 npm 脚本')
    }
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
    // Spring Boot 依赖由 Maven/Gradle 在启动时自行处理，没有独立的「安装会话」
    if (entry.framework === 'spring-boot') {
      throw new Error('Spring Boot 条目不支持 npm 安装会话')
    }
    return await this.spawnSession(entry, null, 'install')
  }

  /**
   * 后端控制台：对 Spring Boot 条目执行 Maven/Gradle 构建任务。
   *
   * goal 是固定枚举（MavenGoal），不接受用户自由输入字符串。
   * 命令按 launchMode 映射：wrapper/system 分别调用 mvnw/mvn/gradlew/gradle，
   * 子命令 Maven 直传 goal，Gradle 用等价任务名（clean→clean, package→build 等）。
   * jar 模式没有独立构建入口，用户先手动构建再切到 jar 模式启动。
   *
   * 安全约束同 buildSpringBootCommand：file + args 数组，不拼 shell 字符串。
   */
  async mavenRun(id: string, goal: MavenGoal): Promise<EntryRuntime> {
    const entry = this.get(id)
    if (!entry) throw new Error(`条目不存在：${id}`)
    if (entry.framework !== 'spring-boot') {
      throw new Error(`mavenRun 只支持 Spring Boot 条目，当前框架：${entry.framework}`)
    }
    // goal 白名单校验（防止渲染层传入非法值）
    const VALID_GOALS: MavenGoal[] = ['clean', 'compile', 'package', 'test', 'install', 'verify']
    if (!VALID_GOALS.includes(goal)) {
      throw new Error(`非法构建目标：${goal}`)
    }
    return await this.spawnMavenGoal(entry, goal)
  }

  /**
   * 带 profile 的打包（build 型会话）。
   * profile 为 null = 不带 -P 参数；非 null 时经 SAFE_PROFILE 白名单校验。
   * 安全约束同 mavenRun：file + args 数组，子命令硬编码，profile 独立元素不拼字符串。
   */
  async packageWithProfile(id: string, profile: string | null): Promise<EntryRuntime> {
    const entry = this.get(id)
    if (!entry) throw new Error(`条目不存在：${id}`)
    if (entry.framework !== 'spring-boot') {
      throw new Error('packageWithProfile 只支持 Spring Boot 条目')
    }
    assertSafeProfile(profile)
    return await this.spawnPackageSession(entry, profile)
  }

  private async spawnPackageSession(entry: LaunchEntry, profile: string | null): Promise<EntryRuntime> {
    const cwd = resolveCwd(entry)
    this.assertInsideEntry(entry, cwd)
    const { file, args, title } = await this.buildPackageCommand(entry, cwd, profile)
    const session = this.sessions.create({
      kind: 'build',
      cwd,
      projectId: entry.id,
      title: `${entry.name} · ${title}`,
      file,
      args,
      env: entry.env
    })
    this.update(entry.id, { lastStartedAt: Date.now() })
    this.lastErrorLine.delete(entry.id)
    const runtime = this.setRuntime(entry.id, {
      status: 'starting',
      sessionId: session.id,
      pid: session.pid,
      port: undefined,
      portUnknown: false,
      startedAt: session.startedAt,
      exitCode: undefined,
      precheck: undefined
    })
    this.watches.set(session.id, { entryId: entry.id, captured: true, timer: null, isPackage: true })
    return runtime
  }

  /**
   * 带 profile 的打包命令构造（file + args 数组，不拼 shell 字符串）。
   * Maven 用 '-P' + profile 两个独立 args 元素；Gradle 用 '-P<profile>' 单个元素（Gradle 惯例）。
   */
  private async buildPackageCommand(
    entry: LaunchEntry,
    cwd: string,
    profile: string | null
  ): Promise<LaunchCommand> {
    const mode = entry.launchMode
    if (!mode || !isSpringBootMode(mode)) {
      throw new Error('Spring Boot 条目缺少合法的启动方式（launchMode）')
    }
    if (mode === 'jar') {
      throw new Error('jar 模式无内置构建命令，请手动构建后切换到 jar 启动方式')
    }
    const comspec = process.env.ComSpec ?? 'cmd.exe'
    const mavenProfileArgs = profile ? ['-P', profile] : []
    const gradleProfileArgs = profile ? [`-P${profile}`] : []

    switch (mode) {
      case 'maven-wrapper': {
        const wrapper = join(cwd, MVNW_CMD)
        if (!(await isFile(wrapper))) throw new Error(`未找到 ${MVNW_CMD}`)
        return {
          file: comspec,
          args: ['/d', '/s', '/c', wrapper, 'package', ...mavenProfileArgs],
          title: profile ? `mvnw package -P ${profile}` : 'mvnw package'
        }
      }
      case 'gradle-wrapper': {
        const wrapper = join(cwd, GRADLEW_BAT)
        if (!(await isFile(wrapper))) throw new Error(`未找到 ${GRADLEW_BAT}`)
        return {
          file: comspec,
          args: ['/d', '/s', '/c', wrapper, 'build', ...gradleProfileArgs],
          title: profile ? `gradlew build -P${profile}` : 'gradlew build'
        }
      }
      case 'system-maven': {
        const mvn = await whichAny(SYSTEM_MAVEN_BINARIES)
        if (!mvn) throw new Error('PATH 中找不到 mvn')
        return {
          file: comspec,
          args: ['/d', '/s', '/c', mvn, 'package', ...mavenProfileArgs],
          title: profile ? `mvn package -P ${profile}` : 'mvn package'
        }
      }
      case 'system-gradle': {
        const gradle = await whichAny(SYSTEM_GRADLE_BINARIES)
        if (!gradle) throw new Error('PATH 中找不到 gradle')
        return {
          file: comspec,
          args: ['/d', '/s', '/c', gradle, 'build', ...gradleProfileArgs],
          title: profile ? `gradle build -P${profile}` : 'gradle build'
        }
      }
    }
  }

  /** 构造并执行 Maven/Gradle goal 的会话（build 型，跑完即止，不做端口捕获） */
  private async spawnMavenGoal(entry: LaunchEntry, goal: MavenGoal): Promise<EntryRuntime> {
    const cwd = resolveCwd(entry)
    this.assertInsideEntry(entry, cwd)

    const { file, args, title } = await this.buildMavenGoalCommand(entry, cwd, goal)

    const session = this.sessions.create({
      kind: 'build',
      cwd,
      projectId: entry.id,
      title: `${entry.name} · ${title}`,
      file,
      args,
      env: entry.env
    })

    this.update(entry.id, { lastStartedAt: Date.now() })
    this.lastErrorLine.delete(entry.id)

    const runtime = this.setRuntime(entry.id, {
      status: 'starting',
      sessionId: session.id,
      pid: session.pid,
      port: undefined,
      portUnknown: false,
      startedAt: session.startedAt,
      exitCode: undefined,
      precheck: undefined
    })

    // build 型会话：不做端口捕获，直接标记 captured
    this.watches.set(session.id, { entryId: entry.id, captured: true, timer: null })

    return runtime
  }

  /**
   * 扫描 Spring Boot 项目 target/ 目录，返回可用 jar 文件的相对路径列表。
   * 过滤掉 -sources / -javadoc 辅助包，只留主体 jar。
   * 路径为相对项目根的相对路径（如 target/xxx.jar），符合 jarPath 字段约束。
   * 只读目录，不执行代码。
   */
  async listJars(id: string): Promise<string[]> {
    const entry = this.get(id)
    if (!entry || entry.framework !== 'spring-boot') return []
    const cwd = resolveCwd(entry)
    const targetDir = join(cwd, 'target')
    let names: string[]
    try {
      names = await readdir(targetDir)
    } catch {
      return [] // target/ 不存在（还没打包）
    }
    return names
      .filter(
        (n) =>
          /\.jar$/i.test(n) &&
          !n.includes('-sources') &&
          !n.includes('-javadoc') &&
          !n.startsWith('original-')
      )
      .map((n) => `target/${n}`)
  }

  /**
   * 将条目的 expectedPort 切换到指定端口并持久化。
   * 由预检"端口冲突→切换"快捷修复路径调用；端口范围已在 IPC 层校验。
   * 只改 expectedPort 元数据，不影响实际启动命令（那是项目配置的职责）。
   */
  async switchPort(id: string, newPort: number): Promise<void> {
    const entry = this.get(id)
    if (!entry) throw new Error(`条目不存在：${id}`)
    const updated: LaunchEntry = { ...entry, expectedPort: newPort }
    this.commit(this.list().map((e) => (e.id === id ? updated : e)))
  }

  /**
   * 按 launchMode + goal 映射构建命令（file + args 数组，不拼 shell 字符串）。
   *
   * Maven goal 直接传递；Gradle 映射：
   *   clean     → clean
   *   compile   → compileJava
   *   package   → build
   *   test      → test
   *   install   → publishToMavenLocal
   *   verify    → check
   */
  private async buildMavenGoalCommand(
    entry: LaunchEntry,
    cwd: string,
    goal: MavenGoal
  ): Promise<LaunchCommand> {
    const mode = entry.launchMode
    if (!mode || !isSpringBootMode(mode)) {
      throw new Error('Spring Boot 条目缺少合法的启动方式（launchMode）')
    }
    if (mode === 'jar') {
      throw new Error('jar 模式无内置构建命令，请手动构建后切换到 jar 启动方式')
    }

    const comspec = process.env.ComSpec ?? 'cmd.exe'

    // Gradle goal 映射：Maven goal → Gradle task
    const GRADLE_TASK: Record<MavenGoal, string> = {
      clean: 'clean',
      compile: 'compileJava',
      package: 'build',
      test: 'test',
      install: 'publishToMavenLocal',
      verify: 'check'
    }

    switch (mode) {
      case 'maven-wrapper': {
        const wrapper = join(cwd, MVNW_CMD)
        if (!(await isFile(wrapper))) {
          throw new Error(`未找到 ${MVNW_CMD}，无法用 Maven Wrapper 执行构建`)
        }
        const title = `mvnw ${goal}`
        return { file: comspec, args: ['/d', '/s', '/c', wrapper, goal], title }
      }
      case 'gradle-wrapper': {
        const wrapper = join(cwd, GRADLEW_BAT)
        if (!(await isFile(wrapper))) {
          throw new Error(`未找到 ${GRADLEW_BAT}，无法用 Gradle Wrapper 执行构建`)
        }
        const task = GRADLE_TASK[goal]
        const title = `gradlew ${task}`
        return { file: comspec, args: ['/d', '/s', '/c', wrapper, task], title }
      }
      case 'system-maven': {
        const mvn = await whichAny(SYSTEM_MAVEN_BINARIES)
        if (!mvn) throw new Error('PATH 中找不到 mvn')
        const title = `mvn ${goal}`
        return { file: comspec, args: ['/d', '/s', '/c', mvn, goal], title }
      }
      case 'system-gradle': {
        const gradle = await whichAny(SYSTEM_GRADLE_BINARIES)
        if (!gradle) throw new Error('PATH 中找不到 gradle')
        const task = GRADLE_TASK[goal]
        const title = `gradle ${task}`
        return { file: comspec, args: ['/d', '/s', '/c', gradle, task], title }
      }
    }
  }

  private async spawnSession(
    entry: LaunchEntry,
    script: string | null,
    kind: 'dev' | 'build' | 'install',
    precheck?: PrecheckResult
  ): Promise<EntryRuntime> {
    const cwd = resolveCwd(entry)
    this.assertInsideEntry(entry, cwd)

    // 命令构造按 framework 分派。每条路径都只产出 file + args 数组、从不拼 shell 字符串，
    // 子命令均为硬编码枚举，可执行文件经 whichAny 定位或项目内产物绝对路径 —— 用户改不了命令本身。
    const { file, args, title } = await this.buildCommand(entry, cwd, script)

    const session = this.sessions.create({
      kind,
      cwd,
      projectId: entry.id,
      title: `${entry.name} · ${title}`,
      file,
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

  /** 按 framework 选命令构造路径。每条都产出 file + args 数组，子命令硬编码，不拼 shell 字符串。 */
  private async buildCommand(
    entry: LaunchEntry,
    cwd: string,
    script: string | null
  ): Promise<LaunchCommand> {
    switch (entry.framework) {
      case 'spring-boot':
        return this.buildSpringBootCommand(entry, cwd)
      case 'django':
      case 'fastapi':
      case 'flask':
      case 'streamlit':
      case 'python':
        return this.buildPythonCommand(entry, cwd)
      case 'go':
        return this.buildGoCommand(entry, cwd)
      case 'rust':
        return this.buildRustCommand(entry)
      case 'cpp':
        return this.buildCppCommand(entry, cwd)
      default:
        return this.buildNpmCommand(entry, cwd, script)
    }
  }

  /**
   * Python 命令：file 固定为 python（whichAny 定位），子命令/flag 硬编码。
   * - python-file：python <入口文件>（入口须在项目内、存在）
   * - python-module：python -m <模块>（点分标识符，白名单）
   * - uvicorn：python -m uvicorn <app:实例>（FastAPI）
   * - flask：python -m flask run
   * - django：python <manage.py> runserver（manage.py 须存在）
   */
  private async buildPythonCommand(entry: LaunchEntry, cwd: string): Promise<LaunchCommand> {
    const mode = entry.launchMode
    const python = await whichAny(PYTHON_BINARIES)
    if (!python) throw new Error('PATH 中找不到 python')

    switch (mode) {
      case 'python-file': {
        const rel = entry.jarPath
        if (!rel) throw new Error('Python 入口文件未配置')
        if (!SAFE_PYTHON_ENTRY.test(rel)) throw new Error(`入口文件名含非法字符：${rel}`)
        const abs = await this.resolveBinPath(entry, cwd, /\.py$/i, 'py')
        return { file: python, args: [abs], title: `python ${rel}` }
      }
      case 'python-module': {
        const mod = entry.jarPath
        if (!mod || !SAFE_PYTHON_MODULE.test(mod)) {
          throw new Error(`Python 模块名非法：${mod ?? '（空）'}`)
        }
        return { file: python, args: ['-m', mod], title: `python -m ${mod}` }
      }
      case 'uvicorn': {
        const app = entry.jarPath
        if (!app || !SAFE_PYTHON_MODULE.test(app)) {
          throw new Error(`uvicorn app 规格非法：${app ?? '（空）'}`)
        }
        return { file: python, args: ['-m', 'uvicorn', app], title: `uvicorn ${app}` }
      }
      case 'flask':
        return { file: python, args: ['-m', 'flask', 'run'], title: 'flask run' }
      case 'django': {
        const manage = join(cwd, 'manage.py')
        if (!(await isFile(manage))) throw new Error('未找到 manage.py，无法启动 Django')
        return { file: python, args: [manage, 'runserver'], title: 'manage.py runserver' }
      }
      default:
        throw new Error(`Python 条目缺少合法的启动方式（launchMode）：${mode ?? '（空）'}`)
    }
  }

  /** Go 命令：go run <项目内包路径|.>。子命令 run 固定，包路径限项目内相对路径。 */
  private async buildGoCommand(entry: LaunchEntry, cwd: string): Promise<LaunchCommand> {
    if (entry.launchMode !== 'go-run') {
      throw new Error(`Go 条目启动方式非法：${entry.launchMode ?? '（空）'}`)
    }
    const pkg = entry.jarPath?.trim() || '.'
    if (!SAFE_GO_PKG.test(pkg) || pkg.split(/[\\/]/).includes('..')) {
      throw new Error(`Go 包路径非法：${pkg}`)
    }
    const go = await whichAny(GO_BINARIES)
    if (!go) throw new Error('PATH 中找不到 go')
    // 校验包路径落在项目内（. 恒成立）
    if (pkg !== '.') this.assertInsideEntry(entry, join(cwd, pkg))
    return { file: go, args: ['run', pkg], title: `go run ${pkg}` }
  }

  /** Rust 命令：cargo run [--release]。子命令固定，无用户自由输入。 */
  private async buildRustCommand(entry: LaunchEntry): Promise<LaunchCommand> {
    const mode = entry.launchMode
    if (mode !== 'cargo-run' && mode !== 'cargo-run-release') {
      throw new Error(`Rust 条目启动方式非法：${mode ?? '（空）'}`)
    }
    const cargo = await whichAny(CARGO_BINARIES)
    if (!cargo) throw new Error('PATH 中找不到 cargo')
    const args = mode === 'cargo-run-release' ? ['run', '--release'] : ['run']
    return { file: cargo, args, title: `cargo ${args.join(' ')}` }
  }

  /** C++ 命令：只跑项目内已构建的 .exe（相对项目根、禁 ..、须存在），不代编译。 */
  private async buildCppCommand(entry: LaunchEntry, cwd: string): Promise<LaunchCommand> {
    if (entry.launchMode !== 'cpp-exe') {
      throw new Error(`C++ 条目启动方式非法：${entry.launchMode ?? '（空）'}`)
    }
    const abs = await this.resolveBinPath(entry, cwd, /\.exe$/i, 'exe')
    // exe 是真可执行文件，可直接 CreateProcess，无需经 cmd
    return { file: abs, args: [], title: entry.jarPath ?? 'exe' }
  }

  /** npm 生态命令：`cmd /d /s /c <pm> run <脚本>` 或 `<pm> install`。脚本名双重校验 */
  private async buildNpmCommand(
    entry: LaunchEntry,
    cwd: string,
    script: string | null
  ): Promise<LaunchCommand> {
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
    return {
      file: process.env.ComSpec ?? 'cmd.exe',
      args,
      title: script ?? 'install'
    }
  }

  /**
   * Spring Boot 命令构造，PRD §4 / §11。
   *
   * 五种启动方式的可执行文件与子命令**全部固定**，用户只能选「哪种方式」：
   * - wrapper 模式跑项目根自带的 mvnw.cmd / gradlew.bat（必须在 cwd 内），子命令写死
   * - jar 模式只跑 `java -jar <jar>`，jar 路径受 outputDir 同款约束（相对、禁 ..、须 .jar、须存在）
   * - system 模式用 PATH 里的 mvn / gradle
   * 全程 file + args 数组，绝不拼 shell 字符串。cmd 已被 assertInsideEntry 保证落在登记目录内。
   */
  private async buildSpringBootCommand(entry: LaunchEntry, cwd: string): Promise<LaunchCommand> {
    const mode = entry.launchMode
    if (!mode || !isSpringBootMode(mode)) {
      throw new Error('Spring Boot 条目缺少合法的启动方式（launchMode）')
    }
    const comspec = process.env.ComSpec ?? 'cmd.exe'

    switch (mode) {
      case 'maven-wrapper': {
        const wrapper = join(cwd, MVNW_CMD)
        if (!(await isFile(wrapper))) {
          throw new Error(`未找到 ${MVNW_CMD}，无法用 Maven Wrapper 启动`)
        }
        // 用 wrapper 的绝对路径：cmd /c 不会去 cwd 搜可执行文件（只搜 PATH），
        // 而项目本地的 mvnw.cmd 不在 PATH 里。路径由主进程用常量文件名拼，非用户输入。
        return { file: comspec, args: ['/d', '/s', '/c', wrapper, 'spring-boot:run'], title: 'spring-boot:run' }
      }
      case 'gradle-wrapper': {
        const wrapper = join(cwd, GRADLEW_BAT)
        if (!(await isFile(wrapper))) {
          throw new Error(`未找到 ${GRADLEW_BAT}，无法用 Gradle Wrapper 启动`)
        }
        return { file: comspec, args: ['/d', '/s', '/c', wrapper, 'bootRun'], title: 'bootRun' }
      }
      case 'jar': {
        const jarAbs = await this.resolveJarPath(entry, cwd)
        const java = await whichAny(JAVA_BINARIES)
        if (!java) throw new Error('PATH 中找不到 java')
        // java.exe 可直接 CreateProcess，无需经 cmd；jar 路径已校验在项目内且存在
        return { file: java, args: ['-jar', jarAbs], title: `java -jar ${entry.jarPath}` }
      }
      case 'system-maven': {
        const mvn = await whichAny(SYSTEM_MAVEN_BINARIES)
        if (!mvn) throw new Error('PATH 中找不到 mvn')
        return { file: comspec, args: ['/d', '/s', '/c', mvn, 'spring-boot:run'], title: 'mvn spring-boot:run' }
      }
      case 'system-gradle': {
        const gradle = await whichAny(SYSTEM_GRADLE_BINARIES)
        if (!gradle) throw new Error('PATH 中找不到 gradle')
        return { file: comspec, args: ['/d', '/s', '/c', gradle, 'bootRun'], title: 'gradle bootRun' }
      }
    }
  }

  /**
   * 把条目的 jarPath 字段解析成绝对路径并校验：相对项目根、禁 `..`、须匹配指定后缀、文件须存在。
   * 约束与 outputDir 一致 —— 它同样会经过 knownPath 进入 shell.openPath 白名单。
   * Spring Boot jar 传 /\.jar$/、C++ exe 传 /\.exe$/、Python 入口文件传 /\.py$/。
   */
  private async resolveBinPath(
    entry: LaunchEntry,
    cwd: string,
    extRegex: RegExp,
    extLabel: string
  ): Promise<string> {
    const rel = entry.jarPath
    if (!rel) throw new Error(`未配置 ${extLabel} 路径`)
    if (isAbsolute(rel)) throw new Error('路径必须是相对项目根的路径')
    if (rel.split(/[\\/]/).includes('..')) throw new Error('路径不能跳出项目根')
    if (!extRegex.test(rel)) throw new Error(`路径必须以 .${extLabel} 结尾`)
    const abs = join(cwd, rel)
    if (!(await isFile(abs))) throw new Error(`${extLabel} 文件不存在：${rel}`)
    return abs
  }

  /** Spring Boot jar 模式：.jar 产物路径校验（resolveBinPath 的 jar 特化） */
  private async resolveJarPath(entry: LaunchEntry, cwd: string): Promise<string> {
    return this.resolveBinPath(entry, cwd, /\.jar$/i, 'jar')
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

    // packageWithProfile 打包成功：扫描 target/ 写入 lastBuiltJar，触发渲染层操作横幅
    if (watch.isPackage && exitCode === 0 && entry) {
      // 异步扫描，失败不影响状态机
      this.listJars(watch.entryId)
        .then((jars) => {
          if (jars.length > 0) {
            this.setRuntime(watch.entryId, { lastBuiltJar: jars[0] })
          }
        })
        .catch(() => {/* 扫描失败静默，不影响主流程 */})
    }

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

    const precheck = await this.precheck.run(entry, this.scanner.snapshot(), this.list())
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

async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile()
  } catch {
    return false
  }
}
