import type { LogLevel, LogLine, LogQuery, LogResult } from '@shared/types'
import type { SessionService } from './SessionService'

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

/*
 * 转义序列一律写成 \x1b 这种可见形式，不敲字面 ESC 字节 —— 字面控制字符在
 * 编辑、复制、diff 与补丁里都会悄悄丢掉，那时正则会静默地什么都不匹配。
 * CSI：颜色与光标移动。OSC：设置窗口标题，以 BEL 或 ST 收尾。
 */
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
/** 剩下的裸控制字符（退格、响铃…）留着会在界面上显示成方块 */
const CONTROL = /[\x00-\x08\x0b-\x1f]/g

/*
 * ConPTY 换行不一定发 \n：它常用绝对光标定位跳到下一行行首（实测 \x1b[5;1H）。
 * 只按 \r?\n 切，两条逻辑行就会粘成一条。这里只认「回到第 1 列」这种形式 ——
 * 那正是换行的语义；定位到其他列是同一行内的重绘，切开反而会把一行拆碎。
 */
const CURSOR_TO_COL1 = /\x1b\[[0-9]+;1[Hf]/g

/** 行级别。只认明确的词形，拿不准就算 info —— 宁可少标，不要把普通输出染成红的 */
const ERROR_RE =
  /\b(error|err!|failed|failure|exception|cannot find|not found|ELIFECYCLE|ENOENT|EADDRINUSE)\b|错误|失败/i
const WARN_RE = /\b(warn|warning|deprecated|deprecation)\b|警告/i

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

/**
 * 取这一行最后一次「画出了东西」的重绘结果。
 *
 * 进度条用裸 \r 原地重写同一行，整块留下来就是几百条几乎一样的行，所以要取最后一段。
 * 但 ConPTY 在输出末尾还会补一个 \r + 擦除序列（实测 \r\x1b[K），那一段清理完是空的；
 * 若直接采信它，末行就会被整条丢掉 —— 而末行往往正是错误摘要。因此从后往前找，
 * 用第一个「清理后仍有可见内容」的段。
 */
function lastVisiblePaint(raw: string): string {
  const paints = raw.split('\r')
  for (let i = paints.length - 1; i >= 0; i--) {
    const text = paints[i].replace(ANSI, '').replace(CONTROL, '').trimEnd()
    if (text.trim()) return text
  }
  return ''
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
