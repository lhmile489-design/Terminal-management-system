import { useState, useCallback, useMemo } from 'react'
import {
  Plus,
  Pencil,
  Trash,
  FolderSimple,
  Folders,
  Users,
  Warning,
  CheckCircle,
  ArrowSquareOut,
  Terminal as TerminalIcon,
  X,
  DotsSixVertical,
  CaretDown
} from '@phosphor-icons/react'
import { useShallow } from 'zustand/react/shallow'
import type { GroupEnvironment, LaunchEntry, ProjectGroup, EntryRuntime } from '@shared/types'
import { GROUP_ENV_LABEL, isWebFramework } from '@shared/types'
import { useGroups } from '../store/groups'
import { useEntries } from '../store/entries'
import { useCardSort } from '../lib/useCardSort'
import { EntryRow } from './EntryRow'
import { TerminalView } from './TerminalView'
import { StatusPill } from './StatusPill'
import { isLiveStatus, STATUS_META } from '../lib/entryMeta'
import type { EntryCardActions } from './EntryCard'

// ─── 环境色调 ──────────────────────────────────────────────────────────────────

const ENV_BADGE: Record<GroupEnvironment, string> = {
  dev:     'bg-live/10 text-live/90 border border-live/20',
  sandbox: 'bg-warn/10 text-warn/90 border border-warn/20',
  prod:    'bg-fault/10 text-fault/90 border border-fault/20'
}

const ENV_DOT: Record<GroupEnvironment, string> = {
  dev:     'bg-live',
  sandbox: 'bg-warn',
  prod:    'bg-fault'
}

// ─── 前端 / 后端 / 其他 分区 ─────────────────────────────────────────────────────

type ModuleSection = 'frontend' | 'backend' | 'other'

const MODULE_LABEL: Record<ModuleSection, string> = {
  frontend: '前端',
  backend:  '后端',
  other:    '其他'
}

/** 根据框架推断条目属于前端 / 后端 / 其他 */
function moduleOf(entry: LaunchEntry): ModuleSection {
  if (isWebFramework(entry.framework)) return 'frontend'
  // 非 web 框架中，uniapp/static/hugo/jekyll/unknown 归"其他"，其余归"后端"
  const otherFrameworks = new Set(['uniapp', 'static', 'hugo', 'jekyll', 'unknown'])
  if (otherFrameworks.has(entry.framework)) return 'other'
  return 'backend'
}

// ─── 工作组对话框（创建 / 编辑）────────────────────────────────────────────────

interface GroupDialogProps {
  initial?: ProjectGroup
  onSubmit: (name: string, description: string, env: GroupEnvironment) => Promise<void>
  onClose: () => void
}

