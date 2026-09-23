import { useCallback, useState } from 'react'
import { XCircle, Play, Stop, ArrowClockwise, Terminal, CaretDown } from '@phosphor-icons/react'
import type { EntryRuntime, LaunchEntry } from '@shared/types'
import { FRAMEWORK_LABEL, STATUS_META, isBusyStatus, isLiveStatus } from '../lib/entryMeta'
import { StatusPill } from './StatusPill'
import { EntryGlyph } from './EntryGlyph'
import { useEntries } from '../store/entries'

/**
 * Dashboard 上的「我的服务」卡片式列表面板。
 *
 * 和启动台不同，这里只做快捷操作：启动 / 停止 / 强制关闭，
 * 不做复杂的编辑交互——那些留给启动台。
 *
 * 「强制关闭」=在运行中或卡住时直接发 stop()，用红色 X 与「强制关闭」标签区分于普通停止。
 * 用户说「不想要的服务可以强制关闭」，本质上就是对运行中服务的快速停止入口。
 */

const IDLE_RUNTIME = (id: string): EntryRuntime => ({
  entryId: id,
  status: 'idle',
  portUnknown: false
})

interface ServiceRowProps {
  entry: LaunchEntry
  runtime: EntryRuntime
  busy: boolean
  onStart: () => void
  onStop: () => void
  onRestart: () => void
  onForceStop: () => void
  onLogs: () => void
}

function ServiceRow({
  entry,
  runtime,
  busy,
  onStart,
  onStop,
  onRestart,
  onForceStop,
  onLogs
}: ServiceRowProps): React.JSX.Element {
  const { status } = runtime
  const meta = STATUS_META[status]
  const isRunning = status === 'running'
  const isLive = isLiveStatus(status)
  const isBusy = isBusyStatus(status)
  const canStart = !entry.registerOnly && !isLive && status !== 'precheck'
  const canStop = isLive
  // 「强制关闭」：运行中或卡在 starting/stopping 状态时可用
  const canForceStop = isRunning || isBusy

  return (
    <li className="group flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0 hover:bg-raised/30 transition-colors duration-150 [transition-timing-function:cubic-bezier(0.25,0.46,0.45,0.94)]">
      {/* 框架字标 / 图标 */}
      <div className="shrink-0">
        <EntryGlyph entry={entry} size={28} />
      </div>

      {/* 名称 + 框架 */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-ink-strong leading-tight" title={entry.name}>
          {entry.name}
        </p>
        <p className="text-[11px] text-ink-faint leading-tight mt-0.5 font-mono">
          {FRAMEWORK_LABEL[entry.framework]}
          {entry.expectedPort && (
            <span className="ml-1.5 text-ink-faint/70">:{entry.expectedPort}</span>
          )}
          {runtime.port && runtime.port !== entry.expectedPort && (
            <span className="ml-1 text-accent">:{runtime.port}</span>
          )}
        </p>
      </div>

      {/* 状态胶囊 */}
      <div className="shrink-0">
        <StatusPill
          tone={meta.tone}
          label={meta.label}
          halo={isRunning}
        />
      </div>

      {/* 操作按钮区：hover 或键盘聚焦时可见，保证键盘用户也能操作 */}
      <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-150 [transition-timing-function:cubic-bezier(0.25,0.46,0.45,0.94)]">
        {/* 日志按钮：有 sessionId 才可用 */}
        {runtime.sessionId && (
          <ActionBtn
            icon={Terminal}
            label="查看日志"
            onClick={onLogs}
            tone="neutral"
          />
        )}

        {/* 启动按钮 */}
        {canStart && !busy && (
          <ActionBtn
            icon={Play}
            label="启动"
            onClick={onStart}
            tone="live"
          />
        )}

        {/* 普通停止：运行中或忙碌时显示 */}
        {canStop && !canForceStop && (
          <ActionBtn
            icon={Stop}
            label="停止"
            onClick={onStop}
            tone="warn"
          />
        )}

        {/* 重启：仅运行中时 */}
        {isRunning && (
          <ActionBtn
            icon={ArrowClockwise}
            label="重启"
            onClick={onRestart}
            tone="neutral"
          />
        )}
      </div>

      {/* 强制关闭：始终可见（当可用时），红色警示。
          调用路径与普通停止相同（stop()→\x03→3s 后 taskkill），
          区别在于：普通停止按钮在进程卡住（isBusy）时隐藏，强制关闭始终显示，
          给用户一个"我知道后果，立刻停"的明确入口。
          安全校验（归属三重验证）由主进程 OwnershipService 保证，此处不跳过。 */}
      {canForceStop && (
        <button
          type="button"
          aria-label={`强制关闭 ${entry.name}`}
          title={`强制停止 ${entry.name}`}
          disabled={busy}
          onClick={onForceStop}
          className="pressable shrink-0 flex items-center gap-1 rounded-[5px] border border-fault/30 bg-fault/8 px-2 py-1 font-mono text-[10px] text-fault hover:border-fault/60 hover:bg-fault/15 disabled:pointer-events-none disabled:opacity-40"
        >
          <XCircle size={12} weight="bold" />
          强制关闭
        </button>
      )}

      {/* 仅登记提示 */}
      {entry.registerOnly && (
        <span className="shrink-0 rounded-[4px] bg-raised px-1.5 py-0.5 font-mono text-[10px] text-ink-faint">
          仅监控
        </span>
      )}
    </li>
  )
}

function ActionBtn({
  icon: IconCmp,
  label,
  onClick,
  tone
}: {
  icon: React.ComponentType<{ size?: number; weight?: 'bold' | 'regular' }>
  label: string
  onClick: () => void
  tone: 'live' | 'warn' | 'neutral'
}): React.JSX.Element {
  const toneClass =
    tone === 'live'
      ? 'border-live/30 text-live hover:border-live/60 hover:bg-live/15'
      : tone === 'warn'
        ? 'border-warn/30 text-warn hover:border-warn/60 hover:bg-warn/15'
        : 'border-line text-ink-muted hover:border-line-strong hover:text-ink-strong'

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`pressable flex h-6 w-6 items-center justify-center rounded-[5px] border bg-card ${toneClass}`}
    >
      <IconCmp size={12} weight="bold" />
    </button>
  )
}

