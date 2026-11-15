import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { CheckCircle, Info, WarningCircle, X } from '@phosphor-icons/react'
import { ICON_SIZE } from '../../lib/icons'

/**
 * 通知条，UI-REFACTOR Q14。
 * - 成功 / 信息 4 秒自动消失，鼠标悬停或焦点在条内时暂停计时。
 * - 失败常驻，直到手动关闭；失败条一般带「查看输出」动作。
 * - 最多同时 4 条，多出来的挤掉最早的一条。
 */
export type ToastTone = 'live' | 'info' | 'fault'

export interface ToastInput {
  tone: ToastTone
  title: string
  body?: string
  action?: { label: string; run: () => void }
}

interface ToastItem extends ToastInput {
  id: number
}

const AUTO_DISMISS_MS = 4000
const MAX_TOASTS = 4

let seq = 0
const useToasts = create<{ items: ToastItem[] }>(() => ({ items: [] }))

export function toast(input: ToastInput): number {
  const id = ++seq
  useToasts.setState((s) => ({ items: [...s.items, { ...input, id }].slice(-MAX_TOASTS) }))
  return id
}

export function dismissToast(id: number): void {
  useToasts.setState((s) => ({ items: s.items.filter((t) => t.id !== id) }))
}

const TONE_ICON = { live: CheckCircle, info: Info, fault: WarningCircle } as const

/** 挂在 App 根部一次 */
export function ToastHost(): React.JSX.Element {
  const items = useToasts((s) => s.items)
  return createPortal(
    <div className="ui-toasts" aria-live="polite">
      {items.map((t) => (
        <ToastCard key={t.id} item={t} />
      ))}
    </div>,
    document.body
  )
}

function ToastCard({ item }: { item: ToastItem }): React.JSX.Element {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sticky = item.tone === 'fault'

  const stop = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  const arm = (): void => {
    if (sticky) return
    stop()
    timer.current = setTimeout(() => dismissToast(item.id), AUTO_DISMISS_MS)
  }

  useEffect(() => {
    arm()
    return stop
    // 只在挂载时起计时；悬停 / 焦点进出再手动暂停和重启
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const IconCmp = TONE_ICON[item.tone]
  return (
    <div
      className="ui-toast"
      data-tone={item.tone}
      role={sticky ? 'alert' : 'status'}
      onMouseEnter={stop}
      onMouseLeave={arm}
      onFocus={stop}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) arm()
      }}
    >
      <span className="ui-toast-icon" aria-hidden>
        <IconCmp size={ICON_SIZE.inline} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="ui-toast-title">{item.title}</div>
        {item.body && <div className="ui-toast-body">{item.body}</div>}
        {item.action && (
          <div className="ui-toast-actions">
            <button
              type="button"
              className="ui-btn"
              data-variant="secondary"
              data-size="sm"
              onClick={() => {
                dismissToast(item.id)
                item.action?.run()
              }}
            >
              {item.action.label}
            </button>
          </div>
        )}
      </div>
      <button
        type="button"
        className="ui-iconbtn"
        data-size="sm"
        aria-label="关闭通知"
        title="关闭通知"
        onClick={() => dismissToast(item.id)}
      >
        <X size={ICON_SIZE.inline} aria-hidden />
      </button>
    </div>
  )
}
