import {
  ArrowClockwise,
  ArrowSquareOut,
  CaretDown,
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
import { useRef, useState } from 'react'
import { FRAMEWORK_LABEL, STATUS_META, TONE_VAR, cardTone, isLiveStatus } from '../lib/entryMeta'
import { ellipsisPath, formatUptime } from '../lib/format'
import type { CardSortHandlers } from '../lib/useCardSort'
import { useEntryImage } from '../store/favicons'
import { EntryGlyph } from './EntryGlyph'
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
  const isService = entry.kind === 'service'
  const port = runtime.port ?? entry.expectedPort
  // 卡片图标：自定义图片 > favicon（web 框架），两视图共用 useEntryImage，无则回退字标
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
          <EntryGlyph entry={entry} imageUrl={imageUrl} size={24} glyphClass="text-[18px]" />
        </span>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[14px] font-semibold text-ink-strong" title={entry.name}>
              {entry.name}
            </span>
            <span className="shrink-0 rounded-[4px] bg-raised px-1.5 font-mono text-[10px] font-semibold tracking-[0.08em] text-ink-muted">
              {isService ? '服务' : '任务'}
            </span>
            {/* uniapp 由 HBuilderX 编译/运行，本应用只能唤起它 —— 徽标让人一眼区分它与直管服务 */}
            {entry.framework === 'uniapp' && (
              <span
                className="shrink-0 rounded-[4px] border border-accent/60 px-1.5 font-mono text-[10px] font-semibold tracking-[0.08em] text-accent"
                title="uniapp 项目：编译与运行由 HBuilderX 负责，本应用不接管其日志、端口与停止"
              >
                HBuilderX
              </span>
            )}
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
        ) : isService ? (
          <Action
            icon={Play}
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
          /* 任务：「运行」主按钮 + 可选下拉（有多个脚本时显示） */
          <TaskRunButton
            entry={entry}
            busy={busy}
            onStart={actions.onStart}
            onRunScript={actions.onRunScript}
          />
        )}

        {/* uniapp 专属：唤起本机 HBuilderX 打开该项目（命令构造全在主进程） */}
        {entry.framework === 'uniapp' && (
          <Action
            icon={ArrowSquareOut}
            label="用 HBuilderX 打开"
            onClick={() => {
              void window.mile.entry.openInHBuilderX(entry.id)
            }}
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
          onClick={actions.onPin ?? actions.onLogs}
          disabled={!runtime.sessionId}
          iconOnly
        />
        <Action icon={Stethoscope} label="诊断" onClick={actions.onDiagnose} iconOnly />
        {/* 编辑运行中也能点：面板自己会锁住影响运行身份的字段，并给出停止入口，PRD §4.6 */}
        <Action icon={PencilSimple} label="编辑" onClick={actions.onEdit} iconOnly />
        <Action icon={FolderOpen} label="打开目录" onClick={actions.onOpenFolder} iconOnly />

        {/* 产物目录只对任务有意义，且要跑完才有东西可看，PRD §4.2
            成功态：提升为 primary 带标签，视觉上从操作栏里跳出来，引导用户点。
            其他态：保持 icon-only 灰色，条目指定了 outputDir 时也允许点（任务未跑也能直接去看上次产物）。 */}
        {!isService && (
          runtime.status === 'succeeded' ? (
            <Action
              icon={Package}
              label="查看产物"
              onClick={actions.onOpenOutput}
              primary
            />
          ) : (
            <Action
              icon={Package}
              label="打开产物目录"
              onClick={actions.onOpenOutput}
              disabled={!entry.outputDir}
              hint={!entry.outputDir ? '任务成功后可用' : undefined}
              iconOnly
            />
          )
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

/**
 * 任务卡片的「运行」区域。
 *
 * - 只有一个脚本（或仅登记）→ 和服务一样，单个「运行」按钮。
 * - 有多个脚本 → 分裂按钮：左侧「运行」执行默认脚本（entry.script）；
 *   右侧小箭头展开下拉，列出所有已声明脚本供选择执行。
 *
 * 下拉用 onBlur 关闭：焦点移到菜单外时收起，键盘 Escape 也收起。
 * 命令构造与安全校验全在主进程（runScript = assertScriptDeclared + SAFE_SCRIPT），
 * 渲染层只传脚本名字符串，不构造任何命令。
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
  // 只有 1 条（或仅登记）时退化为普通单按钮，不显示下拉
  const hasManyScripts = !entry.registerOnly && scriptNames.length > 1 && !!onRunScript

  const handleBlur = (): void => {
    // 焦点移到包裹元素外才关闭；移到菜单项上时 relatedTarget 还在内部
    requestAnimationFrame(() => {
      if (wrapRef.current && !wrapRef.current.contains(document.activeElement)) {
        setOpen(false)
      }
    })
  }

  if (!hasManyScripts) {
    return (
      <Action
        icon={Play}
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
      {/* 主「运行」按钮：执行 entry.script（条目默认脚本） */}
      <button
        type="button"
        disabled={busy}
        onClick={onStart}
        title={`运行 ${entry.script ?? ''}`}
        className="pressable flex items-center gap-1.5 rounded-l-[6px] rounded-r-none border-r border-r-black/10 bg-accent px-2 py-1.5 text-[12px] font-semibold text-on-accent hover:brightness-110 disabled:pointer-events-none disabled:opacity-40"
      >
        <Play size={13} weight="bold" aria-hidden />
        运行
      </button>
      {/* 下拉箭头按钮 */}
      <button
        type="button"
        disabled={busy}
        aria-label="选择要运行的脚本"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
        className="pressable flex items-center rounded-l-none rounded-r-[6px] bg-accent px-1.5 py-1.5 text-on-accent hover:brightness-110 disabled:pointer-events-none disabled:opacity-40"
      >
        <CaretDown
          size={11}
          weight="bold"
          aria-hidden
          className={`transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {/* 下拉菜单 */}
      {open && (
        <div
          role="menu"
          aria-label="选择脚本"
          onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
          className="absolute top-full left-0 z-20 mt-1 min-w-[11rem] max-w-[22rem] overflow-hidden rounded-[8px] border border-line bg-surface shadow-[0_4px_16px_rgba(0,0,0,0.18)]"
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
