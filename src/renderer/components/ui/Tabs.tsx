import { useLayoutEffect, useRef, useState } from 'react'
import type { Icon } from '@phosphor-icons/react'
import { ICON_SIZE } from '../../lib/icons'

export interface TabItem<T extends string> {
  id: T
  label: string
  icon?: Icon
  /** 标签后的计数徽标，如诊断里未通过的项数 */
  badge?: number
}

/**
 * 标签页。下划线在切换时滑到新标签（§4.4 列表选中同款回弹曲线）；
 * 首次测量前不加过渡，避免从 0 宽度弹出来。
 * 面板用 `tabPanelProps(idBase, active)` 拿到配套的 id 与 aria。
 */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  idBase,
  label
}: {
  items: TabItem<T>[]
  value: T
  onChange: (id: T) => void
  idBase: string
  label: string
}): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)
  const [ink, setInk] = useState<{ x: number; w: number } | null>(null)
  const [ready, setReady] = useState(false)

  useLayoutEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!el) return
    const x = el.offsetLeft
    const w = el.offsetWidth
    // 位置没变就不 setState，免得父组件每次渲染都多一轮
    setInk((p) => (p && p.x === x && p.w === w ? p : { x, w }))
  }, [value, items])

  // 第一次落位之后才开过渡
  useLayoutEffect(() => {
    if (ink && !ready) requestAnimationFrame(() => setReady(true))
  }, [ink, ready])

  const focusTab = (i: number): void => {
    const n = items.length
    const t = items[(i + n) % n]
    onChange(t.id)
    listRef.current?.querySelector<HTMLElement>(`#${idBase}-tab-${t.id}`)?.focus()
  }

  const onKey = (e: React.KeyboardEvent): void => {
    const i = items.findIndex((t) => t.id === value)
    if (e.key === 'ArrowRight') { e.preventDefault(); focusTab(i + 1) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); focusTab(i - 1) }
    else if (e.key === 'Home') { e.preventDefault(); focusTab(0) }
    else if (e.key === 'End') { e.preventDefault(); focusTab(items.length - 1) }
  }

  return (
    <div ref={listRef} className="ui-tabs" role="tablist" aria-label={label} onKeyDown={onKey}>
      {items.map((t) => {
        const on = t.id === value
        const IconCmp = t.icon
        return (
          <button
            key={t.id}
            id={`${idBase}-tab-${t.id}`}
            type="button"
            role="tab"
            className="ui-tab"
            aria-selected={on}
            aria-controls={`${idBase}-panel-${t.id}`}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(t.id)}
          >
            {IconCmp && <IconCmp size={ICON_SIZE.inline} weight={on ? 'fill' : 'regular'} aria-hidden />}
            {t.label}
            {t.badge ? <span className="ui-pill" data-tone="fault" style={{ height: 18, padding: '0 6px' }}>{t.badge}</span> : null}
          </button>
        )
      })}
      {ink && (
        <span
          className="ui-tab-ink"
          aria-hidden
          data-ready={ready || undefined}
          style={{ transform: `translateX(${ink.x}px)`, width: ink.w }}
        />
      )}
    </div>
  )
}

export function tabPanelProps(idBase: string, id: string): React.HTMLAttributes<HTMLDivElement> {
  return {
    id: `${idBase}-panel-${id}`,
    role: 'tabpanel',
    'aria-labelledby': `${idBase}-tab-${id}`,
    tabIndex: 0
  }
}
