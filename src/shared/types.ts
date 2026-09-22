export type SessionKind = 'dev' | 'build' | 'install' | 'shell' | 'script'

export type SessionStatus = 'starting' | 'running' | 'building' | 'stopped' | 'crashed'

export interface SessionMeta {
  id: string
  projectId: string | null
  kind: SessionKind
  title: string
  command: string
  cwd: string
  pid: number
  status: SessionStatus
  port?: number
  startedAt: number
  exitCode?: number
}

export interface CreateSessionInput {
  kind: SessionKind
  /** 省略时回退到用户主目录 */
  cwd?: string
  projectId?: string | null
  title?: string
  /** 可执行文件，缺省时使用系统默认 shell */
  file?: string
  /** 参数数组形式，绝不拼接成 shell 字符串 */
  args?: string[]
  env?: Record<string, string>
}

export interface SessionDataEvent {
  id: string
  chunk: string
}

export interface SessionExitEvent {
  id: string
  exitCode: number
  signal?: number
}

// ── 日志中心，PRD §4.8 ──────────────────────────────────────────────────────

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogLine {
  /** 全局单调序号，供渲染层做 key 与「有没有新行」判断 */
  seq: number
  sessionId: string
  /** 会话所属条目，shell 会话为 null */
  entryId: string | null
  title: string
  ts: number
  level: LogLevel
  text: string
}

export interface LogQuery {
  sessionId?: string | null
  entryId?: string | null
  level?: LogLevel | null
  text?: string | null
  limit?: number
}

export interface LogResult {
  /** 按时间正序，最多 limit 条 */
  lines: LogLine[]
  /** 命中筛选的总条数，可能大于 lines.length */
  total: number
  /** 被环形缓冲挤掉的行数 */
  dropped: number
  capacity: number
  sources: { sessionId: string; title: string; count: number }[]
}

/** 归属判定，见 PRD §6.2。foreign 已在采集层过滤，不下发渲染层 */
export type Ownership = 'owned' | 'external' | 'foreign'

/** 单条凭据的校验结果，读不到环境块时为 unknown */
export type CredentialResult = 'hit' | 'miss' | 'unknown'

export interface OwnershipVerdict {
  pid: number
  ownership: Ownership
  token: CredentialResult
  processGroup: CredentialResult
  sameUser: CredentialResult
  sessionId?: string
}

/**
 * 监听分组，PRD §5.2。开发运行时与常见服务进程归「我的服务」，
 * GUI 应用与系统路径进程归「应用后台」。
 */
export type ListenerGroup = 'mine' | 'background'

/**
 * 启动来源，PRD §5.3。**仅用于展示**。
 *
 * 这个值来自父进程链上的进程名与命令行，二者都是进程自己可以随便写的东西，
 * 当不了安全凭据。归属判定只认 OwnershipService 的三重凭据，与此无关。
 */
export type LaunchSource =
  | 'mile'
  | 'vscode'
  | 'cursor'
  | 'jetbrains'
  | 'claude'
  | 'codex'
  | 'terminal'
  | 'explorer'
  | 'service'
  | 'unknown'

/** 一次采集中单个监听进程的快照 */
export interface ListenerSnapshot {
  pid: number
  ports: number[]
  processName: string
  execPath?: string
  cwd?: string
  /** 首轮无增量基线，为 null 而非 0 */
  cpu: number | null
  memory: number
  startedAt?: number
  ownership: Ownership
  entryId?: string
  sessionId?: string
  group: ListenerGroup
  /** 用户手动提升或移回过，界面据此提示这是人定的而非推断的 */
  groupOverridden: boolean
  launchSource: LaunchSource
}

/**
 * 关注进程命中项，PRD §5.5。不监听端口也能被观察到。
 *
 * 命令行按 `WATCHED_CMD_MAX` 截断后下发：匹配是在命令行上做的，不给出片段用户
 * 就不知道为什么命中；但完整参数里可能带 token，全量下发等于把它摊到界面上。
 */
export interface WatchedProcess {
  pid: number
  processName: string
  /** 命中的关键字，一个进程可能同时命中多个，取首个 */
  keyword: string
  commandLine?: string
  cpu: number | null
  memory: number
  startedAt?: number
}

export interface SystemLoad {
  cpu: number | null
  memory: number
}

