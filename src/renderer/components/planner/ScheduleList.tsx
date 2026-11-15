import { mile } from "../../../lib/mile";
import { useMemo, useState } from 'react'
import {
  LEAD_MINUTES,
  REPEAT_KINDS,
  REPEAT_LABEL,
  SCHEDULE_TITLE_MAX,
  WEEKDAY_LABEL,
  isValidDate,
  isValidTime,
  nextFireAt,
  timeOfDay,
  type LeadMinutes,
  type PlannerBoard,
  type PlannerSchedule,
  type PlannerScheduleInput,
  type RepeatKind,
  type ScheduleRepeat
} from '@shared/planner'
import { Button, DialogShell, Field, MenuButton, Segmented, Select, Switch, confirm, type MenuItem } from '../ui'
import { ICON } from '../../lib/icons'
import { usePlanner } from '../../store/planner'
import { useSettings } from '../../store/settings'

/** §5.5：第一次保存日程时，若「关闭时收起到托盘」是关的，问一次要不要改。问过记这里不再打扰 */
const TRAY_ASKED_KEY = 'mile.planner.trayAsked'

/** §5.5 托盘提示：只在新建日程成功后问一次；用户随时可在设置里改 */
async function maybeAskTray(): Promise<void> {
  try {
    if (localStorage.getItem(TRAY_ASKED_KEY)) return
    localStorage.setItem(TRAY_ASKED_KEY, '1')
    if (useSettings.getState().settings?.closeToTray) return
    const ok = await confirm({
      title: '关闭窗口后应用会退出',
      body: '退出期间日程提醒会停。要改成关闭时收起到托盘吗？',
      okLabel: '收起到托盘',
      cancelLabel: '保持现状'
    })
    if (ok) await mile.settings.patch({ closeToTray: true })
  } catch {
    // 问不上不影响保存：设置项读不到就不问
  }
}

/** 提前提醒的选项标签 */
const LEAD_LABEL: Record<LeadMinutes, string> = {
  0: '准时',
  5: '提前 5 分钟',
  15: '提前 15 分钟',
  30: '提前 30 分钟',
  60: '提前 1 小时',
  1440: '提前 1 天'
}

/**
 * 日程列表（PRD-PLANNER §4.2「日程」标签 / §4.6）。每行：铃铛图标、标题、
 * 「重复 · 提前 N」次行、右侧「下次：…」与暂停开关。新建 / 编辑走 DialogShell，
 * 底部实时预览「下次提醒」让用户在保存前核对规则。
 */
