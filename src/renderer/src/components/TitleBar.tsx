import { useEffect, useState } from 'react'
import { Minus, Square, X, Copy } from '@phosphor-icons/react'
import logoUrl from '../assets/logo.png'

export function TitleBar(): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.mile.window.isMaximized().then(setMaximized)
    return window.mile.window.onMaximizeChange(setMaximized)
  }, [])

  return (
    <header className="drag-region flex h-10 shrink-0 items-center justify-between border-b border-line bg-panel pl-4">
      <div className="flex items-center gap-2.5">
        <img src={logoUrl} width={20} height={20} alt="" aria-hidden draggable={false} />
        <span className="font-mono text-[11px] font-semibold tracking-[0.14em] text-ink-muted uppercase">
          Mile Terminal
        </span>
      </div>

      <div className="no-drag flex items-center">
        <ChromeButton label="最小化" onClick={window.mile.window.minimize}>
          <Minus size={13} weight="bold" />
        </ChromeButton>
        <ChromeButton
          label={maximized ? '还原' : '最大化'}
          onClick={window.mile.window.toggleMaximize}
        >
          {maximized ? <Copy size={12} weight="bold" /> : <Square size={11} weight="bold" />}
        </ChromeButton>
        <ChromeButton label="关闭" danger onClick={window.mile.window.close}>
          <X size={13} weight="bold" />
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
  // 不做位移：窗口控件贴着窗口边缘，缩放会露出底下的标题栏。按下靠底色再深一档
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`flex h-10 w-12 items-center justify-center text-ink-muted transition-colors ${
        danger
          ? 'hover:bg-fault active:bg-fault/80 hover:text-white active:text-white'
          : 'hover:bg-raised active:bg-line-strong hover:text-ink-strong'
      }`}
    >
      {children}
    </button>
  )
}