/** 本次窗口会话期间新出现的未纳管监听，见 PRD §7 */
export interface UnmanagedListener {
  pid: number
  port: number
  processName: string
  cwd?: string
  guessedName: string
  startedAt?: number
}

export interface ScanSnapshot {
  at: number
  listeners: ListenerSnapshot[]
  unmanaged: UnmanagedListener[]
  watched: WatchedProcess[]
  system: SystemLoad
  /** 预期端口被非本条目占用的数量 */
  portConflicts: number
  /** 采集失败时保留上次成功时间，渲染层据此标黄 */
  failed: boolean
  lastSuccessAt: number | null
}

export interface ScanDiff {
  at: number
  added: ListenerSnapshot[]
  updated: ListenerSnapshot[]
  removedPids: number[]
  unmanaged: UnmanagedListener[]
  watched: WatchedProcess[]
  system: SystemLoad
  portConflicts: number
  failed: boolean
  lastSuccessAt: number | null
}

export type ThemePreference = 'light' | 'dark' | 'system'

/** 解析后的实际外观，渲染层据此设置 data-theme */
export type ResolvedTheme = 'light' | 'dark'

export interface ThemeState {
  preference: ThemePreference
  resolved: ResolvedTheme
}

export interface Settings {
  scanIntervalMs: 1000 | 2000 | 5000 | 10000
  theme: ThemePreference
  externalTerminal: 'wt' | 'pwsh' | 'powershell' | 'cmd' | 'gitbash'
  terminalFontSize: number
  scrollback: number
  killOwnedOnQuit: boolean
  closeToTray: boolean
  /** 任务跑完弹系统通知，PRD §4.7，v3 起 */
  notifyOnTaskDone: boolean
  /** 从 Windows 任务栏隐藏，只保留系统托盘图标，v6 起 */
  hideFromTaskbar: boolean
}

/** 当前配置结构版本。加字段就要加迁移，见 ConfigStore.migrate */
export const CONFIG_VERSION = 9

/** 用户手动改过分组的进程，PRD §5.2。按进程名而非 PID —— PID 每次重启都换 */
export interface GroupOverride {
  processName: string
  group: ListenerGroup
}

// ── 工作组，PRD-WORKGROUPS §2 ─────────────────────────────────────────────────

/**
 * 工作组运行环境。决定 Java 启动时的提示级别与默认 profile 高亮。
 * - dev：无提示，正常启动
 * - sandbox：黄色警示横幅，用户确认后启动
 * - prod：红色强提示横幅，强调影响真实业务
 */
export type GroupEnvironment = 'dev' | 'sandbox' | 'prod'

export const GROUP_ENV_LABEL: Record<GroupEnvironment, string> = {
  dev: '开发',
  sandbox: '沙箱',
  prod: '生产'
}

/** 用户定义的项目工作组。条目通过 LaunchEntry.groupId 关联。*/
export interface ProjectGroup {
  /** UUID，主进程生成 */
  id: string
  /** 显示名称，最长 40 字 */
  name: string
  /** 可选描述，最长 120 字 */
  description?: string
  /** 当前激活环境；新建时默认 'dev' */
  env: GroupEnvironment
  createdAt: number
  order: number
}

export type NewProjectGroup = Omit<ProjectGroup, 'id' | 'createdAt' | 'order' | 'env'> &
  Partial<Pick<ProjectGroup, 'env' | 'description'>>

export type GroupPatch = Partial<Pick<ProjectGroup, 'name' | 'description' | 'env' | 'order'>>

export interface AppConfig {
  version: number
  entries: LaunchEntry[]
  /** 用户创建的项目工作组，v9 起；旧版迁移时初始化为 [] */
  groups: ProjectGroup[]
  ignoredListeners: { processName: string; port: number }[]
  /** 手动提升到「我的服务」或移回后台的进程名，v2 起 */
  groupOverrides: GroupOverride[]
  /** 关注进程关键字，PRD §5.5，v2 起 */
  watchedKeywords: string[]
  settings: Settings
}

// ── 启动台，PRD §4 / §8 / §10 ──────────────────────────────────────────────

