import { useEffect, useMemo, useState } from 'react'
import { GROUP_ENV_LABEL, orderGroups, type ProjectGroup } from '@shared/types'
import { boardStatus, localDate, pendingFires, taskDueTone, type PlannerBoard } from '@shared/planner'
import { Button, DialogShell, SplitPane } from '../components/ui'
import { BoardTile } from '../components/planner/BoardTile'
import { BoardDetail, type BoardTab } from '../components/planner/BoardDetail'
import { MissedBar } from '../components/planner/MissedBar'
import { usePlanner } from '../store/planner'
import { useGroups } from '../store/groups'
import { ICON } from '../lib/icons'

const SEL_KEY = 'mile.planner.selected'
const TAB_KEY = 'mile.planner.tab'
const TABS: BoardTab[] = ['tasks', 'schedules', 'overview']

function readTab(): BoardTab {
  try {
    const v = localStorage.getItem(TAB_KEY)
    return TABS.includes(v as BoardTab) ? (v as BoardTab) : 'tasks'
  } catch {
    return 'tasks'
  }
}

/**
 * 进度页（docs/PRD-PLANNER.md P1）。看板挂在已有工作组上，用户手动加进来。
 * 布局与服务页同族：工具栏、今日条、看板列表 ⇄ 列表 + 详情分栏。
 * 只读写 planner.json，不碰任何启停、命令、进程。
 */
