import { useEffect, useRef, useState } from 'react'
import {
  TASK_STATUS_LABEL,
  TASK_TITLE_MAX,
  NOTE_MAX,
  taskDueTone,
  type PlannerBoard,
  type PlannerTask,
  type PlannerTaskStatus
} from '@shared/planner'
import { Button, DialogShell, Field, MenuButton, Segmented, confirm, type MenuItem } from '../ui'
import { ICON } from '../../lib/icons'
import { primaryKey } from '../../lib/platform'
import { usePlanner } from '../../store/planner'
import { shortDate } from './BoardTile'

type Filter = 'all' | 'open' | 'done'

const STATUS_ICON: Record<PlannerTaskStatus, typeof ICON.taskTodo> = {
  todo: ICON.taskTodo,
  doing: ICON.taskDoing,
  done: ICON.taskDone,
  canceled: ICON.taskCanceled
}

/** 拖动任务排序用自己的 MIME，与服务页的条目、工作组拖拽互不干扰 */
const TASK_MIME = 'application/x-mile-task'

/**
 * 任务清单（PRD-PLANNER §4.4 / §4.6）。行高 44px，与服务页成员行同一节奏。
 * 状态按钮在待办与已完成之间切换；进行中、已取消从行菜单设。完成后行不消失。
 */