export type Framework =
  | 'next'
  | 'nuxt'
  | 'angular'
  | 'vue-vite'
  | 'vue-cli'
  | 'react-vite'
  | 'react-cra'
  | 'svelte'
  | 'electron'
  | 'hexo'
  | 'node'
  // Spring Boot 非 npm 生态，但命令形状固定（mvnw/gradlew + 硬编码子命令），
  // 因此可启动、不标 registerOnly，走 EntryService 的第二条命令构造路径
  | 'spring-boot'
  // uniapp（纯 HBuilderX 项目）：有 package.json 但无编译脚本，编译器内置在 HBuilderX 里。
  // 能识别、仅登记（registerOnly），启动交给 HBuilderX（EntryService.openInHBuilderX）。
  | 'uniapp'
  // 以下为非 npm 生态。命令形状固定、推得出的（python/go/rust/cpp）走 EntryService 的
  // 第 N 条命令构造路径，可启动；命令形状推不出的（hugo/jekyll/docker-compose/static）仍仅登记。
  | 'hugo'
  | 'jekyll'
  | 'django'
  | 'fastapi'
  | 'flask'
  | 'streamlit'
  | 'python'
  | 'docker-compose'
  | 'go'
  | 'rust'
  // C++：只跑项目内已构建的 exe（不代编译），命令形状 = 固定的可执行产物路径
  | 'cpp'
  | 'static'
  | 'unknown'

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

/**
 * 会产出「网站首页」、因此有本地 favicon 可读的前端生态。
 *
 * 只对这些框架尝试读 favicon —— 后端/CLI 生态（go/rust/python/spring-boot 等）
 * 目录里就算有 .ico 也不是网站图标，读了反而误导。两端共用这一份，避免漂移。
 */
export const WEB_FRAMEWORKS = [
  'next',
  'nuxt',
  'angular',
  'vue-vite',
  'vue-cli',
  'react-vite',
  'react-cra',
  'svelte',
  'hexo',
  'hugo',
  'jekyll',
  'static'
] as const

export function isWebFramework(f: Framework): boolean {
  return (WEB_FRAMEWORKS as readonly string[]).includes(f)
}

/**
 * Spring Boot 启动方式，仅 framework === 'spring-boot' 使用。
 *
 * 每种方式的可执行文件与子命令都是固定的（见 EntryService.buildSpringBootCommand）：
 * - wrapper 模式执行项目根自带的 mvnw.cmd / gradlew.bat，子命令写死 spring-boot:run / bootRun
 * - jar 模式只跑已构建产物，不碰任何 wrapper 脚本
 * - system 模式用 PATH 里的 mvn / gradle
 * 用户只能选「哪种方式」，改不了命令本身 —— 这是替代「脚本必须在 package.json」的可信来源判定。
 */
export type SpringBootLaunchMode =
  | 'maven-wrapper'
  | 'gradle-wrapper'
  | 'jar'
  | 'system-maven'
  | 'system-gradle'

/**
 * Maven/Gradle 构建目标，用于后端控制台的构建操作。
 * 值是固定枚举，不接受用户自由输入字符串 —— 安全约束同 LaunchMode：
 * 命令由 EntryService.buildMavenCommand 按 launchMode + goal 映射成固定 args 数组。
 */
export type MavenGoal = 'clean' | 'compile' | 'package' | 'test' | 'install' | 'verify'

/**
 * 跨语言的启动方式枚举，`LaunchEntry.launchMode` 使用。
 *
 * 与 Spring Boot 同一可信性模型：每个 mode 的可执行文件与子命令都固定（见 EntryService
 * 的 build<Lang>Command），用户只能选「哪种方式」，改不了命令本身。这替代了 npm 的
 * 「脚本必须在 package.json」判定，是把非 npm 生态移出「仅登记」的合法依据。
 *
 * - python-*：file=python(whichAny)，子命令/flag 硬编码；入口文件/模块经白名单 + 项目内校验
 * - go-run：file=go，args=['run', <项目内包路径|.>]
 * - cargo-run[-release]：file=cargo，args=['run'] 或 ['run','--release']
 * - cpp-exe：只跑项目内已构建的 .exe（相对项目根、禁 ..、须存在），不代编译
 */
export type LaunchMode =
  | SpringBootLaunchMode
  | 'python-file'
  | 'python-module'
  | 'uvicorn'
  | 'flask'
  | 'django'
  | 'go-run'
  | 'cargo-run'
  | 'cargo-run-release'
  | 'cpp-exe'

export type EntryKind = 'service' | 'task'

/** 服务卡片允许持久化的图标标识；缺省时沿用框架字标。 */
export const SERVICE_ICON_IDS = [
  'rocket',
  'globe',
  'database',
  'terminal',
  'code',
  'cube',
  'cloud',
  'gear'
] as const