export function MyServicesPanel({
  onOpenLogs
}: {
  onOpenLogs: (sessionId: string) => void
}): React.JSX.Element | null {
  const entries = useEntries((s) => s.entries)
  const runtimes = useEntries((s) => s.runtimes)
  const busy = useEntries((s) => s.busy)
  const start = useEntries((s) => s.start)
  const stop = useEntries((s) => s.stop)
  const restart = useEntries((s) => s.restart)

  const [collapsed, setCollapsed] = useState(false)

  const handleStart = useCallback((id: string) => { void start(id) }, [start])
  const handleStop = useCallback((id: string) => { void stop(id) }, [stop])
  const handleRestart = useCallback((id: string) => { void restart(id) }, [restart])

  if (entries.length === 0) return null

  // 按运行状态排序：运行中 > 启动中/停止中 > 停止/空闲 > 异常
  const sorted = [...entries].sort((a, b) => {
    const statusOrder = (e: LaunchEntry): number => {
      const s = (runtimes[e.id] ?? IDLE_RUNTIME(e.id)).status
      if (s === 'running') return 0
      if (s === 'starting' || s === 'stopping' || s === 'precheck') return 1
      if (s === 'crashed' || s === 'failed') return 3
      return 2
    }
    return statusOrder(a) - statusOrder(b)
  })

  const runningCount = entries.filter((e) => isLiveStatus((runtimes[e.id] ?? IDLE_RUNTIME(e.id)).status)).length

  return (
    <section aria-labelledby="my-services-panel-heading">
      {/* 区块标题栏 */}
      <div className="mb-2.5 flex items-center gap-2">
        <h2 id="my-services-panel-heading" className="eyebrow">
          My Services · 服务操作台
        </h2>
        {runningCount > 0 && (
          <span className="flex items-center gap-1 rounded-full border border-live/25 bg-live/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-live">
            <span className="h-1.5 w-1.5 animate-ping rounded-full bg-live opacity-75" aria-hidden />
            {runningCount} 运行中
          </span>
        )}
        <span className="text-[11px] text-ink-faint font-mono ml-auto">
          {entries.length} 项
        </span>
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? '展开服务列表' : '折叠服务列表'}
          onClick={() => setCollapsed((v) => !v)}
          className="pressable flex items-center gap-1 rounded-[5px] border border-line bg-raised/50 px-1.5 py-0.5 font-mono text-[10px] text-ink-muted hover:border-line-strong hover:text-ink-strong"
        >
          <CaretDown
            size={9}
            weight="bold"
            className="transition-transform duration-300 [transition-timing-function:cubic-bezier(0.34,1.56,0.64,1)]"
            style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
          />
          {collapsed ? '展开' : '折叠'}
        </button>
      </div>

      {!collapsed && (
        <div className="surface-card overflow-hidden">
          {/* 表头 */}
          <div className="grid grid-cols-[auto_1fr_100px_auto] items-center gap-3 border-b border-line px-4 py-2 font-mono text-[10px] font-semibold tracking-[0.12em] text-ink-faint uppercase">
            <span className="w-7" aria-hidden />
            <span>服务名称</span>
            <span>状态</span>
            <span className="sr-only">操作</span>
          </div>

          <ul>
            {sorted.map((entry) => {
              const runtime = runtimes[entry.id] ?? IDLE_RUNTIME(entry.id)
              const isBusy = !!busy[entry.id]
              return (
                <ServiceRow
                  key={entry.id}
                  entry={entry}
                  runtime={runtime}
                  busy={isBusy}
                  onStart={() => handleStart(entry.id)}
                  onStop={() => handleStop(entry.id)}
                  onRestart={() => handleRestart(entry.id)}
                  onForceStop={() => handleStop(entry.id)}
                  onLogs={() => {
                    if (runtime.sessionId) onOpenLogs(runtime.sessionId)
                  }}
                />
              )
            })}
          </ul>
        </div>
      )}
    </section>
  )
}
