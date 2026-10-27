import { useLayoutEffect, useRef, useState } from 'react'
import type { EntryRuntime, LaunchEntry, ProjectGroup } from '@shared/types'
import { GROUP_ENV_LABEL } from '@shared/types'
import { Button, MenuButton, StatusDot, Tile, type MenuItem } from '../ui'
import { EntryGlyph } from '../EntryGlyph'
import { useEntryImage } from '../../store/favicons'
import { ICON } from '../../lib/icons'
import { FRAMEWORK_LABEL, STATUS_META, isBusyStatus, isLiveStatus, type Tone } from '../../lib/entryMeta'
import { isGroupStartable } from '../../lib/services'
import { useEntries } from '../../store/entries'

const IDLE = (id: string): EntryRuntime => ({ entryId: id, status: 'idle', portUnknown: false })

export interface RowActions {
  select: (entry: LaunchEntry) => void
  toggle: (entry: LaunchEntry) => void
  menu: (entry: LaunchEntry) => MenuItem[]
  /** 拖到另一个工作组：groupId 为 null 表示移到「未分组」 */
  move: (entryId: string, groupId: string | null) => void
  /** 放到另一行之前（before）或之后；跨组时同时换组 */
  place: (dragId: string, targetId: string, before: boolean) => void
}

/** 拖拽载荷的 MIME。只带条目 id，归组改动仍走 entry.edit，由主进程校验 */
const DRAG_MIME = 'application/x-mile-entry'
/** dragover 读不到 dataTransfer 的数据，只能读类型；拖的是谁记在这里 */
let draggingId: string | null = null

/**
 * 工作组磁贴，UI-REFACTOR Q10 / Q12。头部：组名、环境、「N/M 运行中」、整组启停、「⋯」。
 * 描边随组状态：有成员出错用错误色，全部运行用成功色（状态色不染底，§4.6）。
 * `group` 为 null 时是「未分组」段：没有环境标记，也没有整组启停。
 */