export function ScheduleList({ board, readOnly }: { board: PlannerBoard; readOnly: boolean }): React.JSX.Element {
  const editSchedule = usePlanner((s) => s.editSchedule)
  const removeSchedule = usePlanner((s) => s.removeSchedule)
  const [dialog, setDialog] = useState<{ schedule?: PlannerSchedule } | null>(null)
  const now = Date.now()

  const rows = useMemo(
    () =>
      [...board.schedules]
        .map((s) => ({ s, next: nextFireAt(s, now) }))
        .sort((a, b) => (a.next ?? Infinity) - (b.next ?? Infinity)),
    [board.schedules, now]
  )

  const menu = (s: PlannerSchedule): MenuItem[] => [
    { label: '编辑', icon: ICON.config, onSelect: () => setDialog({ schedule: s }) },
    { label: s.paused ? '恢复' : '暂停', icon: s.paused ? ICON.start : ICON.stop, onSelect: () => void editSchedule(board.id, s.id, { paused: !s.paused }) },
    { sep: true },
    {
      label: '删除日程',
      icon: ICON.remove,
      danger: true,
      onSelect: () =>
        void confirm({ title: `删除日程「${s.title}」？`, body: '删除后不再提醒。', okLabel: '删除', danger: true }).then(
          (ok) => ok && void removeSchedule(board.id, s.id)
        )
    }
  ]

  return (
    <div className="pl-sched" data-schedule-list>
      {rows.length === 0 ? (
        <p className="pl-tasks-empty">还没有日程。到点弹系统通知，支持每天、工作日、每周、每月重复。</p>
      ) : (
        <ul className="pl-sched-rows">
          {rows.map(({ s, next }) => {
            const task = s.taskId ? board.tasks.find((t) => t.id === s.taskId) : undefined
            const taskGone = !!(s.taskId && !task)
            const taskEnded = !!(task && (task.status === 'done' || task.status === 'canceled'))
            return (
              <li key={s.id} className="pl-sched" data-paused={s.paused || undefined} data-schedule-id={s.id}>
                <span className="pl-sched-icon" aria-hidden>
                  <ICON.reminder size={16} />
                </span>
                <div className="pl-sched-main">
                  <p className="pl-sched-title">{s.title}</p>
                  <p className="pl-sched-sub">
                    {scheduleRuleText(s)}
                    {s.taskId && (
                      <span className="pl-sched-task" data-gone={taskGone || undefined}>
                        {taskGone ? '任务已删除' : task?.title}
                        {taskEnded && '（已结束）'}
                      </span>
                    )}
                  </p>
                </div>
                <div className="pl-sched-side">
                  <span className="pl-sched-next" data-paused={s.paused || undefined}>
                    {taskEnded && s.stopWhenTaskDone ? '已随任务结束' : next ? nextText(next, now) : '不会触发'}
                  </span>
                  {!readOnly && (
                    <Switch
                      label={s.paused ? `恢复日程「${s.title}」` : `暂停日程「${s.title}」`}
                      checked={!s.paused}
                      onChange={(on) => void editSchedule(board.id, s.id, { paused: !on })}
                    />
                  )}
                  {!readOnly && <MenuButton label={`日程「${s.title}」更多操作`} items={menu(s)} />}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {!readOnly && (
        <button type="button" className="pl-task-add" data-schedule-add onClick={() => setDialog({})}>
          <ICON.add size={16} aria-hidden />
          添加日程
        </button>
      )}
      {dialog && (
        <ScheduleDialog
          key={dialog.schedule?.id ?? 'new'}
          board={board}
          schedule={dialog.schedule}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  )
}

/** 「每周一、三 09:30 · 提前 15 分钟」 */
function scheduleRuleText(s: PlannerSchedule): string {
  let base: string
  switch (s.repeat.kind) {
    case 'none':
      base = `${s.date} ${s.time}`
      break
    case 'daily':
      base = `每天 ${s.time}`
      break
    case 'workdays':
      base = `工作日 ${s.time}`
      break
    case 'weekly': {
      const days = s.repeat.days.map((d) => WEEKDAY_LABEL[d]).join('、')
      base = `每周${days} ${s.time}`
      break
    }
    case 'monthly':
      base = `每月 ${s.repeat.day} 号 ${s.time}`
      break
  }
  const lead = s.leadMinutes === 0 ? '' : ` · ${LEAD_LABEL[s.leadMinutes]}`
  return base + lead
}

/** 「今天 15:00」「明天 09:15」「11-10 周一 09:15」 */
function nextText(at: number, now: number): string {
  const t = timeOfDay(at)
  const a = new Date(at)
  const n = new Date(now)
  const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diffDays = Math.round((startOfDay(a) - startOfDay(n)) / 86_400_000)
  if (diffDays === 0) return `下次：今天 ${t}`
  if (diffDays === 1) return `下次：明天 ${t}`
  const wd = WEEKDAY_LABEL[a.getDay()]
  return `下次：${String(a.getMonth() + 1).padStart(2, '0')}-${String(a.getDate()).padStart(2, '0')} 周${wd} ${t}`
}

// ── 新建 / 编辑对话框 ────────────────────────────────────────────────────

function ScheduleDialog({
  board,
  schedule,
  onClose
}: {
  board: PlannerBoard
  schedule?: PlannerSchedule
  onClose: () => void
}): React.JSX.Element {
  const addSchedule = usePlanner((s) => s.addSchedule)
  const editSchedule = usePlanner((s) => s.editSchedule)
  const error = usePlanner((s) => s.error)

  const isNew = !schedule
  const [title, setTitle] = useState(schedule?.title ?? '')
  const [taskId, setTaskId] = useState(schedule?.taskId ?? '')
  const [date, setDate] = useState(schedule?.date ?? todayStr())
  const [time, setTime] = useState(schedule?.time ?? '09:00')
  const [kind, setKind] = useState<RepeatKind>(schedule?.repeat.kind ?? 'none')
  const [weekDays, setWeekDays] = useState<number[]>(
    schedule?.repeat.kind === 'weekly' ? [...schedule.repeat.days] : [1, 3, 5]
  )
  const [monthDay, setMonthDay] = useState(schedule?.repeat.kind === 'monthly' ? schedule.repeat.day : 1)
  const [lead, setLead] = useState<LeadMinutes>(schedule?.leadMinutes ?? 0)
  const [until, setUntil] = useState(schedule?.until ?? '')
  const [stopWhenDone, setStopWhenDone] = useState(schedule?.stopWhenTaskDone ?? true)
  const [saving, setSaving] = useState(false)

  const repeat: ScheduleRepeat =
    kind === 'weekly'
      ? { kind: 'weekly', days: weekDays }
      : kind === 'monthly'
        ? { kind: 'monthly', day: monthDay }
        : { kind }

  const draft: PlannerSchedule = {
    id: schedule?.id ?? '',
    title,
    date,
    time,
    repeat,
    leadMinutes: lead,
    stopWhenTaskDone: stopWhenDone,
    paused: schedule?.paused ?? false
  }
  if (taskId) draft.taskId = taskId
  if (until) draft.until = until

  const preview = useMemo(() => {
    if (!isValidDate(date) || !isValidTime(time)) return null
    if (kind === 'weekly' && weekDays.length === 0) return null
    const next = nextFireAt(draft, Date.now())
    return next === null ? '不会触发' : nextText(next, Date.now()).replace('下次：', '')
  }, [date, time, kind, weekDays, monthDay, until, lead]) // eslint-disable-line react-hooks/exhaustive-deps

  const badUntil = !!until && isValidDate(until) && until < date
  const canSave =
    !!date && isValidDate(date) && !!time && isValidTime(time) &&
    (kind !== 'weekly' || weekDays.length > 0) && !badUntil && !saving

  const save = async (): Promise<void> => {
    setSaving(true)
    const input: PlannerScheduleInput = {
      title: title.trim(),
      date,
      time,
      repeat,
      leadMinutes: lead,
      stopWhenTaskDone: stopWhenDone
    }
    if (taskId) input.taskId = taskId
    else input.taskId = null
    if (until) input.until = until
    else input.until = null
    const ok = isNew ? await addSchedule(board.id, input) : await editSchedule(board.id, schedule.id, input)
    setSaving(false)
    if (ok) {
      onClose()
      // §5.5：只在新建成动后问一次托盘驻留；编辑不算
      if (isNew) void maybeAskTray()
    }
  }

  return (
    <DialogShell
      title={isNew ? '新建日程' : '编辑日程'}
      icon={<ICON.reminder size={20} />}
      onClose={onClose}
      width={520}
      dataset={{ scheduleDialog: schedule?.id ?? 'new' }}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={!canSave} onClick={() => void save()}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <div className="pl-form">
        <Field label="标题" full hint="留空时用关联任务的标题">
          <input
            className="ui-input"
            value={title}
            maxLength={SCHEDULE_TITLE_MAX}
            placeholder="例会 / 发布 / 联调…"
            aria-label="日程标题"
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field label="关联" full>
          <Select aria-label="关联任务" value={taskId} onChange={(e) => setTaskId(e.target.value)}>
            <option value="">只关联看板</option>
            {board.tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="日期">
          <input type="date" className="ui-input" data-mono value={date} aria-label="开始日期" onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="时刻">
          <input type="time" className="ui-input" data-mono value={time} aria-label="时刻" onChange={(e) => setTime(e.target.value)} />
        </Field>
        <Field label="重复" full>
          <Segmented
            label="重复方式"
            value={kind}
            onChange={(k) => setKind(k as RepeatKind)}
            options={REPEAT_KINDS.map((k) => ({ value: k, label: REPEAT_LABEL[k] }))}
          />
        </Field>
        {kind === 'weekly' && (
          <Field label="星期几" full>
            <div className="pl-week" role="group" aria-label="星期几">
              {WEEKDAY_LABEL.map((w, i) => {
                const on = weekDays.includes(i)
                return (
                  <button
                    key={i}
                    type="button"
                    className="pl-week-day"
                    data-on={on || undefined}
                    aria-pressed={on}
                    onClick={() => setWeekDays((cur) => (on ? cur.filter((d) => d !== i) : [...cur, i].sort((a, b) => a - b)))}
                  >
                    {w}
                  </button>
                )
              })}
            </div>
          </Field>
        )}
        {kind === 'monthly' && (
          <Field label="每月几号" hint="没有的日期落到当月最后一天">
            <input
              type="number"
              className="ui-input"
              data-mono
              min={1}
              max={31}
              value={monthDay}
              aria-label="每月几号"
              onChange={(e) => setMonthDay(Math.max(1, Math.min(31, Number(e.target.value) || 1)))}
            />
          </Field>
        )}
        <Field label="提前提醒">
          <Select aria-label="提前提醒" value={lead} onChange={(e) => setLead(Number(e.target.value) as LeadMinutes)}>
            {LEAD_MINUTES.map((m) => (
              <option key={m} value={m}>
                {LEAD_LABEL[m]}
              </option>
            ))}
          </Select>
        </Field>
        {kind !== 'none' && (
          <Field label="结束日期" error={badUntil ? '结束日期不能早于开始日期' : undefined} hint="留空则一直重复">
            <input type="date" className="ui-input" data-mono value={until} min={date || undefined} aria-label="结束日期" onChange={(e) => setUntil(e.target.value)} />
          </Field>
        )}
        {taskId && (
          <Field label="完成后停止" full hint="关联任务标为完成或取消后，这条日程自动暂停">
            <Switch label="关联任务完成后停止" checked={stopWhenDone} onChange={setStopWhenDone} />
          </Field>
        )}
        <p className="pl-sched-preview" data-schedule-preview>
          下次提醒：{preview ?? '—'}
        </p>
        {error && <p className="ui-field-error" role="alert">{error}</p>}
      </div>
    </DialogShell>
  )
}

function todayStr(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
