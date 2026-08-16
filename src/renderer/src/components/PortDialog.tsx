import { useEffect, useRef, useState } from 'react'
import { X } from '@phosphor-icons/react'
import type { Framework } from '@shared/types'

/**
 * 端口修复，PRD §5.3。
 *
 * 只有 Next 的 `PORT` 是已验证的通用入口；其他框架不猜环境变量名，也不改
 * expectedPort 伪装成已修复。
 */
export function PortDialog({
  currentPort,
  holderName,
  framework,
  onSubmit,
  onClose
}: {
  currentPort?: number
  holderName?: string
  framework: Framework
  onSubmit?: (port: number) => void
  onClose: () => void
}): React.JSX.Element {
  const [value, setValue] = useState(currentPort ? String(currentPort) : '')
  const inputRef = useRef<HTMLInputElement>(null)
  const isNext = framework === 'next'

  useEffect(() => {
    inputRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const port = Number(value)
  const valid = Number.isInteger(port) && port >= 1 && port <= 65535

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="port-dialog-heading"
        data-port-fix-mode={isNext ? 'next' : 'manual'}
        className="w-full max-w-sm rounded-[14px] border border-line bg-panel shadow-2xl"
      >
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <h2 id="port-dialog-heading" className="text-[14px] font-semibold text-ink-strong">
            {isNext ? '改用其他端口' : '端口需要项目配置'}
          </h2>
          <button
            type="button"
            aria-label="关闭"
            title="关闭"
            onClick={onClose}
            className="pressable flex h-7 w-7 items-center justify-center rounded-[6px] text-ink-faint hover:bg-raised hover:text-ink"
          >
            <X size={14} weight="bold" />
          </button>
        </header>

        <div className="flex flex-col gap-3 px-5 py-4">
          {holderName && (
            <p className="text-[12.5px] text-ink-muted">
              当前端口被 <span className="font-mono text-ink-strong">{holderName}</span>{' '}
              占用，且不会终止外部进程。
            </p>
          )}
          {isNext ? (
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] text-ink-faint">新的服务端口</span>
              <input
                ref={inputRef}
                type="number"
                min={1}
                max={65535}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && valid) onSubmit?.(port)
                }}
                className="rounded-[6px] border border-line-strong bg-card px-2.5 py-1.5 font-mono text-[12.5px] text-ink-strong outline-none focus:border-info"
              />
            </label>
          ) : (
            <p className="text-[12.5px] leading-5 text-ink-muted">
              Mile Terminal 无法安全推断此项目使用的端口配置。请修改项目配置，或在编辑条目中填写该项目文档指定的环境变量名。
            </p>
          )}
          <p className="text-[11px] text-ink-faint">
            {isNext
              ? '保存后会在下次启动时注入 PORT，并同步预期端口。'
              : '不会修改预期端口，也不会向启动命令追加 --port。'}
          </p>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-line px-5 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="pressable rounded-[6px] border border-line-strong bg-card px-3 py-1.5 text-[12px] text-ink-muted hover:text-ink-strong"
          >
            {isNext ? '取消' : '关闭'}
          </button>
          {isNext && (
            <button
              type="button"
              disabled={!valid}
              onClick={() => onSubmit?.(port)}
              className="btn-primary px-3 py-1.5 text-[12px]"
            >
              保存
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}
