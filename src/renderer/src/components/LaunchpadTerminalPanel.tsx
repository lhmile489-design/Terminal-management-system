import { ArrowSquareOut, Terminal as TerminalIcon, X } from '@phosphor-icons/react'
import type { EntryRuntime, LaunchEntry } from '@shared/types'
import { STATUS_META, isLiveStatus } from '../lib/entryMeta'
import { StatusPill } from './StatusPill'
import { TerminalView } from './TerminalView'

interface LaunchpadTerminalPanelProps {
  /** 当前 pin 的条目 id，null 表示面板未激活 */
  entryId: string | null
  entries: LaunchEntry[]
  runtimes: Record<string, EntryRuntime>
  /** 点「在终端页查看」跳到终端视图 */
  onOpenFullTerminal: (sessionId: string) => void
  /** 收起面板 */
  onClose: () => void
}

/**
 * 启动台底部嵌入终端面板。
 * sticky bottom-0，跟随卡片区滚动时始终贴在 scroll container 底部。
 * entryId 为 null 时不渲染，由 Launchpad 父组件控制显隐。
 */
export function LaunchpadTerminalPanel({
  entryId,
  entries,
  runtimes,
  onOpenFullTerminal,
  onClose
}: LaunchpadTerminalPanelProps): React.JSX.Element | null {
  if (!entryId) return null

  const entry = entries.find((e) => e.id === entryId)
  const runtime = runtimes[entryId]
  const sessionId = runtime?.sessionId ?? null
  const statusMeta = runtime ? STATUS_META[runtime.status] : null
  const live = runtime ? isLiveStatus(runtime.status) : false

  return (
    <div
      data-launchpad-terminal-panel
      className="sticky bottom-0 z-10 mt-4 border-t border-line bg-canvas"
    >
      {/* 标题栏 */}
      <div className="flex items-center gap-3 border-b border-line px-4 py-2">
        <TerminalIcon size={14} weight="bold" className="shrink-0 text-ink-faint" aria-hidden />

        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink-strong" title={entry?.name}>
          {entry?.name ?? '—'}
        </span>

        {statusMeta && (
          <StatusPill tone={statusMeta.tone} label={statusMeta.label} halo={live} />
        )}

        {/* 在终端页查看 */}
        <button
          type="button"
          aria-label="在终端页查看"
          title="在终端页查看"
          disabled={!sessionId}
          onClick={() => sessionId && onOpenFullTerminal(sessionId)}
          className="pressable flex h-6 w-6 items-center justify-center rounded-[5px] text-ink-faint hover:bg-raised hover:text-ink-strong disabled:pointer-events-none disabled:opacity-30"
        >
          <ArrowSquareOut size={13} weight="bold" />
        </button>

        {/* 收起 */}
        <button
          type="button"
          aria-label="收起终端面板"
          title="收起"
          onClick={onClose}
          className="pressable flex h-6 w-6 items-center justify-center rounded-[5px] text-ink-faint hover:bg-raised hover:text-ink-strong"
        >
          <X size={13} weight="bold" />
        </button>
      </div>

      {/* 终端内容区 */}
      <div className="h-60 overflow-hidden">
        {sessionId ? (
          <TerminalView key={sessionId} sessionId={sessionId} />
        ) : (
          <div className="flex h-full items-center justify-center gap-2 text-ink-faint">
            <TerminalIcon size={16} weight="bold" aria-hidden />
            <span className="text-[12.5px]">该条目暂无活跃会话，启动后即可在此查看输出</span>
          </div>
        )}
      </div>
    </div>
  )
}