export type ServiceIcon = (typeof SERVICE_ICON_IDS)[number]

export interface LaunchEntry {
  id: string
  kind: EntryKind
  name: string
  /** User-defined Launchpad category; unset entries belong to the unclassified panel. */
  category?: string
  /** 仅服务使用；未设置时按已识别框架显示默认字标。 */
  icon?: ServiceIcon
  /**
   * 自定义图片文件名（存于 %APPDATA%/mile-terminal/images/），服务与任务均可用。
   * 显示优先级高于 icon 与 favicon。仅由主进程 entry.setImage 压缩落盘后写入，
   * 渲染层不可通过 edit 直接指定文件名（防路径穿越 / 探测任意文件存在性）。
   */
  imageId?: string
  /** 项目根绝对路径 */
  path: string
  /** monorepo 子包相对路径 */
  cwd?: string
  framework: Framework
  packageManager: PackageManager
  /** 服务用 dev 脚本，任务用其命令脚本 */
  script: string | null
  /** package.json scripts 快照 */
  scripts: Record<string, string>
  env: Record<string, string>
  expectedPort?: number
  outputDir?: string
  /**
   * 决定 spawnSession 走哪条命令构造路径。仅命令形状固定的非 npm 生态使用
   * （spring-boot / python / go / rust / cpp）；npm 生态与仅登记条目为 undefined。
   */
  launchMode?: LaunchMode
  /**
   * 可执行产物或入口的相对路径（相对项目根，禁 `..`）。约束同 outputDir，会参与
   * shell.openPath 的白名单推断。按 launchMode 决定语义与后缀校验：
   * - jar（Spring Boot）→ 须以 .jar 结尾的 jar 产物
   * - cpp-exe（C++）→ 须以 .exe 结尾的已构建可执行文件
   * - python-file（Python）→ 项目内的入口 .py 文件
   * - python-module（Python）→ 模块名（点分标识符，非路径）
   */
  jarPath?: string
  /** true = 仅监控不可启动 */
  registerOnly: boolean
  pinned: boolean
  order: number
  createdAt: number
  lastStartedAt?: number
  lastExitCode?: number
  /**
   * 所属工作组 ID，由 group:assignEntries 或 entry:edit 写入。
   * 未设置表示该条目不属于任何工作组（仍可在「全部」视图下操作）。
   */
  groupId?: string
}

/** 新建条目时的入参，id/order/createdAt 由主进程生成 */
export type NewLaunchEntry = Omit<LaunchEntry, 'id' | 'order' | 'createdAt'> &
  Partial<Pick<LaunchEntry, 'pinned' | 'registerOnly'>>

export interface DetectResult {
  path: string
  /** 存在 package.json 才算可推断，否则只能仅登记 */
  hasPackageJson: boolean
  name: string
  framework: Framework
  packageManager: PackageManager
  scripts: Record<string, string>
  devScript: string | null
  buildScript: string | null
  /** 根目录无 dev 脚本时为 true，需用户指定子包，PRD §8.5 */
  monorepoHint: boolean
  registerOnly: boolean
  /**
   * 识别时探测到的默认启动方式，供新建向导预填 launchMode。
   * Spring Boot 有 mvnw 优先 wrapper 否则 system；Python 按入口文件/框架；Go/Rust 各自默认。
   * 命令形状推不出的生态（hugo/static 等）为 undefined。
   */
  detectedLaunchMode?: LaunchMode
  /**
   * 从 application.properties / application.yml 的 server.port 读到的端口。
   * 读不到为 undefined，靠日志捕获兜底。
   */
  detectedPort?: number
  warnings: string[]
}

export type PrecheckLevel = 'pass' | 'warn' | 'fail'

/** 修复入口的动作标识，渲染层据此决定点击行为，PRD §5.3 */
export type PrecheckFixAction =
  | 'pickDirectory'
  | 'removeEntry'
  | 'openInEditor'
  | 'pickScript'
  | 'useNpm'
  | 'createInstallSession'
  | 'showNodeRequirement'
  | 'resolvePort'
  /** 将条目的 expectedPort 切换到主进程扫描出的空闲端口 */
  | 'switchPort'

export interface PrecheckItem {
  id: string
  label: string
  level: PrecheckLevel
  detail?: string
  fix?: {
    action: PrecheckFixAction
    label: string
    /** switchPort 动作时主进程预扫描的候选空闲端口 */
    suggestedPort?: number
  }
}

