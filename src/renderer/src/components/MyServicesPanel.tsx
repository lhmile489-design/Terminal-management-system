import { useCallback, useState } from 'react'
import { Play, Stop, ArrowClockwise, Terminal, CaretDown } from '@phosphor-icons/react'
import type { EntryRuntime, LaunchEntry } from '@shared/types'
import { FRAMEWORK_LABEL, STATUS_META, isLiveStatus } from '../lib/entryMeta'
import { StatusPill } from './StatusPill'
import { launchCounts } from '../lib/launchStats'
import { useEntries } from '../store/entries'

/**
 * Dashboard 上的「我的服务」卡片式列表面板。
 *
 * 和启动台不同，这里只做快捷操作：启动 / 停止 / 重启，
 * 不做复杂的编辑交互——那些留给启动台。
 *
 * 「停止」在运行中或卡住时都可见，是对运行中服务的快速停止入口。
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
  onLogs: () => void
}

function ServiceRow({
  entry,
  runtime,
  busy,
  onStart,
  onStop,
  onRestart,
  onLogs
}: ServiceRowProps): React.JSX.Element {
  const { status } = runtime
  const meta = STATUS_META[status]
  const isRunning = status === 'running'
  const isLive = isLiveStatus(status)
  const canStart = !entry.registerOnly && !isLive && status !== 'precheck'
  const canStop = isLive

  return (
    <li className="group flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0 hover:bg-raised/30 transition-colors duration-150 [transition-timing-function:cubic-bezier(0.25,0.46,0.45,0.94)]">
      {/* 名称 + 框架 */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-ink-strong leading-tight" title={entry.name}>
          {entry.name}
        </p>
        <p className="text-[12px] text-ink-faint leading-tight mt-0.5 font-mono">
          {FRAMEWORK_LABEL[entry.framework]}
          {entry.expectedPort && (
            <span className="ml-1.5 text-ink-faint">:{entry.expectedPort}</span>
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

      {/* 停止：运行中、启动中、停止中都可见，不藏在 hover 里 —— 进程卡住时用户最需要它。
          行为是 Ctrl+C，3 秒后仍未退出再终止进程树；归属三重校验由主进程把关。
          以前这里有一个调用完全相同的「强制关闭」，名称与行为对不上，已合并。 */}
      {canStop && (
        <button
          type="button"
          aria-label={`停止 ${entry.name}`}
          title="先发 Ctrl+C，3 秒后仍未退出则结束进程树"
          disabled={busy}
          onClick={onStop}
          className="pressable shrink-0 flex items-center gap-1 rounded-control border border-fault/30 bg-fault/8 px-2 py-1 font-mono text-[12px] text-fault hover:border-fault/60 hover:bg-fault/15 disabled:pointer-events-none disabled:border-line disabled:bg-raised disabled:text-ink-faint"
        >
          <Stop size={12} weight="bold" />
          停止
        </button>
      )}

      {/* 仅登记提示 */}
      {entry.registerOnly && (
        <span className="shrink-0 rounded-pill bg-raised px-1.5 py-0.5 font-mono text-[12px] text-ink-faint">
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
      className={`pressable flex h-6 w-6 items-center justify-center rounded-control border bg-card ${toneClass}`}
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
  /** 默认只列最常打开的 5 个，点「查看更多」展开全部 */
  const [showAll, setShowAll] = useState(false)

  const handleStart = useCallback((id: string) => { void start(id) }, [start])
  const handleStop = useCallback((id: string) => { void stop(id) }, [stop])
  const handleRestart = useCallback((id: string) => { void restart(id) }, [restart])

  if (entries.length === 0) return null

  // 按打开次数排序：次数多的在前，同次数按最近一次启动
  const counts = launchCounts()
  const sorted = [...entries].sort(
    (x, y) => (counts[y.id] ?? 0) - (counts[x.id] ?? 0) || (y.lastStartedAt ?? 0) - (x.lastStartedAt ?? 0)
  )
  const LIMIT = 5
  const shown = showAll ? sorted : sorted.slice(0, LIMIT)
  const hidden = sorted.length - shown.length

  const runningCount = entries.filter((e) => isLiveStatus((runtimes[e.id] ?? IDLE_RUNTIME(e.id)).status)).length

  return (
    <section aria-labelledby="my-services-panel-heading">
      {/* 区块标题栏 */}
      <div className="mb-2.5 flex items-center gap-2">
        <h2 id="my-services-panel-heading" className="eyebrow">
          服务操作台
        </h2>
        {runningCount > 0 && (
          <span className="flex items-center gap-1 rounded-full border border-live/25 bg-live/10 px-1.5 py-0.5 font-mono text-[12px] font-semibold text-live">
            <span className="h-1.5 w-1.5 animate-ping rounded-full bg-live opacity-75" aria-hidden />
            {runningCount} 运行中
          </span>
        )}
        <span className="text-[12px] text-ink-faint font-mono ml-auto">
          {entries.length} 项
        </span>
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? '展开服务列表' : '折叠服务列表'}
          onClick={() => setCollapsed((v) => !v)}
          className="pressable flex items-center gap-1 rounded-control border border-line bg-raised/50 px-1.5 py-0.5 font-mono text-[12px] text-ink-muted hover:border-line-strong hover:text-ink-strong"
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
          <div className="grid grid-cols-[1fr_100px_auto] items-center gap-3 border-b border-line px-4 py-2 font-mono text-[12px] font-semibold tracking-[0.12em] text-ink-faint uppercase">
                        <span>服务名称</span>
            <span>状态</span>
            <span className="sr-only">操作</span>
          </div>

          <ul>
            {shown.map((entry) => {
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
                  onLogs={() => {
                    if (runtime.sessionId) onOpenLogs(runtime.sessionId)
                  }}
                />
              )
            })}
          </ul>
          {(hidden > 0 || showAll) && sorted.length > LIMIT && (
            <button
              type="button"
              aria-expanded={showAll}
              onClick={() => setShowAll((v) => !v)}
              className="pressable-flat flex w-full items-center justify-center gap-1.5 border-t border-line px-4 py-2.5 text-[13px] font-semibold text-ink-muted hover:bg-raised hover:text-ink-strong"
            >
              {showAll ? '收起' : `查看更多（${hidden}）`}
            </button>
          )}
        </div>
      )}
    </section>
  )
}
