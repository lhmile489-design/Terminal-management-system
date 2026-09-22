import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  EntryKind,
  EntryRuntime,
  LaunchEntry,
  NewLaunchEntry,
  PrecheckResult
} from '@shared/types'
import { EntryCard } from '../components/EntryCard'
import type { EntryCardActions } from '../components/EntryCard'
import { EntryRow } from '../components/EntryRow'
import { AddEntryDialog } from '../components/AddEntryDialog'
import { EditEntryDialog } from '../components/EditEntryDialog'
import { PrecheckPanel } from '../components/PrecheckPanel'
import { LaunchpadTerminalPanel } from '../components/LaunchpadTerminalPanel'
import { GroupsPanel } from '../components/GroupsPanel'
import {
  IconChevronDown,
  IconCommand,
  IconFolder,
  IconGrid,
  IconList,
  IconPlay,
  IconPlus,
  IconWarning,
  IconX
} from '../components/icons'
import { useEntries } from '../store/entries'
import { useEntryFix } from '../lib/useEntryFix'
import { useCardSort } from '../lib/useCardSort'
import {
  SERVICE_FILTERS,
  STACK_LABEL,
  TASK_FILTERS,
  isLiveStatus,
  matchesServiceFilter,
  matchesTaskFilter,
  stackOf
} from '../lib/entryMeta'
import type { ServiceFilter, TaskFilter, TechStack } from '../lib/entryMeta'

/** 展示形态，PRD §9.x。持久化到 localStorage，下次打开沿用 */
type ViewMode = 'card' | 'list'
const VIEW_MODE_KEY = 'mile.launchpad.viewMode'
/** 启动台主模式：全部 | 工作组 */
type LaunchpadMode = 'all' | 'groups'
/** 技术栈 tab 选中值：'all' 或某个大类 */
type StackFilter = 'all' | TechStack

function readViewMode(): ViewMode {
  try {
    return localStorage.getItem(VIEW_MODE_KEY) === 'list' ? 'list' : 'card'
  } catch {
    return 'card'
  }
}

interface DialogState {
  kind: EntryKind
  path?: string
  name?: string
}

interface CategoryGroup {
  key: string
  name: string
  entries: LaunchEntry[]
}

interface CategoryView extends CategoryGroup {
  services: LaunchEntry[]
  tasks: LaunchEntry[]
}

const IDLE_RUNTIME = (id: string): EntryRuntime => ({
  entryId: id,
  status: 'idle',
  portUnknown: false
})

const UNCLASSIFIED_CATEGORY = '未分类'

function categoryOf(entry: LaunchEntry): Pick<CategoryGroup, 'key' | 'name'> {
  const name = entry.category?.trim()
  return name
    ? { key: `category:${name}`, name }
    : { key: 'category:unclassified', name: UNCLASSIFIED_CATEGORY }
}

