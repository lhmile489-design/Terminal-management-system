import { CheckCircle, Warning, XCircle } from '@phosphor-icons/react'
import type { PrecheckFixAction, PrecheckLevel, PrecheckResult } from '@shared/types'
import { LEVEL_META, TONE_CLASS } from '../lib/entryMeta'
import { StatusPill } from './StatusPill'

const ICON: Record<PrecheckLevel, React.ComponentType<{ size?: number; weight?: 'bold' }>> = {
  pass: CheckCircle,
  warn: Warning,
  fail: XCircle
}

export function PrecheckPanel({
  result,
  onFix
}: {
  result: PrecheckResult
  onFix: (action: PrecheckFixAction) => void
}): React.JSX.Element {
  const fails = result.items.filter((i) => i.level === 'fail').length
  const warns = result.items.filter((i) => i.level === 'warn').length

  return (
    <div
      data-tone={fails > 0 ? 'fault' : warns > 0 ? 'warn' : undefined}
      style={
        {
          '--glow':
            fails > 0
              ? 'var(--signal-fault)'
              : warns > 0
                ? 'var(--signal-warn)'
                : 'var(--signal-live)'
        } as React.CSSProperties
      }
      className="surface-card overflow-hidden"
    >
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h3 className="eyebrow eyebrow-tight">Precheck · 启动前预检</h3>
        <p className="text-[12px] text-ink-muted">
          {fails > 0 ? `${fails} 项阻止启动` : '可以启动'}
          {warns > 0 && ` · ${warns} 项警告`}
        </p>
      </header>

      <ul>
        {result.items.map((item) => {
          const meta = LEVEL_META[item.level]
          const IconCmp = ICON[item.level]
          return (
            <li
              key={item.id}
              className="flex items-start gap-3 border-b border-line px-4 py-2.5 last:border-b-0"
            >
              <span
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] ${TONE_CLASS[meta.tone]}`}
                aria-hidden
              >
                <IconCmp size={13} weight="bold" />
              </span>

              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <p className="flex flex-wrap items-baseline gap-2">
                  <span className="text-[13px] text-ink-strong">{item.label}</span>
                  <StatusPill tone={meta.tone} label={meta.label} dot={false} />
                </p>
                {item.detail && (
                  <p className="font-mono text-[11px] break-all text-ink-faint">{item.detail}</p>
                )}
              </div>

              {item.fix && (
                <button
                  type="button"
                  onClick={() => onFix(item.fix!.action)}
                  className="pressable shrink-0 rounded-[6px] border border-line-strong bg-card px-2.5 py-1 text-[12px] text-ink-muted hover:text-ink-strong"
                >
                  {item.fix.label}
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
