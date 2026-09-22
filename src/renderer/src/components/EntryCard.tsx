import type { EntryRuntime, LaunchEntry } from '@shared/types'
import { useRef, useState } from 'react'
import {
  FRAMEWORK_LABEL,
  STATUS_META,
  TONE_VAR,
  cardTone,
  isBusyStatus,
  isLiveStatus
} from '../lib/entryMeta'
import { formatUptime } from '../lib/format'
import type { CardSortHandlers } from '../lib/useCardSort'
import { useEntryImage } from '../store/favicons'
import { EntryGlyph } from './EntryGlyph'
import {
  IconCaretDown,
  IconEdit,
  IconExternalLink,
  IconFolder,
  IconPackage,
  IconPlay,
  IconPushPin,
  IconRestart,
  IconStethoscope,
  IconStop,
  IconTerminal,
  IconTrash
} from './icons'
import { StatusPill } from './StatusPill'

export interface EntryCardActions {
  onStart: () => void
  onStop: () => void
  onRestart: () => void
  onLogs: () => void
  /** 嵌入式终端面板：展开底部 panel 并 pin 该条目，不跳视图。省略时日志按钮回退到 onLogs */
  onPin?: () => void
  onDiagnose: () => void
  onEdit: () => void
  onOpenFolder: () => void
  onOpenOutput: () => void
  onTogglePin: () => void
  onRemove: () => void
  /** 任务卡片：运行指定脚本（脚本必须在 package.json scripts 里） */
  onRunScript?: (script: string) => void
}

