import { useEffect, useState } from 'react'
import type { ProjectGroup } from '@shared/types'
import { GROUP_ENV_LABEL, orderGroups } from '@shared/types'
import { NOTE_MAX, boardStatus, isValidDate, type PlannerBoard } from '@shared/planner'
import { Button, IconButton, Pill, Select, Tabs, tabPanelProps, confirm, type TabItem } from '../ui'
import { ICON } from '../../lib/icons'
import { usePlanner } from '../../store/planner'
import { BOARD_PILL, ProgressBar } from './BoardTile'
import { TaskList } from './TaskList'
import { ScheduleList } from './ScheduleList'

export type BoardTab = 'tasks' | 'schedules' | 'overview'

const ID_BASE = 'pl-detail'

/**
 * 看板详情（PRD-PLANNER §4.2）：任务 / 日程 / 概况三个标签。
 * 日程在 P2 开放，P1 先放说明，不留空白标签。
 */
export function BoardDetail({
  board,
  group,
  groups,
  boards,
  today,
  tab,
  onTab,
  maximized,
  onToggleMax,
  onClose,
  readOnly
}: {
  board: PlannerBoard
  group?: ProjectGroup
  groups: ProjectGroup[]
  boards: PlannerBoard[]
  today: string
  tab: BoardTab
  onTab: (t: BoardTab) => void
  maximized: boolean
  onToggleMax: () => void
  onClose: () => void
  readOnly: boolean
}): React.JSX.Element {
  const status = boardStatus(board, today)
  const name = group?.name ?? '工作组已删除'
  const items: TabItem<BoardTab>[] = [
    { id: 'tasks', label: '任务', icon: ICON.taskDone, badge: board.tasks.filter((t) => t.status === 'todo' || t.status === 'doing').length || undefined },
    { id: 'schedules', label: '日程', icon: ICON.reminder },
    { id: 'overview', label: '概况', icon: ICON.overview }
  ]

  return (
    <section className="ui-tile svc-detail pl-detail" aria-label={`${name} 进度详情`} data-board-detail={board.id}>
      <div className="svc-detail-head">
        <ICON.planner size={20} aria-hidden className="pl-board-icon" />
        <div className="min-w-0">
          <h2 className="svc-detail-title">{name}</h2>
          <div className="svc-detail-meta">
            {group ? (
              <span className="svc-env" data-env={group.env}>{GROUP_ENV_LABEL[group.env]}</span>
            ) : (
              <Pill tone="fault">工作组已删除</Pill>
            )}
            {status.label && <Pill tone={BOARD_PILL[status.tone]}>{status.label}</Pill>}
          </div>
        </div>
        <div className="svc-detail-actions">
          <IconButton icon={maximized ? ICON.restore : ICON.maximize} label={maximized ? '还原分栏' : '最大化'} onClick={onToggleMax} />
          <IconButton icon={ICON.close} label="关闭详情" onClick={onClose} />
        </div>
      </div>
      <div className="pl-detail-progress">
        <ProgressBar board={board} />
      </div>

      <div className="svc-detail-tabs">
        <Tabs items={items} value={tab} onChange={onTab} idBase={ID_BASE} label="看板详情" />
      </div>

      <div className="svc-detail-body" {...tabPanelProps(ID_BASE, tab)}>
        {tab === 'tasks' && <TaskList board={board} readOnly={readOnly} />}
        {tab === 'schedules' && <ScheduleList board={board} readOnly={readOnly} />}
        {tab === 'overview' && (
          <Overview key={board.id} board={board} group={group} groups={groups} boards={boards} readOnly={readOnly} onRemoved={onClose} />
        )}
      </div>
    </section>
  )
}

