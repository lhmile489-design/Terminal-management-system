import { useEffect, useRef } from 'react'

/**
 * 浮层栈：对话框、抽屉、菜单、命令面板共用。
 *
 * 叠层时 Esc 只关最上面那一层 —— 确认弹窗开在详情面板上时，按 Esc 不能把两层一起关掉。
 * 焦点在打开时移入，关闭时还给打开前的元素；Tab 被困在浮层内。
 */
const stack: symbol[] = []

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function isTopOverlay(id: symbol): boolean {
  return stack[stack.length - 1] === id
}

export function hasOpenOverlay(): boolean {
  return stack.length > 0
}

export function useOverlay<T extends HTMLElement>(
  onClose: () => void,
  opts: { trap?: boolean; initialFocus?: React.RefObject<HTMLElement | null> } = {}
): React.RefObject<T | null> {
  const ref = useRef<T | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const { trap = true, initialFocus } = opts

  useEffect(() => {
    const id = Symbol('overlay')
    stack.push(id)
    const prev = document.activeElement as HTMLElement | null

    const root = ref.current
    const first = initialFocus?.current ?? root?.querySelector<HTMLElement>(FOCUSABLE) ?? root
    first?.focus()

    const onKey = (e: KeyboardEvent): void => {
      if (!isTopOverlay(id)) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeRef.current()
        return
      }
      if (trap && e.key === 'Tab' && root) {
        const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null)
        if (!items.length) return
        const head = items[0]
        const tail = items[items.length - 1]
        if (e.shiftKey && document.activeElement === head) {
          e.preventDefault()
          tail.focus()
        } else if (!e.shiftKey && document.activeElement === tail) {
          e.preventDefault()
          head.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey, true)

    return () => {
      document.removeEventListener('keydown', onKey, true)
      const i = stack.indexOf(id)
      if (i >= 0) stack.splice(i, 1)
      // 打开者可能已被卸载（比如菜单项删掉了自己所在的行），这时不强行还焦点
      if (prev && prev.isConnected) prev.focus()
    }
    // 只在挂载时建立；onClose 走 ref，避免每次渲染重新入栈
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return ref
}
