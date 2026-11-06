import { EventEmitter } from 'node:events'
import { homedir } from 'node:os'
import { spawn as spawnPty, type IPty } from 'node-pty'
import type { CreateSessionInput, SessionMeta } from '@shared/types'
import { platform } from '../platform'
import type { OwnershipService } from './OwnershipService'
import type { ScannerService } from './ScannerService'

const MAX_BUFFER_CHARS = 400_000
const FLUSH_INTERVAL_MS = 16

interface Entry {
  meta: SessionMeta
  pty: IPty
  /** 绝不下发渲染层，见 PRD §11 */
  runToken: string
  buffer: string
  pending: string
  flushTimer: NodeJS.Timeout | null
}

let seq = 0
const nextId = (): string => `s${++seq}-${Date.now().toString(36)}`

export class SessionService extends EventEmitter {
  private entries = new Map<string, Entry>()
  /** 后注入（scanner 晚于 sessions 构建），用于 kill 前重校验归属，PRD §6.3 步骤 4 */
  private scanner: ScannerService | null = null

  constructor(private ownership: OwnershipService) {
    super()
  }

  /** 由 index.ts 在 app.whenReady 里调用，避免构造时的循环依赖 */
  setScanner(scanner: ScannerService): void {
    this.scanner = scanner
  }

