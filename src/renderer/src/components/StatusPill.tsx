import { TONE_VAR, type Tone } from '../lib/entryMeta'

/**
 * 状态胶囊：同色系的底、边、字，可选前置圆点。
 * 三者同源才不会像是随便描了个框 —— 具体混色比例在 tokens.css 的 .status-pill。
 */
export function StatusPill({
  tone,
  label,
  dot = true,
  halo = false
}: {
  tone: Tone
  label: string
  dot?: boolean
  /** 运行中等「活着」的状态给圆点加光环 */
  halo?: boolean
}): React.JSX.Element {
  return (
    <span className="status-pill" style={{ '--glow': TONE_VAR[tone] } as React.CSSProperties}>
      {dot && <span className="status-dot" data-halo={halo || undefined} aria-hidden />}
      {label}
    </span>
  )
}
