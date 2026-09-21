import { useCallback, useEffect, useRef, useState } from 'react'
import { FolderOpen, X } from '@phosphor-icons/react'
import type { DetectResult, EntryKind, LaunchMode, NewLaunchEntry } from '@shared/types'
import { FRAMEWORK_LABEL, FRAMEWORK_LAUNCH_MODES, LAUNCH_MODE_LABEL } from '../lib/entryMeta'

/** 需要在 jarPath 字段填「路径/模块」的启动方式 */
const MODES_NEEDING_PATH = new Set<LaunchMode>([
  'jar',
  'cpp-exe',
  'python-file',
  'python-module',
  'uvicorn'
])

const PATH_HINT: Partial<Record<LaunchMode, { label: string; placeholder: string }>> = {
  jar: { label: 'jar 路径', placeholder: 'target/app.jar' },
  'cpp-exe': { label: '可执行文件（.exe）', placeholder: 'build/app.exe' },
  'python-file': { label: '入口文件', placeholder: 'main.py' },
  'python-module': { label: '模块名', placeholder: 'app.main' },
  uvicorn: { label: 'ASGI app', placeholder: 'main:app' }
}

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
  /** image：新建时选的图片字节，条目创建后由 Launchpad 补一次 setImage */
  onSubmit: (input: NewLaunchEntry, image?: ArrayBuffer) => Promise<void>
  onClose: () => void
}): React.JSX.Element {
  const [path, setPath] = useState(initialPath ?? '')
  const [detected, setDetected] = useState<DetectResult | null>(null)
  const [name, setName] = useState(initialName ?? '')
  const [category, setCategory] = useState('')
  const [script, setScript] = useState<string>('')
  const [launchMode, setLaunchMode] = useState<LaunchMode | ''>('')
  const [jarPath, setJarPath] = useState('')
  // 新建时选的图片：字节暂存，预览用 object URL；创建成功后由 Launchpad 补 setImage
  const [imageBytes, setImageBytes] = useState<ArrayBuffer | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
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
        // 可启动的非 npm 生态：用探测到的默认启动方式预填
        setLaunchMode(result.detectedLaunchMode ?? '')
        setJarPath('')
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

  // 新建时选图：暂存字节 + 本地预览。压缩落盘推迟到条目创建后（Launchpad 补 setImage），
  // 因为此刻还没有条目 id。预览用 object URL，卸载时释放。
  const onPickImage = (file: File | undefined): void => {
    if (!file) return
    void file.arrayBuffer().then((buf) => {
      setImageBytes(buf)
      setImagePreview((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return URL.createObjectURL(file)
      })
    })
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const clearImage = (): void => {
    setImagePreview((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    setImageBytes(null)
  }

  useEffect(() => {
    return () => {
      if (imagePreview) URL.revokeObjectURL(imagePreview)
    }
  }, [imagePreview])

  const launchModeOptions = detected ? FRAMEWORK_LAUNCH_MODES[detected.framework] : undefined
  const isLaunchable = !!launchModeOptions

  const submit = async (): Promise<void> => {
    if (!detected || !name.trim()) return

    if (isLaunchable) {
      // 可启动的非 npm 生态：命令由 launchMode 决定；部分模式需要路径/模块
      const mode = launchMode || undefined
      await onSubmit({
        kind,
        name: name.trim(),
        category: category.trim() || undefined,
        path: detected.path,
        framework: detected.framework,
        packageManager: detected.packageManager,
        script: null,
        scripts: {},
        env: {},
        launchMode: mode,
        jarPath: mode && MODES_NEEDING_PATH.has(mode) ? jarPath.trim() || undefined : undefined,
        ...(detected.detectedPort ? { expectedPort: detected.detectedPort } : {}),
        // 选了启动方式才可启动；没选就仅登记
        registerOnly: !mode,
        pinned: false
      }, imageBytes ?? undefined)
      onClose()
      return
    }

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
    }, imageBytes ?? undefined)
    onClose()
  }

  // 需要路径的模式必须填了才能提交
  const modeNeedsPath = launchMode !== '' && MODES_NEEDING_PATH.has(launchMode)
  const pathInfo = launchMode !== '' ? PATH_HINT[launchMode] : undefined
  const launchIncomplete = isLaunchable && modeNeedsPath && !jarPath.trim()

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

              {/* 自定义图片：服务与任务都可用，创建后压缩落盘。优先于预设图标与 favicon */}
              <Field label="自定义图片（可选，压缩存本地）">
                <div className="flex items-center gap-3">
                  <span
                    className="icon-tile flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden"
                    aria-hidden
                  >
                    {imagePreview ? (
                      <img
                        src={imagePreview}
                        className="h-9 w-9 rounded-[4px] object-contain"
                        alt=""
                        draggable={false}
                      />
                    ) : (
                      <span className="font-mono text-[11px] text-ink-faint">无</span>
                    )}
                  </span>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
                    className="hidden"
                    onChange={(e) => onPickImage(e.target.files?.[0])}
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="pressable rounded-[6px] border border-line-strong bg-card px-2.5 py-1.5 text-[12px] text-ink-muted hover:text-ink-strong"
                  >
                    {imagePreview ? '更换图片' : '上传图片'}
                  </button>
                  {imagePreview && (
                    <button
                      type="button"
                      onClick={clearImage}
                      className="pressable rounded-[6px] border border-line-strong bg-card px-2.5 py-1.5 text-[12px] text-ink-muted hover:text-ink-strong"
                    >
                      移除
                    </button>
                  )}
                </div>
              </Field>

              {isLaunchable ? (
                <>
                  <Field label="启动方式">
                    <select
                      value={launchMode}
                      onChange={(e) => setLaunchMode(e.target.value as LaunchMode | '')}
                      className="w-full rounded-[6px] border border-line bg-card px-2.5 py-1.5 font-mono text-[12px] text-ink-strong"
                    >
                      <option value="">不设置（仅登记）</option>
                      {launchModeOptions.map((m) => (
                        <option key={m} value={m}>
                          {LAUNCH_MODE_LABEL[m]}
                        </option>
                      ))}
                    </select>
                  </Field>

                  {modeNeedsPath && (
                    <Field label={pathInfo?.label ?? '路径'}>
                      <input
                        value={jarPath}
                        onChange={(e) => setJarPath(e.target.value)}
                        placeholder={pathInfo?.placeholder ?? ''}
                        className="w-full rounded-[6px] border border-line bg-card px-2.5 py-1.5 font-mono text-[12px] text-ink-strong"
                      />
                    </Field>
                  )}
                </>
              ) : (
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
              )}

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
            disabled={!detected || !name.trim() || launchIncomplete}
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