export function TaskList({ board, readOnly }: { board: PlannerBoard; readOnly: boolean }): React.JSX.Element {
  const editTask = usePlanner((s) => s.editTask)
  const removeTask = usePlanner((s) => s.removeTask)
  const reorderTasks = usePlanner((s) => s.reorderTasks)
  const addTask = usePlanner((s) => s.addTask)

  const [filter, setFilter] = useState<Filter>('all')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [dialogTask, setDialogTask] = useState<PlannerTask | null>(null)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ id: string; before: boolean } | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const addRef = useRef<HTMLInputElement>(null)
  const today = localToday()

  const tasks = [...board.tasks].sort((a, b) => a.order - b.order)
  const open = tasks.filter((t) => t.status === 'todo' || t.status === 'doing')
  const done = tasks.filter((t) => t.status === 'done')
  const shown = filter === 'open' ? open : filter === 'done' ? done : tasks

  useEffect(() => {
    if (adding) addRef.current?.focus()
  }, [adding])

  const move = (id: string, targetId: string, before: boolean): void => {
    if (id === targetId) return
    const ids = tasks.map((t) => t.id).filter((x) => x !== id)
    const at = ids.indexOf(targetId) + (before ? 0 : 1)
    ids.splice(at, 0, id)
    void reorderTasks(board.id, ids)
  }
  const shift = (task: PlannerTask, dir: -1 | 1): void => {
    const i = tasks.findIndex((t) => t.id === task.id)
    const other = tasks[i + dir]
    if (other) move(task.id, other.id, dir < 0)
  }
  const toggle = (t: PlannerTask): void => {
    void editTask(board.id, t.id, { status: t.status === 'done' ? 'todo' : 'done' })
  }

  const submitDraft = async (): Promise<void> => {
    const title = draft.trim()
    if (!title) {
      setAdding(false)
      return
    }
    if (await addTask(board.id, { title })) setDraft('')
    // 连续回车可以连加：保存后输入框留着、清空
    addRef.current?.focus()
  }

  const menu = (t: PlannerTask): MenuItem[] => {
    const i = tasks.findIndex((x) => x.id === t.id)
    return [
      { label: '编辑', icon: ICON.config, onSelect: () => setDialogTask(t) },
      { sep: true },
      ...(['todo', 'doing', 'done', 'canceled'] as const).map((s) => ({
        label: `标为${TASK_STATUS_LABEL[s]}`,
        checked: t.status === s,
        onSelect: () => void editTask(board.id, t.id, { status: s })
      })),
      { sep: true },
      { label: '上移', icon: ICON.moveUp, disabled: i <= 0, onSelect: () => shift(t, -1) },
      { label: '下移', icon: ICON.moveDown, disabled: i >= tasks.length - 1, onSelect: () => shift(t, 1) },
      { sep: true },
      {
        label: '删除任务',
        icon: ICON.remove,
        danger: true,
        onSelect: () =>
          void confirm({ title: `删除任务「${t.title}」？`, body: '删除后不能恢复。', okLabel: '删除', danger: true }).then(
            (ok) => ok && void removeTask(board.id, t.id)
          )
      }
    ]
  }

  const onListKey = (e: React.KeyboardEvent): void => {
    const target = e.target as HTMLElement
    if (target.closest('input, textarea, [role="menu"]')) return
    const visible = shown.map((t) => t.id)
    if (!visible.length) return
    const i = cursor ? visible.indexOf(cursor) : -1
    const cur = shown.find((t) => t.id === cursor)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (primaryKey(e) && cur) {
        shift(cur, e.key === 'ArrowUp' ? -1 : 1)
        return
      }
      const next = visible[Math.min(visible.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))] ?? visible[0]
      setCursor(next)
      document.querySelector<HTMLElement>(`[data-task-id="${next}"]`)?.focus()
      return
    }
    if (!cur || readOnly) return
    if (e.key === ' ' && !target.closest('button')) {
      e.preventDefault()
      toggle(cur)
    } else if (e.key === 'Enter' && !target.closest('button')) {
      e.preventDefault()
      setEditingId(cur.id)
    }
  }

  return (
    <div className="pl-tasks" data-task-list>
      <div className="pl-tasks-bar">
        <Segmented
          label="任务筛选"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: '全部', count: tasks.length },
            { value: 'open', label: '未完成', count: open.length },
            { value: 'done', label: '已完成', count: done.length }
          ]}
        />
      </div>

      {shown.length === 0 && !adding ? (
        <p className="pl-tasks-empty">
          {tasks.length === 0 ? '还没有任务。把要做的事一条条加进来，进度会自动算出来' : '这个筛选下没有任务'}
        </p>
      ) : (
        <ul className="pl-task-rows" role="listbox" aria-label="任务" onKeyDown={onListKey}>
          {shown.map((t) => {
            const Icon = STATUS_ICON[t.status]
            const due = taskDueTone(t, today)
            const dragging = dragId === t.id
            return (
              <li
                key={t.id}
                className="pl-task"
                role="option"
                aria-selected={cursor === t.id}
                tabIndex={cursor === t.id || (!cursor && t === shown[0]) ? 0 : -1}
                data-task-id={t.id}
                data-status={t.status}
                data-dragging={dragging || undefined}
                data-drop-at={dropAt?.id === t.id ? (dropAt.before ? 'before' : 'after') : undefined}
                onFocus={() => setCursor(t.id)}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes(TASK_MIME) || dragId === t.id) return
                  e.preventDefault()
                  const r = e.currentTarget.getBoundingClientRect()
                  const before = e.clientY < r.top + r.height / 2
                  if (dropAt?.id !== t.id || dropAt.before !== before) setDropAt({ id: t.id, before })
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null)
                }}
                onDrop={(e) => {
                  const id = e.dataTransfer.getData(TASK_MIME)
                  const at = dropAt
                  setDropAt(null)
                  if (!id || !at) return
                  e.preventDefault()
                  move(id, t.id, at.before)
                }}
              >
                {!readOnly && (
                  <span
                    className="pl-task-grip"
                    draggable
                    title="拖动调整顺序"
                    aria-hidden
                    onDragStart={(e) => {
                      e.dataTransfer.setData(TASK_MIME, t.id)
                      e.dataTransfer.effectAllowed = 'move'
                      setDragId(t.id)
                    }}
                    onDragEnd={() => {
                      setDragId(null)
                      setDropAt(null)
                    }}
                  >
                    <ICON.dragHandle size={16} />
                  </span>
                )}
                <button
                  type="button"
                  className="pl-task-check"
                  data-status={t.status}
                  disabled={readOnly}
                  aria-label={t.status === 'done' ? `把「${t.title}」标为未完成` : `把「${t.title}」标为已完成`}
                  title={TASK_STATUS_LABEL[t.status]}
                  onClick={() => toggle(t)}
                >
                  <Icon size={16} weight={t.status === 'done' ? 'fill' : 'regular'} aria-hidden />
                </button>
                {editingId === t.id ? (
                  <InlineTitle
                    initial={t.title}
                    onDone={(title) => {
                      setEditingId(null)
                      if (title && title !== t.title) void editTask(board.id, t.id, { title })
                      document.querySelector<HTMLElement>(`[data-task-id="${t.id}"]`)?.focus()
                    }}
                  />
                ) : (
                  <span
                    className="pl-task-title"
                    title={t.note ? `${t.title}\n${t.note}` : t.title}
                    onDoubleClick={() => !readOnly && setEditingId(t.id)}
                  >
                    {t.title}
                  </span>
                )}
                {t.status === 'doing' && <span className="pl-task-tag" data-tone="info">进行中</span>}
                {t.status === 'canceled' && <span className="pl-task-tag">已取消</span>}
                {t.dueDate && t.status !== 'done' && t.status !== 'canceled' && (
                  <span className="pl-task-due" data-due={due ?? 'normal'}>
                    {due === 'overdue' ? '已过期 ' : due === 'today' ? '今天到期 ' : '截止 '}
                    {shortDate(t.dueDate)}
                  </span>
                )}
                {t.status === 'done' && t.doneAt && (
                  <span className="pl-task-due" data-due="done">{doneLabel(t.doneAt)} 完成</span>
                )}
                {!readOnly && <MenuButton label={`${t.title} 更多操作`} items={menu(t)} />}
              </li>
            )
          })}
        </ul>
      )}

      {!readOnly &&
        (adding ? (
          <div className="pl-task-add-row">
            <ICON.taskTodo size={16} aria-hidden className="pl-task-add-icon" />
            <input
              ref={addRef}
              className="ui-input pl-task-add-input"
              data-task-add-input
              value={draft}
              maxLength={TASK_TITLE_MAX}
              placeholder="输入任务标题，回车添加，Esc 结束"
              aria-label="新任务标题"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void submitDraft()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  setDraft('')
                  setAdding(false)
                }
              }}
              onBlur={() => {
                if (!draft.trim()) setAdding(false)
              }}
            />
          </div>
        ) : (
          <button type="button" className="pl-task-add" data-task-add onClick={() => setAdding(true)}>
            <ICON.add size={16} aria-hidden />
            添加任务
          </button>
        ))}

      {dialogTask && (
        <TaskDialog
          task={dialogTask}
          onClose={() => setDialogTask(null)}
          onSave={async (patch) => {
            if (await editTask(board.id, dialogTask.id, patch)) setDialogTask(null)
          }}
        />
      )}
    </div>
  )
}

