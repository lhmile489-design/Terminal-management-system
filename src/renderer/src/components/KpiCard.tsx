import type { Icon } from '@phosphor-icons/react'
import { Sparkline } from './Sparkline'

type Tone = 'neutral' | 'live' | 'warn' | 'fault' | 'info' | 'accent'

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
      className="surface-card flex min-w-0 flex-col px-3.5 py-3"
      style={{ '--glow': TONE_VAR[tone] } as React.CSSProperties}
    >
      {/* 顶部：图标瓦片 + 标签 + 趋势图 */}
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="icon-tile icon-tile-sm h-8 w-8 shrink-0" aria-hidden>
            <IconCmp size={15} weight="bold" />
          </span>
          <div className="min-w-0">
            <h3 className="flex items-center gap-1.5 truncate text-[11px] font-semibold text-ink-muted leading-none">
              {label}
              {live && (
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-live shadow-[0_0_0_2px_color-mix(in_srgb,var(--signal-live)_22%,transparent)]"
                  aria-hidden
                />
              )}
            </h3>
            {hint && (
              <p className="mt-0.5 truncate text-[10px] text-ink-faint/70 leading-none" title={hint}>
                {hint}
              </p>
            )}
          </div>
        </div>
        {trend && <Sparkline points={trend} tone={TONE_VAR[tone]} />}
      </div>

      {/* 主读数 */}
      <div className="mt-2.5 flex items-baseline gap-1">
        <span className="font-mono text-[26px] font-bold leading-none text-ink-strong tabular-nums">
          {value}
        </span>
        {unit && (
          <span className="font-mono text-[12px] font-semibold text-ink-faint/60 leading-none">
            {unit}
          </span>
        )}
      </div>

      {/* 底部详情行 */}
      {detail && (
        <p
          data-kpi-detail
          className="mt-auto pt-2.5 flex items-center gap-1.5 border-t border-line font-mono text-[10px] text-ink-faint/70 mt-2.5"
        >
          <span className="h-1 w-1 shrink-0 rounded-full bg-[var(--glow)]" aria-hidden />
          <span className="truncate">{detail}</span>
        </p>
      )}
    </article>
  )
}
