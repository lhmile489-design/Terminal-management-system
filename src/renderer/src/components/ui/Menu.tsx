import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, DotsThree, type Icon } from '@phosphor-icons/react'
import { useOverlay } from '../../lib/overlay'
import { ICON_SIZE } from '../../lib/icons'

/**
 * 「⋯」菜单，UI-REFACTOR §6。
 * - 方向键 / Home / End 移动，Enter 或 Space 执行，Esc 关闭并把焦点还给触发按钮，Tab 直接关闭。
 * - 危险项红色，调用方在它前面放一个 `{ sep: true }` 分隔。
 * - 下方放不下时向上翻；横向贴着触发按钮右缘对齐，越界时收回视口内。
 */
export type MenuItem =
  | { sep: true }
  | {
      sep?: false
      label: string
      icon?: Icon
      danger?: boolean
      disabled?: boolean
      /** 有值时渲染成 menuitemcheckbox，比如「环境：dev」 */
      checked?: boolean
      onSelect: () => void
    }

const GAP = 4
const EDGE = 8

export function MenuButton({
  label,
  items,
  icon = DotsThree,
  size = 'sm'
}: {
  /** 触发按钮的可读名称，比如「商城前台 更多操作」 */
  label: string
  items: MenuItem[]
  icon?: Icon
  size?: 'sm' | 'md'
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const IconCmp = icon

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="ui-iconbtn"
        data-size={size}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          // 菜单常放在可点击的行里，别让点击冒泡成「选中这一行」
          e.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        <IconCmp size={ICON_SIZE.inline} aria-hidden />
      </button>
      {open && btnRef.current && (
        <MenuPopover anchor={btnRef.current} items={items} label={label} onClose={() => setOpen(false)} />
      )}
    </>
  )
}

function MenuPopover({
  anchor,
  items,
  label,
  onClose
}: {
  anchor: HTMLElement
  items: MenuItem[]
  label: string
  onClose: () => void
}): React.JSX.Element {
  const ref = useOverlay<HTMLDivElement>(onClose, { trap: false })
  // 先放在视口外量尺寸，量完再落位。不用 visibility:hidden —— 那样焦点移不进去
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const a = anchor.getBoundingClientRect()
    const m = el.getBoundingClientRect()
    let top = a.bottom + GAP
    if (top + m.height > innerHeight - EDGE) top = Math.max(EDGE, a.top - GAP - m.height)
    let left = a.right - m.width
    left = Math.min(Math.max(EDGE, left), innerWidth - m.width - EDGE)
    setPos({ left, top })
  }, [anchor, ref])

  // 点菜单外关闭；点触发按钮本身由按钮的 onClick 负责切换，这里放过
  useLayoutEffect(() => {
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchor.contains(t)) return
      onClose()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [anchor, onClose, ref])

  const move = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const list = [...(ref.current?.querySelectorAll<HTMLButtonElement>('.ui-menu-item:not(:disabled)') ?? [])]
    if (!list.length) return
    const i = list.indexOf(document.activeElement as HTMLButtonElement)
    let next = -1
    if (e.key === 'ArrowDown') next = (i + 1) % list.length
    else if (e.key === 'ArrowUp') next = (i - 1 + list.length) % list.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = list.length - 1
    else if (e.key === 'Tab') {
      onClose()
      return
    }
    if (next < 0) return
    e.preventDefault()
    list[next].focus()
  }

  return createPortal(
    <div
      ref={ref}
      className="ui-menu"
      role="menu"
      aria-label={label}
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
      onKeyDown={move}
    >
      {items.map((it, i) =>
        it.sep ? (
          <div key={`sep-${i}`} className="ui-menu-sep" role="separator" />
        ) : (
          <button
            key={it.label}
            type="button"
            className="ui-menu-item"
            role={it.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={it.checked}
            data-danger={it.danger || undefined}
            disabled={it.disabled}
            onClick={() => {
              onClose()
              it.onSelect()
            }}
          >
            <span className="ui-menu-item-icon" aria-hidden>
              {it.checked ? (
                <Check size={ICON_SIZE.inline} />
              ) : it.icon ? (
                <it.icon size={ICON_SIZE.inline} />
              ) : null}
            </span>
            {it.label}
          </button>
        )
      )}
    </div>,
    document.body
  )
}
