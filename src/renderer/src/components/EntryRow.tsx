import {
  ArrowClockwise,
  ArrowSquareOut,
  FolderOpen,
  Package,
  PencilSimple,
  Play,
  PushPin,
  Stethoscope,
  Stop,
  Terminal,
  Trash
} from '@phosphor-icons/react'
import type { EntryRuntime, LaunchEntry } from '@shared/types'
import { FRAMEWORK_LABEL, STATUS_META, TONE_VAR, cardTone, isLiveStatus } from '../lib/entryMeta'
import { formatUptime } from '../lib/format'
import { useEntryImage } from '../store/favicons'
import type { EntryCardActions } from './EntryCard'
import { EntryGlyph } from './EntryGlyph'
import { StatusPill } from './StatusPill'

/**
 * 条目的列表行形态，PRD §9.x（视图切换）。
 *
 * 与 EntryCard 同数据、同动作，只是横向紧凑排布：一行装下名称、状态、端口与操作。
 * 状态色仍只染边框与胶囊、绝不染整行底（与卡片同一约束）。列表不做拖拽排序 ——
 * 排序是卡片网格的交互，列表按现有顺序平铺即可。
 */
export function EntryRow({
  entry,
  runtime,
  busy,
  actions,
  portShared
}: {
  entry: LaunchEntry
  runtime: EntryRuntime
  busy: boolean
  actions: EntryCardActions
  portShared?: boolean
}): React.JSX.Element {
  const status = STATUS_META[runtime.status]
  const live = isLiveStatus(runtime.status)
  const isService = entry.kind === 'service'
  const port = runtime.port ?? entry.expectedPort
  // 列表图标：与卡片同一来源（自定义图片 > favicon），共用 useEntryImage + EntryGlyph
  const imageUrl = useEntryImage(entry)

  return (
    <div
      data-entry-id={entry.id}
      data-entry-row
      data-tone={cardTone(status.tone)}
      style={{ '--glow': TONE_VAR[status.tone] } as React.CSSProperties}
      className="surface-card flex items-center gap-3 px-3 py-2"
    >
      {/* 图标瓦片，比卡片小一号；自定义图片/favicon 有则显示图，无则回退框架字标 */}
      <span className="icon-tile h-8 w-8 shrink-0" aria-hidden>
        <EntryGlyph entry={entry} imageUrl={imageUrl} size={20} glyphClass="text-[12px]" />
      </span>

      {/* 名称 + 目录，占据主要宽度 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold text-ink-strong" title={entry.name}>
            {entry.name}
          </span>
          {/* uniapp 由 HBuilderX 编译/运行，本应用只能唤起它 */}
          {entry.framework === 'uniapp' && (
            <span
              className="shrink-0 rounded-[4px] border border-accent/60 px-1 font-mono text-[9.5px] font-semibold tracking-[0.06em] text-accent"
              title="uniapp 项目：编译与运行由 HBuilderX 负责，本应用不接管其日志、端口与停止"
            >
              HBuilderX
            </span>
          )}
        </span>
        <span className="truncate font-mono text-[10.5px] text-ink-faint" title={entry.path}>
          {FRAMEWORK_LABEL[entry.framework]}
          {entry.script ? ` · ${entry.script}` : ''}
        </span>
      </div>

      {/* 状态胶囊 */}
      <span className="shrink-0" style={{ '--glow': TONE_VAR[status.tone] } as React.CSSProperties}>
        <StatusPill tone={status.tone} label={status.label} halo={live} />
      </span>

      {/* 端口 */}
      {port !== undefined && port !== null && (
        <button
          type="button"
          title={
            portShared
              ? `:${port} 有多个条目在监听，localhost:${port} 只会打开其中一个`
              : `在浏览器打开 http://localhost:${port}`
          }
          onClick={() => window.mile.shell.openLocalhost(port)}
          data-shared={portShared || undefined}
          className="pressable shrink-0 rounded-[4px] border border-line-strong px-1.5 font-mono text-[10px] font-bold text-accent hover:bg-accent hover:text-on-accent data-[shared]:border-warn/60 data-[shared]:text-warn"
        >
          :{port}
        </button>
      )}

      {/* 运行时长 / 退出码 */}
      <span className="hidden w-20 shrink-0 text-right font-mono text-[10.5px] text-ink-faint sm:block">
        {live
          ? formatUptime(runtime.startedAt)
          : runtime.exitCode === undefined
            ? '—'
            : `退出 ${runtime.exitCode}`}
      </span>

      {/* 操作：全图标，紧凑 */}
      <div className="flex shrink-0 items-center gap-1">
        {live ? (
          <RowAction icon={Stop} label={isService ? '停止' : '中止'} onClick={actions.onStop} disabled={busy} primary />
        ) : (
          <RowAction
            icon={Play}
            label={isService ? '启动' : '运行'}
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
        )}
        {/* uniapp 专属：唤起本机 HBuilderX 打开该项目 */}
        {entry.framework === 'uniapp' && (
          <RowAction
            icon={ArrowSquareOut}
            label="用 HBuilderX 打开"
            onClick={() => {
              void window.mile.entry.openInHBuilderX(entry.id)
            }}
            primary
          />
        )}
        {isService && (
          <RowAction
            icon={ArrowClockwise}
            label="重启"
            onClick={actions.onRestart}
            disabled={busy || entry.registerOnly}
          />
        )}
        <RowAction icon={Terminal} label="日志" onClick={actions.onPin ?? actions.onLogs} disabled={!runtime.sessionId} />
        <RowAction icon={Stethoscope} label="诊断" onClick={actions.onDiagnose} />
        <RowAction icon={PencilSimple} label="编辑" onClick={actions.onEdit} />
        <RowAction icon={FolderOpen} label="打开目录" onClick={actions.onOpenFolder} />
        {!isService && (
          <RowAction
            icon={Package}
            label="打开产物目录"
            onClick={actions.onOpenOutput}
            disabled={runtime.status !== 'succeeded' && !entry.outputDir}
            hint={runtime.status !== 'succeeded' && !entry.outputDir ? '任务成功后可用' : undefined}
          />
        )}
        <RowAction icon={PushPin} label={entry.pinned ? '取消置顶' : '置顶'} onClick={actions.onTogglePin} active={entry.pinned} />
        <RowAction
          icon={Trash}
          label="移除条目"
          onClick={actions.onRemove}
          disabled={live}
          hint={live ? '运行中不可移除，请先停止' : undefined}
        />
      </div>
    </div>
  )
}

function RowAction({
  icon: IconCmp,
  label,
  onClick,
  disabled,
  hint,
  primary,
  active
}: {
  icon: React.ComponentType<{ size?: number; weight?: 'bold' }>
  label: string
  onClick: () => void
  disabled?: boolean
  hint?: string
  primary?: boolean
  active?: boolean
}): React.JSX.Element {
  const base = primary
    ? 'btn-primary'
    : active
      ? 'border border-line-strong bg-raised text-ink-strong'
      : 'border border-line-strong bg-card text-ink-muted hover:text-ink-strong disabled:cursor-not-allowed disabled:border-line disabled:text-ink-faint'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={hint ?? label}
      className={`pressable flex h-7 w-7 items-center justify-center rounded-[6px] ${base}`}
    >
      <IconCmp size={13} weight="bold" />
    </button>
  )
}
