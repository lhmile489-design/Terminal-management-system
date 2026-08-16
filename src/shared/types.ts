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
}

/** 当前配置结构版本。加字段就要加迁移，见 ConfigStore.migrate */
export const CONFIG_VERSION = 5

/** 用户手动改过分组的进程，PRD §5.2。按进程名而非 PID —— PID 每次重启都换 */
export interface GroupOverride {
  processName: string
  group: ListenerGroup
}

export interface AppConfig {
  version: number
  entries: LaunchEntry[]
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
  // 以下均非 npm 生态：能识别、能登记，但推不出 `pm run` 形式的命令，一律仅登记
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
  | 'static'
  | 'unknown'

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

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
  /** true = 仅监控不可启动 */
  registerOnly: boolean
  pinned: boolean
  order: number
  createdAt: number
  lastStartedAt?: number
  lastExitCode?: number
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

export interface PrecheckItem {
  id: string
  label: string
  level: PrecheckLevel
  detail?: string
  fix?: { action: PrecheckFixAction; label: string }
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
  | 'expectedPort'
  | 'outputDir'
  | 'registerOnly'

/**
 * `expectedPort` 与 `outputDir` 额外接受 null 表示「显式清空」。
 * 用 undefined 表达清空在 IPC 上不成立 —— 结构化克隆会把 undefined 的键丢掉，
 * 到了主进程就变成「没提这个字段」，端口永远删不掉。
 */
export type EntryEdit = Partial<
  Omit<Pick<LaunchEntry, EditableEntryField>, 'expectedPort' | 'outputDir' | 'icon' | 'category'>
> & {
  expectedPort?: number | null
  outputDir?: string | null
  /** null 是跨 IPC 显式恢复自动框架图标的哨兵值。 */
  icon?: ServiceIcon | null
  /** null explicitly clears the category and returns the entry to the unclassified panel. */
  category?: string | null
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
