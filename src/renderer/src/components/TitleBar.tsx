import { useEffect, useState } from 'react'
import { Copy, Minus, Square, X } from '@phosphor-icons/react'
import { ICON, ICON_SIZE } from '../lib/icons'
import logoUrl from '../assets/logo.png'

/**
 * 标题栏 40px，UI-REFACTOR §3.2：品牌 · 搜索入口 · 实时动态 · 窗口控件。
 * 整条是拖拽区，可点的元素逐个 no-drag。
 */
export function TitleBar({
  onSearch,
  onActivity,
  unread,
  unreadFault
}: {
  onSearch: () => void
  onActivity: () => void
  unread: number
  unreadFault: boolean
}): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.mile.window.isMaximized().then(setMaximized)
    return window.mile.window.onMaximizeChange(setMaximized)
  }, [])

  const Search = ICON.search
  const Bell = ICON.activity

  return (
    <header className="ui-titlebar drag-region">
      <div className="ui-brand">
        <span className="ui-brand-mark" aria-hidden>
          <img src={logoUrl} alt="" draggable={false} />
        </span>
        Mile Terminal
      </div>

      <button type="button" className="ui-search-trigger no-drag" onClick={onSearch}>
        <Search size={ICON_SIZE.inline} aria-hidden />
        <span>搜索服务、端口或命令</span>
        <kbd className="ui-kbd">Ctrl K</kbd>
      </button>

      <div className="ui-tb-right no-drag">
        <button
          type="button"
          id="activity-trigger"
          className="ui-bell"
          onClick={onActivity}
          title="实时动态"
          aria-label={unread ? `实时动态，${unread} 条未读` : '实时动态'}
        >
          <Bell size={ICON_SIZE.inline} aria-hidden />
          {unread > 0 && (
            <span className="ui-bell-badge" data-fault={unreadFault || undefined} aria-hidden>
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>
        <ChromeButton label="最小化" onClick={window.mile.window.minimize}>
          <Minus size={ICON_SIZE.inline} aria-hidden />
        </ChromeButton>
        <ChromeButton label={maximized ? '还原' : '最大化'} onClick={window.mile.window.toggleMaximize}>
          {maximized ? <Copy size={ICON_SIZE.inline} aria-hidden /> : <Square size={ICON_SIZE.inline} aria-hidden />}
        </ChromeButton>
        <ChromeButton label="关闭" danger onClick={window.mile.window.close}>
          <X size={ICON_SIZE.inline} aria-hidden />
        </ChromeButton>
      </div>
    </header>
  )
}

function ChromeButton({
  label,
  onClick,
  danger,
  children
}: {
  label: string
  onClick: () => void
  danger?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="ui-chrome"
      data-close={danger || undefined}
    >
      {children}
    </button>
  )
}