export function GroupTile({
  group,
  members,
  all,
  runtimes,
  selectedId,
  cursorId,
  compact,
  failedId,
  actions,
  groupMenu,
  onStartGroup,
  onStopGroup
}: {
  group: ProjectGroup | null
  /** 当前筛选下可见的成员 */
  members: LaunchEntry[]
  /** 组内全部成员，计数与整组启停用它，不受筛选影响 */
  all: LaunchEntry[]
  runtimes: Record<string, EntryRuntime>
  selectedId: string | null
  cursorId: string | null
  /** 打开详情后列表变窄，整组按钮只留图标 */
  compact: boolean
  failedId: string | null
  actions: RowActions
  groupMenu?: MenuItem[]
  onStartGroup?: () => void
  onStopGroup?: () => void
}): React.JSX.Element {
  const startable = all.filter(isGroupStartable)
  const status = (e: LaunchEntry): EntryRuntime['status'] => runtimes[e.id]?.status ?? 'idle'
  const live = startable.filter((e) => status(e) === 'running').length
  const fault = all.some((e) => STATUS_META[status(e)].tone === 'fault')
  const tone: Tone | undefined = fault ? 'fault' : startable.length && live === startable.length ? 'live' : undefined
  const allOn = startable.length > 0 && live === startable.length
  const name = group?.name ?? '未分组'
  const [dropOver, setDropOver] = useState(false)
  const targetId = group?.id ?? null

  // 只接受本应用的条目拖拽；拖到它本来所在的组不算移动
  const accepts = (e: React.DragEvent): boolean => e.dataTransfer.types.includes(DRAG_MIME)
  const onDragOver = (e: React.DragEvent): void => {
    if (!accepts(e) || all.some((m) => m.id === draggingId)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (!dropOver) setDropOver(true)
  }
  const onDragLeave = (e: React.DragEvent): void => {
    // 在磁贴内部子元素之间移动也会触发 dragleave，只在真正离开磁贴时取消高亮
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOver(false)
  }
  const onDrop = (e: React.DragEvent): void => {
    setDropOver(false)
    const id = e.dataTransfer.getData(DRAG_MIME)
    if (!id) return
    e.preventDefault()
    if (all.some((m) => m.id === id)) return
    actions.move(id, targetId)
  }

  return (
    <Tile
      tone={tone}
      aria-label={name}
      data-group-id={group?.id ?? 'none'}
      data-drop-over={dropOver || undefined}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="svc-group-head" data-cursor={cursorId === `g:${group?.id ?? 'none'}` || undefined}>
        <ICON.group size={20} aria-hidden className="shrink-0 text-ink-muted" />
        <h2 className="ui-tile-title">{name}</h2>
        {group && (
          <span className="svc-env" data-env={group.env}>
            {group.env === 'prod' && <ICON.prodWarning size={12} aria-hidden />}
            {GROUP_ENV_LABEL[group.env]}
          </span>
        )}
        {startable.length > 0 && <span className="svc-count">{live}/{startable.length} 运行中</span>}
        <div className="svc-group-acts">
          {group && startable.length > 0 && (allOn ? (
            <Button size="sm" icon={ICON.stop} onClick={onStopGroup} aria-label={compact ? '全部停止' : undefined} title={compact ? '全部停止' : undefined}>
              {compact ? null : '全部停止'}
            </Button>
          ) : (
            <Button size="sm" variant={compact ? 'secondary' : 'primary'} icon={ICON.start} onClick={onStartGroup} aria-label={compact ? '全部启动' : undefined} title={compact ? '全部启动' : undefined}>
              {compact ? null : '全部启动'}
            </Button>
          ))}
          {groupMenu && <MenuButton label={`${name} 更多操作`} items={groupMenu} />}
        </div>
      </div>
      <Rows
        members={members}
        runtimes={runtimes}
        selectedId={selectedId}
        cursorId={cursorId}
        failedId={failedId}
        actions={actions}
        label={`${name} 成员`}
      />
    </Tile>
  )
}

function Rows({
  members,
  runtimes,
  selectedId,
  cursorId,
  failedId,
  actions,
  label
}: {
  members: LaunchEntry[]
  runtimes: Record<string, EntryRuntime>
  selectedId: string | null
  cursorId: string | null
  failedId: string | null
  actions: RowActions
  label: string
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const ind = useRef<HTMLSpanElement>(null)
  const [ready, setReady] = useState(false)
  const has = members.some((m) => m.id === selectedId)

  // 选中指示条滑到新的那一行（§4.4），首次只定位
  useLayoutEffect(() => {
    const row = ref.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!row || !ind.current) return
    ind.current.style.transform = `translateY(${row.offsetTop + (row.offsetHeight - 24) / 2}px)`
    if (!ready) requestAnimationFrame(() => setReady(true))
  }, [selectedId, members, ready])

  if (!members.length) return <p className="svc-empty-row">这个组还没有成员，在「⋯」菜单里添加服务</p>

  return (
    <div ref={ref} className="svc-rows" role="listbox" aria-label={label}>
      {has && <span ref={ind} className="svc-row-ind" data-ready={ready || undefined} aria-hidden />}
      {members.map((e) => (
        <EntryLine
          key={e.id}
          entry={e}
          runtime={runtimes[e.id] ?? IDLE(e.id)}
          selected={e.id === selectedId}
          cursor={e.id === cursorId}
          failed={e.id === failedId}
          actions={actions}
        />
      ))}
    </div>
  )
}

/** 成员行 44px：状态点、图标、名称、端口、启停、「⋯」 */
function EntryLine({
  entry,
  runtime,
  selected,
  cursor,
  failed,
  actions
}: {
  entry: LaunchEntry
  runtime: EntryRuntime
  selected: boolean
  cursor: boolean
  failed: boolean
  actions: RowActions
}): React.JSX.Element {
  const image = useEntryImage(entry)
  const meta = STATUS_META[runtime.status]
  const port = runtime.port ?? entry.expectedPort
  // 端口重合：两个以上运行中的条目实听同一端口，localhost 只会打开其中一个（PRD §4.3）
  const livePort = isLiveStatus(runtime.status) ? runtime.port : undefined
  const shared = useEntries((s) =>
    livePort != null &&
    Object.values(s.runtimes).filter((r) => r.port === livePort && isLiveStatus(r.status)).length > 1
  )
  const sub = entry.kind === 'task' ? entry.script ?? '任务' : FRAMEWORK_LABEL[entry.framework]
  const [dragging, setDragging] = useState(false)
  const [dropAt, setDropAt] = useState<'before' | 'after' | null>(null)
  const sharedTip = `:${port} 有多个条目在监听，localhost:${port} 只会打开其中一个。改掉一边的端口才能同时访问`

  return (
    <div
      className="svc-row"
      role="option"
      aria-selected={selected}
      data-cursor={cursor || undefined}
      data-entry-id={entry.id}
      data-dragging={dragging || undefined}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_MIME, entry.id)
        draggingId = entry.id
        e.dataTransfer.effectAllowed = 'move'
        setDragging(true)
      }}
      onDragEnd={() => { setDragging(false); draggingId = null; setDropAt(null) }}
      data-drop-at={dropAt ?? undefined}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_MIME) || draggingId === entry.id) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        const r = e.currentTarget.getBoundingClientRect()
        const at = e.clientY < r.top + r.height / 2 ? 'before' : 'after'
        if (at !== dropAt) setDropAt(at)
      }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null) }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(DRAG_MIME)
        const at = dropAt
        setDropAt(null)
        if (!id || id === entry.id || !at) return
        e.preventDefault()
        e.stopPropagation()
        actions.place(id, entry.id, at === 'before')
      }}
      onClick={() => actions.select(entry)}
    >
      <StatusDot tone={meta.tone} label={meta.label} />
      <span className="svc-row-glyph">
        <EntryGlyph entry={entry} imageUrl={image} size={18} glyphClass="text-[12px]" />
      </span>
      <span className="svc-row-name">
        <b>{entry.name}</b>
        <span><em className="svc-kind" data-kind={entry.kind}>{entry.kind === 'task' ? '任务' : '服务'}</em>{sub}</span>
      </span>
      <span className="svc-row-port" data-shared={shared || undefined} title={shared ? sharedTip : undefined}>
        {livePort ? (
          // 运行中且捕获到端口：点击在浏览器打开 localhost（主进程只接受整数端口，PRD §11）
          <button
            type="button"
            className="svc-port-btn"
            data-shared={shared || undefined}
            title={shared ? sharedTip : `在浏览器打开 http://localhost:${livePort}`}
            onClick={(e) => {
              e.stopPropagation()
              window.mile.shell.openLocalhost(livePort)
            }}
          >
            :{livePort}
            <ICON.openExternal size={12} aria-hidden />
          </button>
        ) : port ? (
          `:${port}`
        ) : (
          ''
        )}
        {shared && <em className="svc-shared">端口重合</em>}
      </span>
      <span onClick={(e) => e.stopPropagation()}>
        <RowToggle entry={entry} runtime={runtime} failed={failed} onToggle={() => actions.toggle(entry)} />
      </span>
      <span onClick={(e) => e.stopPropagation()}>
        <MenuButton label={`${entry.name} 更多操作`} items={actions.menu(entry)} />
      </span>
    </div>
  )
}

