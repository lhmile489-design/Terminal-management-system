import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowsClockwise, Broom, MagnifyingGlass, X } from '@phosphor-icons/react'
import type { LogLevel, LogResult } from '@shared/types'
import { StatusPill } from '../components/StatusPill'
import type { Tone } from '../lib/entryMeta'

const LEVELS: { value: LogLevel | 'all'; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'error', label: '错误' },
  { value: 'warn', label: '警告' },
  { value: 'info', label: '普通' }
]

const LEVEL_TONE: Record<LogLevel, Tone> = { info: 'idle', warn: 'warn', error: 'fault' }
const LEVEL_LABEL: Record<LogLevel, string> = { info: 'INFO', warn: 'WARN', error: 'ERROR' }

const PAGE = 300
const POLL_MS = 1000

const EMPTY: LogResult = { lines: [], total: 0, dropped: 0, capacity: 0, sources: [] }

/**
 * 日志中心，PRD §4.8。
 *
 * 筛选条件整体交给主进程，界面只渲染回来的那一屏 —— 不在渲染层缓存全量再本地过滤，
 * 否则「显示的」和「主进程里有的」会随时间偏离。
 */
export function LogCenter(): React.JSX.Element {
  const [level, setLevel] = useState<LogLevel | 'all'>('all')
  const [sessionId, setSessionId] = useState<string>('all')
  const [text, setText] = useState('')
  const [follow, setFollow] = useState(true)
  const [result, setResult] = useState<LogResult>(EMPTY)
  const scrollRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    const next = await window.mile.log.query({
      level: level === 'all' ? null : level,
      sessionId: sessionId === 'all' ? null : sessionId,
      text: text.trim() ? text : null,
      limit: PAGE
    })
    setResult(next)
  }, [level, sessionId, text])

  // 轮询而不是推送：日志行的产生速率是每秒几百条，逐条推 IPC 只会把渲染层压住。
  // 界面每秒重取一屏，代价固定，而且筛选条件变了也走同一条路径。
  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(timer)
  }, [load])

  // 跟随时贴住底部。用户往上翻就自动松开 —— 一边看历史一边被拽回底部是最烦的
  useEffect(() => {
    if (!follow) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [result, follow])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    if (atBottom !== follow) setFollow(atBottom)
  }

  const counts = useMemo(() => {
    const out = { info: 0, warn: 0, error: 0 }
    for (const line of result.lines) out[line.level]++
    return out
  }, [result.lines])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <section aria-labelledby="log-filter-heading" className="flex flex-col gap-3">
        <h2 id="log-filter-heading" className="eyebrow">
          Filters · 筛选
        </h2>

        <div className="flex flex-wrap items-center gap-2.5">
          <div role="radiogroup" aria-label="日志级别筛选" className="segmented">
            {LEVELS.map((l) => (
              <button
                key={l.value}
                type="button"
                role="radio"
                aria-checked={l.value === level}
                onClick={() => setLevel(l.value)}
                className="segmented-item"
              >
                {l.label}
              </button>
            ))}
          </div>

          <label className="flex items-center gap-2 text-[12px] text-ink-muted">
            <span className="font-mono text-[11px] text-ink-faint">会话</span>
            <select
              aria-label="按会话筛选"
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
              className="rounded-[6px] border border-line-strong bg-card px-2 py-1.5 text-[12px] text-ink"
            >
              <option value="all">全部会话（{result.sources.length}）</option>
              {result.sources.map((s) => (
                <option key={s.sessionId} value={s.sessionId}>
                  {s.title}（{s.count}）
                </option>
              ))}
            </select>
          </label>

          <div className="flex min-w-[220px] flex-1 items-center gap-2 rounded-[6px] border border-line-strong bg-card px-2.5 py-1.5">
            <MagnifyingGlass size={13} weight="bold" className="shrink-0 text-ink-faint" />
            <input
              type="search"
              aria-label="搜索日志内容"
              placeholder="搜索关键字"
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-ink-faint"
            />
            {text && (
              <button
                type="button"
                aria-label="清空搜索"
                title="清空搜索"
                onClick={() => setText('')}
                className="pressable shrink-0 text-ink-faint hover:text-ink-strong"
              >
                <X size={12} weight="bold" />
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={() => void load()}
            className="pressable flex items-center gap-1.5 rounded-[6px] border border-line-strong bg-card px-2.5 py-1.5 text-[12px] text-ink-muted hover:text-ink-strong"
          >
            <ArrowsClockwise size={13} weight="bold" />
            刷新
          </button>
          <button
            type="button"
            onClick={() => {
              window.mile.log.clear()
              void load()
            }}
            className="pressable flex items-center gap-1.5 rounded-[6px] border border-line-strong bg-card px-2.5 py-1.5 text-[12px] text-ink-muted hover:text-ink-strong"
          >
            <Broom size={13} weight="bold" />
            清空日志
          </button>
        </div>
      </section>

      <section aria-labelledby="log-stream-heading" className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="log-stream-heading" className="eyebrow eyebrow-tight">
            Stream · 日志流
            <span className="ml-2 font-mono text-ink-faint">
              {result.lines.length}
              {result.total > result.lines.length && ` / ${result.total}`}
            </span>
          </h2>

          <div className="flex items-center gap-2">
            <StatusPill tone="fault" label={`错误 ${counts.error}`} />
            <StatusPill tone="warn" label={`警告 ${counts.warn}`} />
            <StatusPill tone="idle" label={`普通 ${counts.info}`} />
            {/* 跟随状态要能看见也能点回来，否则用户翻过历史就不知道怎么恢复自动滚动 */}
            <button
              type="button"
              aria-pressed={follow}
              onClick={() => setFollow(true)}
              title={follow ? '正在跟随最新输出' : '点击回到底部并继续跟随'}
              className={`pressable rounded-[6px] border px-2 py-1 font-mono text-[10px] font-bold ${
                follow
                  ? 'border-line-strong bg-raised text-ink-strong'
                  : 'border-line-strong bg-card text-ink-muted hover:text-ink-strong'
              }`}
            >
              {follow ? '跟随中' : '已暂停'}
            </button>
          </div>
        </div>

        <div
          ref={scrollRef}
          onScroll={onScroll}
          role="log"
          aria-label="日志输出"
          className="surface-card min-h-0 flex-1 overflow-y-auto px-4 py-3"
        >
          {result.lines.length === 0 ? (
            <p className="py-8 text-center text-[12.5px] text-ink-faint">
              {result.sources.length === 0
                ? '还没有任何会话输出。启动一个服务或任务后，这里会实时汇总它们的日志。'
                : '没有符合当前筛选条件的日志行。'}
            </p>
          ) : (
            <ol className="flex flex-col gap-px">
              {result.lines.map((line) => (
                <li
                  key={line.seq}
                  className="grid grid-cols-[auto_auto_1fr] items-baseline gap-x-2.5 rounded-[4px] px-1.5 py-0.5 hover:bg-raised"
                >
                  <time
                    dateTime={new Date(line.ts).toISOString()}
                    className="font-mono text-[10.5px] text-ink-faint"
                  >
                    {clock(line.ts)}
                  </time>
                  {/* 悬停能看出这行来自哪个会话，省掉一列固定占宽的来源名 */}
                  <span title={line.title}>
                    <StatusPill
                      tone={LEVEL_TONE[line.level]}
                      label={LEVEL_LABEL[line.level]}
                      dot={false}
                    />
                  </span>
                  {/* 日志正文一律等宽 + 保留空白：缩进和对齐本身就是输出的一部分 */}
                  <span className="font-mono text-[11.5px] break-all whitespace-pre-wrap text-ink">
                    {line.text}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>

        {result.dropped > 0 && (
          <p className="text-[11px] text-ink-faint">
            只保留最近 {result.capacity} 行，已滚掉 {result.dropped} 行。完整输出请到终端视图查看。
          </p>
        )}
      </section>
    </div>
  )
}

function clock(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
