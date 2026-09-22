import { useEffect, useRef } from 'react'
import { ArrowDown, ArrowUp } from '@phosphor-icons/react'
import type { ListenerGroup, ListenerSnapshot } from '@shared/types'
import { LAUNCH_SOURCE_LABEL } from '../lib/entryMeta'
import { ellipsisPath, formatBytes, formatUptime } from '../lib/format'
import { StatusPill } from './StatusPill'

const COLS =
  'grid grid-cols-[1fr_64px_112px_1.1fr_76px_76px_64px_92px_60px_28px] items-center gap-2.5'

export function ListenerTable({
  listeners,
  group,
  onSetGroup,
  highlightPort,
  onHighlightConsumed
}: {
  listeners: ListenerSnapshot[]
  /** 本表所属分组，决定操作列给「提升」还是「移回」，PRD §5.2 */
  group: ListenerGroup
  onSetGroup: (processName: string, group: ListenerGroup | null) => void
  /** 命令面板定位过来的端口 */
  highlightPort?: number | null
  onHighlightConsumed?: () => void
}): React.JSX.Element {
  const hit = highlightPort ? listeners.find((l) => l.ports.includes(highlightPort)) : undefined
  const rowRef = useRef<HTMLLIElement>(null)

  /**
   * 回调放进 ref 再用：调用方传的是内联箭头函数，每次渲染都是新引用。
   * 把它列进下面的依赖，采集每 2 秒推一次快照就会重启这个 2 秒定时器，
   * 高亮于是永不消除 —— 定时器只该由 highlightPort 的变化驱动。
   */
  const consumedRef = useRef(onHighlightConsumed)
  consumedRef.current = onHighlightConsumed

  // 滚动到定位行，高亮 2 秒后自动消除 —— 常驻高亮会让人以为那一行有异常
  useEffect(() => {
    if (!highlightPort) return
    rowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const timer = setTimeout(() => consumedRef.current?.(), 2000)
    return () => clearTimeout(timer)
  }, [highlightPort])

  if (listeners.length === 0) {
    return (
      <div className="surface-card px-6 py-10 text-center">
        <p className="text-[13px] text-ink-muted">
          {group === 'mine' ? '当前用户下没有开发服务在监听' : '没有归入后台的监听进程'}
        </p>
        <p className="mt-1.5 text-[12px] text-ink-faint">启动服务后每 2 秒刷新</p>
      </div>
    )
  }

  return (
    <div className="surface-card overflow-hidden">
      <div
        className={`${COLS} border-b border-line px-4 py-2.5 font-mono text-[10px] font-semibold tracking-[0.12em] text-ink-faint uppercase`}
      >
        <span>名称</span>
        <span>PID</span>
        <span>端口</span>
        <span>目录</span>
        <span>CPU</span>
        <span>内存</span>
        <span>时长</span>
        <span>来源</span>
        <span>归属</span>
        <span className="sr-only">分组</span>
      </div>

      <ul>
        {listeners.map((l) => (
          <li
            key={l.pid}
            ref={hit?.pid === l.pid ? rowRef : undefined}
            data-highlighted={hit?.pid === l.pid || undefined}
            className={`${COLS} border-b border-line px-4 py-2.5 last:border-b-0 ${
              hit?.pid === l.pid ? 'bg-info-soft' : ''
            }`}
          >
            <span className="truncate text-[13px] text-ink-strong" title={l.processName}>
              {l.cwd ? l.cwd.split(/[\\/]/).pop() : l.processName}
            </span>

            <span className="font-mono text-[12px] text-ink-muted">{l.pid}</span>

            <span className="flex min-w-0 flex-wrap gap-1">
              {l.ports.map((p) => (
                <PortChip key={p} port={p} />
              ))}
            </span>

            <span
              className="truncate font-mono text-[11px] text-ink-faint"
              title={l.cwd ?? '未知目录'}
            >
              {l.cwd ? ellipsisPath(l.cwd) : '—'}
            </span>

            <Metric value={l.cpu === null ? '—' : l.cpu.toFixed(1)} unit="%" ratio={l.cpu} />
            <span className="font-mono text-[12px] text-ink-muted">{formatBytes(l.memory)}</span>
            <span className="font-mono text-[12px] text-ink-muted">
              {formatUptime(l.startedAt)}
            </span>
            <SourceBadge listener={l} />
            <OwnershipBadge ownership={l.ownership} />
            <GroupToggle listener={l} group={group} onSetGroup={onSetGroup} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function PortChip({ port }: { port: number }): React.JSX.Element {
  return (
    <button
      type="button"
      title={`在浏览器打开 http://localhost:${port}`}
      onClick={() => window.mile.shell.openLocalhost(port)}
      className="pressable rounded-[4px] border border-line-strong px-1.5 font-mono text-[11px] font-bold text-accent hover:bg-accent/15 hover:text-accent"
    >
      {port}
    </button>
  )
}

function Metric({
  value,
  unit,
  ratio
}: {
  value: string
  unit: string
  ratio: number | null
}): React.JSX.Element {
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="font-mono text-[12px] text-ink-muted">
        {value}
        {ratio !== null && <span className="text-ink-faint">{unit}</span>}
      </span>
      <span className="load-track" aria-hidden>
        <span className="load-fill" style={{ width: `${Math.min(100, ratio ?? 0)}%` }} />
      </span>
    </span>
  )
}

/**
 * 启动来源徽标，PRD §5.3。中性色 + 明确的「仅供参考」提示。
 *
 * 提示语不是客套：来源是沿父链按进程名猜的，进程名任何程序都能自己起，
 * 用户不该拿它当「这个进程可信」的依据。
 */
function SourceBadge({ listener }: { listener: ListenerSnapshot }): React.JSX.Element {
  return (
    <span
      data-source={listener.launchSource}
      className="truncate rounded-[4px] bg-raised px-1.5 py-0.5 text-center font-mono text-[10px] font-semibold text-ink-muted"
      title={`推断的启动来源：${LAUNCH_SOURCE_LABEL[listener.launchSource]}。仅供参考，不参与启停权限判定`}
    >
      {LAUNCH_SOURCE_LABEL[listener.launchSource]}
    </span>
  )
}

function OwnershipBadge({ ownership }: { ownership: string }): React.JSX.Element {
  const owned = ownership === 'owned'
  return (
    <span
      className="justify-self-start"
      title={owned ? '本应用启动，可停止与重启' : '外部进程，本应用不提供终止能力'}
    >
      <StatusPill tone={owned ? 'live' : 'idle'} label={owned ? '受控' : '外部'} dot={false} />
    </span>
  )
}

/**
 * 提升 / 移回，PRD §5.2。
 *
 * 本应用启动的进程不给这个按钮：它必然属于「我的服务」，让人把它挪到后台
 * 只会造成「我的服务里找不到刚启动的服务」这种自找的困惑。
 */
function GroupToggle({
  listener,
  group,
  onSetGroup
}: {
  listener: ListenerSnapshot
  group: ListenerGroup
  onSetGroup: (processName: string, group: ListenerGroup | null) => void
}): React.JSX.Element | null {
  if (listener.ownership === 'owned' || listener.entryId) return null

  const toMine = group === 'background'
  const label = toMine ? `将 ${listener.processName} 提升为我的服务` : `将 ${listener.processName} 移回后台`
  const Icon = toMine ? ArrowUp : ArrowDown

  return (
    <button
      type="button"
      aria-label={label}
      // 按进程名生效，同名进程会一起改 —— 说清楚，免得用户以为只动了这一行
      title={`${label}。按进程名生效，同名进程一并归入${listener.groupOverridden ? '（当前分组由你指定）' : ''}`}
      onClick={() => onSetGroup(listener.processName, toMine ? 'mine' : 'background')}
      data-overridden={listener.groupOverridden || undefined}
      className="pressable flex h-6 w-6 items-center justify-center rounded-[5px] border border-line-strong bg-card text-ink-faint hover:text-ink-strong"
    >
      <Icon size={12} weight="bold" />
    </button>
  )
}
