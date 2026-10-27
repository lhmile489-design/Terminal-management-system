import type { Tone } from '../../lib/entryMeta'

/**
 * 状态胶囊与状态点。状态色只进胶囊、圆点和描边，不染卡片底（§4.6）。
 * 颜色配方在 ui.css：信号色混入最强文字色，两套主题都 ≥ 5:1。
 */
export function Pill({
  tone = 'idle',
  dot,
  mono,
  children,
  title
}: {
  tone?: Tone
  dot?: boolean
  mono?: boolean
  children: React.ReactNode
  title?: string
}): React.JSX.Element {
  return (
    <span className="ui-pill" data-tone={tone} data-mono={mono || undefined} title={title}>
      {dot && <StatusDot tone={tone} />}
      {children}
    </span>
  )
}

/** 运行中缓慢呼吸，异常时闪一次后常亮，启动/停止中快呼吸 */
export function StatusDot({ tone, label }: { tone: Tone; label?: string }): React.JSX.Element {
  return (
    <span
      className="ui-dot"
      data-tone={tone}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      title={label}
    />
  )
}
