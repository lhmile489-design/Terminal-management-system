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
  /** 便当网格里占两列的「主磁贴」，UI-REFACTOR §3.4 */
  wide?: boolean
  /** 0–100，主磁贴底部的占比条 */
  ratio?: number
  /** 交错入场索引：按此计算 animation-delay，0-based */
  index?: number
}

/**
 * 总览统计磁贴。数字用 Manrope + tabular-nums（§4.2），刷新时不左右跳。
 * 状态色只进图标块和占比条，不染磁贴底色（§4.6）。
 */
export function KpiCard({
  icon: IconCmp,
  label,
  value,
  unit,
  hint,
  detail,
  tone = 'neutral',
  trend,
  live,
  wide,
  ratio,
  index = 0
}: KpiCardProps): React.JSX.Element {
  return (
    <article
      data-kpi-card
      data-wide={wide || undefined}
      className="item-enter kpi-tile"
      style={{ '--glow': TONE_VAR[tone], '--i': index } as React.CSSProperties}
    >
      <div className="kpi-tile-top">
        <span className="kpi-tile-icon" aria-hidden>
          <IconCmp size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="kpi-tile-label">
            {label}
            {live && <span className="ui-dot" data-tone="live" aria-hidden />}
          </h3>
          {hint && (
            <p className="kpi-tile-hint truncate" title={hint}>
              {hint}
            </p>
          )}
        </div>
        {trend && <Sparkline points={trend} tone={TONE_VAR[tone]} />}
      </div>

      <p className="kpi-tile-value">
        <span>{value}</span>
        {unit && <span className="kpi-tile-unit">{unit}</span>}
      </p>

      {ratio != null && (
        <span className="kpi-tile-bar" aria-hidden>
          <span style={{ width: `${Math.max(0, Math.min(100, ratio))}%` }} />
        </span>
      )}

      {detail && (
        <p data-kpi-detail className="kpi-tile-detail">
          <span className="truncate" title={detail}>{detail}</span>
        </p>
      )}
    </article>
  )
}
