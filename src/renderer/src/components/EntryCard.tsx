import {
  ArrowClockwise,
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
import type { EntryKind, EntryRuntime, Framework, LaunchEntry } from '@shared/types'
import { FRAMEWORK_LABEL, SERVICE_ICON_META, STATUS_META, TONE_VAR, cardTone, isLiveStatus } from '../lib/entryMeta'
import { ellipsisPath, formatUptime } from '../lib/format'
import type { CardSortHandlers } from '../lib/useCardSort'
import { StatusPill } from './StatusPill'

export interface EntryCardActions {
  onStart: () => void
  onStop: () => void
  onRestart: () => void
  onLogs: () => void
  onDiagnose: () => void
  onEdit: () => void
  onOpenFolder: () => void
  onOpenOutput: () => void
  onTogglePin: () => void
  onRemove: () => void
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
  const isService = entry.kind === 'service'
  const port = runtime.port ?? entry.expectedPort

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
      // 卡片本身要能聚焦，否则键盘排序无从触发，PRD §9.4
      tabIndex={sort ? 0 : undefined}
      aria-roledescription={sort ? '可排序卡片' : undefined}
      aria-label={
        sort && position
          ? `${entry.name}，第 ${position.index} 项，共 ${position.total} 项。按住 Ctrl 加方向键可改变顺序`
          : undefined
      }
      data-tone={cardTone(status.tone)}
      data-dragging={dragging || undefined}
      data-interactive={sort ? 'true' : undefined}
      // --glow 驱动图标瓦片底色、边框着色与状态胶囊，状态色只在这里给一次
      style={{ '--glow': TONE_VAR[status.tone] } as React.CSSProperties}
      className="surface-card flex min-w-0 flex-col gap-3 px-4 py-3.5"
    >
      <header className="flex min-w-0 items-start gap-3">
        <span
          className="icon-tile h-11 w-11"
          data-card-icon={isService ? entry.icon ?? 'auto' : undefined}
          aria-hidden
        >
          <EntryGlyph entry={entry} />
        </span>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[14px] font-semibold text-ink-strong" title={entry.name}>
              {entry.name}
            </span>
            <span className="shrink-0 rounded-[4px] bg-raised px-1.5 font-mono text-[10px] font-semibold tracking-[0.08em] text-ink-muted">
              {isService ? '服务' : '任务'}
            </span>
          </h3>
          <p className="flex min-w-0 items-center gap-2">
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
                className="pressable shrink-0 rounded-[4px] border border-line-strong px-1.5 font-mono text-[10px] font-bold text-accent hover:bg-accent hover:text-on-accent data-[shared]:border-warn/60 data-[shared]:text-warn data-[shared]:hover:bg-warn data-[shared]:hover:text-on-accent"
              >
                :{port}
              </button>
            )}
            {/*
              端口重合必须有文字，不能只靠把胶囊染黄 —— 两张卡片都写 :3000 时，
              「颜色不一样」传达不出「localhost 只通向其中一个」。
            */}
            {portShared && (
              <span
                className="shrink-0 rounded-[4px] bg-warn-soft px-1.5 font-mono text-[10px] font-semibold text-warn"
                title={`另有条目也在监听 :${port}`}
              >
                端口重合
              </span>
            )}
          </p>
        </div>
      </header>

      <p className="truncate font-mono text-[11px] text-ink-faint" title={entry.path}>
        {FRAMEWORK_LABEL[entry.framework]} · {entry.packageManager}
        {entry.script ? ` run ${entry.script}` : ''}
      </p>

      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1 text-[11px]">
        <dt className="font-mono text-ink-faint">目录</dt>
        <dd className="truncate font-mono text-ink-muted" title={entry.path}>
          {ellipsisPath(entry.path, 30)}
        </dd>

        {/* 端口已提到页头的胶囊旁，这里只在「有预期端口但没抓到」时补一句 */}
        {port === undefined || port === null ? (
          <>
            <dt className="font-mono text-ink-faint">端口</dt>
            <dd className="font-mono text-ink-muted">{runtime.portUnknown ? '端口未知' : '—'}</dd>
          </>
        ) : null}

        <dt className="font-mono text-ink-faint">{live ? '已运行' : '上次'}</dt>
        <dd className="font-mono text-ink-muted">
          {live
            ? formatUptime(runtime.startedAt)
            : runtime.exitCode === undefined
              ? '—'
              : `退出码 ${runtime.exitCode}`}
        </dd>
      </dl>

      <div className="flex flex-wrap items-center gap-1.5">
        {/* 任务说「运行/中止」，服务说「启动/停止」—— 一次性命令没有「停止运行中的服务」那层含义 */}
        {live ? (
          <Action
            icon={Stop}
            label={isService ? '停止' : '中止'}
            onClick={actions.onStop}
            disabled={busy}
            primary
          />
        ) : (
          <Action
            icon={Play}
            label={isService ? '启动' : '运行'}
            onClick={actions.onStart}
            disabled={busy || entry.registerOnly}
            hint={entry.registerOnly ? '仅登记条目不可启动' : undefined}
            primary
          />
        )}

        {isService && (
          <Action
            icon={ArrowClockwise}
            label="重启"
            onClick={actions.onRestart}
            disabled={busy || entry.registerOnly}
            iconOnly
          />
        )}

        <Action
          icon={Terminal}
          label="日志"
          onClick={actions.onLogs}
          disabled={!runtime.sessionId}
          iconOnly
        />
        <Action icon={Stethoscope} label="诊断" onClick={actions.onDiagnose} iconOnly />
        {/* 编辑运行中也能点：面板自己会锁住影响运行身份的字段，并给出停止入口，PRD §4.6 */}
        <Action icon={PencilSimple} label="编辑" onClick={actions.onEdit} iconOnly />
        <Action icon={FolderOpen} label="打开目录" onClick={actions.onOpenFolder} iconOnly />

        {/* 产物目录只对任务有意义，且要跑完才有东西可看，PRD §4.2 */}
        {!isService && (
          <Action
            icon={Package}
            label="打开产物目录"
            onClick={actions.onOpenOutput}
            disabled={runtime.status !== 'succeeded' && !entry.outputDir}
            hint={
              runtime.status !== 'succeeded' && !entry.outputDir
                ? '任务成功后可用'
                : undefined
            }
            iconOnly
          />
        )}
        <Action
          icon={PushPin}
          label={entry.pinned ? '取消置顶' : '置顶'}
          onClick={actions.onTogglePin}
          active={entry.pinned}
          iconOnly
        />
        <Action
          icon={Trash}
          label="移除条目"
          onClick={actions.onRemove}
          disabled={live}
          hint={live ? '运行中不可移除，请先停止' : undefined}
          iconOnly
          className="ml-auto"
        />
      </div>
    </article>
  )
}

