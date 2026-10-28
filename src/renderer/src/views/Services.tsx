import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EntryKind, EntryRuntime, LaunchEntry, NewLaunchEntry, ProjectGroup } from '@shared/types'
import { GROUP_ENV_LABEL } from '@shared/types'
import { Button, Segmented, Select, TextInput, SplitPane, toast, type MenuItem } from '../components/ui'
import { GroupTile, type RowActions } from '../components/services/GroupTile'
import { EntryDetail, effectiveTab, hasBuildTab, type DetailTab } from '../components/services/EntryDetail'
import { hasOpenOverlay } from '../lib/overlay'
import { AddEntryDialog } from '../components/AddEntryDialog'
import { AssignGroupDialog, GroupDialog } from '../components/services/GroupDialogs'
import { useEntries } from '../store/entries'
import { useGroups } from '../store/groups'
import { useEntryFix } from '../lib/useEntryFix'
import { ICON } from '../lib/icons'
import { isLiveStatus } from '../lib/entryMeta'
import {
  classOf,
  forceStop,
  isGroupStartable,
  matchesQuery,
  openOutput,
  removeEntry,
  startEntry,
  startGroup,
  stopGroup,
  matchesStatus,
  type ClassFilter,
  type StatusFilter
} from '../lib/services'
import { confirm } from '../components/ui'

