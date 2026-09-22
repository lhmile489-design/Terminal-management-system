import { useState, useCallback, useMemo } from 'react'
import { Plus, Pencil, Trash, FolderSimple, Users, Warning, CheckCircle } from '@phosphor-icons/react'
import type { GroupEnvironment, LaunchEntry, ProjectGroup } from '@shared/types'
import { GROUP_ENV_LABEL } from '@shared/types'
import { useGroups } from '../store/groups'
import { useEntries } from '../store/entries'
import { EntryRow } from './EntryRow'
import { isLiveStatus } from '../lib/entryMeta'
import type { EntryCardActions } from './EntryCard'

// ─── 环境色调 ──────────────────────────────────────────────────────────────────

const ENV_BADGE: Record<GroupEnvironment, string> = {
  dev:     'bg-live/10 text-live/90 border border-live/20',
  sandbox: 'bg-warn/10 text-warn/90 border border-warn/20',
  prod:    'bg-fault/10 text-fault/90 border border-fault/20'
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
  const { patch: patchEntry } = useEntries((s) => ({ patch: s.edit }))
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

// ─── 主工作组面板 ──────────────────────────────────────────────────────────────

interface GroupPanelProps {
  actionsFor: (entry: LaunchEntry) => EntryCardActions
}

export function GroupsPanel({ actionsFor }: GroupPanelProps): React.JSX.Element {
  const { groups, add, patch, remove } = useGroups((s) => ({
    groups: s.groups, add: s.add, patch: s.patch, remove: s.remove
  }))
  const entries = useEntries((s) => s.entries)
  const runtimes = useEntries((s) => s.runtimes)
  const busy = useEntries((s) => s.busy)

  const [selectedId, setSelectedId] = useState<string | null>(() => groups[0]?.id ?? null)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [editingGroup, setEditingGroup] = useState<ProjectGroup | null>(null)
  const [assigningGroup, setAssigningGroup] = useState<ProjectGroup | null>(null)

  const selectedGroup = groups.find((g) => g.id === selectedId) ?? null

  const groupEntries = useMemo(
    () => (selectedGroup ? entries.filter((e) => e.groupId === selectedGroup.id) : []),
    [entries, selectedGroup]
  )

  const liveCount = useMemo(
    () => groupEntries.filter((e) => isLiveStatus(runtimes[e.id]?.status ?? 'idle')).length,
    [groupEntries, runtimes]
  )

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

  if (groups.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 py-16">
        <div className="flex h-14 w-14 items-center justify-center rounded-[14px] border-2 border-dashed border-line-strong/60">
          <FolderSimple size={26} className="text-ink-faint/40" />
        </div>
        <div className="text-center">
          <p className="text-[14px] font-semibold text-ink-strong">还没有工作组</p>
          <p className="mt-1 text-[12px] text-ink-faint">创建工作组，将相关前后端任务归集在一起</p>
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
      {/* ── 左侧：工作组列表 ── */}
      <div className="flex w-44 shrink-0 flex-col gap-1 overflow-y-auto">
        {groups
          .sort((a, b) => a.order - b.order)
          .map((g) => {
            const gEntries = entries.filter((e) => e.groupId === g.id)
            const gLive = gEntries.filter((e) => isLiveStatus(runtimes[e.id]?.status ?? 'idle')).length
            return (
              <button
                key={g.id}
                type="button"
                onClick={() => setSelectedId(g.id)}
                className={[
                  'pressable-flat flex min-w-0 flex-col rounded-[7px] border px-2.5 py-2 text-left transition-colors',
                  selectedId === g.id
                    ? 'border-accent/30 bg-accent/8'
                    : 'border-line bg-card hover:border-line-strong hover:bg-raised'
                ].join(' ')}
              >
                <span className="truncate text-[12px] font-semibold text-ink-strong">{g.name}</span>
                <div className="mt-1 flex items-center gap-1.5">
                  <span className={`rounded-[3px] px-1.5 font-mono text-[8.5px] font-medium ${ENV_BADGE[g.env]}`}>
                    {GROUP_ENV_LABEL[g.env]}
                  </span>
                  <span className="font-mono text-[8.5px] text-ink-faint/60">
                    {gEntries.length} 项
                    {gLive > 0 && <> · <span className="text-live/80">{gLive} 运行</span></>}
                  </span>
                </div>
              </button>
            )
          })}

        <button
          type="button"
          onClick={() => setShowCreateDialog(true)}
          className="pressable-flat mt-1 flex items-center gap-1.5 rounded-[6px] border border-dashed border-line px-2.5 py-2 text-[11.5px] text-ink-faint hover:border-line-strong hover:text-ink-muted"
        >
          <Plus size={11} weight="bold" aria-hidden />
          新建工作组
        </button>
      </div>

      {/* ── 右侧：工作组详情 ── */}
      <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto">
        {selectedGroup ? (
          <>
            {/* 工作组头部 */}
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-[14px] font-semibold text-ink-strong">{selectedGroup.name}</h2>
                  <span className={`shrink-0 rounded-[4px] px-1.5 py-0.5 font-mono text-[9px] font-medium ${ENV_BADGE[selectedGroup.env]}`}>
                    {GROUP_ENV_LABEL[selectedGroup.env]}
                  </span>
                </div>
                {selectedGroup.description && (
                  <p className="mt-0.5 text-[11.5px] text-ink-faint/70">{selectedGroup.description}</p>
                )}
                <p className="mt-1 font-mono text-[9.5px] text-ink-faint/50">
                  {groupEntries.length} 个条目 · {liveCount} 个运行中
                </p>
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

            {/* 条目列表 */}
            {groupEntries.length === 0 ? (
              <div className="flex flex-col items-center gap-3 rounded-[8px] border border-dashed border-line py-8">
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
              <div className="flex flex-col gap-1">
                {groupEntries.map((entry) => (
                  <EntryRow
                    key={entry.id}
                    entry={entry}
                    runtime={runtimes[entry.id] ?? { entryId: entry.id, status: 'idle', portUnknown: false }}
                    busy={!!busy[entry.id]}
                    actions={actionsFor(entry)}
                  />
                ))}
                <button
                  type="button"
                  onClick={() => setAssigningGroup(selectedGroup)}
                  className="pressable-flat mt-1 flex items-center gap-1.5 rounded-[5px] border border-dashed border-line px-2.5 py-1.5 text-[11.5px] text-ink-faint hover:border-line-strong hover:text-ink-muted"
                >
                  <Plus size={10} weight="bold" aria-hidden />
                  添加更多条目
                </button>
              </div>
            )}
          </>
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
