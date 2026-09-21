import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { LaunchEntry } from '@shared/types'

/**
 * 启动台卡片排序，PRD §9.4：鼠标拖拽 + 键盘排序，无第三方拖拽库。
 *
 * 拖拽期间只改本地预览顺序，落下才写配置 —— 每次 dragover 都走 IPC 会把
 * 配置文件按像素移动的频率反复落盘。
 *
 * 置顶组始终在前，所以移动一律限制在同组内：把未置顶卡片拖到置顶组中间，
 * 主进程的 byOrder 也会把它排回去，看起来就是「拖了没反应」。不如直接不放行。
 */
export interface CardSortHandlers {
  draggable: boolean
  onDragStart: (e: React.DragEvent) => void
  onDragEnter: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onDragEnd: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
}

export function useCardSort(
  entries: LaunchEntry[],
  reorder: (ids: string[]) => Promise<void>
): {
  ordered: LaunchEntry[]
  gridRef: React.RefObject<HTMLDivElement | null>
  /** 供 aria-live 播报，无障碍必需项而非可选 */
  announcement: string
  draggingId: string | null
  handlersFor: (entry: LaunchEntry) => CardSortHandlers
} {
  const [preview, setPreview] = useState<string[] | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const gridRef = useRef<HTMLDivElement>(null)

  /**
   * 拖拽判定读 ref 而非 state：dragover 可能与 dragstart 落在同一帧，
   * 此时 state 还没提交，闭包里的 draggingId 仍是 null，整段拖拽会被误判成
   * 「没有拖拽源」而拒绝。state 只用于视觉（占位框），逻辑必须同步可读。
   */
  const dragRef = useRef<string | null>(null)
  const previewRef = useRef<string[] | null>(null)

  const setDragging = useCallback((id: string | null) => {
    dragRef.current = id
    setDraggingId(id)
  }, [])

  const setPreviewOrder = useCallback((ids: string[] | null) => {
    previewRef.current = ids
    setPreview(ids)
  }, [])

  const ordered = useMemo(() => {
    if (!preview) return entries
    const rank = new Map(preview.map((id, i) => [id, i]))
    return [...entries].sort(
      (a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER)
    )
  }, [entries, preview])

  useFlip(gridRef, ordered.map((e) => e.id).join(), draggingId)

  /** 同置顶组内的可移动区间，越界一律夹回 */
  const groupBounds = useCallback(
    (list: LaunchEntry[], pinned: boolean): [number, number] => {
      const idx = list.reduce<number[]>((acc, e, i) => (e.pinned === pinned ? [...acc, i] : acc), [])
      return [idx[0] ?? 0, idx[idx.length - 1] ?? 0]
    },
    []
  )

  const moveTo = useCallback(
    (list: LaunchEntry[], from: number, target: number): string[] | null => {
      const [lo, hi] = groupBounds(list, list[from].pinned)
      const to = Math.min(Math.max(target, lo), hi)
      if (to === from) return null
      const next = [...list]
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item)
      setAnnouncement(`${item.name} 已移到第 ${to - lo + 1} 位，共 ${hi - lo + 1} 项`)
      return next.map((e) => e.id)
    },
    [groupBounds]
  )

  /** 网格实际列数：断点写死会在窗口缩放后算错上下移动的步长 */
  const columns = useCallback((): number => {
    const grid = gridRef.current
    if (!grid) return 1
    return getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length || 1
  }, [])

  const nudge = useCallback(
    (entry: LaunchEntry, delta: number) => {
      const from = ordered.findIndex((e) => e.id === entry.id)
      if (from < 0) return
      const next = moveTo(ordered, from, from + delta)
      if (next) void reorder(next)
    },
    [ordered, moveTo, reorder]
  )

  /** 同一帧内的连续拖拽事件要看 previewRef，否则每次都从落库顺序重算 */
  const currentOrder = useCallback((): LaunchEntry[] => {
    const ids = previewRef.current
    if (!ids) return ordered
    const rank = new Map(ids.map((id, i) => [id, i]))
    return [...ordered].sort(
      (a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER)
    )
  }, [ordered])

  const handlersFor = useCallback(
    (entry: LaunchEntry): CardSortHandlers => ({
      draggable: true,
      onDragStart: (e) => {
        setDragging(entry.id)
        setPreviewOrder(ordered.map((x) => x.id))
        e.dataTransfer.effectAllowed = 'move'
        // Firefox 要求必须设点数据才会派发后续 drag 事件
        e.dataTransfer.setData('text/plain', entry.id)
      },
      onDragEnter: (e) => {
        e.preventDefault()
        const source = dragRef.current
        if (!source || source === entry.id) return
        const list = currentOrder()
        const from = list.findIndex((x) => x.id === source)
        const to = list.findIndex((x) => x.id === entry.id)
        if (from < 0 || to < 0 || list[from].pinned !== list[to].pinned) return
        const next = moveTo(list, from, to)
        if (next) setPreviewOrder(next)
      },
      onDragOver: (e) => {
        // 不 preventDefault 就不会触发 drop
        const source = dragRef.current
        if (!source) return
        const list = currentOrder()
        const target = list.find((x) => x.id === entry.id)
        const from = list.find((x) => x.id === source)
        if (!target || !from || target.pinned !== from.pinned) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
      },
      onDrop: (e) => {
        e.preventDefault()
        const next = previewRef.current
        setDragging(null)
        // preview 留到 reorder 回执后再清，否则会闪回旧顺序
        if (next) {
          void reorder(next).finally(() => setPreviewOrder(null))
        } else {
          setPreviewOrder(null)
        }
      },
      onDragEnd: () => {
        // 拖到网格外松手：drop 没发生，不落库，恢复原顺序
        if (!dragRef.current) return
        setDragging(null)
        setPreviewOrder(null)
      },
      onKeyDown: (e) => {
        if (!e.ctrlKey || e.altKey || e.metaKey) return
        const step =
          e.key === 'ArrowLeft' ? -1
          : e.key === 'ArrowRight' ? 1
          : e.key === 'ArrowUp' ? -columns()
          : e.key === 'ArrowDown' ? columns()
          : 0
        if (step === 0) return
        e.preventDefault()
        nudge(entry, step)
      }
    }),
    [ordered, currentOrder, moveTo, reorder, columns, nudge, setDragging, setPreviewOrder]
  )

  return { ordered, gridRef, announcement, draggingId, handlersFor }
}