export function RowToggle({
  entry,
  runtime,
  failed,
  onToggle,
  primary
}: {
  entry: LaunchEntry
  runtime: EntryRuntime
  failed?: boolean
  onToggle: () => void
  primary?: boolean
}): React.JSX.Element {
  const live = isLiveStatus(runtime.status)
  const busy = isBusyStatus(runtime.status)
  if (entry.framework === 'uniapp') {
    return (
      <Button size="sm" icon={ICON.openExternal} onClick={() => void window.mile.entry.openInHBuilderX(entry.id)}>
        HBuilderX
      </Button>
    )
  }
  if (entry.registerOnly) {
    return <span className="ui-pill" data-tone="idle" title="推不出启动命令，只登记、可监控">仅登记</span>
  }
  const task = entry.kind === 'task'
  if (live) {
    return (
      <Button size="sm" icon={ICON.stop} disabled={busy && runtime.status === 'stopping'} onClick={onToggle}>
        {runtime.status === 'stopping' ? '停止中' : task ? '中止' : '停止'}
      </Button>
    )
  }
  return (
    <Button size="sm" variant={primary ? 'primary' : 'secondary'} icon={ICON.start} failed={failed} onClick={onToggle}>
      {failed ? '启动失败' : task ? '运行' : STATUS_META[runtime.status].tone === 'fault' ? '重试' : '启动'}
    </Button>
  )
}
