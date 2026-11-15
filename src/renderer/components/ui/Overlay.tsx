import { useId } from 'react'
import { createPortal } from 'react-dom'
import { X } from '@phosphor-icons/react'
import { useOverlay } from '../../lib/overlay'
import { IconButton } from './Button'

/**
 * 对话框外壳：遮罩淡入、面板回弹弹出、焦点陷阱、Esc 只关最上层。
 * 挂到 body 上，避免被父级的 overflow / transform 截住。
 */
export function DialogShell({
  title,
  icon,
  onClose,
  footer,
  children,
  width = 480,
  alert,
  initialFocus,
  dismissOnScrim = true,
  dataset
}: {
  title: string
  icon?: React.ReactNode
  onClose: () => void
  footer?: React.ReactNode
  children?: React.ReactNode
  width?: number
  /** 危险确认用 alertdialog，读屏会立即播报 */
  alert?: boolean
  initialFocus?: React.RefObject<HTMLElement | null>
  dismissOnScrim?: boolean
  /** 额外的 data-* 属性，给 harness 与样式定位用 */
  dataset?: Record<string, string>
}): React.JSX.Element {
  const titleId = useId()
  const ref = useOverlay<HTMLDivElement>(onClose, { initialFocus })

  return createPortal(
    <>
      <div className="ui-scrim" onClick={dismissOnScrim ? onClose : undefined} aria-hidden />
      <div
        ref={ref}
        className="ui-dialog"
        role={alert ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={titleId}
        style={{ width }}
        {...Object.fromEntries(Object.entries(dataset ?? {}).map(([k, v]) => [`data-${k}`, v]))}
      >
        <div className="ui-dialog-head">
          {icon && <span className="ui-dialog-icon" aria-hidden>{icon}</span>}
          <h2 id={titleId} className="ui-dialog-title">{title}</h2>
          {!alert && (
            <span style={{ marginLeft: 'auto' }}>
              <IconButton icon={X} label="关闭" onClick={onClose} />
            </span>
          )}
        </div>
        {children != null && <div className="ui-dialog-body">{children}</div>}
        {footer && <div className="ui-dialog-foot">{footer}</div>}
      </div>
    </>,
    document.body
  )
}

/**
 * 右侧抽屉：从右滑入，遮罩淡入，毛玻璃。实时动态用它（Q1）。
 * 遮罩从标题栏下方开始，标题栏上的「动态」按钮仍可见。
 */
export function Drawer({
  title,
  onClose,
  actions,
  children,
  width = 360
}: {
  title: string
  onClose: () => void
  actions?: React.ReactNode
  children: React.ReactNode
  width?: number
}): React.JSX.Element {
  const titleId = useId()
  const ref = useOverlay<HTMLElement>(onClose)

  return createPortal(
    <>
      <div className="ui-scrim" data-below-titlebar="true" onClick={onClose} aria-hidden />
      <aside ref={ref} className="ui-drawer" role="dialog" aria-modal="true" aria-labelledby={titleId} style={{ width }}>
        <div className="ui-drawer-head">
          <h2 id={titleId} className="ui-drawer-title">{title}</h2>
          {actions}
          <IconButton icon={X} label="关闭" onClick={onClose} />
        </div>
        <div className="ui-drawer-body">{children}</div>
      </aside>
    </>,
    document.body
  )
}
