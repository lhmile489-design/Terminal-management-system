import type { LogLevel, LogLine, LogQuery, LogResult } from '@shared/types'
import type { SessionService } from './SessionService'
import { CURSOR_TO_COL1, ERROR_RE, WARN_RE, lastVisiblePaint } from '../lib/outputText'

/**
 * 日志中心，PRD §4.8。
 *
 * SessionService 的 buffer 是每个会话各自一条原始 ANSI 流，只够喂给 xterm 重放；
 * 「跨会话按级别筛、搜关键字」需要的是切好的行。因此这里另建一个全局环形缓冲，
 * 与终端视图共用同一个 data 事件，不改动会话本身的存储。
 *
 * 只留在内存：日志落盘就得连带处理保留期、体积上限与「里面可能有密钥」这些问题，
 * 而这个工具的用途是看当下这轮跑得怎么样，不是审计。
 */
const MAX_LINES = 5000
const MAX_LINE_CHARS = 500
/** 退出后再等一小会儿收尾，容纳晚于 exit 到达的末尾数据。见 scheduleFinalFlush */
const FINAL_FLUSH_MS = 120

export class LogService {
  private lines: LogLine[] = []
  private seq = 0
  /** 已被环形缓冲挤掉的行数，界面要能说明「只保留最近 N 行」 */
  private dropped = 0
  /** 每个会话尚未收到换行的残段。不缓存就会把一行拆成两条 */
  private partial = new Map<string, string>()
  /** 已退出会话的收尾计时器，见 scheduleFinalFlush */
  private finalizers = new Map<string, NodeJS.Timeout>()

  constructor(private sessions: SessionService) {
    this.sessions.on('data', ({ id, chunk }: { id: string; chunk: string }) =>
      this.absorb(id, chunk)
    )
    // 会话退出时把残段收尾，否则最后一行（往往正是错误摘要）永远不出现
    this.sessions.on('exit', ({ id }: { id: string }) => this.scheduleFinalFlush(id))
  }

  private absorb(sessionId: string, chunk: string): void {
    const text = ((this.partial.get(sessionId) ?? '') + chunk).replace(CURSOR_TO_COL1, '\n')
    const parts = text.split(/\r?\n/)
    // 最后一段没有换行结尾，留着等下一块
    this.partial.set(sessionId, parts.pop() ?? '')
    for (const raw of parts) this.push(sessionId, raw)
    // 退出后又来了数据：把收尾推后，否则这一段会永远留在 partial 里
    if (this.finalizers.has(sessionId)) this.scheduleFinalFlush(sessionId)
  }

  /**
   * 会话退出后延迟收尾。
   *
   * exit 不保证晚于最后一块 data：ConPTY 的退出事件和 SessionService 的 16ms 合并
   * 刷新是两条独立路径，末尾那块常常在 exit 之后才到。收到 exit 就立刻清 partial
   * 的话，末行会被丢掉，而且是间歇性的 —— 这种偶发比稳定失败更难查。
   */
  private scheduleFinalFlush(sessionId: string): void {
    const pending = this.finalizers.get(sessionId)
    if (pending) clearTimeout(pending)
    this.finalizers.set(
      sessionId,
      setTimeout(() => {
        this.finalizers.delete(sessionId)
        const rest = this.partial.get(sessionId)
        this.partial.delete(sessionId)
        if (rest) this.push(sessionId, rest)
      }, FINAL_FLUSH_MS)
    )
  }

  private push(sessionId: string, raw: string): void {
    const text = lastVisiblePaint(raw)
    if (!text) return

    const meta = this.sessions.list().find((s) => s.id === sessionId)
    this.lines.push({
      seq: ++this.seq,
      sessionId,
      entryId: meta?.projectId ?? null,
      title: meta?.title ?? sessionId,
      ts: Date.now(),
      level: level(text),
      text: text.slice(0, MAX_LINE_CHARS)
    })

    if (this.lines.length > MAX_LINES) {
      const cut = this.lines.length - MAX_LINES
      this.lines.splice(0, cut)
      this.dropped += cut
    }
  }

  /**
   * 倒序取最近的行。筛选在主进程做而不是把 5000 行整体下发 ——
   * 渲染层拿到的始终是它要显示的那一屏。
   */
  query(q: LogQuery): LogResult {
    const limit = clampLimit(q.limit)
    const needle = typeof q.text === 'string' ? q.text.trim().toLowerCase() : ''
    const matched: LogLine[] = []
    let total = 0

    for (let i = this.lines.length - 1; i >= 0; i--) {
      const line = this.lines[i]
      if (q.sessionId && line.sessionId !== q.sessionId) continue
      if (q.entryId && line.entryId !== q.entryId) continue
      if (q.level && line.level !== q.level) continue
      if (needle && !line.text.toLowerCase().includes(needle)) continue
      total++
      if (matched.length < limit) matched.push(line)
    }

    return {
      lines: matched.reverse(),
      total,
      dropped: this.dropped,
      capacity: MAX_LINES,
      sources: this.sources()
    }
  }

  /** 出现过日志的会话，供界面出下拉。已退出的会话也留着 —— 崩溃后正要看它 */
  private sources(): LogResult['sources'] {
    const seen = new Map<string, { sessionId: string; title: string; count: number }>()
    for (const line of this.lines) {
      const hit = seen.get(line.sessionId)
      if (hit) hit.count++
      else seen.set(line.sessionId, { sessionId: line.sessionId, title: line.title, count: 1 })
    }
    return [...seen.values()]
  }

  clear(): void {
    this.lines = []
    this.dropped = 0
    this.partial.clear()
    // 挂着的收尾会把刚清掉的残段再写回来，用户点了清空却又冒出一行
    for (const t of this.finalizers.values()) clearTimeout(t)
    this.finalizers.clear()
  }
}

function level(text: string): LogLevel {
  if (ERROR_RE.test(text)) return 'error'
  if (WARN_RE.test(text)) return 'warn'
  return 'info'
}

function clampLimit(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return 300
  return Math.min(Math.max(Math.trunc(n), 1), MAX_LINES)
}
