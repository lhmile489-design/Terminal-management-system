import { useState } from 'react'
import { CaretRight, Trash } from '@phosphor-icons/react'
import type { ListenerSnapshot } from '@shared/types'
import { useScanner } from '../store/scanner'
import { formatBytes } from '../lib/format'

export type EventLevel = 'live' | 'warn' | 'fault' | 'info'

type LoadMetric = 'cpu' | 'memory'

export interface ActivityEvent {
  id: string
  at: number
  level: EventLevel
  text: string
}

/** 事件圆点与卡片状态同一套色，走 --glow 复用 .status-dot */
const DOT: Record<EventLevel, string> = {
  live: 'var(--signal-live)',
  warn: 'var(--signal-warn)',
  fault: 'var(--signal-fault)',
  info: 'var(--signal-info)'
}

export function ActivitySidebar({
  events,
  onClear
}: {
  events: ActivityEvent[]
  onClear: () => void
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  const [metric, setMetric] = useState<LoadMetric>('memory')
  const listeners = useScanner((s) => s.listeners)

  // 展开条贴着窗口右缘，缩放会在边上露出画布，按压只换底色
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        aria-label="展开实时动态"
        className="flex w-9 shrink-0 items-start justify-center border-l border-line bg-panel pt-4 text-ink-faint transition-colors hover:bg-raised hover:text-ink active:bg-line-strong"
      >
        <CaretRight size={14} weight="bold" className="rotate-180" />
      </button>
    )
  }

  return (
    <aside
      aria-label="实时动态"
      className="flex w-80 shrink-0 flex-col gap-5 overflow-y-auto border-l border-line bg-panel px-4 py-4"
    >
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="eyebrow">Activity</h2>
          <div className="flex items-center gap-1">
            <IconAction label="清空事件" onClick={onClear}>
              <Trash size={13} />
            </IconAction>
            <IconAction label="折叠侧栏" onClick={() => setCollapsed(true)}>
              <CaretRight size={13} weight="bold" />
            </IconAction>
          </div>
        </div>

        {events.length === 0 ? (
          <Empty>暂无事件。启动或停止服务后会记录在此。</Empty>
        ) : (
          <ol className="flex flex-col gap-2.5">
            {events.map((e) => (
              <li key={e.id} className="flex gap-2.5">
                <span
                  className="status-dot mt-[6px]"
                  data-halo={e.level === 'live' || e.level === 'fault' || undefined}
                  style={{ '--glow': DOT[e.level] } as React.CSSProperties}
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] leading-snug text-ink">{e.text}</span>
                  <time className="font-mono text-[10.5px] text-ink-faint">
                    {new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false })}
                  </time>
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <Divider />

      <section>
        <h2 className="eyebrow mb-3">Ports · Top 5</h2>
        <TopList
          rows={topByPorts(listeners)}
          empty="等待采集数据。"
          format={(l) => `${l.ports.length} 个端口`}
        />
      </section>

      <Divider />

      <section>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="eyebrow">Load · Top 5</h2>
          {/* CPU / 内存可切，PRD §9.3 */}
          <div role="radiogroup" aria-label="负载指标" className="segmented">
            {(['cpu', 'memory'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={metric === m}
                aria-label={m === 'cpu' ? '按 CPU 排序' : '按内存排序'}
                onClick={() => setMetric(m)}
                className="segmented-item font-mono text-[10px] tracking-[0.08em]"
              >
                {m === 'cpu' ? 'CPU' : 'MEM'}
              </button>
            ))}
          </div>
        </div>
        <TopList
          rows={topByLoad(listeners, metric)}
          empty="等待采集数据。"
          weight={(l) => (metric === 'cpu' ? (l.cpu ?? 0) : l.memory)}
          format={(l) =>
            metric === 'cpu' ? (l.cpu === null ? '—' : `${l.cpu.toFixed(1)}%`) : formatBytes(l.memory)
          }
        />
      </section>
    </aside>
  )
}

function IconAction({
  label,
  onClick,
  children
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="pressable flex h-6 w-6 items-center justify-center rounded-[5px] text-ink-faint hover:bg-raised hover:text-ink"
    >
      {children}
    </button>
  )
}

function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="text-[12.5px] leading-relaxed text-ink-faint">{children}</p>
}

function topByPorts(listeners: ListenerSnapshot[]): ListenerSnapshot[] {
  return [...listeners].sort((a, b) => b.ports.length - a.ports.length).slice(0, 5)
}

/** 首轮 CPU 无增量基线为 null，按 0 参与排序，不要当成最高 */
function topByLoad(listeners: ListenerSnapshot[], metric: LoadMetric): ListenerSnapshot[] {
  const weigh = (l: ListenerSnapshot): number => (metric === 'cpu' ? (l.cpu ?? 0) : l.memory)
  return [...listeners].sort((a, b) => weigh(b) - weigh(a)).slice(0, 5)
}

function TopList({
  rows,
  empty,
  format,
  weight
}: {
  rows: ListenerSnapshot[]
  empty: string
  format: (l: ListenerSnapshot) => string
  /** 条形长度依据，缺省用内存 */
  weight?: (l: ListenerSnapshot) => number
}): React.JSX.Element {
  if (rows.length === 0) return <Empty>{empty}</Empty>

  const weigh = weight ?? ((l: ListenerSnapshot): number => l.memory)
  const max = Math.max(...rows.map(weigh), 1)

  return (
    <ol className="flex flex-col gap-2">
      {rows.map((l) => (
        <li key={l.pid} className="flex flex-col gap-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate text-[12.5px] text-ink" title={l.processName}>
              {l.cwd ? l.cwd.split(/[\\/]/).pop() : l.processName}
            </span>
            <span className="shrink-0 font-mono text-[11px] text-ink-faint">{format(l)}</span>
          </span>
          <span className="load-track" aria-hidden>
            <span
              className="load-fill"
              style={{ width: `${Math.round((weigh(l) / max) * 100)}%` }}
            />
          </span>
        </li>
      ))}
    </ol>
  )
}

function Divider(): React.JSX.Element {
  return <hr className="border-line" />
}