export function Launchpad({
  onOpenLogs,
  pendingAdd,
  onPendingConsumed,
  pendingKind,
  onPendingKindConsumed
}: {
  onOpenLogs: (sessionId: string) => void
  pendingAdd?: { path: string; name: string } | null
  onPendingConsumed?: () => void
  pendingKind?: EntryKind | null
  onPendingKindConsumed?: () => void
}): React.JSX.Element {
  const entries = useEntries((s) => s.entries)
  const runtimes = useEntries((s) => s.runtimes)
  const busy = useEntries((s) => s.busy)
  const error = useEntries((s) => s.error)
  const clearError = useEntries((s) => s.clearError)
  const add = useEntries((s) => s.add)
  const edit = useEntries((s) => s.edit)
  const remove = useEntries((s) => s.remove)
  const start = useEntries((s) => s.start)
  const stop = useEntries((s) => s.stop)
  const restart = useEntries((s) => s.restart)
  const reorder = useEntries((s) => s.reorder)
  const runScript = useEntries((s) => s.runScript)

  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [focus, setFocus] = useState<{ entryId: string; precheck: PrecheckResult } | null>(null)
  const [serviceFilter, setServiceFilter] = useState<ServiceFilter>('all')
  const [taskFilter, setTaskFilter] = useState<TaskFilter>('all')
  const [stackFilter, setStackFilter] = useState<StackFilter>('all')
  const [viewMode, setViewMode] = useState<ViewMode>(readViewMode)
  const [launchpadMode, setLaunchpadMode] = useState<LaunchpadMode>('all')
  /** 底部嵌入终端面板当前 pin 的条目 id，null 表示面板收起 */
  const [pinnedEntryId, setPinnedEntryId] = useState<string | null>(null)

  // 视图形态持久化：下次打开沿用上次选的卡片 / 列表
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_MODE_KEY, viewMode)
    } catch {
      // localStorage 不可用（隐私模式等）时静默降级，不影响功能
    }
  }, [viewMode])

  const afterFix = useCallback(async (entryId: string) => {
    try {
      setFocus({ entryId, precheck: await window.mile.entry.precheck(entryId) })
    } catch {
      setFocus(null)
    }
  }, [])
  const { runFix, dialogs } = useEntryFix((id) => void afterFix(id))

  const categories = useMemo<CategoryGroup[]>(() => {
    const groups = new Map<string, CategoryGroup>()
    for (const entry of entries) {
      const { key, name } = categoryOf(entry)
      const group = groups.get(key)
      if (group) {
        group.entries.push(entry)
      } else {
        groups.set(key, { key, name, entries: [entry] })
      }
    }
    return [...groups.values()]
  }, [entries])

  const categoryNames = useMemo(
    () => categories.filter((category) => category.name !== UNCLASSIFIED_CATEGORY).map((category) => category.name),
    [categories]
  )

  /**
   * 技术栈 tab：从现有条目里出现过的框架大类自动生成，PRD §9.x。
   * 新增一个 react 项目就多一个 React tab，新增 spring-boot 就多 Java tab。
   * 每类带上条目计数；按标签排序让 tab 顺序稳定，不随条目增删跳动。
   */
  const stackTabs = useMemo(() => {
    const count = new Map<TechStack, number>()
    for (const entry of entries) {
      const stack = stackOf(entry.framework)
      count.set(stack, (count.get(stack) ?? 0) + 1)
    }
    return [...count.entries()]
      .map(([stack, n]) => ({ stack, count: n, label: STACK_LABEL[stack] }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [entries])

  // 选中的技术栈 tab 若因条目删光而消失，回落到「全部」，避免筛出空列表还找不到入口
  useEffect(() => {
    if (stackFilter !== 'all' && !stackTabs.some((tab) => tab.stack === stackFilter)) {
      setStackFilter('all')
    }
  }, [stackTabs, stackFilter])

  const matchesStack = useCallback(
    (entry: LaunchEntry) => stackFilter === 'all' || stackOf(entry.framework) === stackFilter,
    [stackFilter]
  )

  const categoryViews = useMemo<CategoryView[]>(
    () => categories
      .map((category) => ({
        ...category,
        services: category.entries.filter(
          (entry) =>
            entry.kind === 'service' &&
            matchesStack(entry) &&
            matchesServiceFilter(runtimes[entry.id]?.status ?? 'idle', serviceFilter)
        ),
        tasks: category.entries.filter(
          (entry) =>
            entry.kind === 'task' &&
            matchesStack(entry) &&
            matchesTaskFilter(runtimes[entry.id]?.status ?? 'idle', taskFilter)
        )
      }))
      .filter((category) => category.services.length > 0 || category.tasks.length > 0),
    [categories, runtimes, serviceFilter, taskFilter, matchesStack]
  )

  const noVisibleServices =
    serviceFilter !== 'all' &&
    entries.some((entry) => entry.kind === 'service') &&
    !categoryViews.some((category) => category.services.length > 0)
  const noVisibleTasks =
    taskFilter !== 'all' &&
    entries.some((entry) => entry.kind === 'task') &&
    !categoryViews.some((category) => category.tasks.length > 0)

  const sharedPorts = useMemo(() => {
    const count = new Map<number, number>()
    for (const entry of entries) {
      const runtime = runtimes[entry.id]
      const port = runtime && isLiveStatus(runtime.status) ? runtime.port : undefined
      if (!port) continue
      count.set(port, (count.get(port) ?? 0) + 1)
    }
    return new Set([...count].filter(([, count]) => count > 1).map(([port]) => port))
  }, [entries, runtimes])

  // useCardSort only knows the local grid. Expand its ordered ids back into the
  // complete list so another category never jumps because this category moved.
  const reorderWithinGroup = useCallback(async (ids: string[]): Promise<void> => {
    const moved = new Set(ids)
    let next = 0
    const allIds = entries.map((entry) => (moved.has(entry.id) ? ids[next++] : entry.id))
    await reorder(allIds)
  }, [entries, reorder])

  useEffect(() => {
    if (!pendingAdd) return
    setDialog({ kind: 'service', path: pendingAdd.path, name: pendingAdd.name })
    onPendingConsumed?.()
  }, [pendingAdd, onPendingConsumed])

  useEffect(() => {
    if (!pendingKind) return
    setDialog({ kind: pendingKind })
    onPendingKindConsumed?.()
  }, [pendingKind, onPendingKindConsumed])

  const submit = async (input: NewLaunchEntry, image?: ArrayBuffer): Promise<void> => {
    const entry = await add(input)
    // 新建时选了图片：条目创建后补一次 setImage（此刻才有 id），主进程压缩落盘并回填
    if (image && entry?.id) {
      try {
        await window.mile.entry.setImage(entry.id, image)
      } catch {
        // 图片处理失败不阻断条目创建，条目已建好，用户可在编辑面板重试
      }
    }
  }

  const runStart = async (entry: LaunchEntry): Promise<void> => {
    const blocked = await start(entry.id)
    setFocus(blocked ? { entryId: entry.id, precheck: blocked } : null)
  }

  const runRestart = async (entry: LaunchEntry): Promise<void> => {
    const blocked = await restart(entry.id)
    setFocus(blocked ? { entryId: entry.id, precheck: blocked } : null)
  }

  const actionsFor = (entry: LaunchEntry): EntryCardActions => ({
    onStart: () => void runStart(entry),
    onStop: () => void stop(entry.id),
    onRestart: () => void runRestart(entry),
    onLogs: () => {
      const sessionId = runtimes[entry.id]?.sessionId
      if (sessionId) onOpenLogs(sessionId)
    },
    onPin: () => {
      // 展开底部嵌入终端面板，pin 当前条目，不跳视图
      setPinnedEntryId(entry.id)
    },
    onDiagnose: () =>
      void window.mile.entry
        .precheck(entry.id)
        .then((precheck) => setFocus({ entryId: entry.id, precheck })),
    onEdit: () => {
      clearError()
      setEditing(entry.id)
    },
    onOpenFolder: () => window.mile.shell.openPath(entry.path),
    onOpenOutput: () => {
      if (entry.kind === 'task' && runtimes[entry.id]?.status === 'succeeded') {
        // 成功态：在资源管理器里定位并高亮产物文件，路径由主进程构造
        void window.mile.entry.revealOutput(entry.id)
      } else {
        // 其他态（配置了 outputDir 时也允许直接打开目录）
        void window.mile.entry
          .outputDir(entry.id)
          .then((dir) => dir && window.mile.shell.openPath(dir))
      }
    },
    onTogglePin: () => void edit(entry.id, { pinned: !entry.pinned }),
    onRemove: () => void remove(entry.id),
    onRunScript:
      entry.kind === 'task'
        ? (script) => void runScript(entry.id, script)
        : undefined
  })

  const focusEntry = focus ? entries.find((entry) => entry.id === focus.entryId) : undefined
  const editEntry = editing ? entries.find((entry) => entry.id === editing) : undefined

  return (
    <div className="flex min-h-full flex-1 flex-col gap-5">
      {error && !editEntry && (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-[8px] border border-fault/35 bg-fault/8 px-3.5 py-2.5"
        >
          <IconWarning size={13} strokeWidth={1.6} className="mt-0.5 shrink-0 text-fault" />
          <p className="min-w-0 flex-1 text-[12px] break-words text-fault">{error}</p>
          <button
            type="button"
            aria-label="关闭提示"
            title="关闭提示"
            onClick={clearError}
            className="pressable shrink-0 text-fault/70 hover:text-fault"
          >
            <IconX size={12} strokeWidth={2} />
          </button>
        </div>
      )}

      {/* 模式切换：全部 / 工作组 */}
      {entries.length > 0 && (
        <div className="flex items-center gap-1 border-b border-line pb-2.5">
          <div role="tablist" className="segmented flex items-center">
            <button
              role="tab"
              type="button"
              aria-selected={launchpadMode === 'all'}
              onClick={() => setLaunchpadMode('all')}
              className="segmented-item px-3 py-1 text-[12px]"
            >
              全部
            </button>
            <button
              role="tab"
              type="button"
              aria-selected={launchpadMode === 'groups'}
              onClick={() => setLaunchpadMode('groups')}
              className="segmented-item px-3 py-1 text-[12px]"
            >
              工作组
            </button>
          </div>
        </div>
      )}

      {/* ── 工作组模式 ── */}
      {launchpadMode === 'groups' && (
        <GroupsPanel actionsFor={actionsFor} />
      )}

      {/* ── 全部模式 ── */}
      {launchpadMode === 'all' && (
        <>
        {entries.length === 0 ? (
          <div className="flex flex-col items-center gap-6 py-16">
          {/* 主图标 */}
          <div className="flex h-14 w-14 items-center justify-center rounded-[14px] border-2 border-dashed border-line-strong/60">
            <IconPlay size={26} strokeWidth={1.4} className="translate-x-0.5 text-ink-faint/40" />
          </div>

          <div className="text-center">
            <p className="text-[14px] font-semibold text-ink-strong">启动台还没有项目</p>
            <p className="mt-1 text-[12px] text-ink-faint">添加一个项目目录，识别框架后即可一键启动</p>
          </div>

          <div className="grid w-full max-w-[420px] grid-cols-3 gap-3">
            <EmptyGuideCard
              icon={IconPlus}
              label="添加服务"
              desc="长期运行的开发服务、后端进程"
              onClick={() => setDialog({ kind: 'service' })}
            />
            <EmptyGuideCard
              icon={IconCommand}
              label="添加任务"
              desc="构建、部署等一次性批处理命令"
              onClick={() => setDialog({ kind: 'task' })}
            />
            <EmptyGuideCard
              icon={IconFolder}
              label="打开目录"
              desc="从文件夹自动识别项目框架"
              onClick={() => setDialog({ kind: 'service' })}
            />
          </div>
        </div>
      ) : (
        <>
          {/* 工具栏：技术栈 tab + 筛选 + 视图切换，一行搞定 */}
          <div className="flex flex-wrap items-center gap-2 border-b border-line pb-2.5">
            {/* 技术栈 tab：仅在有多个栈时显示 */}
            {stackTabs.length > 1 && (
              <nav aria-label="技术栈筛选">
                <div role="tablist" className="flex items-center gap-0.5">
                  <StackTab
                    label="全部"
                    count={entries.length}
                    active={stackFilter === 'all'}
                    onClick={() => setStackFilter('all')}
                  />
                  {stackTabs.map((tab) => (
                    <StackTab
                      key={tab.stack}
                      label={tab.label}
                      count={tab.count}
                      active={stackFilter === tab.stack}
                      onClick={() => setStackFilter(tab.stack)}
                    />
                  ))}
                </div>
              </nav>
            )}

            {stackTabs.length > 1 && (
              <div className="h-3.5 w-px shrink-0 bg-line-strong/60" />
            )}

            {/* 筛选 + 视图切换推到右侧 */}
            <div className="flex flex-wrap items-center gap-2 ml-auto">
              <FilterControl
                label="服务筛选"
                filter={serviceFilter}
                filters={SERVICE_FILTERS}
                onChange={setServiceFilter}
              />
              <FilterControl
                label="任务筛选"
                filter={taskFilter}
                filters={TASK_FILTERS}
                onChange={setTaskFilter}
              />
              <div className="h-3.5 w-px shrink-0 bg-line-strong/60" />
              <ViewToggle mode={viewMode} onChange={setViewMode} />
            </div>
          </div>

          {categoryViews.length > 0 && (noVisibleServices || noVisibleTasks) && (
            <div role="status" className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-ink-faint">
              {noVisibleServices && <p data-empty-service-filter>服务筛选条件下没有符合项</p>}
              {noVisibleTasks && <p data-empty-task-filter>任务筛选条件下没有符合项</p>}
            </div>
          )}

          {categoryViews.length === 0 ? (
            <p className="text-[12.5px] text-ink-faint">当前筛选条件下没有匹配的服务或任务</p>
          ) : (
            categoryViews.map((category) => (
              <CategoryPanel
                key={category.key}
                category={category}
                serviceFilter={serviceFilter}
                taskFilter={taskFilter}
                viewMode={viewMode}
                reorder={reorderWithinGroup}
                runtimes={runtimes}
                busy={busy}
                sharedPorts={sharedPorts}
                actionsFor={actionsFor}
              />
            ))
          )}
        </>
      )}

        </>
      )}

      {focus && focusEntry && (
        <section aria-labelledby="precheck-heading">
          <div className="mb-2.5 flex items-center justify-between gap-3">
            <h2 id="precheck-heading" className="eyebrow">
              Diagnose · {focusEntry.name}
            </h2>
            <button
              type="button"
              onClick={() => setFocus(null)}
              className="pressable rounded-[5px] border border-line bg-raised/50 px-2.5 py-1 text-[11.5px] text-ink-muted hover:border-line-strong hover:text-ink-strong"
            >
              收起
            </button>
          </div>
          <PrecheckPanel
            result={focus.precheck}
            onFix={(action, suggestedPort) => void runFix(focusEntry.id, action, suggestedPort)}
          />
        </section>
      )}

      {dialog && (
        <AddEntryDialog
          kind={dialog.kind}
          initialPath={dialog.path}
          initialName={dialog.name}
          categories={categoryNames}
          onSubmit={submit}
          onClose={() => setDialog(null)}
        />
      )}

      {editEntry && (
        <EditEntryDialog
          entry={editEntry}
          runtime={runtimes[editEntry.id] ?? IDLE_RUNTIME(editEntry.id)}
          categories={categoryNames}
          error={error}
          onSubmit={(patch) => edit(editEntry.id, patch)}
          onStop={() => void stop(editEntry.id)}
          onClose={() => {
            setEditing(null)
            clearError()
          }}
        />
      )}

      {dialogs}

      <LaunchpadTerminalPanel
        entryId={pinnedEntryId}
        entries={entries}
        runtimes={runtimes}
        onOpenFullTerminal={(sessionId) => onOpenLogs(sessionId)}
        onClose={() => setPinnedEntryId(null)}
      />
    </div>
  )
}

function FilterControl<F extends string>({
  label,
  filter,
  filters,
  onChange
}: {
  label: string
  filter: F
  filters: { value: F; label: string }[]
  onChange: (value: F) => void
}): React.JSX.Element {
  return (
    <div role="radiogroup" aria-label={label} className="segmented">
      {filters.map((item) => (
        <button
          key={item.value}
          type="button"
          role="radio"
          aria-checked={item.value === filter}
          onClick={() => onChange(item.value)}
          className="segmented-item"
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

/** 技术栈 tab 单项：标签 + 计数徽标，选中态用强调色边框 */
function StackTab({
  label,
  count,
  active,
  onClick
}: {
  label: string
  count: number
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-stack-tab={label}
      onClick={onClick}
      className={`pressable-flat flex items-center gap-1.5 rounded-[6px] border px-2.5 py-1 text-[12px] transition-colors duration-150 ${
        active
          ? 'border-accent/60 bg-accent/8 text-accent'
          : 'border-transparent bg-raised/60 text-ink-faint hover:border-line hover:text-ink-muted'
      }`}
    >
      <span className="font-medium">{label}</span>
      <span
        className={`rounded-[3px] px-1 font-mono text-[10px] ${
          active ? 'bg-accent/15 text-accent' : 'bg-raised text-ink-faint'
        }`}
      >
        {count}
      </span>
    </button>
  )
}

/** 卡片 / 列表 视图切换，两个图标按钮组成的分段控件 */
function ViewToggle({
  mode,
  onChange
}: {
  mode: ViewMode
  onChange: (mode: ViewMode) => void
}): React.JSX.Element {
  return (
    <div role="radiogroup" aria-label="展示形态" className="segmented">
      <button
        type="button"
        role="radio"
        aria-checked={mode === 'card'}
        aria-label="卡片视图"
        title="卡片视图"
        data-view-toggle="card"
        onClick={() => onChange('card')}
        className="segmented-item"
      >
        <IconGrid size={14} strokeWidth={1.6} />
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={mode === 'list'}
        aria-label="列表视图"
        title="列表视图"
        data-view-toggle="list"
        onClick={() => onChange('list')}
        className="segmented-item"
      >
        <IconList size={14} strokeWidth={1.6} />
      </button>
    </div>
  )
}

function CategoryPanel({
  category,
  serviceFilter,
  taskFilter,
  viewMode,
  reorder,
  runtimes,
  busy,
  sharedPorts,
  actionsFor
}: {
  category: CategoryView
  serviceFilter: ServiceFilter
  taskFilter: TaskFilter
  viewMode: ViewMode
  reorder: (ids: string[]) => Promise<void>
  runtimes: Record<string, EntryRuntime>
  busy: Record<string, boolean>
  sharedPorts: ReadonlySet<number>
  actionsFor: (entry: LaunchEntry) => EntryCardActions
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(true)
  const services = category.entries.filter((entry) => entry.kind === 'service')
  const tasks = category.entries.filter((entry) => entry.kind === 'task')
  const visible = category.services.length + category.tasks.length
  const live = category.entries.filter((entry) => isLiveStatus(runtimes[entry.id]?.status ?? 'idle')).length
  const headingId = `category-${category.key}`

  return (
    <section
      data-category-panel
      data-category-name={category.name}
      aria-labelledby={headingId}
      className="border-y border-line py-0.5"
    >
      <h2 id={headingId}>
        <button
          type="button"
          data-category-toggle
          aria-expanded={expanded}
          aria-controls={`${headingId}-content`}
          onClick={() => setExpanded((value) => !value)}
          className={`pressable-flat flex w-full min-w-0 items-center gap-2.5 rounded-[5px] border-l-2 py-1.5 pl-3 pr-2 text-left transition-colors hover:bg-raised/60 ${
            expanded ? 'border-accent/60' : 'border-line-strong/50'
          }`}
        >
          <span
            className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink-strong"
            title={category.name}
          >
            {category.name}
          </span>
          {live > 0 && (
            <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-live">
              <span
                className="h-1.5 w-1.5 rounded-full bg-live shadow-[0_0_0_2px_color-mix(in_srgb,var(--signal-live)_22%,transparent)]"
                aria-hidden
              />
              {live} 运行中
            </span>
          )}
          <span className="shrink-0 rounded-[4px] bg-raised px-1.5 font-mono text-[10px] text-ink-faint">
            {visible === category.entries.length ? visible : `${visible} / ${category.entries.length}`}
          </span>
          <IconChevronDown
            size={12}
            strokeWidth={1.8}
            className={`shrink-0 text-ink-faint/70 transition-transform duration-300 [transition-timing-function:cubic-bezier(0.34,1.56,0.64,1)] ${expanded ? 'rotate-0' : '-rotate-90'}`}
          />
        </button>
      </h2>

      <div id={`${headingId}-content`} data-category-content hidden={!expanded} className="px-2 pt-2.5 pb-3">
        <div className="flex flex-col gap-4">
          {category.services.length > 0 && (
            <EntryGrid
              kind="service"
              entries={services}
              visible={category.services}
              sortable={serviceFilter === 'all' && viewMode === 'card'}
              viewMode={viewMode}
              reorder={reorder}
              runtimes={runtimes}
              busy={busy}
              sharedPorts={sharedPorts}
              actionsFor={actionsFor}
            />
          )}
          {category.tasks.length > 0 && (
            <EntryGrid
              kind="task"
              entries={tasks}
              visible={category.tasks}
              sortable={taskFilter === 'all' && viewMode === 'card'}
              viewMode={viewMode}
              reorder={reorder}
              runtimes={runtimes}
              busy={busy}
              sharedPorts={sharedPorts}
              actionsFor={actionsFor}
            />
          )}
        </div>
      </div>
    </section>
  )
}

function EntryGrid({
  kind,
  entries,
  visible,
  sortable,
  viewMode,
  reorder,
  runtimes,
  busy,
  sharedPorts,
  actionsFor
}: {
  kind: EntryKind
  entries: LaunchEntry[]
  visible: LaunchEntry[]
  sortable: boolean
  viewMode: ViewMode
  reorder: (ids: string[]) => Promise<void>
  runtimes: Record<string, EntryRuntime>
  busy: Record<string, boolean>
  sharedPorts: ReadonlySet<number>
  actionsFor: (entry: LaunchEntry) => EntryCardActions
}): React.JSX.Element {
  const { ordered, gridRef, announcement, draggingId, handlersFor } = useCardSort(entries, reorder)
  const visibleIds = new Set(visible.map((entry) => entry.id))
  const orderedVisible = ordered.filter((entry) => visibleIds.has(entry.id))
  const label = kind === 'service' ? 'Services · 服务' : 'Tasks · 批处理任务'

  return (
    <section data-category-kind={kind} aria-label={label}>
      <div aria-live="polite" role="status" className="sr-only">
        {announcement}
      </div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="eyebrow eyebrow-tight">
          {label}
          <span className="ml-2 font-mono text-ink-faint">
            {orderedVisible.length}
            {orderedVisible.length !== entries.length && ` / ${entries.length}`}
          </span>
        </h3>
      </div>
      {viewMode === 'list' ? (
        // 列表：竖直堆叠紧凑行，不做拖拽排序（排序是卡片网格的交互）
        <div data-entry-list className="flex flex-col gap-1.5">
          {orderedVisible.map((entry, i) => (
            <EntryRow
              key={entry.id}
              entry={entry}
              runtime={runtimes[entry.id] ?? IDLE_RUNTIME(entry.id)}
              busy={busy[entry.id] ?? false}
              portShared={sharedPorts.has(runtimes[entry.id]?.port ?? -1)}
              actions={actionsFor(entry)}
              index={i}
            />
          ))}
        </div>
      ) : (
        <div
          ref={gridRef}
          data-sorting={sortable && draggingId !== null ? 'true' : undefined}
          className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3"
        >
          {orderedVisible.map((entry, index) => (
            <EntryCard
              key={entry.id}
              entry={entry}
              runtime={runtimes[entry.id] ?? IDLE_RUNTIME(entry.id)}
              busy={busy[entry.id] ?? false}
              sort={sortable ? handlersFor(entry) : undefined}
              dragging={draggingId === entry.id}
              position={{ index: index + 1, total: orderedVisible.length }}
              portShared={sharedPorts.has(runtimes[entry.id]?.port ?? -1)}
              actions={actionsFor(entry)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

/** 空状态引导卡，三格布局 */
function EmptyGuideCard({
  icon: IconCmp,
  label,
  desc,
  onClick
}: {
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>
  label: string
  desc: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="pressable group flex flex-col items-center gap-2 rounded-[10px] border border-dashed border-line-strong/60 bg-card px-4 py-5 text-center transition-colors duration-200 hover:border-accent/50 hover:bg-accent/5"
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-[8px] bg-raised transition-colors group-hover:bg-accent/10">
        <IconCmp size={18} strokeWidth={1.5} className="text-ink-muted transition-colors group-hover:text-accent" />
      </span>
      <span className="text-[12px] font-semibold text-ink-strong">{label}</span>
      <span className="text-[10.5px] leading-relaxed text-ink-faint">{desc}</span>
    </button>
  )
}