function Action({
  icon: IconCmp,
  label,
  onClick,
  disabled,
  hint,
  primary,
  active,
  iconOnly,
  className = ''
}: {
  icon: React.ComponentType<{ size?: number; weight?: 'bold' }>
  label: string
  onClick: () => void
  disabled?: boolean
  hint?: string
  primary?: boolean
  active?: boolean
  iconOnly?: boolean
  className?: string
}): React.JSX.Element {
  // 主按钮的配色与禁用态都收在 .btn-primary 里，见 tokens.css 的说明
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
      className={`pressable flex items-center gap-1.5 rounded-[6px] px-2 py-1.5 text-[12px] ${base} ${className}`}
    >
      <IconCmp size={13} weight="bold" />
      {!iconOnly && label}
    </button>
  )
}

/**
 * 卡片图标瓦片里的字形。用框架名首字母而非彩色 logo ——
 * 内置各家品牌图标会带来商标与体积问题，且深浅两模式都要各配一版。
 */
const GLYPH: Record<Framework, string> = {
  next: 'N',
  nuxt: 'Nu',
  angular: 'A',
  'vue-vite': 'V',
  'vue-cli': 'V',
  'react-vite': 'R',
  'react-cra': 'R',
  svelte: 'S',
  electron: 'E',
  hexo: 'Hx',
  node: 'JS',
  hugo: 'Hg',
  jekyll: 'Jk',
  django: 'Dj',
  fastapi: 'Fa',
  flask: 'Fl',
  streamlit: 'St',
  python: 'Py',
  'docker-compose': 'Do',
  go: 'Go',
  rust: 'Rs',
  static: '</>',
  unknown: '?'
}

function FrameworkGlyph({
  framework,
  kind
}: {
  framework: Framework
  kind: EntryKind
}): React.JSX.Element {
  // 未识别的任务给个终端符号，比一个问号更像「一条命令」
  const text = framework === 'unknown' && kind === 'task' ? '>_' : GLYPH[framework]
  return (
    <span className="font-mono text-[15px] font-bold" aria-hidden>
      {text}
    </span>
  )
}

function EntryGlyph({ entry }: { entry: LaunchEntry }): React.JSX.Element {
  const meta = entry.kind === 'service' && entry.icon ? SERVICE_ICON_META[entry.icon] : undefined
  if (meta) {
    const IconCmp = meta.icon
    return <IconCmp size={20} weight="bold" aria-hidden />
  }
  return <FrameworkGlyph framework={entry.framework} kind={entry.kind} />
}