function Overview({
  board,
  group,
  groups,
  boards,
  readOnly,
  onRemoved
}: {
  board: PlannerBoard
  group?: ProjectGroup
  groups: ProjectGroup[]
  boards: PlannerBoard[]
  readOnly: boolean
  onRemoved: () => void
}): React.JSX.Element {
  const editBoard = usePlanner((s) => s.editBoard)
  const removeBoard = usePlanner((s) => s.removeBoard)
  const reassignBoard = usePlanner((s) => s.reassignBoard)
  const error = usePlanner((s) => s.error)
  const [start, setStart] = useState(board.startDate ?? '')
  const [end, setEnd] = useState(board.endDate ?? '')
  const [note, setNote] = useState(board.note ?? '')
  const [saving, setSaving] = useState(false)
  const [target, setTarget] = useState('')

  // 别处改了同一块看板（广播整份替换）时，输入框跟上最新值
  useEffect(() => {
    setStart(board.startDate ?? '')
    setEnd(board.endDate ?? '')
    setNote(board.note ?? '')
  }, [board.startDate, board.endDate, board.note])

  const dirty = start !== (board.startDate ?? '') || end !== (board.endDate ?? '') || note !== (board.note ?? '')
  const rangeBad = !!start && !!end && isValidDate(start) && isValidDate(end) && end < start
  const used = new Set(boards.filter((b) => b.id !== board.id).map((b) => b.groupId))
  const free = orderGroups(groups).filter((g) => !used.has(g.id))

  const save = async (): Promise<void> => {
    setSaving(true)
    await editBoard(board.id, { startDate: start || null, endDate: end || null, note: note.trim() ? note : null })
    setSaving(false)
  }

  return (
    <div className="pl-overview" data-board-overview>
      <div className="pl-form">
        <label className="ui-field">
          <span className="ui-field-label">开始日期</span>
          <input type="date" data-board-start className="ui-input" data-mono value={start} disabled={readOnly} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label className="ui-field">
          <span className="ui-field-label">预计结束日期</span>
          <input type="date" data-board-end className="ui-input" data-mono value={end} min={start || undefined} disabled={readOnly} aria-invalid={rangeBad || undefined} onChange={(e) => setEnd(e.target.value)} />
          {rangeBad && <span className="ui-field-error" role="alert">预计结束日期不能早于开始日期</span>}
        </label>
        <label className="ui-field" style={{ gridColumn: '1 / -1' }}>
          <span className="ui-field-label">备注</span>
          <textarea data-board-note className="ui-input pl-note" rows={4} maxLength={NOTE_MAX} value={note} disabled={readOnly} placeholder="这个项目的目标、范围或要注意的事" onChange={(e) => setNote(e.target.value)} />
          <span className="ui-field-hint">{note.length} / {NOTE_MAX}</span>
        </label>
      </div>
      {error && <p className="ui-field-error" role="alert">{error}</p>}
      <div className="pl-overview-acts">
        <Button variant="primary" icon={ICON.check} disabled={readOnly || !dirty || rangeBad || saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存'}
        </Button>
        {dirty && (
          <Button onClick={() => { setStart(board.startDate ?? ''); setEnd(board.endDate ?? ''); setNote(board.note ?? '') }}>放弃改动</Button>
        )}
      </div>

      {!group && (
        <div className="pl-reassign" data-board-orphan>
          <p>原来的工作组已被删除，任务和备注都还在。可以改挂到另一个还没有看板的工作组。</p>
          <div className="flex items-center gap-2">
            <Select aria-label="改挂到工作组" value={target} disabled={readOnly || free.length === 0} onChange={(e) => setTarget(e.target.value)}>
              <option value="">{free.length ? '选择工作组' : '没有可改挂的工作组'}</option>
              {free.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </Select>
            <Button disabled={readOnly || !target} onClick={() => void reassignBoard(board.id, target).then(() => setTarget(''))}>改挂</Button>
          </div>
        </div>
      )}

      <div className="pl-danger">
        <Button
          variant="danger"
          icon={ICON.remove}
          disabled={readOnly}
          onClick={() =>
            void confirm({
              title: `移除「${group?.name ?? '这块看板'}」的看板？`,
              body: `看板里的 ${board.tasks.length} 项任务和备注会一起删除，工作组本身不受影响。`,
              okLabel: '移除看板',
              danger: true
            }).then(async (ok) => {
              if (ok && (await removeBoard(board.id))) onRemoved()
            })
          }
        >
          移除看板
        </Button>
      </div>
    </div>
  )
}
