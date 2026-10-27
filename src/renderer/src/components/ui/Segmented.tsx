import { useRef } from 'react'

export interface SegmentOption<T extends string | number> {
  value: T
  label: React.ReactNode
  /** 选项后的计数，如「前端 4」 */
  count?: number
  /** 可见文字是缩写时给读屏的完整名称，如「CPU」→「按 CPU 排序」 */
  ariaLabel?: string
}

/**
 * 分段切换。语义是单选组：方向键在选项间移动并立即选中，Tab 只停在选中项上。
 */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label
}: {
  value: T
  options: SegmentOption<T>[]
  onChange: (v: T) => void
  label: string
}): React.JSX.Element {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const current = Math.max(0, options.findIndex((o) => o.value === value))

  const move = (to: number): void => {
    const n = options.length
    const i = (to + n) % n
    onChange(options[i].value)
    refs.current[i]?.focus()
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(current + 1) }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(current - 1) }
    else if (e.key === 'Home') { e.preventDefault(); move(0) }
    else if (e.key === 'End') { e.preventDefault(); move(options.length - 1) }
  }

  return (
    <div className="ui-seg" role="radiogroup" aria-label={label} onKeyDown={onKey}>
      {options.map((o, i) => (
        <button
          key={String(o.value)}
          ref={(el) => { refs.current[i] = el }}
          type="button"
          role="radio"
          aria-checked={i === current}
          aria-label={o.ariaLabel}
          tabIndex={i === current ? 0 : -1}
          onClick={() => onChange(o.value)}
        >
          {o.label}
          {o.count != null && <span className="ui-seg-count">{o.count}</span>}
        </button>
      ))}
    </div>
  )
}
