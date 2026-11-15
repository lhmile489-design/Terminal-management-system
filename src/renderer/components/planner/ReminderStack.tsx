import { useState } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import type { ReminderFire } from '@shared/planner'
import { Button, MenuButton, type MenuItem } from '../ui'
import { ICON } from '../../lib/icons'
import { usePlanner } from '../../store/planner'

/**
 * 到点提醒卡片栈（PRD-PLANNER §4.6「到点时的应用内提醒卡片」）。
 *
 * 与普通 toast 分开：不自动消失、更宽（360px）、用 .surface-frosted 毛玻璃浮层。
 * 主进程经 planner:reminder 推一条就叠一张，最多同时显示 3 张，其余折成「还有 N 条」。
 * 三个操作都是意图发回主进程：「标记完成」勾掉关联任务、「稍后提醒」设 snoozeUntil、
 * 「知道了」只是关掉这张卡。
 */

const MAX_VISIBLE = 3
let seq = 0

interface ReminderItem extends ReminderFire {
  key: number
}

const useReminders = create<{ items: ReminderItem[] }>(() => ({ items: [] }))

/** 主进程推送入口；在 App 里订阅 */
export function pushReminder(fire: ReminderFire): void {
  useReminders.setState((s) => ({ items: [...s.items, { ...fire, key: ++seq }] }))
}

function dismiss(key: number): void {
  useReminders.setState((s) => ({ items: s.items.filter((t) => t.key !== key) }))
}

/** 挂在 App 根部一次（与 ToastHost 并列） */
export function ReminderStack({ onFocus }: { onFocus: (boardId: string, taskId?: string) => void }): React.JSX.Element {
  const items = useReminders((s) => s.items)
  const visible = items.slice(0, MAX_VISIBLE)
  const folded = items.length - visible.length

  return createPortal(
    <div className="pl-reminders" aria-live="assertive" data-reminder-stack>
      {visible.map((r) => (
        <ReminderCard key={r.key} item={r} onFocus={onFocus} />
      ))}
      {folded > 0 && <p className="pl-reminders-more">还有 {folded} 条提醒</p>}
    </div>,
    document.body
  )
}

function ReminderCard({
  item,
  onFocus
}: {
  item: ReminderItem
  onFocus: (boardId: string, taskId?: string) => void
}): React.JSX.Element {
  const completeTask = usePlanner((s) => s.completeScheduleTask)
  const editSchedule = usePlanner((s) => s.editSchedule)
  const [busy, setBusy] = useState(false)

  const snooze = (minutes: number): void => {
    void editSchedule(item.boardId, item.scheduleId, { snoozeUntil: Date.now() + minutes * 60_000 })
    dismiss(item.key)
  }

  const snoozeMenu: MenuItem[] = [
    { label: '10 分钟后', onSelect: () => snooze(10) },
    { label: '1 小时后', onSelect: () => snooze(60) },
    {
      label: '明天同一时间',
      onSelect: () => {
        // 明天同一时刻：当前时间 +24h，保持墙上时刻
        void editSchedule(item.boardId, item.scheduleId, { snoozeUntil: Date.now() + 24 * 60 * 60_000 })
        dismiss(item.key)
      }
    }
  ]

  const markDone = async (): Promise<void> => {
    setBusy(true)
    await completeTask(item.boardId, item.scheduleId)
    setBusy(false)
    dismiss(item.key)
  }

  const acknowledge = (): void => {
    dismiss(item.key)
    onFocus(item.boardId, item.taskId)
  }

  return (
    <div className="pl-reminder surface-frosted" role="alertdialog" aria-label={`日程提醒：${item.title}`} data-reminder-card>
      <span className="pl-reminder-icon" aria-hidden>
        <ICON.reminder size={20} />
      </span>
      <div className="pl-reminder-body">
        <p className="pl-reminder-head">日程提醒 · {item.groupName}</p>
        <p className="pl-reminder-title">{item.title}</p>
        <p className="pl-reminder-time">{item.when}</p>
        <div className="pl-reminder-acts">
          {item.taskId && (
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void markDone()}>
              标记完成
            </Button>
          )}
          <span className="pl-reminder-snooze">
            <MenuButton label={`「${item.title}」稍后提醒`} items={snoozeMenu} icon={ICON.more} />
            <span className="pl-reminder-snooze-hint" aria-hidden>稍后提醒</span>
          </span>
          <Button size="sm" onClick={acknowledge}>
            知道了
          </Button>
        </div>
      </div>
    </div>
  )
}