  /**
   * IPC 的「新建终端」入口：只认 kind 与标题，shell、参数、目录全部由主进程定。
   * 不要把 IPC 入参直接交给 create() —— 那等于让渲染层指定任意可执行文件，PRD §11。
   */
  createShell(input: unknown, at?: { cwd: string; title: string }): SessionMeta {
    const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
    if (raw.kind !== 'shell') throw new Error('自由终端只允许 shell')
    const shell = platform.defaultShell()
    const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 80) : shell.title
    const file = shell.file
    // at 只由主进程传入（EntryService.terminalCwd 解析并校验过的条目目录），渲染层给不了
    return this.create({
      kind: 'shell',
      file,
      args: platform.shellArgs(file),
      cwd: at?.cwd ?? homedir(),
      title: at?.title ?? title
    })
  }

  /** 主进程内部入口，调用方负责构造可信的完整规格 */
  create(input: CreateSessionInput): SessionMeta {
    const file = input.file ?? platform.defaultShell().file
    const args = input.args ?? platform.shellArgs(file)
    const cwd = input.cwd ?? homedir()
    const id = nextId()
    const runToken = this.ownership.issueToken()

    const pty = spawnPty(file, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env: {
        ...(process.env as Record<string, string>),
        ...input.env,
        MILE_RUN_TOKEN: runToken,
        MILE_SESSION_ID: id,
        LANG: 'zh_CN.UTF-8',
        LC_ALL: 'zh_CN.UTF-8',
        PYTHONIOENCODING: 'utf-8',
        FORCE_COLOR: '1',
        TERM: 'xterm-256color',
        /*
         * 关掉 npm 自己的转轮进度。它用 \r 反复重绘同一行，会把紧挨着它、
         * 又没有换行结尾的真实输出直接擦掉（实测末行 `TAILMARK` 被 `⠙\x1b[K` 覆盖），
         * 并在日志里留下一堆只有转轮字符的行。这是 npm 的显示开关，不改项目行为。
         */
        npm_config_progress: 'false'
      },
      // 只在 Windows 生效，其他平台 node-pty 忽略这个选项
      useConpty: true
    })

    const meta: SessionMeta = {
      id,
      projectId: input.projectId ?? null,
      kind: input.kind,
      title: input.title ?? input.kind,
      command: [file, ...args].join(' '),
      cwd,
      pid: pty.pid,
      status: 'starting',
      startedAt: Date.now()
    }

    const entry: Entry = { meta, pty, runToken, buffer: '', pending: '', flushTimer: null }
    this.entries.set(meta.id, entry)
    this.ownership.register(meta.id, pty.pid, runToken)

    pty.onData((chunk) => this.absorb(entry, chunk))
    pty.onExit(({ exitCode, signal }) => {
      this.flush(entry)
      entry.meta.status = exitCode === 0 ? 'stopped' : 'crashed'
      entry.meta.exitCode = exitCode
      this.ownership.unregister(entry.meta.id)
      this.emit('exit', { id: entry.meta.id, exitCode, signal })
    })

    // Windows PowerShell 要先切 UTF-8（ConPTY 默认代码页 936）；macOS 的 shell 本身就是 UTF-8
    const init = platform.shellInit(file)
    if (init) pty.write(init)

    return meta
  }

  private absorb(entry: Entry, chunk: string): void {
    entry.pending += chunk
    if (entry.flushTimer) return
    entry.flushTimer = setTimeout(() => this.flush(entry), FLUSH_INTERVAL_MS)
  }

  private flush(entry: Entry): void {
    if (entry.flushTimer) {
      clearTimeout(entry.flushTimer)
      entry.flushTimer = null
    }
    if (!entry.pending) return

    const chunk = entry.pending
    entry.pending = ''
    entry.buffer = (entry.buffer + chunk).slice(-MAX_BUFFER_CHARS)

    if (entry.meta.status === 'starting') entry.meta.status = 'running'
    this.emit('data', { id: entry.meta.id, chunk })
  }

  write(id: string, data: string): void {
    this.entries.get(id)?.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const entry = this.entries.get(id)
    if (
      !entry ||
      !Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      cols < 1 ||
      rows < 1 ||
      cols > 1000 ||
      rows > 1000
    )
      return
    try {
      entry.pty.resize(cols, rows)
    } catch {
      // pty 已退出，忽略
    }
  }

  history(id: string): string {
    const entry = this.entries.get(id)
    if (!entry) return ''
    return entry.buffer + entry.pending
  }

  list(): SessionMeta[] {
    return [...this.entries.values()].map((e) => e.meta)
  }

  stop(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    try {
      entry.pty.write('\x03')
    } catch {
      // pty 已退出，\x03 无法写入，3s 后 kill 仍会执行
    }
    setTimeout(() => this.kill(id), 3000)
  }

  /** 返回的 Promise 在 taskkill 结束后才 resolve；退出清理要等它，普通调用方可以不等 */
  kill(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return Promise.resolve()
    const { pid, status } = entry.meta
    // 会话已退出则 PID 可能被系统回收复用，此时 taskkill 就是误杀
    if (status === 'stopped' || status === 'crashed') {
      this.ownership.unregister(id)
      return Promise.resolve()
    }
    // PRD §6.3 步骤 4：kill 前重新验证归属，防止 3s 等待期间 PID 被回收复用后误杀。
    // scanner 未注入（极早期 disposeAll）时无法重校验，doKill 拒绝 kill、只清理登记
    return this.doKill(id, pid, entry)
  }

  private async doKill(id: string, pid: number, entry: Entry): Promise<void> {
    // scanner 未注入就无法做归属重校验：宁可留下进程也不冒误杀风险，只清理登记
    if (!this.scanner) {
      this.ownership.unregister(id)
      return
    }
    try {
      const table = await this.scanner.table([pid])
      await this.ownership.assertKillable(pid, table, id)
    } catch {
      // 重校验拒绝（归属变化或 PID 已复用）：取消 kill，仅清理会话登记
      this.ownership.unregister(id)
      return
    }

    // Vite/webpack 会拉起子进程，pty.kill() 只结束根进程，必须带树终止。
    // 等平台层确认结束再往下走：退出清理靠这一步确认进程树已结束
    // （Windows：taskkill /T /F；macOS：进程组 SIGTERM → SIGKILL）
    await platform.killTree(pid)
    try {
      entry.pty.kill()
    } catch {
      // 已退出
    }
    this.ownership.unregister(id)
  }

  ownedPids(): number[] {
    return [...this.entries.values()]
      .filter((e) => e.meta.status !== 'stopped' && e.meta.status !== 'crashed')
      .map((e) => e.meta.pid)
  }

  sessionIdByPid(pid: number): string | null {
    for (const e of this.entries.values()) if (e.meta.pid === pid) return e.meta.id
    return null
  }

  /** 还活着的会话数，退出流程据此决定要不要等清理 */
  liveCount(): number {
    return this.ownedPids().length
  }

  /** 终止全部会话的进程树；resolve 时每个 taskkill 都已返回 */
  async disposeAll(): Promise<void> {
    const ids = [...this.entries.keys()]
    await Promise.all(ids.map((id) => this.kill(id)))
    this.entries.clear()
  }
}