function InlineTitle({ initial, onDone }: { initial: string; onDone: (title: string | null) => void }): React.JSX.Element {
  const [v, setV] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const finish = (value: string | null): void => {
    if (done.current) return
    done.current = true
    onDone(value)
  }
  return (
    <input
      ref={ref}
      className="ui-input pl-task-title-input"
      value={v}
      maxLength={TASK_TITLE_MAX}
      aria-label="任务标题"
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(v.trim() || null)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          finish(null)
        }
      }}
      onBlur={() => finish(v.trim() || null)}
    />
  )
}

function TaskDialog({
  task,
  onClose,
  onSave
}: {
  task: PlannerTask
  onClose: () => void
  onSave: (patch: { title: string; status: PlannerTaskStatus; startDate: string | null; dueDate: string | null; note: string | null }) => Promise<void>
}): React.JSX.Element {
  const error = usePlanner((s) => s.error)
  const [title, setTitle] = useState(task.title)
  const [status, setStatus] = useState<PlannerTaskStatus>(task.status)
  const [startDate, setStartDate] = useState(task.startDate ?? '')
  const [dueDate, setDueDate] = useState(task.dueDate ?? '')
  const [note, setNote] = useState(task.note ?? '')
  const [saving, setSaving] = useState(false)
  const rangeBad = !!startDate && !!dueDate && dueDate < startDate

  return (
    <DialogShell
      title="编辑任务"
      icon={<ICON.planner size={20} />}
      onClose={onClose}
      width={520}
      dataset={{ taskDialog: task.id }}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            disabled={!title.trim() || rangeBad || saving}
            onClick={async () => {
              setSaving(true)
              try {
                await onSave({
                  title: title.trim(),
                  status,
                  startDate: startDate || null,
                  dueDate: dueDate || null,
                  note: note.trim() || null
                })
              } finally {
                setSaving(false)
              }
            }}
          >
            保存
          </Button>
        </>
      }
    >
      <div className="pl-form">
        <Field label="标题" full>
          <input className="ui-input" value={title} maxLength={TASK_TITLE_MAX} onChange={(e) => setTitle(e.target.value)} aria-label="标题" />
        </Field>
        <Field label="状态" full>
          <Segmented
            label="任务状态"
            value={status}
            onChange={setStatus}
            options={(['todo', 'doing', 'done', 'canceled'] as const).map((s) => ({ value: s, label: TASK_STATUS_LABEL[s] }))}
          />
        </Field>
        <Field label="开始日期">
          <input type="date" className="ui-input" data-mono value={startDate} onChange={(e) => setStartDate(e.target.value)} aria-label="开始日期" />
        </Field>
        <Field label="截止日期" error={rangeBad ? '截止日期不能早于开始日期' : undefined}>
          <input type="date" className="ui-input" data-mono value={dueDate} onChange={(e) => setDueDate(e.target.value)} aria-label="截止日期" />
        </Field>
        <Field label="备注" hint={`纯文本，最长 ${NOTE_MAX} 字`} full>
          <textarea className="ui-input pl-note" rows={4} value={note} maxLength={NOTE_MAX} onChange={(e) => setNote(e.target.value)} aria-label="备注" />
        </Field>
        {error && <p className="ui-field-error" role="alert">{error}</p>}
      </div>
    </DialogShell>
  )
}

function localToday(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function doneLabel(at: number): string {
  const d = new Date(at)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
