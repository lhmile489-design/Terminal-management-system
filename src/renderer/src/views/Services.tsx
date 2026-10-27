import { useCallback, useEffect, useMemo, useState } from 'react'
import type { EntryKind, EntryRuntime, LaunchEntry, NewLaunchEntry, ProjectGroup } from '@shared/types'
import { GROUP_ENV_LABEL } from '@shared/types'
import { Button, Segmented, TextInput, SplitPane, type MenuItem } from '../components/ui'
import { GroupTile, type RowActions } from '../components/services/GroupTile'
import { EntryDetail, effectiveTab, type DetailTab } from '../components/services/EntryDetail'
import { AddEntryDialog } from '../components/AddEntryDialog'
import { EditEntryDialog } from '../components/EditEntryDialog'
import { AssignGroupDialog, GroupDialog } from '../components/GroupsPanel'
import { useEntries } from '../store/entries'
import { useGroups } from '../store/groups'
import { useEntryFix } from '../lib/useEntryFix'
import { ICON } from '../lib/icons'
import { isLiveStatus } from '../lib/entryMeta'
import {
  classOf,
  forceStop,
  matchesQuery,
  openOutput,
  removeEntry,
  startEntry,
  startGroup,
  stopGroup,
  type ClassFilter
} from '../lib/services'
import { confirm } from '../components/ui'

const TAB_KEY = 'mile.services.tab'
const IDLE = (id: string): EntryRuntime => ({ entryId: id, status: 'idle', portUnknown: false })

function readTab(): DetailTab {
  const v = localStorage.getItem(TAB_KEY)
  return v === 'output' || v === 'diagnose' || v === 'build' || v === 'config' ? v : 'overview'
}

/**
 * 服务页，UI-REFACTOR §3.3：前端、后端、任务合在一个列表里，按工作组分段（Q10 / Q12），
 * 点成员打开右侧详情分栏（Q8），标签记住上次用的（Q20）。
 * 只做展示与交互：启停、确认、汇总通知走 lib/services，命令构造与归属校验都在主进程。
 */