export function EntryCard({
  entry,
  runtime,
  busy,
  actions,
  sort,
  dragging,
  position,
  portShared
}: {
  entry: LaunchEntry
  runtime: EntryRuntime
  busy: boolean
  actions: EntryCardActions
  /** 排序交互，PRD §9.4。省略则卡片不可拖拽 */
  sort?: CardSortHandlers
  dragging?: boolean
  /** 「第 n / 共 m」，供屏幕阅读器知道当前位置 */
  position?: { index: number; total: number }
  /** 同一端口还有别的条目在监听，PRD §4.3 */
  portShared?: boolean
}): React.JSX.Element {
  const status = STATUS_META[runtime.status]
  const live = isLiveStatus(runtime.status)
  const isBusy = isBusyStatus(runtime.status)
  const isService = entry.kind === 'service'
  const port = runtime.port ?? entry.expectedPort
  const imageUrl = useEntryImage(entry)

  return (
    <article
      data-entry-id={entry.id}
      draggable={sort?.draggable}
      onDragStart={sort?.onDragStart}
      onDragEnter={sort?.onDragEnter}
      onDragOver={sort?.onDragOver}
      onDrop={sort?.onDrop}
      onDragEnd={sort?.onDragEnd}
      onKeyDown={sort?.onKeyDown}
      tabIndex={sort ? 0 : undefined}
      aria-roledescription={sort ? '可排序卡片' : undefined}
      aria-label={
        sort && position
          ? `${entry.name}，第 ${position.index} 项，共 ${position.total} 项。按住 Ctrl 加方向键可改变顺序`
          : undefined
      }
      data-tone={cardTone(status.tone, isBusy)}
      data-dragging={dragging || undefined}
      data-interactive={sort ? 'true' : undefined}
      style={{ '--glow': TONE_VAR[status.tone], '--i': position?.index ?? 0 } as React.CSSProperties}
      className="item-enter surface-card relative flex min-w-0 flex-col gap-0 px-4 pt-3.5 pb-3"
    >
      {/* ── 第一行：图标 + 名称 + 状态胶囊 + 端口 ── */}
      <header className="flex min-w-0 items-center gap-2.5">
        <span
          className="icon-tile h-9 w-9 shrink-0"
          data-card-icon={isService ? (entry.icon ?? 'auto') : undefined}
          aria-hidden
        >
          <EntryGlyph entry={entry} imageUrl={imageUrl} size={18} glyphClass="text-[11px]" />
        </span>

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              className="truncate text-[13.5px] font-semibold text-ink-strong"
              title={entry.name}
            >
              {entry.name}
            </span>
            <span className="shrink-0 rounded-[4px] bg-raised px-1.5 font-mono text-[9.5px] font-semibold tracking-[0.06em] text-ink-muted">
              {isService ? '服务' : '任务'}
            </span>
            {entry.framework === 'uniapp' && (
              <span
                className="shrink-0 rounded-[4px] border border-accent/60 px-1.5 font-mono text-[9.5px] font-semibold tracking-[0.06em] text-accent"
                title="uniapp 项目：编译与运行由 HBuilderX 负责，本应用不接管其日志、端口与停止"
              >
                HBuilderX
              </span>
            )}
          </div>

          {/* 状态胶囊 + 端口按钮 */}
          <div className="flex items-center gap-1.5">
            <StatusPill tone={status.tone} label={status.label} halo={live} />
            {port !== undefined && port !== null && (
              <button
                type="button"
                title={
                  portShared
                    ? `:${port} 有多个条目在监听，localhost:${port} 只会打开其中一个。改掉一边的端口才能同时访问`
                    : `在浏览器打开 http://localhost:${port}`
                }
                onClick={() => window.mile.shell.openLocalhost(port)}
                data-shared={portShared || undefined}
                className="pressable shrink-0 rounded-[4px] border border-line-strong px-1.5 font-mono text-[10px] font-bold text-accent hover:bg-accent/15 hover:text-accent data-[shared]:border-warn/60 data-[shared]:text-warn data-[shared]:hover:bg-warn/15 data-[shared]:hover:text-warn"
              >
                :{port}
              </button>
            )}
            {portShared && (
              <span
                className="shrink-0 rounded-[4px] bg-warn-soft px-1.5 font-mono text-[9.5px] font-semibold text-warn"
                title={`另有条目也在监听 :${port}`}
              >
                端口重合
              </span>
            )}
          </div>
        </div>

        {/* 右上角运行时长 / 退出码角标 */}
        {live && (
          <span className="shrink-0 font-mono text-[10px] text-ink-faint/70">
            {formatUptime(runtime.startedAt)}
          </span>
        )}
        {!live && runtime.exitCode !== undefined && (
          <span
            className={`shrink-0 font-mono text-[10px] ${
              runtime.exitCode === 0 ? 'text-live/70' : 'text-fault/70'
            }`}
          >
            退出 {runtime.exitCode}
          </span>
        )}
      </header>

      {/* ── 第二行：框架 badge 组 ── */}
      <div className="mt-2 flex flex-wrap items-center gap-1 pl-[calc(36px+10px)]">
        <span className="badge-neutral">{FRAMEWORK_LABEL[entry.framework]}</span>
        {entry.packageManager && (
          <span className="badge-neutral">{entry.packageManager}</span>
        )}
        {entry.script && (
          <span className="badge-neutral">run {entry.script}</span>
        )}
      </div>

      {/* ── 第三行：路径 ── */}
      <div className="mt-1.5 flex items-center gap-1 pl-[calc(36px+10px)]">
        <IconFolder size={10} className="shrink-0 text-ink-faint/50" />
        <span
          className="truncate font-mono text-[10px] text-ink-faint/70"
          title={entry.path}
        >
          {entry.path}
        </span>
      </div>

      {/* ── 操作区：主操作 / 次操作（信息类）/ 危险操作 ── */}
      <div className="mt-3 flex items-center gap-1 border-t border-line/40 pt-2.5">
        {/* 主操作组 */}
        <div className="flex items-center gap-1">
          {live ? (
            <CardAction
              icon={IconStop}
              label={isService ? '停止' : '中止'}
              onClick={actions.onStop}
              disabled={busy}
              primary
            />
          ) : isService ? (
            <CardAction
              icon={IconPlay}
              label="启动"
              onClick={actions.onStart}
              disabled={busy || entry.registerOnly}
              hint={
                entry.framework === 'uniapp'
                  ? 'uniapp 由 HBuilderX 启动'
                  : entry.registerOnly
                    ? '仅登记条目不可启动'
                    : undefined
              }
              primary
            />
          ) : (
            <TaskRunButton
              entry={entry}
              busy={busy}
              onStart={actions.onStart}
              onRunScript={actions.onRunScript}
            />
          )}

          {entry.framework === 'uniapp' && (
            <CardAction
              icon={IconExternalLink}
              label="用 HBuilderX 打开"
              onClick={() => {
                void window.mile.entry.openInHBuilderX(entry.id)
              }}
              primary
            />
          )}

          {isService && (
            <CardAction
              icon={IconRestart}
              label="重启"
              onClick={actions.onRestart}
              disabled={busy || entry.registerOnly}
            />
          )}

          <CardAction
            icon={IconTerminal}
            label="日志"
            onClick={actions.onPin ?? actions.onLogs}
            disabled={!runtime.sessionId}
          />
        </div>

        {/* 竖分隔线 */}
        <div className="mx-0.5 h-4 w-px shrink-0 bg-line-strong/50" />

        {/* 次操作组（信息类） */}
        <div className="flex items-center gap-1">
          <CardAction icon={IconStethoscope} label="诊断" onClick={actions.onDiagnose} />
          <CardAction icon={IconEdit} label="编辑" onClick={actions.onEdit} />
          <CardAction icon={IconFolder} label="打开目录" onClick={actions.onOpenFolder} />

          {!isService && (
            runtime.status === 'succeeded' ? (
              <CardAction
                icon={IconPackage}
                label="查看产物"
                onClick={actions.onOpenOutput}
                primary
              />
            ) : (
              <CardAction
                icon={IconPackage}
                label="打开产物目录"
                onClick={actions.onOpenOutput}
                disabled={!entry.outputDir}
                hint={!entry.outputDir ? '任务成功后可用' : undefined}
              />
            )
          )}
        </div>

        {/* 竖分隔线 */}
        <div className="mx-0.5 h-4 w-px shrink-0 bg-line-strong/50" />

        {/* 状态操作组（置顶 + 危险操作推到末尾） */}
        <div className="flex items-center gap-1 ml-auto">
          <CardAction
            icon={IconPushPin}
            label={entry.pinned ? '取消置顶' : '置顶'}
            onClick={actions.onTogglePin}
            active={entry.pinned}
          />
          <CardAction
            icon={IconTrash}
            label="移除条目"
            onClick={actions.onRemove}
            disabled={live}
            hint={live ? '运行中不可移除，请先停止' : undefined}
            danger
          />
        </div>
      </div>

      {/* busy 时底部进度条 */}
      {isBusy && <div className="card-progress-bar" />}
    </article>
  )
}