export interface PrecheckResult {
  ok: boolean
  items: PrecheckItem[]
}

export type EntryStatus =
  | 'idle'
  | 'precheck'
  | 'blocked'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'crashed'
  | 'succeeded'
  | 'failed'
  /** 任务以 130 退出，即脚本自报的用户取消，PRD §4.6 */
  | 'canceled'

/**
 * 用户可编辑的字段，PRD §4.6。
 *
 * 白名单而非黑名单：`id` / `order` / `createdAt` / `lastExitCode` 这类由主进程维护的
 * 字段，一旦允许渲染层覆盖就等于把落盘结构交给了界面。
 */
export type EditableEntryField =
  | 'name'
  | 'category'
  | 'groupId'
  | 'pinned'
  | 'kind'
  | 'path'
  | 'cwd'
  | 'script'
  | 'scripts'
  | 'framework'
  | 'packageManager'
  | 'env'
  | 'icon'
  | 'imageId'
  | 'expectedPort'
  | 'outputDir'
  | 'launchMode'
  | 'jarPath'
  | 'registerOnly'

/**
 * `expectedPort`、`outputDir`、`jarPath`、`launchMode` 额外接受 null 表示「显式清空」。
 * 用 undefined 表达清空在 IPC 上不成立 —— 结构化克隆会把 undefined 的键丢掉，
 * 到了主进程就变成「没提这个字段」，值永远删不掉。
 */
export type EntryEdit = Partial<
  Omit<
    Pick<LaunchEntry, EditableEntryField>,
    'expectedPort' | 'outputDir' | 'icon' | 'imageId' | 'category' | 'groupId' | 'launchMode' | 'jarPath'
  >
> & {
  expectedPort?: number | null
  outputDir?: string | null
  /** null 是跨 IPC 显式恢复自动框架图标的哨兵值。 */
  icon?: ServiceIcon | null
  /**
   * 只接受 null —— 显式清除自定义图片，回退到 icon / favicon / 字标。
   * 设置图片不走 edit，走专用的 entry.setImage(bytes)：由主进程压缩落盘并回填文件名，
   * 渲染层无从指定任意文件名。
   */
  imageId?: null
  /** null explicitly clears the category and returns the entry to the unclassified panel. */
  category?: string | null
  /** null 显式清空工作组归属，将条目移出工作组。 */
  groupId?: string | null
  /** null 显式清空启动方式。 */
  launchMode?: LaunchMode | null
  /** null 显式清空可执行产物/入口路径。 */
  jarPath?: string | null
}

/** 条目运行态，不持久化 */
export interface EntryRuntime {
  entryId: string
  status: EntryStatus
  sessionId?: string
  pid?: number
  port?: number
  /** 服务 60s 未捕获端口但进程存活，PRD §4.3 */
  portUnknown: boolean
  startedAt?: number
  exitCode?: number
  precheck?: PrecheckResult
  /**
   * 最近一次 packageWithProfile 成功后扫描到的 jar 相对路径（相对项目根）。
   * 渲染层据此展示"打包完成"操作横幅；下一次 build 开始时清空。
   * 不持久化，key={entry.id} 切换条目时自动丢弃。
   */
  lastBuiltJar?: string
}

export interface EntryStartResult {
  ok: boolean
  precheck: PrecheckResult
  runtime?: EntryRuntime
}

export interface PortHolder {
  pid: number
  processName: string
  ownership: Ownership
  /** 仅在主进程能够按会话归属精确映射到受控条目时提供 */
  entryId?: string
}

export interface EntryDiagnosis {
  entryId: string
  precheck: PrecheckResult
  /** 被诊断的预期端口，无则 null */
  port: number | null
  /** 预期端口现状，无预期端口或空闲时为 null */
  portHolder: PortHolder | null
  lastExitCode?: number
  lastStartedAt?: number
  /** 上次运行时长（毫秒），未运行过为 undefined */
  lastRunMs?: number
  firstErrorLine?: string
  node: string
  packageManager: PackageManager
  /** 包管理器可执行文件路径，PATH 中找不到时为 null */
  packageManagerPath: string | null
  /** 只给键名，绝不含值，PRD §4.4 */
  envKeys: string[]
  /** 任务产物目录，不存在为 null */
  outputDir: string | null
}