export function GroupDialog({ initial, onSubmit, onClose }: GroupDialogProps): React.JSX.Element {
  const [name, setName] = useState(initial?.name ?? '')
  const [desc, setDesc] = useState(initial?.description ?? '')
  const [env, setEnv] = useState<GroupEnvironment>(initial?.env ?? 'dev')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!name.trim()) { setErr('名称不能为空'); return }
    if (name.trim().length > 40) { setErr('名称不超过 40 字'); return }
    setLoading(true)
    setErr(null)
    try {
      await onSubmit(name.trim(), desc.trim(), env)
      onClose()
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : '操作失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className="scrim-frosted fixed inset-0 z-50 flex items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="surface-frosted cmd-dialog w-full max-w-[400px] rounded-[12px] p-5 shadow-xl">
        <h2 className="mb-4 text-[14px] font-semibold text-ink-strong">
          {initial ? '编辑工作组' : '新建工作组'}
        </h2>

        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
          {/* 名称 */}
          <div>
            <label htmlFor="group-name" className="mb-1 block font-mono text-[9px] font-bold uppercase tracking-[0.15em] text-ink-faint/60">
              名称 <span className="text-fault">*</span>
            </label>
            <input
              id="group-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              placeholder="例：商城系统"
              autoFocus
              className="w-full rounded-[6px] border border-line bg-raised/50 px-2.5 py-1.5 text-[12.5px] text-ink-strong placeholder-ink-faint/40 outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20"
            />
          </div>

          {/* 描述 */}
          <div>
            <label htmlFor="group-desc" className="mb-1 block font-mono text-[9px] font-bold uppercase tracking-[0.15em] text-ink-faint/60">
              描述（可选）
            </label>
            <input
              id="group-desc"
              type="text"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              maxLength={120}
              placeholder="简短说明这个工作组的用途"
              className="w-full rounded-[6px] border border-line bg-raised/50 px-2.5 py-1.5 text-[12.5px] text-ink-strong placeholder-ink-faint/40 outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20"
            />
          </div>

          {/* 环境 */}
          <div>
            <span className="mb-1.5 block font-mono text-[9px] font-bold uppercase tracking-[0.15em] text-ink-faint/60">
              初始环境
            </span>
            <div className="flex gap-2">
              {(['dev', 'sandbox', 'prod'] as GroupEnvironment[]).map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => setEnv(e)}
                  className={[
                    'pressable flex-1 rounded-[6px] border py-1.5 text-[11.5px] font-medium transition-all duration-150',
                    env === e
                      ? ENV_BADGE[e]
                      : 'border-line bg-raised/40 text-ink-faint hover:bg-raised hover:text-ink-muted'
                  ].join(' ')}
                >
                  {GROUP_ENV_LABEL[e]}
                </button>
              ))}
            </div>
          </div>

          {/* 错误 */}
          {err && (
            <div className="flex items-center gap-1.5 rounded-[5px] border border-fault/25 bg-fault/8 px-2.5 py-1.5">
              <Warning size={11} weight="bold" className="shrink-0 text-fault" />
              <p className="text-[11px] text-fault">{err}</p>
            </div>
          )}

          {/* 按钮 */}
          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="pressable rounded-[6px] border border-line bg-raised/40 px-3.5 py-1.5 text-[12px] text-ink-muted hover:border-line-strong hover:text-ink-strong"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={loading}
              className="btn-primary pressable rounded-[6px] px-4 py-1.5 text-[12px] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? '保存中…' : initial ? '保存' : '创建'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── 条目分配对话框 ────────────────────────────────────────────────────────────

interface AssignDialogProps {
  group: ProjectGroup
  entries: LaunchEntry[]
  onClose: () => void
}