/**
 * 任务卡片的「运行」区域。
 * 只有一个脚本 → 单「运行」按钮；有多个脚本 → 分裂按钮。
 */
function TaskRunButton({
  entry,
  busy,
  onStart,
  onRunScript
}: {
  entry: LaunchEntry
  busy: boolean
  onStart: () => void
  onRunScript?: (script: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  const scriptNames = Object.keys(entry.scripts)
  const hasManyScripts = !entry.registerOnly && scriptNames.length > 1 && !!onRunScript

  const handleBlur = (): void => {
    requestAnimationFrame(() => {
      if (wrapRef.current && !wrapRef.current.contains(document.activeElement)) {
        setOpen(false)
      }
    })
  }

  if (!hasManyScripts) {
    return (
      <CardAction
        icon={IconPlay}
        label="运行"
        onClick={onStart}
        disabled={busy || entry.registerOnly}
        hint={entry.registerOnly ? '仅登记条目不可启动' : undefined}
        primary
      />
    )
  }

  return (
    <div ref={wrapRef} className="relative flex" onBlur={handleBlur}>
      {/* 左半：主运行操作。用 btn-primary 类而非硬编码 bg-ink-strong，
          深色模式下自动切换为蓝灰底+柔蓝白字，避免同色灰底灰字。
          border-r 用 btn-primary-border 颜色的半透明变体作分隔。 */}
      <button
        type="button"
        disabled={busy}
        onClick={onStart}
        title={`运行 ${entry.script ?? ''}`}
        className="btn-primary pressable flex items-center gap-1.5 rounded-l-[6px] rounded-r-none border-r-0 px-2.5 py-1.5 text-[12px] font-semibold [border-right:1px_solid_color-mix(in_srgb,currentColor_20%,transparent)] disabled:pointer-events-none"
      >
        <IconPlay size={12} strokeWidth={2} />
        运行
      </button>
      {/* 右半：下拉选脚本。同一套 btn-primary 颜色，圆角只在右侧 */}
      <button
        type="button"
        disabled={busy}
        aria-label="选择要运行的脚本"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
        className="btn-primary pressable flex items-center rounded-l-none rounded-r-[6px] border-l-0 px-1.5 py-1.5 disabled:pointer-events-none"
      >
        <IconCaretDown
          size={11}
          strokeWidth={2}
          className={`transition-transform duration-250 [transition-timing-function:cubic-bezier(0.34,1.56,0.64,1)] ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="选择脚本"
          onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
          className="absolute top-full left-0 z-20 mt-1 min-w-[11rem] max-w-[22rem] overflow-hidden rounded-[8px] border border-line bg-card shadow-[0_4px_16px_rgba(0,0,0,0.18)]"
        >
          {scriptNames.map((name) => {
            const cmd = entry.scripts[name] ?? ''
            const isDefault = name === entry.script
            return (
              <button
                key={name}
                role="menuitem"
                type="button"
                onClick={() => {
                  setOpen(false)
                  onRunScript(name)
                }}
                className="pressable-flat flex w-full min-w-0 flex-col gap-0.5 px-3 py-2 text-left hover:bg-raised focus-visible:bg-raised focus-visible:outline-none"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate font-mono text-[12px] font-semibold text-ink-strong">
                    {name}
                  </span>
                  {isDefault && (
                    <span className="shrink-0 rounded-[3px] bg-accent/15 px-1 font-mono text-[10px] font-semibold text-accent">
                      默认
                    </span>
                  )}
                </span>
                {cmd && (
                  <span className="truncate font-mono text-[10px] text-ink-faint" title={cmd}>
                    {cmd}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function CardAction({
  icon: IconCmp,
  label,
  onClick,
  disabled,
  hint,
  primary,
  active,
  danger
}: {
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>
  label: string
  onClick: () => void
  disabled?: boolean
  hint?: string
  primary?: boolean
  active?: boolean
  danger?: boolean
}): React.JSX.Element {
  const cls = primary
    ? 'btn-primary gap-1.5 px-2.5 py-1.5 text-[12px] font-semibold'
    : active
      ? 'h-7 w-7 border border-accent/50 bg-accent/10 text-accent'
      : danger
        ? 'h-7 w-7 border border-line bg-card text-ink-faint hover:border-fault/40 hover:bg-fault/8 hover:text-fault disabled:cursor-not-allowed disabled:opacity-35'
        : 'h-7 w-7 border border-line bg-card text-ink-muted hover:border-line-strong hover:text-ink-strong disabled:cursor-not-allowed disabled:opacity-35'

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={hint ?? label}
      className={`pressable flex shrink-0 items-center justify-center rounded-[6px] transition-colors duration-150 ${cls}`}
    >
      <IconCmp size={13} strokeWidth={1.7} />
      {primary && <span>{label}</span>}
    </button>
  )
}

