import { useCallback, useEffect, useRef, useState } from 'react'

const STEP = 24

function readWidth(key: string, min: number, max: number, fallback: number): number {
  const raw = Number(localStorage.getItem(key))
  return Number.isFinite(raw) && raw >= min && raw <= max ? raw : fallback
}

/**
 * 服务页分栏，UI-REFACTOR §3.3 / Q8。左侧列表可拖宽（也可用方向键），宽度记在 localStorage ——
 * 纯展示偏好，不进主进程配置。`maximized` 时详情盖满整个分栏，列表保留在下面不卸载，
 * 还原后滚动位置不丢。`detail` 为空时列表独占全宽。
 */
export function SplitPane({
  list,
  detail,
  storageKey,
  min = 300,
  max = 560,
  defaultWidth = 360,
  maximized = false,
  listLabel = '列表'
}: {
  list: React.ReactNode
  detail?: React.ReactNode
  storageKey: string
  min?: number
  max?: number
  defaultWidth?: number
  maximized?: boolean
  listLabel?: string
}): React.JSX.Element {
  const [width, setWidth] = useState(() => readWidth(storageKey, min, max, defaultWidth))
  const [dragging, setDragging] = useState(false)
  const start = useRef({ x: 0, w: 0 })

  const clamp = useCallback((w: number) => Math.round(Math.min(max, Math.max(min, w))), [min, max])

  useEffect(() => {
    localStorage.setItem(storageKey, String(width))
  }, [storageKey, width])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    start.current = { x: e.clientX, w: width }
    setDragging(true)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    setWidth(clamp(start.current.w + e.clientX - start.current.x))
  }
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    setDragging(false)
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'ArrowLeft') setWidth((w) => clamp(w - STEP))
    else if (e.key === 'ArrowRight') setWidth((w) => clamp(w + STEP))
    else if (e.key === 'Home') setWidth(min)
    else if (e.key === 'End') setWidth(max)
    else return
    e.preventDefault()
  }

  const open = detail != null && detail !== false

  return (
    <div className="ui-split" data-open={open || undefined}>
      <div className="ui-split-list" style={open ? { width } : { flex: 1 }} aria-label={listLabel}>
        {list}
      </div>
      {open && (
        <>
          <div
            className="ui-split-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整列表宽度"
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuenow={width}
            tabIndex={0}
            data-dragging={dragging || undefined}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={onKeyDown}
          />
          <div className="ui-split-detail" data-max={maximized || undefined}>
            {detail}
          </div>
        </>
      )}
    </div>
  )
}
