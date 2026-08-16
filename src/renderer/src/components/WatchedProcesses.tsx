import { useState } from 'react'
import { Eye, Plus, X } from '@phosphor-icons/react'
import { useScanner } from '../store/scanner'
import { formatBytes, formatUptime } from '../lib/format'

/**
 * 关注进程，PRD §5.5。按命令行关键字匹配当前用户的进程，不监听端口也能看到。
 *
 * 命令行由主进程截断后下发：完整参数里可能带 token，摊在界面上不合适。
 */
export function WatchedProcesses(): React.JSX.Element {
  const watched = useScanner((s) => s.watched)
  const keywords = useScanner((s) => s.keywords)
  const addKeyword = useScanner((s) => s.addKeyword)
  const removeKeyword = useScanner((s) => s.removeKeyword)
  const [draft, setDraft] = useState('')

  const submit = (): void => {
    const value = draft.trim()
    if (!value) return
    setDraft('')
    void addKeyword(value)
  }

  return (
    <section aria-labelledby="watched-heading">
      <h2 id="watched-heading" className="eyebrow mb-3">
        Watched · 关注进程
      </h2>

      <div className="surface-card flex flex-col gap-3 px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {keywords.map((k) => (
            <span
              key={k}
              className="flex items-center gap-1 rounded-[5px] border border-line-strong bg-raised py-0.5 pr-0.5 pl-2 font-mono text-[11px] text-ink-muted"
            >
              {k}
              <button
                type="button"
                aria-label={`移除关键字 ${k}`}
                title={`移除关键字 ${k}`}
                onClick={() => void removeKeyword(k)}
                className="pressable flex h-4 w-4 items-center justify-center rounded-[3px] text-ink-faint hover:bg-card hover:text-fault"
              >
                <X size={9} weight="bold" />
              </button>
            </span>
          ))}

          <span className="flex items-center gap-1.5">
            <input
              value={draft}
              placeholder="ffmpeg"
              aria-label="新增关注关键字"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
              className="w-[132px] rounded-[5px] border border-line bg-card px-2 py-1 font-mono text-[11px] text-ink-strong outline-none focus:border-accent"
            />
            <button
              type="button"
              aria-label="添加关键字"
              title="添加关键字"
              onClick={submit}
              disabled={!draft.trim()}
              className="pressable flex h-[26px] w-[26px] items-center justify-center rounded-[5px] border border-line-strong bg-card text-ink-muted hover:text-ink-strong disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Plus size={12} weight="bold" />
            </button>
          </span>
        </div>

        {keywords.length === 0 ? (
          <p className="text-[12px] text-ink-faint">
            保存关键字后，即使进程不监听端口也能在这里持续观察它的 CPU 与内存
          </p>
        ) : watched.length === 0 ? (
          <p className="text-[12px] text-ink-faint">当前没有命中的进程</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {watched.map((w) => (
              <li key={w.pid} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
                <span className="icon-tile h-7 w-7 shrink-0" aria-hidden>
                  <Eye size={12} weight="bold" />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <p className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate text-[12.5px] text-ink-strong">{w.processName}</span>
                    <span className="shrink-0 rounded-[4px] bg-raised px-1.5 font-mono text-[10px] text-ink-muted">
                      {w.keyword}
                    </span>
                  </p>
                  <p
                    className="truncate font-mono text-[10.5px] text-ink-faint"
                    title={w.commandLine ?? ''}
                  >
                    {w.commandLine ?? '命令行不可读'}
                  </p>
                </div>
                <span className="shrink-0 font-mono text-[11px] text-ink-muted">PID {w.pid}</span>
                <span className="w-[52px] shrink-0 text-right font-mono text-[11px] text-ink-muted">
                  {w.cpu === null ? '—' : `${w.cpu.toFixed(1)}%`}
                </span>
                <span className="w-[64px] shrink-0 text-right font-mono text-[11px] text-ink-muted">
                  {formatBytes(w.memory)}
                </span>
                <span className="w-[60px] shrink-0 text-right font-mono text-[11px] text-ink-muted">
                  {formatUptime(w.startedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
