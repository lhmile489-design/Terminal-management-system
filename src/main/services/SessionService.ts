import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { spawn as spawnPty, type IPty } from 'node-pty'
import type { CreateSessionInput, SessionMeta } from '@shared/types'
import { defaultShell, shellLaunchArgs } from '../lib/shell'
import type { OwnershipService } from './OwnershipService'

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

  constructor(private ownership: OwnershipService) {
    super()
  }

  create(input: CreateSessionInput): SessionMeta {
    const file = input.file ?? defaultShell()
    const args = input.args ?? shellLaunchArgs(file)
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

    // ConPTY 默认代码页 936，中文与进度条会乱码
    if (isPowerShell(file)) {
      pty.write("chcp 65001 > $null; [Console]::OutputEncoding = [Text.Encoding]::UTF8; Clear-Host\r")
    }

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
    if (!entry || cols < 1 || rows < 1) return
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
    entry.pty.write('\x03')
    setTimeout(() => this.kill(id), 3000)
  }

  kill(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    const { pid, status } = entry.meta
    // 会话已退出则 PID 可能被系统回收复用，此时 taskkill 就是误杀
    if (status === 'stopped' || status === 'crashed') {
      this.ownership.unregister(id)
      return
    }

    // Vite/webpack 会拉起子进程，pty.kill() 只结束 conhost 根进程，必须带树终止
    try {
      execFile(
        'taskkill.exe',
        ['/PID', String(pid), '/T', '/F'],
        { windowsHide: true },
        () => undefined
      )
    } catch {
      // taskkill 不可用时退回 pty.kill
    }
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

  disposeAll(): void {
    for (const id of this.entries.keys()) this.kill(id)
    this.entries.clear()
  }
}

function isPowerShell(file: string): boolean {
  return /powershell\.exe$|pwsh\.exe$/i.test(file)
}
