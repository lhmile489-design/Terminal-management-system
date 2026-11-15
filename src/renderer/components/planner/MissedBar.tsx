import { useMemo, useState } from 'react'
import type { MissedReminder, PlannerBoard } from '@shared/planner'
import { Button, DialogShell, confirm } from '../ui'
import { usePlanner } from '../../store/planner'
import { useGroups } from '../../store/groups'
import { ICON } from '../../lib/icons'

/**
 * 错过的提醒汇总（PRD-PLANNER §5.4）。
 *
 * 应用没运行 / 电脑休眠期间该弹的提醒，主进程攒在 missed[] 里，这里汇总成一条
 * 「有 N 条提醒在应用未运行时错过」的横幅，点开看清单。重复日程错过多次折成
 * 一条，写明次数。逐条「标记完成」勾掉关联任务并清掉这条；「忽略」只清掉。
 * 只在应用内显示，不补弹系统通知——弹了就不是「错过」而是「打扰」了。
 */

/** 同一日程的多次错过折成一行；at 记最早那次的，次数标在行尾 */
interface Row {
  boardId: string
  scheduleId: string
  title: string
  /** 关联任务（有则显示「标记完成」） */
  taskId?: string
  /** 最早一次该弹的时刻 */
  at: number
  /** 折起来的次数 */
  count: number
}

function collapse(missed: MissedReminder[], boards: PlannerBoard[]): Row[] {
  const bySchedule = new Map<string, Row>()
  for (const m of missed) {
    const key = `${m.boardId}:${m.scheduleId}`
    const prev = bySchedule.get(key)
    const taskId = boards.find((b) => b.id === m.boardId)?.schedules.find((s) => s.id === m.scheduleId)?.taskId
    if (prev) {
      prev.count++
      prev.at = Math.min(prev.at, m.at)
    } else {
      bySchedule.set(key, { boardId: m.boardId, scheduleId: m.scheduleId, title: m.title, taskId, at: m.at, count: 1 })
    }
  }
  return [...bySchedule.values()].sort((a, b) => a.at - b.at)
}

/** 「今天 15:00 / 昨天 09:30 / 11-02 18:00」 */
function fmtWhen(at: number, today: string): string {
  const d = new Date(at)
  const p = (n: number): string => String(n).padStart(2, '0')
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`
  const dateStr = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  if (dateStr === today) return `今天 ${time}`
  const y = new Date(`${today}T00:00:00`).getTime()
  if (d.getTime() >= y - 86_400_000 && d.getTime() < y) return `昨天 ${time}`
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${time}`
}

export function MissedBar({ today, onFocusBoard }: { today: string; onFocusBoard: (boardId: string) => void }): React.JSX.Element | null {
  const missed = usePlanner((s) => s.missed)
  const boards = usePlanner((s) => s.boards)
  const dismissMissed = usePlanner((s) => s.dismissMissed)
  const clearMissed = usePlanner((s) => s.clearMissed)
  const completeScheduleTask = usePlanner((s) => s.completeScheduleTask)
  const groups = useGroups((s) => s.groups)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const rows = useMemo(() => collapse(missed, boards), [missed, boards])
  const total = missed.length
  if (total === 0) return null

  const groupName = (boardId: string): string => {
    const b = boards.find((x) => x.id === boardId)
    if (!b) return '看板已删除'
    return groups.find((g) => g.id === b.groupId)?.name ?? '工作组已删除'
  }

  const markDone = async (r: Row): Promise<void> => {
    setBusy(true)
    await completeScheduleTask(r.boardId, r.scheduleId)
    await dismissMissed(r.boardId, r.scheduleId)
    setBusy(false)
  }

  const clearAll = async (): Promise<void> => {
    const ok = await confirm({ title: `忽略全部 ${total} 条错过的提醒？`, body: '只是清掉这条汇总，日程本身不受影响', okLabel: '全部忽略' })
    if (!ok) return
    await clearMissed()
    setOpen(false)
  }

  return (
    <>
      <div className="pl-missed" data-planner-missed role="status">
        <span className="pl-missed-icon" aria-hidden><ICON.reminder size={16} /></span>
        <p className="pl-missed-text">
          有 <b>{total}</b> 条提醒在应用未运行时错过
          {rows.length > 1 ? `（${rows.length} 条日程）` : ''}
        </p>
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)} data-missed-view>
          查看
        </Button>
      </div>

      {open && (
        <DialogShell
          title="错过的提醒"
          icon={<ICON.reminder size={20} />}
          onClose={() => setOpen(false)}
          dataset={{ missedDialog: '' }}
          width={520}
          footer={
            <>
              <Button variant="secondary" onClick={() => setOpen(false)}>关 闭</Button>
              <Button variant="primary" disabled={busy} onClick={() => void clearAll()}>全部忽略</Button>
            </>
          }
        >
          <p className="pl-dialog-hint">这些提醒本该在你不在的时候弹出。重复的日程折成一条，标出错过的次数。</p>
          <ul className="pl-missed-list" data-missed-list>
            {rows.map((r) => (
              <li key={`${r.scheduleId}`} className="pl-missed-row" data-missed-row>
                <div className="pl-missed-main">
                  <p className="pl-missed-title">{r.title}</p>
                  <p className="pl-missed-sub">
                    {groupName(r.boardId)} · {fmtWhen(r.at, today)}
                    {r.count > 1 && <em className="pl-missed-count"> ×{r.count}</em>}
                  </p>
                </div>
                <div className="pl-missed-acts">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => { onFocusBoard(r.boardId); setOpen(false) }}
                  >
                    定位
                  </Button>
                  {r.taskId && (
                    <Button size="sm" variant="primary" disabled={busy} onClick={() => void markDone(r)} data-missed-done>
                      标记完成
                    </Button>
                  )}
                  <Button size="sm" disabled={busy} onClick={() => void dismissMissed(r.boardId, r.scheduleId)} data-missed-dismiss>
                    忽 略
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </DialogShell>
      )}
    </>
  )
}
