import type { LaunchMode, LaunchSource, PackageManager, Settings } from '@shared/types'

/**
 * 平台适配层的数据结构与接口（docs/MACOS-PORTING.md §4）。
 *
 * 只有这一层知道 netstat / lsof、taskkill / 进程组、cmd.exe 包装这些平台细节；
 * 服务层依赖 `Platform` 接口，不再直接调用任何平台命令。判定逻辑（归属三重凭据、
 * 预检、命令白名单）留在服务层，两个平台共用一份。
 */

export interface ProcessRow {
  pid: number
  ppid: number
  name: string
  execPath?: string
  commandLine?: string
  /** Unix ms，用于识别 PID 复用 */
  startedAt?: number
}

export interface ListenRow {
  port: number
  pid: number
}

export interface ProcessMeta {
  byPid: Map<number, ProcessRow>
  /** 当前用户的所有 PID（Windows：登录会话关联；macOS：uid 相同） */
  mine: Set<number>
  at: number
}

export interface ProcessTable extends ProcessMeta {
  listens: ListenRow[]
}

export type TerminalKind = Settings['externalTerminal']

/** 主进程按名字查 PATH 的可执行文件。名字是常量，用户不能指定 */
export type BinaryName = PackageManager | 'java' | 'mvn' | 'gradle' | 'python' | 'go' | 'cargo'

/** 启动来源推断用的进程名表，只用于展示，绝不参与终止授权（红线 2） */
export interface AttributionTables {
  /** 上溯时跳过的中间层：shell、包管理器、运行时包装 */
  transparent: ReadonlySet<string>
  sourceByName: readonly { source: LaunchSource; names: string[] }[]
  sourceByCmd: readonly { source: LaunchSource; needles: string[] }[]
  /** 监听端口时默认归「我的服务」的开发运行时 */
  devRuntime: ReadonlySet<string>
  /** 执行路径落在这些目录下的进程默认归后台（小写比较） */
  systemDirs: readonly string[]
}

export interface Platform {
  id: 'win32' | 'darwin'

  // ── 进程采集 ──
  readListenPorts(timeoutMs?: number): Promise<ListenRow[]>
  readProcessMeta(timeoutMs?: number): Promise<ProcessMeta>
  /** 终止会话进程树；resolve 时信号已发完并确认结束（或到达上限） */
  killTree(rootPid: number): Promise<void>

  // ── 命令构造 ──
  binaries: Readonly<Record<BinaryName, string[]>>
  /** 项目自带的构建 wrapper 文件名 */
  wrapperFile: { maven: string; gradle: string }
  /**
   * 批处理类可执行文件（npm.cmd、mvnw.cmd）的包装。Windows 必须经 `cmd /d /s /c` 转发，
   * macOS 原样返回。参数始终是数组，不拼字符串（红线 3）。
   */
  wrapBatch(file: string, args: string[]): { file: string; args: string[] }
  /** 这些启动方式在本平台首版不支持，条目只能「仅登记」 */
  unsupportedLaunchModes: ReadonlySet<LaunchMode>
  /** 项目内可执行文件（wrapper）是否要求执行位 */
  requiresExecBit: boolean
  /** HBuilderX 命令行的探测位置；空数组表示本平台不支持 */
  hbuilderxCandidates(): string[]

  // ── 终端 ──
  /** 自建终端用的 shell 与界面上的默认标题 */
  defaultShell(): { file: string; title: string }
  /** 拉起这个 shell 的固定参数（PowerShell：-NoLogo -NoExit；zsh / bash：-l） */
  shellArgs(file: string): string[]
  /** 新会话启动后先写入的初始化命令（Windows PowerShell 切 UTF-8），没有就返回 null */
  shellInit(file: string): string | null
  terminalKinds: readonly TerminalKind[]
  defaultTerminal: TerminalKind
  openExternalTerminal(kind: TerminalKind, cwd: string): void

  // ── 路径与环境 ──
  /** 路径比较键：Windows 不区分大小写，macOS 保留大小写 */
  pathKey(p: string): string
  /**
   * 启动时补全 PATH（macOS GUI 应用拿不到 shell 里的 PATH）；Windows 不做任何事。
   * 必须同步返回：whenReady 回调里一旦 await，建窗口就晚了一拍，依赖窗口的初始化顺序全变。
   * 固定目录立即生效；登录 shell 那一路（设置项默认关）在后台读，读到再合并。
   */
  preparePath(opts: { loginShellPath: boolean }): void

  attribution: AttributionTables

  // ── 外壳 ──
  globalHotkey: string
}
