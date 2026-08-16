import { useCallback, useEffect, useMemo, useState } from 'react'
import { CaretDown, Warning, X } from '@phosphor-icons/react'
import type {
  EntryKind,
  EntryRuntime,
  LaunchEntry,
  NewLaunchEntry,
  PrecheckResult
} from '@shared/types'
import { EntryCard } from '../components/EntryCard'
import type { EntryCardActions } from '../components/EntryCard'
import { AddEntryDialog } from '../components/AddEntryDialog'
import { EditEntryDialog } from '../components/EditEntryDialog'
import { PrecheckPanel } from '../components/PrecheckPanel'
import { useEntries } from '../store/entries'
import { useEntryFix } from '../lib/useEntryFix'
import { useCardSort } from '../lib/useCardSort'
import {
  SERVICE_FILTERS,
  TASK_FILTERS,
  isLiveStatus,
  matchesServiceFilter,
  matchesTaskFilter
} from '../lib/entryMeta'
import type { ServiceFilter, TaskFilter } from '../lib/entryMeta'

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

  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [focus, setFocus] = useState<{ entryId: string; precheck: PrecheckResult } | null>(null)
  const [serviceFilter, setServiceFilter] = useState<ServiceFilter>('all')
  const [taskFilter, setTaskFilter] = useState<TaskFilter>('all')

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

  const categoryViews = useMemo<CategoryView[]>(
    () => categories
      .map((category) => ({
        ...category,
        services: category.entries.filter(
          (entry) => entry.kind === 'service' && matchesServiceFilter(runtimes[entry.id]?.status ?? 'idle', serviceFilter)
        ),
        tasks: category.entries.filter(
          (entry) => entry.kind === 'task' && matchesTaskFilter(runtimes[entry.id]?.status ?? 'idle', taskFilter)
        )
      }))
      .filter((category) => category.services.length > 0 || category.tasks.length > 0),
    [categories, runtimes, serviceFilter, taskFilter]
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

  const submit = async (input: NewLaunchEntry): Promise<void> => {
    await add(input)
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
    onDiagnose: () =>
      void window.mile.entry
        .precheck(entry.id)
        .then((precheck) => setFocus({ entryId: entry.id, precheck })),
    onEdit: () => {
      clearError()
      setEditing(entry.id)
    },
    onOpenFolder: () => window.mile.shell.openPath(entry.path),
    onOpenOutput: () =>
      void window.mile.entry
        .outputDir(entry.id)
        .then((dir) => dir && window.mile.shell.openPath(dir)),
    onTogglePin: () => void edit(entry.id, { pinned: !entry.pinned }),
    onRemove: () => void remove(entry.id)
  })

  const focusEntry = focus ? entries.find((entry) => entry.id === focus.entryId) : undefined
  const editEntry = editing ? entries.find((entry) => entry.id === editing) : undefined

  return (
    <div className="flex flex-col gap-7">
      {error && !editEntry && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-[12px] border border-fault/40 bg-fault-soft px-4 py-3"
        >
          <Warning size={15} weight="bold" className="mt-0.5 shrink-0 text-fault" aria-hidden />
          <p className="min-w-0 flex-1 text-[13px] break-words text-fault">{error}</p>
          <button
            type="button"
            aria-label="关闭提示"
            title="关闭提示"
            onClick={clearError}
            className="pressable shrink-0 text-fault hover:opacity-80"
          >
            <X size={14} weight="bold" />
          </button>
        </div>
      )}

      {entries.length === 0 ? (
        <div className="surface-card px-6 py-14 text-center">
          <p className="text-[13px] text-ink-muted">启动台还没有条目</p>
          <p className="mt-1.5 text-[12px] text-ink-faint">添加一个项目目录，识别后即可一键启动</p>
        </div>
      ) : (
        <>
          <section aria-labelledby="launchpad-filter-heading" className="border-y border-line py-3">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <h2 id="launchpad-filter-heading" className="eyebrow eyebrow-tight">
                Filters · 筛选
              </h2>
              <div className="flex flex-wrap items-center gap-3">
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
              </div>
            </div>
          </section>

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

      {focus && focusEntry && (
        <section aria-labelledby="precheck-heading">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 id="precheck-heading" className="eyebrow">
              Diagnose · {focusEntry.name}
            </h2>
            <button
              type="button"
              onClick={() => setFocus(null)}
              className="pressable rounded-[6px] border border-line-strong bg-card px-2.5 py-1 text-[12px] text-ink-muted hover:text-ink-strong"
            >
              收起
            </button>
          </div>
          <PrecheckPanel
            result={focus.precheck}
            onFix={(action) => void runFix(focusEntry.id, action)}
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

function CategoryPanel({
  category,
  serviceFilter,
  taskFilter,
  reorder,
  runtimes,
  busy,
  sharedPorts,
  actionsFor
}: {
  category: CategoryView
  serviceFilter: ServiceFilter
  taskFilter: TaskFilter
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
      className="border-y border-line py-1"
    >
      <h2 id={headingId}>
        <button
          type="button"
          data-category-toggle
          aria-expanded={expanded}
          aria-controls={`${headingId}-content`}
          onClick={() => setExpanded((value) => !value)}
          className="pressable flex w-full min-w-0 items-center gap-3 rounded-[6px] px-2 py-2 text-left hover:bg-raised"
        >
          <CaretDown
            size={15}
            weight="bold"
            aria-hidden
            className={`shrink-0 text-ink-faint transition-transform ${expanded ? '' : '-rotate-90'}`}
          />
          <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink-strong" title={category.name}>
            {category.name}
          </span>
          {live > 0 && <span className="status-dot shrink-0" data-halo="true" aria-label={`${live} 项运行中`} />}
          <span className="shrink-0 font-mono text-[11px] text-ink-faint">
            {visible === category.entries.length ? visible : `${visible} / ${category.entries.length}`}
          </span>
        </button>
      </h2>

      <div id={`${headingId}-content`} data-category-content hidden={!expanded} className="px-2 pt-3 pb-4">
        <div className="flex flex-col gap-5">
          {category.services.length > 0 && (
            <EntryGrid
              kind="service"
              entries={services}
              visible={category.services}
              sortable={serviceFilter === 'all'}
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
              sortable={taskFilter === 'all'}
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
      <div ref={gridRef} className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
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
    </section>
  )
}
