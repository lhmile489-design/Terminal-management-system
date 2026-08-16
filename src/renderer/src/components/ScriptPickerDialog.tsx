import { useEffect, useRef, useState } from 'react'
import { X } from '@phosphor-icons/react'
import type { LaunchEntry } from '@shared/types'

/**
 * 选择其他脚本，PRD §5.3。候选只来自该项目 package.json 的 scripts 快照 ——
 * 不接受自由输入，否则等于让界面构造任意命令。
 */
export function ScriptPickerDialog({
  entry,
  onPick,
  onClose
}: {
  entry: LaunchEntry
  onPick: (script: string) => void
  onClose: () => void
}): React.JSX.Element {
  const names = Object.keys(entry.scripts)
  const [selected, setSelected] = useState(entry.script ?? names[0] ?? '')
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="script-picker-heading"
        className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-[14px] border border-line bg-panel shadow-2xl"
      >
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <h2 id="script-picker-heading" className="text-[14px] font-semibold text-ink-strong">
            选择要执行的脚本
          </h2>
          <button
            ref={closeRef}
            type="button"
            aria-label="关闭"
            title="关闭"
            onClick={onClose}
            className="pressable flex h-7 w-7 items-center justify-center rounded-[6px] text-ink-faint hover:bg-raised hover:text-ink"
          >
            <X size={14} weight="bold" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {names.length === 0 ? (
            <p className="text-[13px] text-ink-muted">
              该项目的 package.json 里没有可用脚本。请重新选择目录，或改用仅登记。
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {names.map((name) => (
                <li key={name}>
                  <label
                    className={`pressable-flat flex cursor-pointer items-start gap-3 rounded-[8px] border px-3 py-2 ${
                      selected === name
                        ? 'border-line-strong bg-raised'
                        : 'border-line bg-card hover:border-line-strong'
                    }`}
                  >
                    <input
                      type="radio"
                      name="script"
                      value={name}
                      checked={selected === name}
                      onChange={() => setSelected(name)}
                      className="mt-1 shrink-0"
                    />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="font-mono text-[12.5px] text-ink-strong">{name}</span>
                      <span className="font-mono text-[11px] break-all text-ink-faint">
                        {entry.scripts[name]}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-line px-5 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="pressable rounded-[6px] border border-line-strong bg-card px-3 py-1.5 text-[12px] text-ink-muted hover:text-ink-strong"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!selected}
            onClick={() => onPick(selected)}
            className="btn-primary px-3 py-1.5 text-[12px]"
          >
            使用该脚本
          </button>
        </footer>
      </div>
    </div>
  )
}