export function Planner({
  onGoServices,
  focus,
  onFocusConsumed
}: {
  onGoServices: () => void
  focus?: { boardId: string; taskId?: string; tab?: BoardTab; nonce: number } | null
  onFocusConsumed?: () => void
}): React.JSX.Element {
  const boards = usePlanner((s) => s.boards)
  const readOnly = usePlanner((s) => s.readOnly)
  const loaded = usePlanner((s) => s.loaded)
  const error = usePlanner((s) => s.error)
  const clearError = usePlanner((s) => s.clearError)
  const addBoard = usePlanner((s) => s.addBoard)
  const groups = useGroups((s) => s.groups)

  // 跨午夜时「今天」要跟着变：每分钟对一次
  const [today, setToday] = useState(localDate)
  useEffect(() => {
    const t = setInterval(() => setToday(localDate()), 60_000)
    return () => clearInterval(t)
  }, [])

  const [selectedId, setSelectedId] = useState<string | null>(() => {
    try { return localStorage.getItem(SEL_KEY) } catch { return null }
  })
  const [tab, setTabState] = useState<BoardTab>(readTab)
  const [maximized, setMaximized] = useState(false)
  const [adding, setAdding] = useState(false)

  const setTab = (t: BoardTab): void => {
    setTabState(t)
    try { localStorage.setItem(TAB_KEY, t) } catch { /* 记不住标签不影响使用 */ }
  }
  const select = (id: string | null): void => {
    setSelectedId(id)
    if (id === null) setMaximized(false)
    try {
      if (id) localStorage.setItem(SEL_KEY, id)
      else localStorage.removeItem(SEL_KEY)
    } catch { /* 无害 */ }
  }

  // 看板顺序跟工作组走（置顶在前，与服务页同一个 orderGroups）；工作组已删除的排最后
  const ordered = useMemo(() => {
    const rank = new Map(orderGroups(groups).map((g, i) => [g.id, i]))
    return [...boards].sort(
      (a, b) => (rank.get(a.groupId) ?? 1e6 + a.order) - (rank.get(b.groupId) ?? 1e6 + b.order)
    )
  }, [boards, groups])

  const groupOf = (b: PlannerBoard): ProjectGroup | undefined => groups.find((g) => g.id === b.groupId)
  const available = useMemo(
    () => orderGroups(groups).filter((g) => !boards.some((b) => b.groupId === g.id)),
    [groups, boards]
  )

  const selected = selectedId ? boards.find((b) => b.id === selectedId) : undefined
  // 选中的看板被移除后关掉详情
  useEffect(() => {
    if (loaded && selectedId && !boards.some((b) => b.id === selectedId)) select(null)
  }, [loaded, boards, selectedId])

  // 通知点击 / 提醒卡片定位（P2）：打开对应看板与标签；nonce 让同一目标能重复触发
  useEffect(() => {
    if (!focus || !loaded) return
    if (!boards.some((b) => b.id === focus.boardId)) {
      onFocusConsumed?.()
      return
    }
    select(focus.boardId)
    if (focus.tab) setTab(focus.tab)
    onFocusConsumed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce, loaded])

  // Esc：先退出最大化，再关详情
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const t = e.target as HTMLElement | null
      if (t?.closest('input, textarea, select, [role="dialog"], [role="menu"]')) return
      if (maximized) { e.preventDefault(); setMaximized(false) }
      else if (selectedId) { e.preventDefault(); select(null) }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [maximized, selectedId])

  // 今日条：今天该弹的提醒、今天到期的任务、已超期的看板
  const todayInfo = useMemo(() => {
    let dueToday = 0
    let overdueTasks = 0
    let reminders = 0
    let firstDueBoard: string | null = null
    let firstRemindBoard: string | null = null
    const dayStart = new Date(`${today}T00:00:00`).getTime()
    const dayEnd = dayStart + 86_400_000
    const now = Date.now()
    for (const b of boards) {
      for (const t of b.tasks) {
        const tone = taskDueTone(t, today)
        if (tone === 'today') { dueToday++; firstDueBoard ??= b.id }
        if (tone === 'overdue') overdueTasks++
      }
      for (const s of b.schedules) {
        // 「今天 N 条提醒」只算还没弹过的；弹过的不重复计数
        const upcoming = pendingFires(s, Math.max(now, dayStart), dayEnd)
        if (upcoming.length > 0) { reminders += upcoming.length; firstRemindBoard ??= b.id }
      }
    }
    const overdueBoards = boards.filter((b) => boardStatus(b, today).tone === 'overdue')
    return { dueToday, overdueTasks, reminders, firstDueBoard, firstRemindBoard, overdueBoards }
  }, [boards, today])

  const submitAdd = async (groupId: string): Promise<void> => {
    const board = await addBoard(groupId)
    setAdding(false)
    if (board) {
      select(board.id)
      setTab('tasks')
    }
  }

  const addButton = (
    <Button
      variant="primary"
      icon={ICON.add}
      disabled={readOnly || available.length === 0}
      title={available.length === 0 ? (groups.length === 0 ? '先在服务页新建工作组' : '所有工作组都已加入') : undefined}
      onClick={() => setAdding(true)}
      data-planner-add
    >
      添加工作组
    </Button>
  )

  const list =
    ordered.length === 0 ? (
      <div className="ui-tile pl-empty" data-planner-empty>
        <span className="pl-empty-icon" aria-hidden><ICON.planner size={20} /></span>
        <p className="pl-empty-title">还没有看板</p>
        <p className="pl-empty-text">把一个工作组加进来，开始记录进度和日程</p>
        {groups.length === 0 ? (
          <Button variant="primary" icon={ICON.navServices} onClick={onGoServices}>去服务页新建工作组</Button>
        ) : (
          addButton
        )}
      </div>
    ) : (
      <div className="pl-boards" data-planner-boards>
        {ordered.map((b) => (
          <BoardTile
            key={b.id}
            board={b}
            group={groupOf(b)}
            selected={b.id === selectedId}
            today={today}
            onOpen={() => select(b.id)}
          />
        ))}
      </div>
    )

  const hasToday =
    todayInfo.dueToday > 0 || todayInfo.overdueTasks > 0 || todayInfo.reminders > 0 || todayInfo.overdueBoards.length > 0

  return (
    <div className="pl-page flex min-h-0 flex-1 flex-col gap-4" data-planner-page>
      {readOnly && (
        <div role="alert" className="ui-tile svc-empty-row" data-tone="fault" data-planner-readonly>
          <p>进度数据文件读不出来，这次运行不会保存任何改动，以免覆盖原文件。</p>
        </div>
      )}
      {error && (
        <div role="alert" className="ui-tile svc-empty-row" data-tone="fault" data-planner-error>
          <p>{error}</p>
          <Button size="sm" onClick={clearError}>知道了</Button>
        </div>
      )}

      <MissedBar today={today} onFocusBoard={(id) => { select(id); setTab('schedules') }} />

      {ordered.length > 0 && (
        <div className="pl-toolbar">
          <span className="pl-toolbar-count">{ordered.length} 块看板</span>
          <div className="pl-toolbar-acts">{addButton}</div>
        </div>
      )}

      {hasToday && (
        <div className="pl-today" data-planner-today role="status">
          <ICON.reminder size={16} aria-hidden className="pl-today-icon" />
          <span className="pl-today-label">今天</span>
          {todayInfo.reminders > 0 && (
            <button
              type="button"
              className="pl-today-item"
              data-today="reminders"
              onClick={() => { if (todayInfo.firstRemindBoard) { select(todayInfo.firstRemindBoard); setTab('schedules') } }}
            >
              {todayInfo.reminders} 条提醒
            </button>
          )}
          {todayInfo.dueToday > 0 && (
            <button
              type="button"
              className="pl-today-item"
              data-today="due"
              onClick={() => { if (todayInfo.firstDueBoard) { select(todayInfo.firstDueBoard); setTab('tasks') } }}
            >
              {todayInfo.dueToday} 项任务今天到期
            </button>
          )}
          {todayInfo.overdueTasks > 0 && (
            <span className="pl-today-item" data-today="overdue-tasks" data-tone="fault">
              {todayInfo.overdueTasks} 项任务已过截止日期
            </span>
          )}
          {todayInfo.overdueBoards.length > 0 && (
            <button
              type="button"
              className="pl-today-item"
              data-today="overdue-boards"
              data-tone="fault"
              onClick={() => { select(todayInfo.overdueBoards[0].id); setTab('overview') }}
            >
              {todayInfo.overdueBoards.length} 块看板已超期
            </button>
          )}
        </div>
      )}

      <SplitPane
        storageKey="mile.planner.listW"
        listLabel="看板列表"
        maximized={maximized}
        list={list}
        detail={
          selected ? (
            <BoardDetail
              key={selected.id}
              board={selected}
              group={groupOf(selected)}
              groups={groups}
              boards={boards}
              today={today}
              tab={tab}
              onTab={setTab}
              maximized={maximized}
              onToggleMax={() => setMaximized((v) => !v)}
              onClose={() => select(null)}
              readOnly={readOnly}
            />
          ) : undefined
        }
      />

      {adding && (
        <DialogShell
          title="添加工作组"
          icon={<ICON.planner size={20} />}
          onClose={() => setAdding(false)}
          dataset={{ plannerAddDialog: '' }}
          width={440}
        >
          <p className="pl-dialog-hint">只列出还没有看板的工作组。工作组在服务页里新建和管理。</p>
          <ul className="pl-pick" aria-label="可添加的工作组">
            {available.map((g) => (
              <li key={g.id}>
                <button type="button" className="pl-pick-item" data-pick-group={g.id} onClick={() => void submitAdd(g.id)}>
                  <ICON.group size={16} aria-hidden />
                  <span className="pl-pick-name">{g.name}</span>
                  {g.pinned && <span className="svc-pinned"><ICON.pin size={12} aria-hidden />置顶</span>}
                  <span className="svc-env" data-env={g.env}>{GROUP_ENV_LABEL[g.env]}</span>
                </button>
              </li>
            ))}
          </ul>
        </DialogShell>
      )}
    </div>
  )
}