export function Services({
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
  const error = useEntries((s) => s.error)
  const clearError = useEntries((s) => s.clearError)
  const add = useEntries((s) => s.add)
  const edit = useEntries((s) => s.edit)
  const stop = useEntries((s) => s.stop)
  const restart = useEntries((s) => s.restart)
  const groups = useGroups((s) => s.groups)
  const addGroup = useGroups((s) => s.add)
  const patchGroup = useGroups((s) => s.patch)
  const removeGroup = useGroups((s) => s.remove)

  const [filter, setFilter] = useState<ClassFilter>('all')
  const [q, setQ] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tab, setTabState] = useState<DetailTab>(readTab)
  const [maximized, setMaximized] = useState(false)
  const [failedId, setFailedId] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [addDialog, setAddDialog] = useState<{ kind: EntryKind; path?: string; name?: string; groupId?: string } | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [groupDialog, setGroupDialog] = useState<{ group?: ProjectGroup } | null>(null)
  const [assigning, setAssigning] = useState<ProjectGroup | null>(null)

  const { runFix, dialogs } = useEntryFix(useCallback(() => setRefreshKey((n) => n + 1), []))

  const setTab = (t: DetailTab): void => {
    setTabState(t)
    localStorage.setItem(TAB_KEY, t)
  }

  // 「发现未纳管服务」与命令面板发起的添加，沿用既有的识别对话框
  useEffect(() => {
    if (!pendingAdd) return
    setAddDialog({ kind: 'service', path: pendingAdd.path, name: pendingAdd.name })
    onPendingConsumed?.()
  }, [pendingAdd, onPendingConsumed])
  useEffect(() => {
    if (!pendingKind) return
    setAddDialog({ kind: pendingKind })
    onPendingKindConsumed?.()
  }, [pendingKind, onPendingKindConsumed])

  // 选中的条目被移除后关掉详情
  useEffect(() => {
    if (selectedId && !entries.some((e) => e.id === selectedId)) {
      setSelectedId(null)
      setMaximized(false)
    }
  }, [entries, selectedId])

  const counts = useMemo(() => {
    const c = { all: entries.length, fe: 0, be: 0, task: 0 }
    for (const e of entries) c[classOf(e)]++
    return c
  }, [entries])

  const visible = useCallback(
    (e: LaunchEntry) => (filter === 'all' || classOf(e) === filter) && matchesQuery(e, runtimes[e.id], q),
    [filter, q, runtimes]
  )
  const filtering = filter !== 'all' || q.trim() !== ''

  const sections = useMemo(() => {
    const sorted = [...groups].sort((a, b) => a.order - b.order)
    const byOrder = (a: LaunchEntry, b: LaunchEntry): number => a.order - b.order
    const out: { group: ProjectGroup | null; all: LaunchEntry[]; members: LaunchEntry[] }[] = sorted.map((g) => {
      const all = entries.filter((e) => e.groupId === g.id).sort(byOrder)
      return { group: g, all, members: all.filter(visible) }
    })
    const known = new Set(groups.map((g) => g.id))
    const loose = entries.filter((e) => !e.groupId || !known.has(e.groupId)).sort(byOrder)
    out.push({ group: null, all: loose, members: loose.filter(visible) })
    // 筛选时只留有命中的段；不筛选时空工作组也显示，方便往里加服务；空的「未分组」不显示
    return out.filter((s) => (filtering ? s.members.length > 0 : s.group !== null || s.all.length > 0))
  }, [groups, entries, visible, filtering])

  const selected = selectedId ? entries.find((e) => e.id === selectedId) : undefined
  const groupOf = (e: LaunchEntry): ProjectGroup | undefined => groups.find((g) => g.id === e.groupId)

  const flashFail = (id: string): void => {
    setFailedId(id)
    window.setTimeout(() => setFailedId((cur) => (cur === id ? null : cur)), 420)
  }

  const openDiagnose = (entry: LaunchEntry): void => {
    setSelectedId(entry.id)
    setTab('diagnose')
    setRefreshKey((n) => n + 1)
  }

  const toggle = async (entry: LaunchEntry): Promise<void> => {
    const rt = runtimes[entry.id]
    if (isLiveStatus(rt?.status ?? 'idle')) {
      await stop(entry.id)
      return
    }
    await startEntry(entry, groupOf(entry), {
      onBlocked: (e) => {
        flashFail(e.id)
        openDiagnose(e)
      }
    })
  }

  const rowMenu = (entry: LaunchEntry): MenuItem[] => {
    const rt = runtimes[entry.id] ?? IDLE(entry.id)
    const live = isLiveStatus(rt.status)
    const items: MenuItem[] = []
    if (entry.kind === 'service' && !entry.registerOnly && entry.framework !== 'uniapp') {
      items.push({
        label: '重启',
        icon: ICON.restart,
        disabled: !live,
        onSelect: () =>
          void restart(entry.id).then((blocked) => {
            if (blocked) openDiagnose(entry)
          })
      })
      items.push({ label: '强制关闭', icon: ICON.kill, disabled: !live, onSelect: () => void forceStop(entry) })
      items.push({ sep: true })
    }
    items.push(
      { label: '查看输出', icon: ICON.output, onSelect: () => { setSelectedId(entry.id); setTab('output') } },
      { label: '诊断', icon: ICON.diagnose, onSelect: () => openDiagnose(entry) },
      { label: '配置', icon: ICON.config, onSelect: () => { setSelectedId(entry.id); setTab('config') } },
      { label: '打开目录', icon: ICON.openFolder, onSelect: () => window.mile.shell.openPath(entry.path) },
      { label: '查看产物', icon: ICON.artifact, onSelect: () => openOutput(entry, rt) }
    )
    if (entry.framework === 'uniapp') {
      items.push({ label: '用 HBuilderX 打开', icon: ICON.openExternal, onSelect: () => void window.mile.entry.openInHBuilderX(entry.id) })
    }
    items.push(
      { sep: true },
      { label: '移除', icon: ICON.remove, danger: true, disabled: live, onSelect: () => void removeEntry(entry) }
    )
    return items
  }

  const groupMenu = (group: ProjectGroup, all: LaunchEntry[]): MenuItem[] => [
    { label: '添加服务到本组', icon: ICON.add, onSelect: () => setAddDialog({ kind: 'service', groupId: group.id }) },
    { label: '管理成员', icon: ICON.group, onSelect: () => setAssigning(group) },
    { label: '编辑工作组', icon: ICON.config, onSelect: () => setGroupDialog({ group }) },
    { label: '全部停止', icon: ICON.stop, disabled: !all.some((e) => isLiveStatus(runtimes[e.id]?.status ?? 'idle')), onSelect: () => void stopGroup(group, all) },
    { sep: true },
    ...(['dev', 'sandbox', 'prod'] as const).map((env) => ({
      label: `环境：${GROUP_ENV_LABEL[env]}`,
      checked: group.env === env,
      onSelect: () => void patchGroup(group.id, { env })
    })),
    { sep: true },
    {
      label: '删除工作组',
      icon: ICON.remove,
      danger: true,
      onSelect: () =>
        void confirm({
          title: `删除工作组「${group.name}」？`,
          body: '组内条目不会被删除，会回到「未分组」。',
          okLabel: '删除工作组',
          danger: true
        }).then(async (ok) => {
          if (ok) await removeGroup(group.id)
        })
    }
  ]

  const actions: RowActions = {
    select: (e) => setSelectedId((cur) => (cur === e.id ? cur : e.id)),
    toggle: (e) => void toggle(e),
    menu: rowMenu
  }

  const categories = useMemo(
    () => [...new Set(entries.map((e) => e.category).filter((c): c is string => !!c))],
    [entries]
  )

  const submitAdd = async (input: NewLaunchEntry, image?: ArrayBuffer): Promise<void> => {
    const entry = await add(input)
    if (!entry?.id) return
    if (image) await window.mile.entry.setImage(entry.id, image).catch(() => undefined)
    if (addDialog?.groupId) await edit(entry.id, { groupId: addDialog.groupId })
    // 添加完成后直接打开新条目的详情（UI-REFACTOR 默认做法）
    setSelectedId(entry.id)
    setTab('overview')
  }

  const editing = editingId ? entries.find((e) => e.id === editingId) : undefined

  const list = (
    <div className="svc-groups">
      {sections.length === 0 ? (
        <div className="ui-tile svc-empty-row" style={{ gridColumn: '1 / -1' }}>
          <p>{filtering ? '没有匹配的服务，换个关键字或切回「全部」' : '还没有服务。添加一个项目目录，识别框架后即可一键启动'}</p>
          {filtering ? (
            <Button onClick={() => { setQ(''); setFilter('all') }}>清除筛选</Button>
          ) : (
            <Button variant="primary" icon={ICON.add} onClick={() => setAddDialog({ kind: 'service' })}>添加服务</Button>
          )}
        </div>
      ) : (
        sections.map((s) => (
          <GroupTile
            key={s.group?.id ?? '_none'}
            group={s.group}
            members={s.members}
            all={s.all}
            runtimes={runtimes}
            selectedId={selectedId}
            cursorId={null}
            compact={!!selected}
            failedId={failedId}
            actions={actions}
            groupMenu={s.group ? groupMenu(s.group, s.all) : undefined}
            onStartGroup={s.group ? () => void startGroup(s.group as ProjectGroup, s.all, { onBlocked: (e) => openDiagnose(e) }) : undefined}
            onStopGroup={s.group ? () => void stopGroup(s.group as ProjectGroup, s.all) : undefined}
          />
        ))
      )}
    </div>
  )

  return (
    <div className="svc-page flex min-h-0 flex-1 flex-col gap-4" data-services-page>
      <div className="svc-toolbar">
        <Segmented
          label="类型"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: '全部', count: counts.all },
            { value: 'fe', label: '前端', count: counts.fe },
            { value: 'be', label: '后端', count: counts.be },
            { value: 'task', label: '任务', count: counts.task }
          ]}
        />
        <div className="svc-search">
          <ICON.search size={16} aria-hidden />
          <TextInput
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="名称、端口或路径"
            aria-label="搜索服务"
          />
        </div>
        <div className="svc-acts">
          <Button icon={ICON.group} onClick={() => setGroupDialog({})}>新建工作组</Button>
          <Button variant="primary" icon={ICON.add} onClick={() => setAddDialog({ kind: 'service' })}>添加服务</Button>
        </div>
      </div>

      {error && !editing && (
        <div role="alert" className="ui-tile svc-empty-row" data-tone="fault">
          <p>{error}</p>
          <Button size="sm" onClick={clearError}>知道了</Button>
        </div>
      )}

      <SplitPane
        storageKey="mile.services.listW"
        listLabel="服务列表"
        maximized={maximized}
        list={list}
        detail={
          selected ? (
            <EntryDetail
              key={selected.id}
              entry={selected}
              runtime={runtimes[selected.id] ?? IDLE(selected.id)}
              group={groupOf(selected)}
              tab={effectiveTab(selected, tab)}
              onTab={setTab}
              maximized={maximized}
              onToggleMax={() => setMaximized((v) => !v)}
              onClose={() => { setSelectedId(null); setMaximized(false) }}
              onToggle={() => void toggle(selected)}
              failed={failedId === selected.id}
              onEdit={() => { clearError(); setEditingId(selected.id) }}
              onOpenLogs={onOpenLogs}
              onFix={(action, port) => void runFix(selected.id, action, port)}
              refreshKey={refreshKey}
            />
          ) : undefined
        }
      />

      {addDialog && (
        <AddEntryDialog
          kind={addDialog.kind}
          initialPath={addDialog.path}
          initialName={addDialog.name}
          categories={categories}
          onSubmit={submitAdd}
          onClose={() => setAddDialog(null)}
        />
      )}
      {editing && (
        <EditEntryDialog
          entry={editing}
          runtime={runtimes[editing.id] ?? IDLE(editing.id)}
          categories={categories}
          error={error}
          onSubmit={(patch) => edit(editing.id, patch)}
          onStop={() => void stop(editing.id)}
          onClose={() => { setEditingId(null); clearError() }}
        />
      )}
      {groupDialog && (
        <GroupDialog
          initial={groupDialog.group}
          onSubmit={async (name, description, env) => {
            if (groupDialog.group) await patchGroup(groupDialog.group.id, { name, description: description || undefined, env })
            else await addGroup({ name, description: description || undefined, env })
            setGroupDialog(null)
          }}
          onClose={() => setGroupDialog(null)}
        />
      )}
      {assigning && <AssignGroupDialog group={assigning} entries={entries} onClose={() => setAssigning(null)} />}
      {dialogs}
    </div>
  )
}
