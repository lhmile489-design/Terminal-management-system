import type { Icon } from '@phosphor-icons/react'
import { Sparkline } from './Sparkline'

type Tone = 'neutral' | 'live' | 'warn' | 'fault' | 'info' | 'accent'

/** 色调驱动图标瓦片底色与迷你折线，neutral 用弱文字色而非 accent */
const TONE_VAR: Record<Tone, string> = {
  neutral: 'var(--text-faint)',
  live: 'var(--signal-live)',
  warn: 'var(--signal-warn)',
  fault: 'var(--signal-fault)',
  info: 'var(--signal-info)',
  accent: 'var(--signal-accent)'
}

export interface KpiCardProps {
  icon: Icon
  label: string
  value: string
  unit?: string
  hint?: string
  detail?: string
  tone?: Tone
  trend?: number[]
  live?: boolean
}

export function KpiCard({
  icon: IconCmp,
  label,
  value,
  unit,
  hint,
  detail,
  tone = 'neutral',
  trend,
  live
}: KpiCardProps): React.JSX.Element {
  return (
    <article
      data-kpi-card
      className="surface-card flex min-h-[144px] min-w-0 flex-col px-4 py-3.5"
      style={{ '--glow': TONE_VAR[tone] } as React.CSSProperties}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="icon-tile icon-tile-sm h-10 w-10" aria-hidden>
            <IconCmp size={18} weight="bold" />
          </span>

          <div className="min-w-0">
            <h3 className="flex items-center gap-1.5 truncate text-[11px] font-semibold text-ink-muted">
              {label}
              {live && <span className="status-dot" data-halo="true" aria-hidden />}
            </h3>
            {hint && (
              <p className="mt-0.5 truncate text-[10.5px] text-ink-faint" title={hint}>
                {hint}
              </p>
            )}
          </div>
        </div>

        {trend && <Sparkline points={trend} tone={TONE_VAR[tone]} />}
      </div>

      <div className="mt-3 flex items-end gap-1.5">
        {/* tabular-nums 让每轮刷新数字不跳动；三列布局允许主读数承担视觉重心。 */}
        <p className="flex min-w-0 items-baseline gap-1">
          <span className="font-mono text-[32px] leading-none font-bold text-ink-strong tabular-nums">
            {value}
          </span>
          {unit && (
            <span className="shrink-0 font-mono text-[14px] font-semibold text-ink-faint opacity-70">
              {unit}
            </span>
          )}
        </p>
      </div>

      {detail && (
        <p
          data-kpi-detail
          className="mt-auto flex min-h-6 items-center gap-2 border-t border-line pt-2 font-mono text-[10.5px] text-ink-faint"
        >
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--glow)]" aria-hidden />
          <span className="truncate">{detail}</span>
        </p>
      )}
    </article>
  )
}
