import { useCallback, useEffect, useRef, useState } from 'react'
import { FolderOpen, X } from '@phosphor-icons/react'
import type { DetectResult, EntryKind, NewLaunchEntry } from '@shared/types'
import { FRAMEWORK_LABEL } from '../lib/entryMeta'

export function AddEntryDialog({
  kind,
  initialPath,
  initialName,
  categories,
  onSubmit,
  onClose
}: {
  kind: EntryKind
  /** 从「发现未纳管服务」进入时带上目录，跳过手动选择 */
  initialPath?: string
  initialName?: string
  categories: string[]
  onSubmit: (input: NewLaunchEntry) => Promise<void>
  onClose: () => void
}): React.JSX.Element {
  const [path, setPath] = useState(initialPath ?? '')
  const [detected, setDetected] = useState<DetectResult | null>(null)
  const [name, setName] = useState(initialName ?? '')
  const [category, setCategory] = useState('')
  const [script, setScript] = useState<string>('')
  const [detecting, setDetecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  const detect = useCallback(
    async (target: string) => {
      setDetecting(true)
      setError(null)
      try {
        const result = await window.mile.entry.detect(target)
        setDetected(result)
        setName((current) => current || result.name)
        // 服务取 dev 脚本，任务取 build 脚本
        setScript((kind === 'service' ? result.devScript : result.buildScript) ?? '')
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setDetecting(false)
      }
    },
    [kind]
  )

  useEffect(() => {
    closeRef.current?.focus()
    if (initialPath) void detect(initialPath)
  }, [initialPath, detect])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const pick = async (): Promise<void> => {
    const target = await window.mile.dialog.pickDirectory()
    if (!target) return
    setPath(target)
    await detect(target)
  }

  const submit = async (): Promise<void> => {
    if (!detected || !name.trim()) return
    // 无 package.json 或未选脚本时只能仅登记：可监控、不可启动
    const registerOnly = detected.registerOnly || !script
    await onSubmit({
      kind,
      name: name.trim(),
      category: category.trim() || undefined,
      path: detected.path,
      framework: detected.framework,
      packageManager: detected.packageManager,
      script: script || null,
      scripts: detected.scripts,
      env: {},
      registerOnly,
      pinned: false
    })
    onClose()
  }

  const scripts = Object.keys(detected?.scripts ?? {})

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/80 px-6 py-10"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-entry-title"
    >
      <div className="flex max-h-full w-full max-w-[560px] flex-col overflow-hidden rounded-[12px] border border-line bg-panel">
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <h2 id="add-entry-title" className="text-[15px] font-semibold text-ink-strong">
            添加{kind === 'service' ? '服务' : '任务'}
          </h2>
          <button
            ref={closeRef}
            type="button"
            aria-label="关闭"
            title="关闭"
            onClick={onClose}
            className="pressable flex h-7 w-7 items-center justify-center rounded-[6px] text-ink-muted hover:bg-raised hover:text-ink-strong"
          >
            <X size={14} weight="bold" />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
          <Field label="项目目录">
            <div className="flex items-center gap-2">
              <span
                className="min-w-0 flex-1 truncate rounded-[6px] border border-line bg-card px-2.5 py-1.5 font-mono text-[12px] text-ink-muted"
                title={path || '未选择'}
              >
                {path || '未选择'}
              </span>
              <button
                type="button"
                onClick={() => void pick()}
                className="pressable flex shrink-0 items-center gap-1.5 rounded-[6px] border border-line-strong bg-card px-2.5 py-1.5 text-[12px] text-ink-muted hover:text-ink-strong"
              >
                <FolderOpen size={13} weight="bold" />
                选择目录
              </button>
            </div>
          </Field>

          {detecting && <p className="text-[12px] text-ink-muted">正在识别项目…</p>}
          {error && <p className="text-[12px] text-fault">{error}</p>}

          {detected && (
            <>
              <Field label="名称">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-[6px] border border-line bg-card px-2.5 py-1.5 text-[13px] text-ink-strong"
                />
              </Field>

              <Field label="分类">
                <input
                  data-entry-category-input
                  list="launchpad-category-options"
                  value={category}
                  maxLength={40}
                  placeholder="未分类（可输入新分类）"
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full rounded-[6px] border border-line bg-card px-2.5 py-1.5 text-[13px] text-ink-strong outline-none focus:border-accent"
                />
                <datalist id="launchpad-category-options">
                  {categories.map((item) => (
                    <option key={item} value={item} />
                  ))}
                </datalist>
              </Field>

              <Field label="识别结果">
                <p className="font-mono text-[12px] text-ink-muted">
                  {FRAMEWORK_LABEL[detected.framework]} · {detected.packageManager}
                  {detected.hasPackageJson ? '' : ' · 无 package.json'}
                </p>
              </Field>

              <Field label={kind === 'service' ? '启动脚本' : '执行脚本'}>
                {scripts.length === 0 ? (
                  <p className="text-[12px] text-ink-faint">
                    该项目没有可用脚本，条目将以「仅登记」方式添加，可监控不可启动
                  </p>
                ) : (
                  <select
                    value={script}
                    onChange={(e) => setScript(e.target.value)}
                    className="w-full rounded-[6px] border border-line bg-card px-2.5 py-1.5 font-mono text-[12px] text-ink-strong"
                  >
                    <option value="">不设置（仅登记）</option>
                    {scripts.map((s) => (
                      <option key={s} value={s}>
                        {s} — {detected.scripts[s]}
                      </option>
                    ))}
                  </select>
                )}
              </Field>

              {detected.warnings.length > 0 && (
                <ul className="flex flex-col gap-1 rounded-[6px] bg-warn-soft px-3 py-2">
                  {detected.warnings.map((w) => (
                    <li key={w} className="text-[12px] text-warn">
                      {w}
                    </li>
                  ))}
                </ul>
              )}
            </>
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
            onClick={() => void submit()}
            disabled={!detected || !name.trim()}
            className="btn-primary px-3 py-1.5 text-[12px]"
          >
            添加到启动台
          </button>
        </footer>
      </div>
    </div>
  )
}

function Field({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-[10px] font-semibold tracking-[0.12em] text-ink-faint uppercase">
        {label}
      </span>
      {children}
    </label>
  )
}
