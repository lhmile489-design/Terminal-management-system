import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FolderOpen, MagnifyingGlass, Image as ImageIcon, Warning } from '@phosphor-icons/react'
import { Button, IconButton } from './ui'
import { useOverlay } from '../lib/overlay'
import { ICON } from '../lib/icons'
import type { DetectResult, EntryKind, LaunchMode, NewLaunchEntry } from '@shared/types'
import { FRAMEWORK_LABEL, FRAMEWORK_LAUNCH_MODES, LAUNCH_MODE_LABEL } from '../lib/entryMeta'
import { useEntries } from '../store/entries'

/** Windows 路径比较：大小写、斜杠方向、末尾分隔符都不算区别 */
const normDir = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

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
  /** 每次识别递增；晚到的旧结果发现版本不是自己就丢弃，免得盖掉新目录的状态 */
  const detectSeq = useRef(0)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const panelRef = useOverlay<HTMLDivElement>(onClose)
  const allEntries = useEntries((s) => s.entries)
  const sameDir = detected ? allEntries.filter((e) => normDir(e.path) === normDir(detected.path)) : []

  const detect = useCallback(
    async (target: string) => {
      const seq = ++detectSeq.current
      setDetecting(true)
      setError(null)
      try {
        const result = await window.mile.entry.detect(target)
        // 期间又选了别的目录：这份结果属于旧目录，丢掉
        if (seq !== detectSeq.current) return
        setDetected(result)
        setName((current) => current || result.name)
        // 服务取 dev 脚本，任务取 build 脚本
        setScript((kind === 'service' ? result.devScript : result.buildScript) ?? '')
        // 可启动的非 npm 生态：用探测到的默认启动方式预填
        setLaunchMode(result.detectedLaunchMode ?? '')
        setJarPath('')
      } catch (err) {
        if (seq === detectSeq.current) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (seq === detectSeq.current) setDetecting(false)
      }
    },
    [kind]
  )

  useEffect(() => {
    if (initialPath) void detect(initialPath)
  }, [initialPath, detect])


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

  /** 同步锁：state 要等下一次渲染才变，同一帧里的第二次点击会漏过去，所以另用 ref */
  const submitLock = useRef(false)
  const submit = async (): Promise<void> => {
    if (submitLock.current) return
    submitLock.current = true
    setSubmitting(true)
    try {
      await submitNow()
    } finally {
      // onSubmit 抛错时对话框不关，要让用户能再点一次
      submitLock.current = false
      setSubmitting(false)
    }
  }

  const submitNow = async (): Promise<void> => {
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

  const willRegisterOnly = detected ? (isLaunchable ? !launchMode : detected.registerOnly || !script) : false
  const noun = kind === 'service' ? '服务' : '任务'

  return createPortal(
    <>
      <div className="ui-scrim add-scrim" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        className="add-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-entry-title"
      >
        <header className="add-head">
          <span className="add-head-icon" aria-hidden>
            <ICON.add size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="add-entry-title" className="add-title">添加{noun}</h2>
            <p className="add-sub">选一个项目目录，自动识别框架和{kind === 'service' ? '启动' : '执行'}脚本。只读文件，不会执行项目代码</p>
          </div>
          <ol className="add-steps" aria-label="步骤">
            <li data-on={!detected || undefined}>1 选目录</li>
            <li data-on={!!detected || undefined}>2 确认</li>
          </ol>
          <IconButton icon={ICON.close} label="关闭" onClick={onClose} />
        </header>

        <div className="add-body">
          {!path ? (
            <button type="button" className="add-drop" onClick={() => void pick()}>
              <FolderOpen size={28} aria-hidden />
              <b>选择项目目录</b>
              <span>识别 package.json、pom.xml 等标记文件</span>
            </button>
          ) : (
            <div className="add-path">
              <FolderOpen size={20} aria-hidden className="shrink-0 text-ink-muted" />
              <span className="add-path-text" title={path}>{path}</span>
              <Button size="sm" onClick={() => void pick()}>更换目录</Button>
            </div>
          )}

          {detecting && (
            <p className="add-status"><MagnifyingGlass size={16} aria-hidden />正在识别项目…</p>
          )}
          {error && <p className="add-error" role="alert">{error}</p>}

          {detected && (
            <>
              <div className="add-detect">
                <span className="add-detect-k">识别结果</span>
                <span className="ui-pill" data-tone="accent">{FRAMEWORK_LABEL[detected.framework]}</span>
                <span className="ui-pill" data-tone="idle" data-mono="true">{detected.packageManager}</span>
                {!detected.hasPackageJson && <span className="ui-pill" data-tone="warn">无 package.json</span>}
                {detected.detectedPort ? <span className="ui-pill" data-tone="idle" data-mono="true">:{detected.detectedPort}</span> : null}
              </div>

              {/* 同一目录已登记：只提示不拦截，同目录配不同脚本（monorepo、dev 与 build）是合理用法 */}
              {sameDir.length > 0 && (
                <p className="add-dup" data-dup-dir>
                  <Warning size={16} aria-hidden />
                  这个目录已登记为{sameDir.map((e) => `「${e.name}」`).join('、')}。要用同一目录配另一个脚本可以继续添加，否则不必重复登记
                </p>
              )}

              <div className="add-grid">
                <Field label="名称">
                  <input className="ui-input" value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
                <Field label="分类">
                  <input
                    className="ui-input"
                    data-entry-category-input
                    list="launchpad-category-options"
                    value={category}
                    maxLength={40}
                    placeholder="未分类（可输入新分类）"
                    onChange={(e) => setCategory(e.target.value)}
                  />
                  <datalist id="launchpad-category-options">
                    {categories.map((item) => (
                      <option key={item} value={item} />
                    ))}
                  </datalist>
                </Field>

                {isLaunchable ? (
                  <>
                    <Field label="启动方式" full={!modeNeedsPath}>
                      <select
                        className="ui-input"
                        data-mono="true"
                        value={launchMode}
                        onChange={(e) => setLaunchMode(e.target.value as LaunchMode | '')}
                      >
                        <option value="">不设置（仅登记）</option>
                        {launchModeOptions.map((m) => (
                          <option key={m} value={m}>{LAUNCH_MODE_LABEL[m]}</option>
                        ))}
                      </select>
                    </Field>
                    {modeNeedsPath && (
                      <Field label={pathInfo?.label ?? '路径'}>
                        <input
                          className="ui-input"
                          data-mono="true"
                          value={jarPath}
                          onChange={(e) => setJarPath(e.target.value)}
                          placeholder={pathInfo?.placeholder ?? ''}
                        />
                      </Field>
                    )}
                  </>
                ) : (
                  <Field label={kind === 'service' ? '启动脚本' : '执行脚本'} full>
                    {scripts.length === 0 ? (
                      <p className="add-hint">该项目没有可用脚本，会以「仅登记」方式添加：可监控，不可启动</p>
                    ) : (
                      <select className="ui-input" data-mono="true" value={script} onChange={(e) => setScript(e.target.value)}>
                        <option value="">不设置（仅登记）</option>
                        {scripts.map((s) => (
                          <option key={s} value={s}>{s} — {detected.scripts[s]}</option>
                        ))}
                      </select>
                    )}
                  </Field>
                )}

                <Field label="自定义图片（可选）" full>
                  <div className="add-image">
                    <span className="add-image-tile" aria-hidden>
                      {imagePreview ? (
                        <img src={imagePreview} alt="" draggable={false} />
                      ) : (
                        <ImageIcon size={20} />
                      )}
                    </span>
                    <span className="add-hint">压缩后存本地，优先于框架图标</span>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
                      className="hidden"
                      onChange={(e) => onPickImage(e.target.files?.[0])}
                    />
                    <Button size="sm" onClick={() => fileInputRef.current?.click()}>
                      {imagePreview ? '更换图片' : '上传图片'}
                    </Button>
                    {imagePreview && <Button size="sm" variant="ghost" onClick={clearImage}>移除</Button>}
                  </div>
                </Field>
              </div>

              {detected.warnings.length > 0 && (
                <ul className="add-warn">
                  {detected.warnings.map((w) => (
                    <li key={w}><Warning size={16} aria-hidden />{w}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        <footer className="add-foot">
          <span className="add-foot-msg">
            {!detected ? '先选一个项目目录' : willRegisterOnly ? '将以「仅登记」方式添加：可监控，不可启动' : `添加后可在服务页一键启动`}
          </span>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            icon={ICON.add}
            onClick={() => void submit()}
            disabled={!detected || !name.trim() || launchIncomplete || submitting}
          >
            添加{noun}
          </Button>
        </footer>
      </div>
    </>,
    document.body
  )
}

function Field({
  label,
  full,
  children
}: {
  label: string
  full?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="ui-field" style={full ? { gridColumn: '1 / -1' } : undefined}>
      <span className="ui-field-label">{label}</span>
      {children}
    </label>
  )
}
