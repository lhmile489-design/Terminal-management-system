import { useEffect, useRef, useState } from 'react'
import { ArrowsClockwise, FolderOpen, Lock, Plus, Stop, Trash, X } from '@phosphor-icons/react'
import {
  SERVICE_ICON_IDS,
  type EntryEdit,
  type EntryKind,
  type EntryRuntime,
  type LaunchEntry,
  type LaunchMode,
  type ServiceIcon
} from '@shared/types'
import {
  FRAMEWORK_LABEL,
  FRAMEWORK_LAUNCH_MODES,
  LAUNCH_MODE_LABEL,
  SERVICE_ICON_META,
  STATUS_META,
  TONE_VAR,
  isLiveStatus
} from '../lib/entryMeta'
import { StatusPill } from './StatusPill'

/** 需要在 jarPath 字段填「路径/模块」的启动方式（其余方式命令自足，无需额外输入） */
const MODES_NEEDING_PATH = new Set<LaunchMode>([
  'jar',
  'cpp-exe',
  'python-file',
  'python-module',
  'uvicorn'
])

/** 各 mode 的输入框提示文案 */
const PATH_HINT: Partial<Record<LaunchMode, { label: string; hint: string; placeholder: string }>> = {
  jar: { label: 'jar 路径', hint: '相对项目根，须以 .jar 结尾', placeholder: 'target/app.jar' },
  'cpp-exe': { label: '可执行文件路径', hint: '相对项目根，须以 .exe 结尾', placeholder: 'build/app.exe' },
  'python-file': { label: '入口文件', hint: '相对项目根的 .py 文件', placeholder: 'main.py' },
  'python-module': { label: '模块名', hint: 'python -m 的模块，如 app.main', placeholder: 'app.main' },
  uvicorn: { label: 'ASGI app', hint: 'uvicorn 的 app 规格，如 main:app', placeholder: 'main:app' }
}

/**
 * 条目编辑，PRD §4.6。
 *
 * 名称、分类、置顶与图标运行中可直接改；类型、目录、脚本、端口、环境变量决定
 * 「这张卡片是谁」，必须先停止 —— 运行中改了它们，停止时的归属校验会拿新配置去对旧进程。
 *
 * 面板内提供停止入口，且停止不关面板、不清草稿：让人把填好的东西丢掉再去外面点停止，
 * 是把实现的限制转嫁给使用者。
 */