/**
 * FLIP：DOM 重排后把卡片从旧位置动画到新位置。
 * 纯 CSS transition 管不了 grid 顺序变化 —— 元素是被移动而非位移，没有可过渡的属性。
 *
 * 正在拖拽的那张卡片必须跳过 FLIP：浏览器已经在给它渲染原生拖拽 ghost，
 * 源元素本身停在原位（0.4 透明的占位框）。若再对它补一段 translate，
 * 补间会与占位框位置打架，看起来就是被拖的卡「乱跳」。它的落点由 drop 决定，
 * 不需要动画。其余卡片照常 FLIP 滑动。
 */
function useFlip(
  gridRef: React.RefObject<HTMLDivElement | null>,
  orderKey: string,
  draggingId: string | null
): void {
  const rects = useRef<Map<string, DOMRect>>(new Map())

  useLayoutEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    const cards = [...grid.querySelectorAll<HTMLElement>('[data-entry-id]')]
    const before = rects.current
    const next = new Map<string, DOMRect>()

    for (const card of cards) {
      const id = card.dataset.entryId as string
      const now = card.getBoundingClientRect()
      next.set(id, now)
      const was = before.get(id)
      if (!was) continue
      // 被拖的卡不做补间：它归原生拖拽与占位框管
      if (id === draggingId) continue
      const dx = was.left - now.left
      const dy = was.top - now.top
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue
      card.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: 150, easing: 'ease-out' }
      )
    }
    rects.current = next
  }, [gridRef, orderKey, draggingId])
}
