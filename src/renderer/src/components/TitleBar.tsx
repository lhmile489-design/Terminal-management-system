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
    <header className="drag-region flex h-9 shrink-0 items-center justify-between border-b border-line bg-panel pl-3">
      <div className="flex items-center gap-2">
        <img src={logoUrl} width={16} height={16} alt="" aria-hidden draggable={false} className="opacity-80" />
        <span className="font-mono text-[10px] font-bold tracking-[0.18em] text-ink-faint/80 uppercase select-none">
          Mile Terminal
        </span>
      </div>

      <div className="no-drag flex items-center">
        <ChromeButton label="最小化" onClick={window.mile.window.minimize}>
          <Minus size={11} weight="bold" />
        </ChromeButton>
        <ChromeButton
          label={maximized ? '还原' : '最大化'}
          onClick={window.mile.window.toggleMaximize}
        >
          {maximized ? <Copy size={10} weight="bold" /> : <Square size={10} weight="bold" />}
        </ChromeButton>
        <ChromeButton label="关闭" danger onClick={window.mile.window.close}>
          <X size={11} weight="bold" />
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
      className={`flex h-9 w-11 items-center justify-center text-ink-faint/60 transition-colors duration-150 ${
        danger
          ? 'hover:bg-fault hover:text-white active:bg-fault/80 active:text-white'
          : 'hover:bg-raised hover:text-ink-strong active:bg-line-strong'
      }`}
    >
      {children}
    </button>
  )
}