export function EditEntryDialog({
  entry,
  runtime,
  categories,
  onSubmit,
  onStop,
  onClose,
  error
}: {
  entry: LaunchEntry
  runtime: EntryRuntime
  categories: string[]
  onSubmit: (patch: EntryEdit) => Promise<boolean>
  onStop: () => void
  onClose: () => void
  /** 主进程校验失败的原因，显示在面板内而不是外面的横幅 */
  error: string | null
}): React.JSX.Element {
  const [kind, setKind] = useState<EntryKind>(entry.kind)
  const [name, setName] = useState(entry.name)
  const [category, setCategory] = useState(entry.category ?? '')
  const [icon, setIcon] = useState<ServiceIcon | null>(entry.icon ?? null)
  const [path, setPath] = useState(entry.path)
  const [cwd, setCwd] = useState(entry.cwd ?? '')
  const [script, setScript] = useState(entry.script ?? '')
  const [scripts, setScripts] = useState(entry.scripts)
  const [envRows, setEnvRows] = useState<EnvRow[]>(() =>
    Object.entries(entry.env).map(([key, value], id) => ({ id, key, value }))
  )
  const [port, setPort] = useState(entry.expectedPort ? String(entry.expectedPort) : '')
  const [outputDir, setOutputDir] = useState(entry.outputDir ?? '')
  const [framework, setFramework] = useState(entry.framework)
  const [packageManager, setPackageManager] = useState(entry.packageManager)
  const [launchMode, setLaunchMode] = useState<LaunchMode | ''>(entry.launchMode ?? '')
  const [jarPath, setJarPath] = useState(entry.jarPath ?? '')
  // 自定义图片预览（data URL）。图片改动即时经 setImage/clearImage 落盘，不随保存按钮走 ——
  // 它是展示字段（同 icon），运行中也能改，不影响运行身份。
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [hasImage, setHasImage] = useState(!!entry.imageId)
  const [imageBusy, setImageBusy] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [redetecting, setRedetecting] = useState(false)
  const [saving, setSaving] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)
  const nextEnvRowId = useRef(Object.keys(entry.env).length)

  const status = STATUS_META[runtime.status]
  const live = isLiveStatus(runtime.status)

  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  // 载入当前自定义图片作预览（有则显示缩略图 + 移除按钮）
  useEffect(() => {
    if (!entry.imageId) return
    let alive = true
    void window.mile.entry.image(entry.id).then((url) => {
      if (alive) setImageUrl(url)
    })
    return () => {
      alive = false
    }
  }, [entry.id, entry.imageId])

  // 上传图片：读文件字节交主进程压缩落盘，回填后刷新预览。图片改动即时生效。
  const onPickImage = async (file: File | undefined): Promise<void> => {
    if (!file) return
    setImageBusy(true)
    try {
      const bytes = await file.arrayBuffer()
      await window.mile.entry.setImage(entry.id, bytes)
      const url = await window.mile.entry.image(entry.id)
      setImageUrl(url)
      setHasImage(true)
    } catch {
      // 解码失败 / 过大：主进程已拒绝，保持原样，用户可重选
    } finally {
      setImageBusy(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const onRemoveImage = async (): Promise<void> => {
    setImageBusy(true)
    try {
      await window.mile.entry.clearImage(entry.id)
      setImageUrl(null)
      setHasImage(false)
    } finally {
      setImageBusy(false)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // 换目录要重认框架与脚本表，否则「脚本已声明」的校验参照的是上一个项目
  const pick = async (): Promise<void> => {
    const target = await window.mile.dialog.pickDirectory()
    if (!target) return
    setRedetecting(true)
    try {
      const detected = await window.mile.entry.detect(target)
      setPath(detected.path)
      setFramework(detected.framework)
      setPackageManager(detected.packageManager)
      setScripts(detected.scripts)
      setCwd('')
      // 换目录后按识别结果预填启动方式（可启动的非 npm 生态）；否则清空这两个字段
      if (FRAMEWORK_LAUNCH_MODES[detected.framework]) {
        setLaunchMode(detected.detectedLaunchMode ?? '')
        setJarPath('')
      } else {
        setLaunchMode('')
        setJarPath('')
      }
      // 新目录里同名脚本还在就留着，否则回落到它的 dev / build
      setScript((current) =>
        current && detected.scripts[current]
          ? current
          : ((kind === 'service' ? detected.devScript : detected.buildScript) ?? '')
      )
    } finally {
      setRedetecting(false)
    }
  }

  const launchModeOptions = FRAMEWORK_LAUNCH_MODES[framework]
  const isLaunchable = !!launchModeOptions
  const modeNeedsPath = launchMode !== '' && MODES_NEEDING_PATH.has(launchMode)

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const mode = isLaunchable ? launchMode || null : null
      const ok = await onSubmit({
        kind,
        name,
        category: category.trim() || null,
        icon: kind === 'service' ? icon : null,
        path,
        cwd,
        // 可启动的非 npm 生态无 npm 脚本，脚本字段恒为空
        script: isLaunchable ? null : script || null,
        scripts: isLaunchable ? {} : scripts,
        framework,
        packageManager,
        env: envFromRows(envRows),
        // 空串表示清掉端口，用 null 让主进程按「显式清空」处理而不是「没提这个字段」
        expectedPort: kind === 'task' || !port ? null : Number(port),
        outputDir,
        // 可启动生态显式写 launchMode / jarPath（null 清空）
        launchMode: isLaunchable ? mode : null,
        jarPath: isLaunchable && mode && MODES_NEEDING_PATH.has(mode) ? jarPath.trim() || null : null,
        // 选了启动方式才可启动；npm 项目按有无脚本判定
        registerOnly: isLaunchable ? !mode : !script
      })
      if (ok) onClose()
    } finally {
      setSaving(false)
    }
  }

  const scriptNames = Object.keys(scripts)
  // 需要填路径的模式必须填了才能保存
  const launchIncomplete = isLaunchable && modeNeedsPath && !jarPath.trim()
  const updateEnvRow = (id: number, field: 'key' | 'value', value: string): void => {
    setEnvRows((rows) => rows.map((row) => (row.id === id ? { ...row, [field]: value } : row)))
  }

  const addEnvRow = (): void => {
    setEnvRows((rows) => [...rows, { id: nextEnvRowId.current++, key: '', value: '' }])
  }

  const removeEnvRow = (id: number): void => {
    setEnvRows((rows) => rows.filter((row) => row.id !== id))
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/80 px-6 py-10"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-entry-title"
    >
      <div className="flex max-h-full w-full max-w-[560px] flex-col overflow-hidden rounded-[12px] border border-line bg-panel">
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <h2
            id="edit-entry-title"
            className="flex min-w-0 items-center gap-2.5 text-[15px] font-semibold text-ink-strong"
          >
            <span className="truncate">编辑 · {entry.name}</span>
            <span style={{ '--glow': TONE_VAR[status.tone] } as React.CSSProperties}>
              <StatusPill tone={status.tone} label={status.label} halo={live} />
            </span>
          </h2>
          <button
            ref={closeRef}
            type="button"
            aria-label="关闭"
            title="关闭"
            onClick={onClose}
            className="pressable flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-ink-muted hover:bg-raised hover:text-ink-strong"
          >
            <X size={14} weight="bold" />
          </button>
        </header>

        {/* 运行中的锁定说明必须给出停止入口，否则只是告诉人「不行」却不告诉怎么行 */}
        {live && (
          <div
            data-tone="warn"
            style={{ '--glow': 'var(--signal-warn)' } as React.CSSProperties}
            className="flex items-center gap-3 border-b border-line bg-warn-soft px-5 py-2.5"
          >
            <Lock size={14} weight="bold" className="shrink-0 text-warn" aria-hidden />
            <p className="min-w-0 flex-1 text-[12px] text-warn">
              运行中只能改名称、分类、置顶与图标。类型、目录、脚本、端口与环境变量需先停止。
            </p>
            <button
              type="button"
              onClick={onStop}
              className="pressable flex shrink-0 items-center gap-1.5 rounded-[6px] border border-warn/40 px-2.5 py-1 text-[12px] text-warn hover:bg-warn/15 hover:text-warn"
            >
              <Stop size={12} weight="fill" />
              停止服务
            </button>
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
          {error && (
            <p role="alert" className="rounded-[6px] bg-fault-soft px-3 py-2 text-[12px] text-fault">
              {error}
            </p>
          )}

          <Field label="名称">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-[6px] border border-line bg-card px-2.5 py-1.5 text-[13px] text-ink-strong outline-none focus:border-accent"
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

          <Field label="类型" locked={live}>
            <div role="radiogroup" className="segmented">
              {(['service', 'task'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={kind === k}
                  disabled={live}
                  onClick={() => setKind(k)}
                  className="segmented-item disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {k === 'service' ? '服务' : '任务'}
                </button>
              ))}
            </div>
          </Field>

          {/* 自定义图片：服务与任务都可用，优先级高于预设图标与 favicon。图片即时压缩落盘 */}
          <Field
            label="自定义图片"
            hint="上传后压缩存本地，卡片与列表都用它显示；优先于预设图标与 favicon"
          >
            <div className="flex items-center gap-3">
              <span
                className="icon-tile flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden"
                aria-hidden
              >
                {imageUrl ? (
                  <img
                    src={imageUrl}
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
                onChange={(e) => void onPickImage(e.target.files?.[0])}
              />
              <button
                type="button"
                disabled={imageBusy}
                onClick={() => fileInputRef.current?.click()}
                className="pressable rounded-[6px] border border-line-strong bg-card px-2.5 py-1.5 text-[12px] text-ink-muted hover:text-ink-strong disabled:opacity-45"
              >
                {imageBusy ? '处理中…' : hasImage ? '更换图片' : '上传图片'}
              </button>
              {hasImage && (
                <button
                  type="button"
                  disabled={imageBusy}
                  onClick={() => void onRemoveImage()}
                  className="pressable rounded-[6px] border border-line-strong bg-card px-2.5 py-1.5 text-[12px] text-ink-muted hover:text-ink-strong disabled:opacity-45"
                >
                  移除
                </button>
              )}
            </div>
          </Field>

          {kind === 'service' && (
            <Field
              label="服务卡片图标"
              hint={hasImage ? '已上传自定义图片，将优先显示' : '选择自动时沿用已识别的框架字标'}
            >
              <div
                data-icon-picker
                role="group"
                aria-label="服务卡片图标"
                className="grid grid-cols-3 gap-1.5 sm:grid-cols-9"
              >
                <button
                  type="button"
                  data-icon-option="auto"
                  aria-label="自动（框架图标）"
                  title="自动（框架图标）"
                  aria-pressed={icon === null}
                  onClick={() => setIcon(null)}
                  className={`pressable flex h-9 w-full items-center justify-center rounded-[6px] border text-ink-muted hover:text-ink-strong ${
                    icon === null
                      ? 'border-accent bg-accent-soft text-accent'
                      : 'border-line-strong bg-card'
                  }`}
                >
                  <ArrowsClockwise size={15} weight="bold" aria-hidden />
                </button>
                {SERVICE_ICON_IDS.map((option) => {
                  const { icon: IconCmp, label } = SERVICE_ICON_META[option]
                  const selected = icon === option
                  return (
                    <button
                      key={option}
                      type="button"
                      data-icon-option={option}
                      aria-label={label}
                      title={label}
                      aria-pressed={selected}
                      onClick={() => setIcon(option)}
                      className={`pressable flex h-9 w-full items-center justify-center rounded-[6px] border text-ink-muted hover:text-ink-strong ${
                        selected
                          ? 'border-accent bg-accent-soft text-accent'
                          : 'border-line-strong bg-card'
                      }`}
                    >
                      <IconCmp size={16} weight="bold" aria-hidden />
                    </button>
                  )
                })}
              </div>
            </Field>
          )}

          <Field label="项目目录" locked={live}>
            <div className="flex items-center gap-2">
              <span
                className="min-w-0 flex-1 truncate rounded-[6px] border border-line bg-card px-2.5 py-1.5 font-mono text-[12px] text-ink-muted"
                title={path}
              >
                {path}
              </span>
              <button
                type="button"
                disabled={live || redetecting}
                onClick={() => void pick()}
                className="pressable flex shrink-0 items-center gap-1.5 rounded-[6px] border border-line-strong bg-card px-2.5 py-1.5 text-[12px] text-ink-muted hover:text-ink-strong disabled:cursor-not-allowed disabled:opacity-45"
              >
                <FolderOpen size={13} weight="bold" />
                {redetecting ? '识别中' : '更换'}
              </button>
            </div>
          </Field>

          <Field label="子目录" hint="monorepo 子包，相对项目根，留空表示用根目录" locked={live}>
            <input
              value={cwd}
              disabled={live}
              placeholder="packages/web"
              onChange={(e) => setCwd(e.target.value)}
              className="w-full rounded-[6px] border border-line bg-card px-2.5 py-1.5 font-mono text-[12px] text-ink-strong outline-none focus:border-accent disabled:opacity-45"
            />
          </Field>

          <Field label="识别结果">
            <p className="font-mono text-[12px] text-ink-muted">
              {FRAMEWORK_LABEL[framework]} · {packageManager}
            </p>
          </Field>

          {isLaunchable ? (
            <>
              <Field label="启动方式" hint="留空表示仅登记，可监控不可启动" locked={live}>
                <select
                  value={launchMode}
                  disabled={live}
                  onChange={(e) => setLaunchMode(e.target.value as LaunchMode | '')}
                  className="w-full rounded-[6px] border border-line bg-card px-2.5 py-1.5 font-mono text-[12px] text-ink-strong outline-none focus:border-accent disabled:opacity-45"
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
                <Field
                  label={PATH_HINT[launchMode]?.label ?? '路径'}
                  hint={PATH_HINT[launchMode]?.hint ?? ''}
                  locked={live}
                >
                  <input
                    value={jarPath}
                    disabled={live}
                    placeholder={PATH_HINT[launchMode]?.placeholder ?? ''}
                    onChange={(e) => setJarPath(e.target.value)}
                    className="w-full rounded-[6px] border border-line bg-card px-2.5 py-1.5 font-mono text-[12px] text-ink-strong outline-none focus:border-accent disabled:opacity-45"
                  />
                </Field>
              )}
            </>
          ) : (
            <Field
              label={kind === 'service' ? '启动脚本' : '执行脚本'}
              hint="留空表示仅登记，可监控不可启动"
              locked={live}
            >
              {scriptNames.length === 0 ? (
                <p className="text-[12px] text-ink-faint">该项目没有可用脚本，只能仅登记</p>
              ) : (
                <select
                  value={script}
                  disabled={live}
                  onChange={(e) => setScript(e.target.value)}
                  className="w-full rounded-[6px] border border-line bg-card px-2.5 py-1.5 font-mono text-[12px] text-ink-strong outline-none focus:border-accent disabled:opacity-45"
                >
                  <option value="">不设置（仅登记）</option>
                  {scriptNames.map((s) => (
                    <option key={s} value={s}>
                      {s} — {scripts[s]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}

          <Field
            label="环境变量"
            hint="值以密码形式遮盖；诊断中只显示变量名"
            locked={live}
          >
            <div data-env-editor className="flex flex-col gap-2">
              {envRows.map((row, index) => (
                <div key={row.id} data-env-row className="flex items-center gap-2">
                  <input
                    data-env-key
                    value={row.key}
                    disabled={live}
                    aria-label={`环境变量名称 ${index + 1}`}
                    placeholder="NAME"
                    onChange={(e) => updateEnvRow(row.id, 'key', e.target.value)}
                    className="min-w-0 flex-1 rounded-[6px] border border-line bg-card px-2.5 py-1.5 font-mono text-[12px] text-ink-strong outline-none focus:border-accent disabled:opacity-45"
                  />
                  <input
                    data-env-value
                    type="password"
                    value={row.value}
                    disabled={live}
                    autoComplete="new-password"
                    aria-label={`环境变量值 ${index + 1}`}
                    placeholder="value"
                    onChange={(e) => updateEnvRow(row.id, 'value', e.target.value)}
                    className="min-w-0 flex-1 rounded-[6px] border border-line bg-card px-2.5 py-1.5 font-mono text-[12px] text-ink-strong outline-none focus:border-accent disabled:opacity-45"
                  />
                  <button
                    type="button"
                    aria-label="删除环境变量"
                    title="删除环境变量"
                    disabled={live}
                    onClick={() => removeEnvRow(row.id)}
                    className="pressable flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] border border-line text-ink-faint hover:border-fault/50 hover:text-fault disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    <Trash size={14} weight="bold" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                aria-label="添加环境变量"
                title="添加环境变量"
                disabled={live}
                onClick={addEnvRow}
                className="pressable flex h-8 w-8 items-center justify-center rounded-[6px] border border-line-strong bg-card text-ink-muted hover:text-ink-strong disabled:cursor-not-allowed disabled:opacity-45"
              >
                <Plus size={14} weight="bold" />
              </button>
            </div>
          </Field>

          {/* 任务不监听端口，PRD §4.6 强制为空 —— 直接不给这个字段，比给了再报错清楚 */}
          {kind === 'service' ? (
            <Field label="预期端口" hint="供预检与冲突判定参照，实际端口由项目决定" locked={live}>
              <input
                type="number"
                min={1}
                max={65535}
                value={port}
                disabled={live}
                onChange={(e) => setPort(e.target.value)}
                className="w-full rounded-[6px] border border-line bg-card px-2.5 py-1.5 font-mono text-[12.5px] text-ink-strong outline-none focus:border-accent disabled:opacity-45"
              />
            </Field>
          ) : (
            <Field label="产物目录" hint="留空则按 dist / build / out 等约定探测">
              <input
                value={outputDir}
                placeholder="dist"
                onChange={(e) => setOutputDir(e.target.value)}
                className="w-full rounded-[6px] border border-line bg-card px-2.5 py-1.5 font-mono text-[12px] text-ink-strong outline-none focus:border-accent"
              />
            </Field>
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
            onClick={() => void save()}
            disabled={saving || !name.trim() || launchIncomplete}
            className="btn-primary px-3 py-1.5 text-[12px]"
          >
            {saving ? '保存中' : '保存'}
          </button>
        </footer>
      </div>
    </div>
  )
}

interface EnvRow {
  id: number
  key: string
  value: string
}

function envFromRows(rows: EnvRow[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (key) env[key] = row.value
  }
  return env
}

function Field({
  label,
  hint,
  locked,
  children
}: {
  label: string
  hint?: string
  /** 运行中锁定的字段加个锁标，让人知道禁用是有原因的而不是坏了 */
  locked?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-center gap-1.5 font-mono text-[10px] font-semibold tracking-[0.12em] text-ink-faint uppercase">
        {label}
        {locked && <Lock size={10} weight="bold" aria-label="运行中不可改" />}
      </span>
      {children}
      {hint && <span className="text-[11px] text-ink-faint">{hint}</span>}
    </label>
  )
}
