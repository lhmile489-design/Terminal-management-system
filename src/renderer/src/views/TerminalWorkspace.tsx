import { Plus, Terminal as TerminalIcon, Stop } from '@phosphor-icons/react'
import { TerminalView } from '../components/TerminalView'
import { useSessions } from '../store/sessions'

/** 会话圆点与卡片状态共用 .status-dot，色值走 --glow */
const DOT: Record<string, string> = {
  starting: 'var(--signal-warn)',
  running: 'var(--signal-live)',
  building: 'var(--signal-info)',
  stopped: 'var(--signal-idle)',
  crashed: 'var(--signal-fault)'
}

export function TerminalWorkspace(): React.JSX.Element {
  const { sessions, activeId, openShell, select, stop } = useSessions()

  return (
    <div className="flex min-h-0 flex-1 gap-4">
      <div className="surface-card flex w-60 shrink-0 flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="eyebrow">Sessions</h2>
          <button
            type="button"
            aria-label="新建终端会话"
            onClick={() => void openShell()}
            className="pressable flex h-6 w-6 items-center justify-center rounded-[5px] text-ink-faint hover:bg-raised hover:text-ink"
          >
            <Plus size={13} weight="bold" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {sessions.length === 0 ? (
            <p className="px-2 py-1.5 text-[12.5px] leading-relaxed text-ink-faint">
              暂无会话。点击加号新建一个 PowerShell 终端。
            </p>
          ) : (
            sessions.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => select(s.id)}
                aria-current={s.id === activeId}
                className={`pressable-flat group flex w-full items-center gap-2.5 rounded-[6px] px-2.5 py-2 text-left ${
                  s.id === activeId ? 'bg-raised' : 'hover:bg-raised'
                }`}
              >
                <span
                  className="status-dot"
                  data-halo={s.status === 'running' || s.status === 'building' || undefined}
                  style={
                    { '--glow': DOT[s.status] ?? 'var(--signal-idle)' } as React.CSSProperties
                  }
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-ink">{s.title}</span>
                  <span className="block truncate font-mono text-[10.5px] text-ink-faint">
                    PID {s.pid} · {s.status}
                  </span>
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={`停止 ${s.title}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    void stop(s.id)
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return
                    e.stopPropagation()
                    void stop(s.id)
                  }}
                  className="text-ink-faint opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-fault"
                >
                  <Stop size={13} weight="fill" />
                </span>
              </button>
            ))
          )}
        </div>
      </div>

      <div className="surface-card flex min-w-0 flex-1 overflow-hidden">
        {activeId ? (
          <TerminalView key={activeId} sessionId={activeId} />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-ink-faint">
            <TerminalIcon size={26} weight="bold" />
            <p className="text-[13px]">选择或新建一个会话以查看终端输出</p>
          </div>
        )}
      </div>
    </div>
  )
}
