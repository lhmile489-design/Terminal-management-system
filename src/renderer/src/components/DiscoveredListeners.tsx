import { Plus, EyeSlash, MagnifyingGlass, X } from '@phosphor-icons/react'
import { useScanner } from '../store/scanner'
import { ellipsisPath, formatUptime } from '../lib/format'

export function DiscoveredListeners({
  onRequestAdd
}: {
  onRequestAdd: (path: string, name: string) => void
}): React.JSX.Element | null {
  const unmanaged = useScanner((s) => s.unmanaged)
  const ignore = useScanner((s) => s.ignore)
  const hideOnce = useScanner((s) => s.hideOnce)

  // 无新发现时整个区块不渲染，PRD §7
  if (unmanaged.length === 0) return null

  return (
    <section aria-labelledby="discovered-heading">
      <h2 id="discovered-heading" className="eyebrow mb-3">
        Discovered · 发现新的监听端口
      </h2>

      <ul className="flex flex-col gap-2">
        {unmanaged.map((u) => (
          <li
            key={`${u.pid}:${u.port}`}
            data-tone="warn"
            style={{ '--glow': 'var(--signal-warn)' } as React.CSSProperties}
            className="surface-card flex items-center gap-3 px-4 py-3"
          >
            <span className="icon-tile h-9 w-9" aria-hidden>
              <MagnifyingGlass size={15} weight="bold" />
            </span>

            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p className="flex items-baseline gap-2">
                <span className="truncate text-[13px] font-semibold text-ink-strong">
                  {u.guessedName}
                </span>
                <span className="shrink-0 rounded-[4px] border border-line-strong px-1.5 font-mono text-[10px] font-bold text-accent">
                  :{u.port}
                </span>
              </p>
              <p className="truncate font-mono text-[11px] text-ink-muted">
                {u.processName} · PID {u.pid} · 已运行 {formatUptime(u.startedAt)}
                {u.cwd ? ` · ${ellipsisPath(u.cwd, 34)}` : ''}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              {/* 只登记不接管：已在跑的进程仍是 external，PRD §7 */}
              <Action
                icon={Plus}
                label="加入启动台"
                primary
                disabled={!u.cwd}
                hint={u.cwd ? '以该目录建条目，不接管已在跑的进程' : '未能推断工作目录，无法自动建条目'}
                onClick={() => u.cwd && onRequestAdd(u.cwd, u.guessedName)}
              />
              <Action
                icon={EyeSlash}
                label="忽略并隐藏"
                onClick={() => ignore(u.processName, u.port)}
              />
              <Action icon={X} label="本次隐藏" onClick={() => hideOnce(u.pid, u.port)} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Action({
  icon: IconCmp,
  label,
  onClick,
  primary,
  disabled,
  hint
}: {
  icon: React.ComponentType<{ size?: number; weight?: 'bold' }>
  label: string
  onClick: () => void
  primary?: boolean
  disabled?: boolean
  hint?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={hint ?? label}
      className={`pressable flex items-center gap-1.5 rounded-[6px] px-2.5 py-1.5 text-[12px] ${
        primary
          ? 'btn-primary'
          : 'border border-line-strong bg-card text-ink-muted hover:text-ink-strong disabled:cursor-not-allowed disabled:border-line disabled:text-ink-faint'
      }`}
    >
      <IconCmp size={13} weight="bold" />
      {label}
    </button>
  )
}