const TAB_KEY = 'mile.services.tab'
const SEL_KEY = 'mile.services.selected'
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
  onPendingKindConsumed,
  focus
}: {
  onOpenLogs: (sessionId: string) => void
  pendingAdd?: { path: string; name: string } | null
  onPendingConsumed?: () => void
  pendingKind?: EntryKind | null
  onPendingKindConsumed?: () => void
  /** 外部要求打开某个服务的某个标签（失败通知、命令面板、总览）。nonce 变化才触发，同一请求不重复执行 */
  focus?: { id: string; tab: DetailTab; nonce: number } | null
}): React.JSX.Element {
  const entries = useEntries((s) => s.entries)
  const runtimes = useEntries((s) => s.runtimes)
  const error = useEntries((s) => s.error)
  const clearError = useEntries((s) => s.clearError)
  const add = useEntries((s) => s.add)
  const edit = useEntries((s) => s.edit)
  const reorder = useEntries((s) => s.reorder)
  const stop = useEntries((s) => s.stop)
  const restart = useEntries((s) => s.restart)
  const groups = useGroups((s) => s.groups)
  const addGroup = useGroups((s) => s.add)
  const patchGroup = useGroups((s) => s.patch)
  const removeGroup = useGroups((s) => s.remove)

  const [filter, setFilter] = useState<ClassFilter>('all')
  const [statusF, setStatusF] = useState<StatusFilter>('all')
  const [q, setQ] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tab, setTabState] = useState<DetailTab>(readTab)
  const [maximized, setMaximized] = useState(false)
  const [failedId, setFailedId] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [addDialog, setAddDialog] = useState<{ kind: EntryKind; path?: string; name?: string; groupId?: string } | null>(null)
  /** 配置标签有未保存改动（Q13）：切换服务、关闭详情前先确认 */
  const [dirty, setDirty] = useState(false)
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

  // 选中的服务跨重启恢复。写入的 effect 必须排在恢复 effect 之前：同一次提交里
  // 恢复还没生效，先写会把存的 id 覆盖成 null
  const selRestored = useRef(false)
  useEffect(() => {
    if (!selRestored.current) return
    try {
      if (selectedId) localStorage.setItem(SEL_KEY, selectedId)
      else localStorage.removeItem(SEL_KEY)
    } catch { /* 记不住选中项不影响使用 */ }
  }, [selectedId])
  useEffect(() => {
    // 启动时条目还没加载完，等到有条目再恢复一次；之后不再介入
    if (selRestored.current || entries.length === 0) return
    selRestored.current = true
    const id = localStorage.getItem(SEL_KEY)
    if (id && entries.some((e) => e.id === id)) {
      setSelectedId(id)
      setCursorId(id)
    }
  }, [entries])

  // 选中的条目被移除后关掉详情
  useEffect(() => {
    if (selectedId && !entries.some((e) => e.id === selectedId)) {
      setSelectedId(null)
      setMaximized(false)
      setDirty(false)
    }
  }, [entries, selectedId])

  const counts = useMemo(() => {
    const c = { all: entries.length, fe: 0, be: 0, task: 0 }
    for (const e of entries) c[classOf(e)]++
    return c
  }, [entries])

  const visible = useCallback(
    (e: LaunchEntry) =>
      (filter === 'all' || classOf(e) === filter) && matchesStatus(runtimes[e.id], statusF) && matchesQuery(e, runtimes[e.id], q),
    [filter, statusF, q, runtimes]
  )
  const filtering = filter !== 'all' || statusF !== 'all' || q.trim() !== ''

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

  /** 换工作组。groupId 不是身份字段，运行中也能改；null = 移出到未分组 */
  function moveEntry(id: string, groupId: string | null): void {
    const entry = entries.find((e) => e.id === id)
    if (!entry || (entry.groupId ?? null) === groupId) return
    const target = groupId ? groups.find((g) => g.id === groupId)?.name : '未分组'
    void edit(id, { groupId }).then((ok) => {
      if (ok) toast({ tone: 'live', title: `已把「${entry.name}」移到「${target ?? '工作组'}」` })
    })
  }

  /**
   * 放到另一行的前面或后面。目标在别的组时先换组再排位。
   * 主进程 reorder 收的是完整 id 序列（没列出的会被推到末尾），所以这里排的是全部条目。
   */
  function placeEntry(dragId: string, targetId: string, before: boolean): void {
    if (dragId === targetId) return
    const drag = entries.find((e) => e.id === dragId)
    const target = entries.find((e) => e.id === targetId)
    if (!drag || !target) return
    const ids = [...entries].sort((a, b) => a.order - b.order).map((e) => e.id).filter((id) => id !== dragId)
    const at = ids.indexOf(targetId) + (before ? 0 : 1)
    ids.splice(at, 0, dragId)
    const sameGroup = (drag.groupId ?? null) === (target.groupId ?? null)
    void (async () => {
      if (!sameGroup && !(await edit(dragId, { groupId: target.groupId ?? null }))) return
      await reorder(ids)
      if (!sameGroup) {
        const name = target.groupId ? groups.find((g) => g.id === target.groupId)?.name : '未分组'
        toast({ tone: 'live', title: `已把「${drag.name}」移到「${name ?? '工作组'}」` })
      }
    })()
  }

  /** 上移 / 下移：拖拽的键盘替代，只在本组成员之间换位 */
  function shiftEntry(entry: LaunchEntry, dir: -1 | 1): void {
    const sib = entries.filter((e) => (e.groupId ?? null) === (entry.groupId ?? null)).sort((a, b) => a.order - b.order)
    const i = sib.findIndex((e) => e.id === entry.id)
    const other = sib[i + dir]
    if (!other) return
    placeEntry(entry.id, other.id, dir < 0)
    // 读屏播报新位置（旧卡片有，合并时保留）
    setAnnounce(`「${entry.name}」已移到第 ${i + dir + 1} 位，共 ${sib.length} 项`)
  }

  const flashFail = (id: string): void => {
    setFailedId(id)
    window.setTimeout(() => setFailedId((cur) => (cur === id ? null : cur)), 420)
  }

  /** 换选中（或关闭详情）。配置有未保存改动时先确认，取消则留在原处 */
  const pick = async (id: string | null): Promise<boolean> => {
    if (dirty && id !== selectedId) {
      const ok = await confirm({
        title: '放弃未保存的改动？',
        body: '当前服务的配置改了还没保存，离开后这些改动会丢失。',
        okLabel: '放弃改动',
        danger: true
      })
      if (!ok) return false
      setDirty(false)
    }
    setSelectedId(id)
    if (id === null) setMaximized(false)
    return true
  }
  const pickTab = (id: string, t: DetailTab): void => {
    void pick(id).then((ok) => ok && setTab(t))
  }

  // 外部定位请求：只认 nonce，等条目加载到了再执行
  const focusDone = useRef(0)
  useEffect(() => {
    if (!focus || focus.nonce === focusDone.current) return
    if (!entries.some((e) => e.id === focus.id)) return
    focusDone.current = focus.nonce
    setCursorId(focus.id)
    void pick(focus.id).then((ok) => {
      if (!ok) return
      setTab(focus.tab)
      if (focus.tab === 'diagnose') setRefreshKey((n) => n + 1)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, entries])

  const openDiagnose = (entry: LaunchEntry): void => {
    void pick(entry.id).then((ok) => {
      if (!ok) return
      setTab('diagnose')
      setRefreshKey((n) => n + 1)
    })
  }

  const toggle = async (entry: LaunchEntry): Promise<void> => {
    const rt = runtimes[entry.id]
    // 停止中再按一次不能再发一次 stop：行按钮此时是禁用的，键盘路径要守同一条规则
    if (rt?.status === 'stopping') return
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
      { label: '查看输出', icon: ICON.output, onSelect: () => pickTab(entry.id, 'output') },
      { label: '诊断', icon: ICON.diagnose, onSelect: () => openDiagnose(entry) },
      { label: '配置', icon: ICON.config, onSelect: () => pickTab(entry.id, 'config') },
      { label: '打开目录', icon: ICON.openFolder, onSelect: () => window.mile.shell.openPath(entry.path) },
      { label: '查看产物', icon: ICON.artifact, onSelect: () => openOutput(entry, rt) }
    )
    if (entry.framework === 'uniapp') {
      items.push({ label: '用 HBuilderX 打开', icon: ICON.openExternal, onSelect: () => void window.mile.entry.openInHBuilderX(entry.id) })
    }
    const sib = entries.filter((e) => (e.groupId ?? null) === (entry.groupId ?? null)).sort((a, b) => a.order - b.order)
    const pos = sib.findIndex((e) => e.id === entry.id)
    items.push(
      { sep: true },
      { label: '上移', icon: ICON.moveUp, disabled: pos <= 0, onSelect: () => shiftEntry(entry, -1) },
      { label: '下移', icon: ICON.moveDown, disabled: pos < 0 || pos >= sib.length - 1, onSelect: () => shiftEntry(entry, 1) }
    )
    // 拖拽的键盘替代：移到其他工作组 / 移出到未分组
    const targets = groups.filter((g) => g.id !== entry.groupId)
    if (targets.length || entry.groupId) items.push({ sep: true })
    for (const g of targets) {
      items.push({ label: `移到「${g.name}」`, icon: ICON.group, onSelect: () => moveEntry(entry.id, g.id) })
    }
    if (entry.groupId) items.push({ label: '移出到未分组', icon: ICON.group, onSelect: () => moveEntry(entry.id, null) })
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

  /*
   * 列表键盘操作（Q15）：方向键移动、Enter 打开详情、Space 启停（组头上是整组）、
   * Esc 先退出最大化再关详情、Ctrl+Tab 切标签。焦点在输入框、终端、按钮或自带方向键的
   * 控件（分段、标签、菜单、分隔条）里时让给它们；有浮层时浮层优先。
   */
  const [cursorId, setCursorId] = useState<string | null>(null)
  /** 排序结果给读屏播报（aria-live），视觉上隐藏 */
  const [announce, setAnnounce] = useState('')
  useEffect(() => {
    if (selectedId) setCursorId(selectedId)
  }, [selectedId])

  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keyRef.current = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || hasOpenOverlay() || e.altKey || e.metaKey) return
    const t = e.target as HTMLElement | null
    const typing = !!t?.closest('input, textarea, select, [contenteditable="true"], .xterm')
    const ownKeys = !!t?.closest('[role="tablist"], [role="radiogroup"], [role="menu"], [role="separator"]')

    // Ctrl+↑ / Ctrl+↓：在本组内移动光标所在的行（拖拽的键盘替代）
    if (e.ctrlKey && !typing && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && cursorId && !cursorId.startsWith('g:')) {
      const entry = entries.find((x) => x.id === cursorId)
      if (entry) { e.preventDefault(); shiftEntry(entry, e.key === 'ArrowUp' ? -1 : 1) }
      return
    }
    // 输入框里的 Ctrl+Tab 让给它：配置表单里切走标签会让人以为改动丢了
    if (e.ctrlKey && !typing && e.key === 'Tab' && selected) {
      e.preventDefault()
      const order: DetailTab[] = ['overview', 'output', 'diagnose', ...(hasBuildTab(selected) ? (['build'] as DetailTab[]) : []), 'config']
      const i = order.indexOf(effectiveTab(selected, tab))
      setTab(order[(i + (e.shiftKey ? -1 : 1) + order.length) % order.length])
      return
    }
    if (e.ctrlKey || typing) return

    if (e.key === 'Escape') {
      if (maximized) { e.preventDefault(); setMaximized(false) }
      else if (selectedId) { e.preventDefault(); void pick(null) }
      // 详情已关时再按 Esc 清掉键盘光标，回到「什么都没选」
      else if (cursorId) { e.preventDefault(); setCursorId(null) }
      return
    }
    if (ownKeys) return

    const nav: string[] = []
    for (const s of sections) {
      nav.push(`g:${s.group?.id ?? 'none'}`)
      for (const m of s.members) nav.push(m.id)
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!nav.length) return
      e.preventDefault()
      const i = cursorId ? nav.indexOf(cursorId) : -1
      const next = nav[i < 0 ? 0 : Math.min(nav.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]
      setCursorId(next)
      // 详情开着时跟着换服务（Q8）
      if (selectedId && !next.startsWith('g:')) void pick(next)
      document.querySelector(next.startsWith('g:') ? `[data-group-id="${next.slice(2)}"]` : `[data-entry-id="${next}"]`)?.scrollIntoView({ block: 'nearest' })
      return
    }
    // Enter / Space 落在按钮上时走按钮自己的点击，不重复触发
    if ((e.key === 'Enter' || e.key === ' ') && t?.closest('button, a[href]')) return
    if (e.key === 'Enter' && cursorId && !cursorId.startsWith('g:')) {
      e.preventDefault()
      void pick(cursorId)
      return
    }
    if (e.key === ' ' && cursorId) {
      e.preventDefault()
      if (cursorId.startsWith('g:')) {
        const sec = sections.find((s) => `g:${s.group?.id ?? 'none'}` === cursorId)
        if (!sec?.group) return
        const startable = sec.all.filter(isGroupStartable)
        const allOn = startable.length > 0 && startable.every((m) => runtimes[m.id]?.status === 'running')
        void (allOn ? stopGroup(sec.group, sec.all) : startGroup(sec.group, sec.all, { onBlocked: (b) => openDiagnose(b) }))
        return
      }
      const entry = entries.find((x) => x.id === cursorId)
      if (entry && !entry.registerOnly && entry.framework !== 'uniapp') void toggle(entry)
    }
  }
  useEffect(() => {
    const on = (e: KeyboardEvent): void => keyRef.current(e)
    document.addEventListener('keydown', on)
    return () => document.removeEventListener('keydown', on)
  }, [])

  const actions: RowActions = {
    select: (e) => { setCursorId(e.id); void pick(e.id) },
    toggle: (e) => void toggle(e),
    menu: rowMenu,
    move: (id, gid) => moveEntry(id, gid),
    place: (dragId, targetId, before) => placeEntry(dragId, targetId, before)
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


  const list = (
    <div className="svc-groups">
      {sections.length === 0 ? (
        <div className="ui-tile svc-empty-row" style={{ gridColumn: '1 / -1' }}>
          <p>{filtering ? '没有符合条件的服务' : '还没有服务。添加一个项目目录，识别框架后即可一键启动'}</p>
          {filtering ? (
            <Button onClick={() => { setQ(''); setFilter('all'); setStatusF('all') }}>清除筛选</Button>
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
            cursorId={cursorId}
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
      <p className="sr-only" role="status" aria-live="polite" data-sort-announce>{announce}</p>
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
        <Select aria-label="运行状态" className="svc-status" value={statusF} onChange={(e) => setStatusF(e.target.value as StatusFilter)}>
          <option value="all">全部状态</option>
          <option value="running">运行中</option>
          <option value="stopped">已停止</option>
          <option value="fault">异常</option>
        </Select>
        <div className="svc-search">
          <ICON.search size={16} aria-hidden />
          <TextInput
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="名称、分类、端口或路径"
            aria-label="搜索服务"
          />
        </div>
        <div className="svc-toolbar-acts">
          <Button icon={ICON.group} onClick={() => setGroupDialog({})}>新建工作组</Button>
          <Button variant="primary" icon={ICON.add} onClick={() => setAddDialog({ kind: 'service' })}>添加服务</Button>
        </div>
      </div>

      {/* 配置标签自己在面板内显示保存失败的原因，这里不重复 */}
      {error && !(selected && effectiveTab(selected, tab) === 'config') && (
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
              onClose={() => void pick(null)}
              onToggle={() => void toggle(selected)}
              failed={failedId === selected.id}
              categories={categories}
              onDirtyChange={setDirty}
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
