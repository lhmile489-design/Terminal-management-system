import { useState } from 'react'
import type { ListenerSnapshot } from '@shared/types'
import { useScanner } from '../store/scanner'
import { formatBytes } from '../lib/format'
import { ICON } from '../lib/icons'
import { Drawer, IconButton, Segmented } from './ui'

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

/**
 * 实时动态抽屉，UI-REFACTOR Q1：从标题栏「动态」按钮打开，覆盖在内容上，
 * 不再常驻占掉 320px。内容不变：事件流 + 端口 Top 5 + 负载 Top 5。
 */
export function ActivityDrawer({
  events,
  onClear,
  onClose
}: {
  events: ActivityEvent[]
  onClear: () => void
  onClose: () => void
}): React.JSX.Element {
  const listeners = useScanner((s) => s.listeners)
  const [metric, setMetric] = useState<LoadMetric>('memory')

  return (
    <Drawer
      title="实时动态"
      onClose={onClose}
      actions={<IconButton icon={ICON.remove} label="清空事件" onClick={onClear} disabled={!events.length} />}
    >
      <section className="ui-act-section" aria-label="事件">
        {events.length === 0 ? (
          <Empty>暂无事件。启动或停止服务后会记录在此。</Empty>
        ) : (
          <ol className="flex flex-col gap-3">
            {events.map((e) => (
              <li key={e.id} className="event-enter flex gap-2.5">
                <span
                  className="status-dot mt-[7px]"
                  data-halo={e.level === 'live' || e.level === 'fault' || undefined}
                  style={{ '--glow': DOT[e.level] } as React.CSSProperties}
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] leading-snug text-ink">{e.text}</span>
                  <time className="font-mono text-[12px] text-ink-faint">
                    {new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false })}
                  </time>
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="ui-act-section">
        {/* 标题保留 Ports / Load 字样：verify-m6-settings 按它找区块 */}
        <h3 className="ui-act-h">端口最多 · Ports Top 5</h3>
        <TopList rows={topByPorts(listeners)} empty="等待采集数据。" format={(l) => `${l.ports.length} 个端口`} />
      </section>

      <section className="ui-act-section">
        <div className="ui-act-h">
          <h3>负载最高 · Load Top 5</h3>
          {/* CPU / 内存可切，PRD §9.3 */}
          <Segmented
            label="负载指标"
            value={metric}
            onChange={setMetric}
            options={[
              { value: 'cpu', label: 'CPU', ariaLabel: '按 CPU 排序' },
              { value: 'memory', label: '内存', ariaLabel: '按内存排序' }
            ]}
          />
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
    </Drawer>
  )
}

function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="text-[13px] leading-relaxed text-ink-faint">{children}</p>
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
    <ol className="flex flex-col gap-2.5">
      {rows.map((l, i) => (
        <li key={l.pid} className="flex flex-col gap-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate text-[13px] text-ink" title={l.processName}>
              {l.cwd ? l.cwd.split(/[\\/]/).pop() : l.processName}
            </span>
            <span className="shrink-0 font-mono text-[12px] text-ink-faint">{format(l)}</span>
          </span>
          <span className="load-track" aria-hidden>
            <span
              className="load-fill bar-grow"
              style={{ width: `${Math.round((weigh(l) / max) * 100)}%`, '--i': i } as React.CSSProperties}
            />
          </span>
        </li>
      ))}
    </ol>
  )
}