export function AssignGroupDialog({ group, entries, onClose }: AssignDialogProps): React.JSX.Element {
  const patchEntry = useEntries((s) => s.edit)
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')

  const filtered = useMemo(
    () => entries.filter((e) =>
      !search || e.name.toLowerCase().includes(search.toLowerCase())
    ),
    [entries, search]
  )

  const toggle = useCallback(async (entry: LaunchEntry) => {
    setLoading(true)
    try {
      if (entry.groupId === group.id) {
        await patchEntry(entry.id, { groupId: null })
      } else {
        await patchEntry(entry.id, { groupId: group.id })
      }
    } finally {
      setLoading(false)
    }
  }, [group.id, patchEntry])

  return (
    <div
      className="scrim-frosted fixed inset-0 z-50 flex items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="surface-frosted cmd-dialog w-full max-w-[440px] rounded-[12px] p-5 shadow-xl">
        <div className="mb-3 flex items-center gap-2">
          <Users size={14} weight="regular" className="shrink-0 text-accent/70" aria-hidden />
          <h2 className="text-[14px] font-semibold text-ink-strong">分配条目到「{group.name}」</h2>
        </div>

        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索条目名称…"
          className="mb-3 w-full rounded-[6px] border border-line bg-raised/50 px-2.5 py-1.5 text-[12px] text-ink-strong placeholder-ink-faint/40 outline-none focus:border-accent/50"
        />

        <div className="flex max-h-[280px] flex-col gap-1 overflow-y-auto">
          {filtered.length === 0 && (
            <p className="py-4 text-center text-[12px] text-ink-faint/60">没有匹配的条目</p>
          )}
          {filtered.map((entry) => {
            const inGroup = entry.groupId === group.id
            const inOther = entry.groupId && entry.groupId !== group.id
            return (
              <button
                key={entry.id}
                type="button"
                disabled={loading}
                onClick={() => void toggle(entry)}
                className={[
                  'pressable-flat flex min-w-0 items-center gap-2.5 rounded-[5px] border px-3 py-2 text-left transition-colors',
                  inGroup
                    ? 'border-accent/25 bg-accent/8'
                    : inOther
                      ? 'border-line bg-raised/20 opacity-50'
                      : 'border-line bg-card hover:border-line-strong hover:bg-raised'
                ].join(' ')}
              >
                {inGroup ? (
                  <CheckCircle size={13} weight="fill" className="shrink-0 text-accent" aria-hidden />
                ) : (
                  <div className="h-3.5 w-3.5 shrink-0 rounded-full border border-line" aria-hidden />
                )}
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink-strong">{entry.name}</span>
                {inOther && (
                  <span className="shrink-0 text-[9.5px] text-ink-faint/60">已在其他工作组</span>
                )}
              </button>
            )
          })}
        </div>

        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="pressable rounded-[6px] border border-line bg-raised/40 px-4 py-1.5 text-[12px] text-ink-muted hover:border-line-strong hover:text-ink-strong"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── 可排序的模块区（前端 / 后端 / 其他）──────────────────────────────────────────

interface ModuleSectionProps {
  section: ModuleSection
  entries: LaunchEntry[]
  runtimes: Record<string, EntryRuntime>
  busy: Record<string, boolean>
  actionsFor: (entry: LaunchEntry) => EntryCardActions
  onTerminalSelect: (entryId: string) => void
  selectedTerminalId: string | null
  reorder: (ids: string[]) => Promise<void>
}

function ModuleSectionRow({
  section,
  entries,
  runtimes,
  busy,
  actionsFor,
  onTerminalSelect,
  selectedTerminalId,
  reorder
}: ModuleSectionProps): React.JSX.Element {
  const { ordered, gridRef, announcement, draggingId, handlersFor } = useCardSort(entries, reorder)

  const IDLE_RT = (id: string): EntryRuntime => ({ entryId: id, status: 'idle', portUnknown: false })

  return (
    <section className="flex flex-col gap-1.5">
      {/* Section 标题 */}
      <div className="flex items-center gap-2 px-1">
        <span className="eyebrow">{MODULE_LABEL[section]}</span>
        <span className="font-mono text-[9.5px] text-ink-faint/50">{entries.length}</span>
      </div>

      {/* 无障碍播报 */}
      <div role="status" aria-live="assertive" className="sr-only">{announcement}</div>

      {/* 条目列表 */}
      <div ref={gridRef} className="flex flex-col gap-0.5" role="list" aria-label={`${MODULE_LABEL[section]}条目`}>
        {ordered.map((entry) => {
          const runtime = runtimes[entry.id] ?? IDLE_RT(entry.id)
          const handlers = handlersFor(entry)
          const isSelected = selectedTerminalId === entry.id
          const isRunning = isLiveStatus(runtime.status)

          return (
            <div
              key={entry.id}
              data-entry-id={entry.id}
              role="listitem"
              className={[
                'group/row relative flex items-center gap-1.5 rounded-[7px] border transition-colors duration-150',
                draggingId === entry.id ? 'opacity-40' : '',
                isSelected
                  ? 'border-accent/25 bg-accent/5'
                  : 'border-transparent hover:border-line hover:bg-raised/40'
              ].join(' ')}
            >
              {/* 拖拽手柄 */}
              <div
                {...handlers}
                aria-label={`拖拽排序：${entry.name}`}
                className="flex h-full cursor-grab items-center px-1 py-2 text-ink-faint/30 opacity-0 transition-opacity active:cursor-grabbing group-hover/row:opacity-100"
              >
                <DotsSixVertical size={12} weight="bold" />
              </div>

              {/* 条目行，略微左移以适配手柄 */}
              <div className="min-w-0 flex-1">
                <EntryRow
                  entry={entry}
                  runtime={runtime}
                  busy={!!busy[entry.id]}
                  actions={actionsFor(entry)}
                />
              </div>

              {/* 终端选中指示器（运行时才出现） */}
              {isRunning && runtime.sessionId && (
                <button
                  type="button"
                  aria-label={isSelected ? '当前终端预览' : '在下方预览终端'}
                  title={isSelected ? '已选中预览此条目终端' : '在下方预览终端'}
                  onClick={() => onTerminalSelect(entry.id)}
                  className={[
                    'pressable mr-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] opacity-0 transition-opacity group-hover/row:opacity-100',
                    isSelected
                      ? 'bg-accent/15 text-accent opacity-100'
                      : 'text-ink-faint hover:bg-raised hover:text-ink-strong'
                  ].join(' ')}
                >
                  <TerminalIcon size={12} weight={isSelected ? 'fill' : 'regular'} />
                </button>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ─── 主工作组面板 ──────────────────────────────────────────────────────────────

interface GroupPanelProps {
  actionsFor: (entry: LaunchEntry) => EntryCardActions
  onOpenLogs: (sessionId: string) => void
}

export function GroupsPanel({ actionsFor, onOpenLogs }: GroupPanelProps): React.JSX.Element {
  const { groups, add, patch, remove } = useGroups(
    useShallow((s) => ({ groups: s.groups, add: s.add, patch: s.patch, remove: s.remove }))
  )
  const entries = useEntries((s) => s.entries)
  const runtimes = useEntries((s) => s.runtimes)
  const busy = useEntries((s) => s.busy)
  const reorder = useEntries((s) => s.reorder)

  const [selectedId, setSelectedId] = useState<string | null>(() => groups[0]?.id ?? null)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [editingGroup, setEditingGroup] = useState<ProjectGroup | null>(null)
  const [assigningGroup, setAssigningGroup] = useState<ProjectGroup | null>(null)
  /** 当前锁定在终端预览区的条目 id */
  const [terminalEntryId, setTerminalEntryId] = useState<string | null>(null)
  /** 终端预览区是否折叠 */
  const [terminalCollapsed, setTerminalCollapsed] = useState(false)

  const selectedGroup = groups.find((g) => g.id === selectedId) ?? null

  const groupEntries = useMemo(
    () => (selectedGroup ? entries.filter((e) => e.groupId === selectedGroup.id) : []),
    [entries, selectedGroup]
  )

  // 按模块分区
  const frontendEntries = useMemo(
    () => groupEntries.filter((e) => moduleOf(e) === 'frontend'),
    [groupEntries]
  )
  const backendEntries = useMemo(
    () => groupEntries.filter((e) => moduleOf(e) === 'backend'),
    [groupEntries]
  )
  const otherEntries = useMemo(
    () => groupEntries.filter((e) => moduleOf(e) === 'other'),
    [groupEntries]
  )

  const liveCount = useMemo(
    () => groupEntries.filter((e) => isLiveStatus(runtimes[e.id]?.status ?? 'idle')).length,
    [groupEntries, runtimes]
  )

  // 左侧列表每个工作组的统计
  const groupStats = useMemo(
    () =>
      groups.reduce<Record<string, { total: number; live: number; frontend: number; backend: number }>>((acc, g) => {
        const ge = entries.filter((e) => e.groupId === g.id)
        acc[g.id] = {
          total: ge.length,
          live: ge.filter((e) => isLiveStatus(runtimes[e.id]?.status ?? 'idle')).length,
          frontend: ge.filter((e) => moduleOf(e) === 'frontend').length,
          backend: ge.filter((e) => moduleOf(e) === 'backend').length
        }
        return acc
      }, {}),
    [groups, entries, runtimes]
  )

  // 终端预览：当前活跃会话条目（优先锁定的，其次取第一个运行中的后端条目，再取前端）
  const activeTerminalEntry = useMemo(() => {
    if (terminalEntryId) {
      const entry = groupEntries.find((e) => e.id === terminalEntryId)
      if (entry && runtimes[entry.id]?.sessionId) return entry
    }
    // 自动选取运行中后端
    const runningBackend = backendEntries.find((e) => isLiveStatus(runtimes[e.id]?.status ?? 'idle') && runtimes[e.id]?.sessionId)
    if (runningBackend) return runningBackend
    // 再取运行中前端
    const runningFrontend = frontendEntries.find((e) => isLiveStatus(runtimes[e.id]?.status ?? 'idle') && runtimes[e.id]?.sessionId)
    if (runningFrontend) return runningFrontend
    return null
  }, [terminalEntryId, groupEntries, runtimes, backendEntries, frontendEntries])

  const activeTerminalSessionId = activeTerminalEntry ? runtimes[activeTerminalEntry.id]?.sessionId ?? null : null
  const activeTerminalRuntime = activeTerminalEntry ? runtimes[activeTerminalEntry.id] : null
  const showTerminal = !!activeTerminalSessionId

  const handleCreate = useCallback(
    async (name: string, description: string, env: GroupEnvironment) => {
      const g = await add({ name, description: description || undefined, env })
      setSelectedId(g.id)
    },
    [add]
  )

  const handleEdit = useCallback(
    async (name: string, description: string, env: GroupEnvironment) => {
      if (!editingGroup) return
      await patch(editingGroup.id, { name, description: description || undefined, env })
    },
    [patch, editingGroup]
  )

  const handleDelete = useCallback(
    async (group: ProjectGroup) => {
      if (!window.confirm(`确认删除工作组「${group.name}」？此操作不可恢复，组内条目不会被删除。`)) return
      await remove(group.id)
      if (selectedId === group.id) setSelectedId(groups.find((g) => g.id !== group.id)?.id ?? null)
    },
    [remove, selectedId, groups]
  )

  // 工作组内拖排序：保持其他工作组条目的相对顺序不变
  const reorderWithinGroup = useCallback(async (ids: string[]) => {
    const moved = new Set(ids)
    let next = 0
    const allIds = entries.map((e) => (moved.has(e.id) ? ids[next++] : e.id))
    await reorder(allIds)
  }, [entries, reorder])

  const handleTerminalSelect = useCallback((entryId: string) => {
    setTerminalEntryId((prev) => prev === entryId ? null : entryId)
    setTerminalCollapsed(false)
  }, [])

  // 空状态：没有工作组
  if (groups.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 py-16">
        <div className="flex h-14 w-14 items-center justify-center rounded-[14px] border-2 border-dashed border-line-strong/60">
          <Folders size={26} className="text-ink-faint/40" />
        </div>
        <div className="text-center">
          <p className="text-[14px] font-semibold text-ink-strong">还没有工作组</p>
          <p className="mt-1 text-[12px] text-ink-faint">创建工作组，将相关前后端服务归集在一起统一管理</p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreateDialog(true)}
          className="btn-primary pressable flex items-center gap-1.5 rounded-[6px] px-4 py-2 text-[12.5px]"
        >
          <Plus size={12} weight="bold" aria-hidden />
          新建工作组
        </button>
        {showCreateDialog && (
          <GroupDialog onSubmit={handleCreate} onClose={() => setShowCreateDialog(false)} />
        )}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-hidden">
      {/* ── 左侧：工作组列表 ─────────────────────────────────────────────────── */}
      <div className="flex w-52 shrink-0 flex-col gap-1 overflow-y-auto">
        {groups
          .sort((a, b) => a.order - b.order)
          .map((g) => {
            const stats = groupStats[g.id] ?? { total: 0, live: 0, frontend: 0, backend: 0 }
            return (
              <button
                key={g.id}
                type="button"
                onClick={() => setSelectedId(g.id)}
                className={[
                  'pressable-flat flex min-w-0 flex-col rounded-[8px] border px-3 py-2.5 text-left transition-colors',
                  selectedId === g.id
                    ? 'border-accent/30 bg-accent/8'
                    : 'border-line bg-card hover:border-line-strong hover:bg-raised'
                ].join(' ')}
              >
                {/* 工作组名称 + 运行指示 */}
                <div className="flex w-full items-center gap-1.5">
                  {stats.live > 0 && (
                    <span className="relative flex h-2 w-2 shrink-0">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-live opacity-50" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-live" />
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-ink-strong">{g.name}</span>
                </div>

                {/* 环境标签 + 统计 */}
                <div className="mt-1.5 flex items-center gap-1.5">
                  <span className={`flex h-1.5 w-1.5 shrink-0 rounded-full ${ENV_DOT[g.env]}`} />
                  <span className="font-mono text-[9px] text-ink-faint/60">
                    {GROUP_ENV_LABEL[g.env]}
                  </span>
                  <span className="font-mono text-[9px] text-ink-faint/40">·</span>
                  {stats.frontend > 0 && (
                    <span className="font-mono text-[9px] text-ink-faint/60">
                      前 {stats.frontend}
                    </span>
                  )}
                  {stats.backend > 0 && (
                    <span className="font-mono text-[9px] text-ink-faint/60">
                      后 {stats.backend}
                    </span>
                  )}
                  {stats.total === 0 && (
                    <span className="font-mono text-[9px] text-ink-faint/40">空</span>
                  )}
                </div>
              </button>
            )
          })}

        {/* 新建工作组 */}
        <button
          type="button"
          onClick={() => setShowCreateDialog(true)}
          className="pressable-flat mt-1 flex items-center gap-1.5 rounded-[7px] border border-dashed border-line px-3 py-2 text-[11.5px] text-ink-faint hover:border-line-strong hover:text-ink-muted"
        >
          <Plus size={11} weight="bold" aria-hidden />
          新建工作组
        </button>
      </div>

      {/* ── 右侧：工作组详情 ─────────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {selectedGroup ? (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* 工作组头部 */}
            <div className="mb-3 flex items-start gap-2 border-b border-line pb-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-[14px] font-semibold text-ink-strong">{selectedGroup.name}</h2>
                  <span className={`shrink-0 rounded-[4px] px-1.5 py-0.5 font-mono text-[9px] font-medium ${ENV_BADGE[selectedGroup.env]}`}>
                    {GROUP_ENV_LABEL[selectedGroup.env]}
                  </span>
                  {groupEntries.length > 0 && (
                    <span className="shrink-0 rounded-[3px] bg-raised/80 px-1.5 py-0.5 font-mono text-[9px] text-ink-faint/70">
                      {groupEntries.length} 项 {liveCount > 0 && <span className="text-live/80">{liveCount} 运行</span>}
                    </span>
                  )}
                </div>
                {selectedGroup.description && (
                  <p className="mt-0.5 text-[11.5px] text-ink-faint/70">{selectedGroup.description}</p>
                )}
              </div>

              {/* 环境切换 */}
              <div className="flex shrink-0 items-center gap-1">
                {(['dev', 'sandbox', 'prod'] as GroupEnvironment[]).map((e) => (
                  <button
                    key={e}
                    type="button"
                    onClick={() => void patch(selectedGroup.id, { env: e })}
                    title={`切换到${GROUP_ENV_LABEL[e]}环境`}
                    className={[
                      'pressable rounded-[4px] border px-2 py-1 font-mono text-[9.5px] font-medium transition-all duration-150',
                      selectedGroup.env === e
                        ? ENV_BADGE[e]
                        : 'border-line bg-raised/40 text-ink-faint hover:bg-raised hover:text-ink-muted'
                    ].join(' ')}
                  >
                    {GROUP_ENV_LABEL[e]}
                  </button>
                ))}
              </div>

              {/* 操作按钮 */}
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => setAssigningGroup(selectedGroup)}
                  title="管理工作组条目"
                  aria-label="管理工作组条目"
                  className="pressable flex items-center gap-1 rounded-[5px] border border-line bg-raised/40 px-2 py-1 text-[10px] text-ink-faint hover:border-line-strong hover:text-ink-muted"
                >
                  <Users size={10} weight="regular" aria-hidden />
                  管理
                </button>
                <button
                  type="button"
                  onClick={() => setEditingGroup(selectedGroup)}
                  title="编辑工作组"
                  aria-label="编辑工作组"
                  className="pressable flex h-6 w-6 items-center justify-center rounded-[5px] border border-line bg-raised/40 text-ink-faint hover:border-line-strong hover:text-ink-muted"
                >
                  <Pencil size={11} weight="regular" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => void handleDelete(selectedGroup)}
                  title="删除工作组"
                  aria-label="删除工作组"
                  className="pressable flex h-6 w-6 items-center justify-center rounded-[5px] border border-line bg-raised/40 text-ink-faint hover:border-fault/30 hover:bg-fault/8 hover:text-fault"
                >
                  <Trash size={11} weight="regular" aria-hidden />
                </button>
              </div>
            </div>

            {/* 条目列表区（可滚动） */}
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              {groupEntries.length === 0 ? (
                <div className="flex flex-col items-center gap-3 rounded-[8px] border border-dashed border-line py-10">
                  <FolderSimple size={22} className="text-ink-faint/40" />
                  <p className="text-[12px] text-ink-faint/60">工作组还没有条目</p>
                  <button
                    type="button"
                    onClick={() => setAssigningGroup(selectedGroup)}
                    className="pressable flex items-center gap-1.5 rounded-[5px] border border-line bg-raised/40 px-3 py-1.5 text-[11.5px] text-ink-muted hover:border-line-strong hover:text-ink-strong"
                  >
                    <Plus size={10} weight="bold" aria-hidden />
                    添加条目
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  {/* 前端区 */}
                  {frontendEntries.length > 0 && (
                    <ModuleSectionRow
                      section="frontend"
                      entries={frontendEntries}
                      runtimes={runtimes}
                      busy={busy}
                      actionsFor={actionsFor}
                      onTerminalSelect={handleTerminalSelect}
                      selectedTerminalId={terminalEntryId}
                      reorder={reorderWithinGroup}
                    />
                  )}

                  {/* 后端区 */}
                  {backendEntries.length > 0 && (
                    <ModuleSectionRow
                      section="backend"
                      entries={backendEntries}
                      runtimes={runtimes}
                      busy={busy}
                      actionsFor={actionsFor}
                      onTerminalSelect={handleTerminalSelect}
                      selectedTerminalId={terminalEntryId}
                      reorder={reorderWithinGroup}
                    />
                  )}

                  {/* 其他区（仅在有条目时显示） */}
                  {otherEntries.length > 0 && (
                    <ModuleSectionRow
                      section="other"
                      entries={otherEntries}
                      runtimes={runtimes}
                      busy={busy}
                      actionsFor={actionsFor}
                      onTerminalSelect={handleTerminalSelect}
                      selectedTerminalId={terminalEntryId}
                      reorder={reorderWithinGroup}
                    />
                  )}

                  {/* 添加更多 */}
                  <button
                    type="button"
                    onClick={() => setAssigningGroup(selectedGroup)}
                    className="pressable-flat flex items-center gap-1.5 rounded-[6px] border border-dashed border-line px-3 py-2 text-[11.5px] text-ink-faint hover:border-line-strong hover:text-ink-muted"
                  >
                    <Plus size={10} weight="bold" aria-hidden />
                    添加更多条目
                  </button>
                </div>
              )}
            </div>

            {/* ── 终端预览面板（底部，有活跃会话时显示）── */}
            {showTerminal && activeTerminalEntry && (
              <div className="mt-3 shrink-0 border-t border-line">
                {/* 终端头部 */}
                <div className="flex items-center gap-2 border-b border-line/60 bg-raised/50 px-3 py-1.5">
                  <TerminalIcon size={13} weight="bold" className="shrink-0 text-ink-faint" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink-strong" title={activeTerminalEntry.name}>
                    {activeTerminalEntry.name}
                  </span>

                  {/* 状态 pill */}
                  {activeTerminalRuntime && (() => {
                    const meta = STATUS_META[activeTerminalRuntime.status]
                    return (
                      <StatusPill
                        tone={meta.tone}
                        label={meta.label}
                        halo={isLiveStatus(activeTerminalRuntime.status)}
                      />
                    )
                  })()}

                  {/* 在终端页查看 */}
                  <button
                    type="button"
                    aria-label="在终端页查看"
                    title="在终端页查看"
                    disabled={!activeTerminalSessionId}
                    onClick={() => activeTerminalSessionId && onOpenLogs(activeTerminalSessionId)}
                    className="pressable flex h-6 w-6 items-center justify-center rounded-[5px] text-ink-faint hover:bg-raised hover:text-ink-strong disabled:pointer-events-none disabled:opacity-30"
                  >
                    <ArrowSquareOut size={12} weight="bold" />
                  </button>

                  {/* 折叠/展开 */}
                  <button
                    type="button"
                    aria-label={terminalCollapsed ? '展开终端' : '折叠终端'}
                    onClick={() => setTerminalCollapsed((v) => !v)}
                    className="pressable flex h-6 w-6 items-center justify-center rounded-[5px] text-ink-faint hover:bg-raised hover:text-ink-strong"
                  >
                    <CaretDown
                      size={11}
                      weight="bold"
                      className={`transition-transform duration-200 [transition-timing-function:cubic-bezier(0.34,1.56,0.64,1)] ${terminalCollapsed ? '-rotate-90' : ''}`}
                    />
                  </button>

                  {/* 关闭（取消锁定） */}
                  {terminalEntryId && (
                    <button
                      type="button"
                      aria-label="关闭终端预览"
                      onClick={() => setTerminalEntryId(null)}
                      className="pressable flex h-6 w-6 items-center justify-center rounded-[5px] text-ink-faint hover:bg-raised hover:text-ink-strong"
                    >
                      <X size={11} weight="bold" />
                    </button>
                  )}
                </div>

                {/* 终端内容区 */}
                {!terminalCollapsed && (
                  <div className="h-52 overflow-hidden">
                    {activeTerminalSessionId ? (
                      <TerminalView key={activeTerminalSessionId} sessionId={activeTerminalSessionId} />
                    ) : (
                      <div className="flex h-full items-center justify-center gap-2 text-ink-faint">
                        <TerminalIcon size={14} weight="bold" aria-hidden />
                        <span className="text-[12px]">等待会话启动…</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-3 py-12">
            <p className="text-[12px] text-ink-faint/60">从左侧选择一个工作组</p>
          </div>
        )}
      </div>

      {/* ── 对话框 ── */}
      {showCreateDialog && (
        <GroupDialog onSubmit={handleCreate} onClose={() => setShowCreateDialog(false)} />
      )}
      {editingGroup && (
        <GroupDialog
          initial={editingGroup}
          onSubmit={handleEdit}
          onClose={() => setEditingGroup(null)}
        />
      )}
      {assigningGroup && (
        <AssignGroupDialog
          group={assigningGroup}
          entries={entries}
          onClose={() => setAssigningGroup(null)}
        />
      )}
    </div>
  )
}
