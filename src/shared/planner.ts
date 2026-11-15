// 对应 src/shared/planner.ts（原文复制，一字未改）。
//
// 不用生成层的 planner 类型：Go 侧没有判别联合，生成的 ScheduleRepeat 是 {kind: string; days?; day?}，
// 组件里按 kind 收窄的写法会编不过。所以这里保留原版类型与纯函数，src/lib/mile.ts 在边界断言一次。

/**
 * 进度与日程（docs/PRD-PLANNER.md）的共享类型与纯函数。
 *
 * 主进程与渲染层都用这里的口径算进度、判超期，避免两边各写一份后对不上。
 * 数据存独立文件 planner.json，不进 config.json（PRD §6.1）。
 */

export const PLANNER_VERSION = 1

/** 单个看板任务上限，PRD §4.4 */
export const MAX_TASKS_PER_BOARD = 500
export const MAX_BOARDS = 200
export const TASK_TITLE_MAX = 120
export const NOTE_MAX = 2000

export type PlannerTaskStatus = 'todo' | 'doing' | 'done' | 'canceled'

export const TASK_STATUSES: readonly PlannerTaskStatus[] = ['todo', 'doing', 'done', 'canceled']

export const TASK_STATUS_LABEL: Record<PlannerTaskStatus, string> = {
  todo: '待办',
  doing: '进行中',
  done: '已完成',
  canceled: '已取消'
}

// ── 日程 ────────────────────────────────────────────────────────────────

export const SCHEDULE_TITLE_MAX = 120
export const MAX_SCHEDULES_PER_BOARD = 200

/** 提前提醒的分钟数白名单，0 = 准时 */
export const LEAD_MINUTES = [0, 5, 15, 30, 60, 1440] as const
export type LeadMinutes = (typeof LEAD_MINUTES)[number]

export type ScheduleRepeat =
  | { kind: 'none' }
  | { kind: 'daily' }
  | { kind: 'workdays' }
  | { kind: 'weekly'; days: number[] }
  | { kind: 'monthly'; day: number }

export type RepeatKind = ScheduleRepeat['kind']
export const REPEAT_KINDS: readonly RepeatKind[] = ['none', 'daily', 'workdays', 'weekly', 'monthly']

export const REPEAT_LABEL: Record<RepeatKind, string> = {
  none: '不重复',
  daily: '每天',
  workdays: '工作日',
  weekly: '每周',
  monthly: '每月'
}

/** 星期几：0=周日 … 6=周六，与 Date.getDay() 一致 */
export const WEEKDAY_LABEL = ['日', '一', '二', '三', '四', '五', '六'] as const

export interface PlannerSchedule {
  id: string
  title: string
  taskId?: string
  /** 'YYYY-MM-DD'，首次 / 唯一一次的本地日期；重复日程也从这天开始 */
  date: string
  /** 'HH:mm'，本地时刻 */
  time: string
  repeat: ScheduleRepeat
  /** 'YYYY-MM-DD'，重复日程到这天为止（含） */
  until?: string
  leadMinutes: LeadMinutes
  /** 关联任务完成后自动停止，默认开 */
  stopWhenTaskDone: boolean
  paused: boolean
  /** 稍后提醒，Unix ms；到点按这个再弹一次 */
  snoozeUntil?: number
  /** 上次真正弹出的触发时刻（Unix ms），防重 */
  lastFiredAt?: number
}

/** 一条错过的提醒：触发时刻过去超过错过阈值没弹，记下来等 P3 汇总 */
export interface MissedReminder {
  scheduleId: string
  boardId: string
  title: string
  /** 本该触发的时刻（Unix ms） */
  at: number
}

export interface PlannerTask {
  id: string
  title: string
  status: PlannerTaskStatus
  /** 'YYYY-MM-DD'，本地日期 */
  startDate?: string
  dueDate?: string
  note?: string
  /** 勾选完成时由主进程记下，取消完成时清空 */
  doneAt?: number
  order: number
}

export interface PlannerBoard {
  id: string
  /** 必须是已有工作组；工作组被删后保留看板，界面标「工作组已删除」 */
  groupId: string
  startDate?: string
  endDate?: string
  note?: string
  createdAt: number
  order: number
  tasks: PlannerTask[]
  schedules: PlannerSchedule[]
}

export interface PlannerData {
  version: number
  boards: PlannerBoard[]
  /** 错过的提醒，P3 汇总用；P2 只写不读 */
  missed?: MissedReminder[]
}

/** 渲染层拿到的整份数据，多一个只读标记：文件坏了时界面要说明「这次不会保存」 */
export interface PlannerSnapshot {
  boards: PlannerBoard[]
  readOnly: boolean
  /** 错过的提醒汇总（P3 §5.4），启动时展示、逐条处理 */
  missed: MissedReminder[]
}

/** 看板可编辑字段。null = 显式清空（IPC 结构化克隆会丢掉 undefined 的键） */
export interface PlannerBoardPatch {
  startDate?: string | null
  endDate?: string | null
  note?: string | null
}

export interface PlannerTaskInput {
  title: string
  status?: PlannerTaskStatus
  startDate?: string | null
  dueDate?: string | null
  note?: string | null
}

export type PlannerTaskPatch = Partial<PlannerTaskInput>

/** 日程可编辑字段。null = 显式清空（taskId、until、snoozeUntil） */
export interface PlannerScheduleInput {
  title: string
  taskId?: string | null
  date: string
  time: string
  repeat?: ScheduleRepeat
  until?: string | null
  leadMinutes?: LeadMinutes
  stopWhenTaskDone?: boolean
  paused?: boolean
}

export type PlannerSchedulePatch = Partial<PlannerScheduleInput> & { snoozeUntil?: number | null }

/** 渲染层收到的一条到点提醒（planner:reminder） */
export interface ReminderFire {
  boardId: string
  scheduleId: string
  /** 工作组名（主进程查好，渲染层不用 join） */
  groupName: string
  title: string
  /** 关联任务 id；没有就不显示「标记完成」 */
  taskId?: string
  /** 显示用的时间文本，如「今天 15:00」 */
  when: string
  /** 真正的触发时刻 */
  at: number
}

// ── 日期 ────────────────────────────────────────────────────────────────

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** 合法的本地日期 'YYYY-MM-DD'：格式对、月日真实存在（2 月 30 日不算） */
export function isValidDate(s: unknown): s is string {
  if (typeof s !== 'string') return false
  const m = DATE_RE.exec(s)
  if (!m) return false
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (y < 1970 || y > 2999 || mo < 1 || mo > 12 || d < 1) return false
  return d <= new Date(y, mo, 0).getDate()
}

/** 本地日期字符串。不用 toISOString：那是 UTC，东八区凌晨会算成前一天 */
export function localDate(at: number = Date.now()): string {
  const d = new Date(at)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** b - a 相差的整天数（都是本地日期字符串） */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  // 用 UTC 构造只是为了避开夏令时的 23 / 25 小时，两边口径一致即可
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000)
}

// ── 进度 ────────────────────────────────────────────────────────────────

export interface BoardProgress {
  done: number
  /** 不含已取消 */
  total: number
  /** 0..100 的整数；total 为 0 时为 null（界面显示「还没有任务」，不显示 0%） */
  percent: number | null
}

/** PRD §4.3：只算「已完成」；「已取消」不计入分子也不计入分母 */
export function boardProgress(board: Pick<PlannerBoard, 'tasks'>): BoardProgress {
  let done = 0
  let total = 0
  for (const t of board.tasks) {
    if (t.status === 'canceled') continue
    total++
    if (t.status === 'done') done++
  }
  return { done, total, percent: total === 0 ? null : Math.round((done / total) * 100) }
}

export type BoardTone = 'overdue' | 'complete' | 'soon' | 'normal'

export interface BoardStatus {
  tone: BoardTone
  /** 胶囊文案；normal 时为距结束的天数说明或空 */
  label: string
  /** endDate - today；没有结束日期时为 null */
  daysLeft: number | null
}

/** 离结束这么多天内还没完成就提示 */
export const SOON_DAYS = 3

/**
 * 看板状态（PRD §4.6）：全部完成 → complete；过了结束日期没完成 → overdue；
 * 结束前 3 天内没完成 → soon。没有任务的看板不算完成。
 */
export function boardStatus(board: Pick<PlannerBoard, 'tasks' | 'endDate'>, today: string = localDate()): BoardStatus {
  const p = boardProgress(board)
  const daysLeft = board.endDate && isValidDate(board.endDate) ? daysBetween(today, board.endDate) : null
  if (p.total > 0 && p.done === p.total) return { tone: 'complete', label: '已完成', daysLeft }
  if (daysLeft !== null && daysLeft < 0) return { tone: 'overdue', label: `已超期 ${-daysLeft} 天`, daysLeft }
  if (daysLeft !== null && daysLeft <= SOON_DAYS) {
    return { tone: 'soon', label: daysLeft === 0 ? '今天结束' : `还剩 ${daysLeft} 天`, daysLeft }
  }
  return { tone: 'normal', label: daysLeft !== null ? `剩 ${daysLeft} 天` : '', daysLeft }
}

export type TaskDueTone = 'overdue' | 'today' | 'normal'

/** 任务截止胶囊：今天到期 / 已过期 / 其余。完成与取消的任务不再提示 */
export function taskDueTone(task: Pick<PlannerTask, 'dueDate' | 'status'>, today: string = localDate()): TaskDueTone | null {
  if (!task.dueDate || !isValidDate(task.dueDate)) return null
  if (task.status === 'done' || task.status === 'canceled') return 'normal'
  const d = daysBetween(today, task.dueDate)
  if (d < 0) return 'overdue'
  if (d === 0) return 'today'
  return 'normal'
}

// ── 日程触发计算（P2 §5）─────────────────────────────────────────────────

const TIME_RE = /^(\d{2}):(\d{2})$/

/** 合法的 'HH:mm' 时刻：小时 0–23、分 0–59 */
export function isValidTime(s: unknown): s is string {
  if (typeof s !== 'string') return false
  const m = TIME_RE.exec(s)
  if (!m) return false
  return Number(m[1]) <= 23 && Number(m[2]) <= 59
}

/** 'YYYY-MM-DD' + 'HH:mm' → 本地 Unix ms。日期非法时返回 NaN */
export function scheduleMoment(date: string, time: string): number {
  if (!isValidDate(date) || !isValidTime(time)) return NaN
  const [y, mo, d] = date.split('-').map(Number)
  const [h, mi] = time.split(':').map(Number)
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime()
}

/** ms → 'HH:mm' 本地时刻 */
export function timeOfDay(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 某月的第几天，超过当月天数落到月末（每月 31 号在 2 月落到 28/29） */
function clampDay(y: number, mo1: number, day: number): number {
  return Math.min(day, new Date(y, mo1 + 1, 0).getDate())
}

/** 这一天是否被该重复规则命中（date 已经是 'YYYY-MM-DD'） */
export function repeatMatches(repeat: ScheduleRepeat, date: string): boolean {
  const [y, mo, d] = date.split('-').map(Number)
  const dow = new Date(y, mo - 1, d).getDay()
  switch (repeat.kind) {
    case 'none':
      return false
    case 'daily':
      return true
    case 'workdays':
      return dow >= 1 && dow <= 5
    case 'weekly':
      return repeat.days.includes(dow)
    case 'monthly':
      return d === clampDay(y, mo - 1, repeat.day)
  }
}

/** 一次待触发的候选：业务触发时刻与显示日期 */
export interface PendingFire {
  /** 触发时刻（date + time），业务时间；lastFiredAt 记的就是它 */
  at: number
  /** 该次触发对应的本地日期 'YYYY-MM-DD'（重复日程逐日不同） */
  date: string
}

/**
 * 列出一条日程在 [fromMs, toMs] 之间所有该弹的触发。
 * 弹出时刻 = 触发时刻 - leadMinutes，落在这个闭区间内才算。
 * 返回按时间升序。用于：轮询「现在到没到点」、测试「下次触发是哪天」。
 */
export function pendingFires(s: PlannerSchedule, fromMs: number, toMs: number): PendingFire[] {
  if (s.paused) return []
  const lead = s.leadMinutes * 60_000
  const out: PendingFire[] = []
  const untilMs = s.until && isValidDate(s.until) ? scheduleMoment(s.until, '23:59') : Infinity

  if (s.repeat.kind === 'none') {
    const at = scheduleMoment(s.date, s.time)
    if (!Number.isNaN(at) && at <= untilMs && at - lead >= fromMs && at - lead <= toMs) {
      out.push({ at, date: s.date })
    }
    return out
  }

  // 重复日程：逐日扫，从 fromMs-lead 那天扫到 toMs+lead 那天（提醒可比触发早一天弹）
  const startDay = new Date(fromMs - lead - 86_400_000)
  const endDay = new Date(toMs + 86_400_000)
  const cur = new Date(startDay.getFullYear(), startDay.getMonth(), startDay.getDate())
  const last = new Date(endDay.getFullYear(), endDay.getMonth(), endDay.getDate()).getTime()
  while (cur.getTime() <= last) {
    const ds = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`
    if (daysBetween(s.date, ds) >= 0 && repeatMatches(s.repeat, ds)) {
      const at = scheduleMoment(ds, s.time)
      if (!Number.isNaN(at) && at <= untilMs && at - lead >= fromMs && at - lead <= toMs) {
        out.push({ at, date: ds })
      }
    }
    cur.setDate(cur.getDate() + 1)
  }
  return out
}

/** 下一条提醒的业务触发时刻（用于「下次提醒」列），没找到返回 null */
export function nextFireAt(s: PlannerSchedule, now: number): number | null {
  const first = pendingFires(s, now, now + 370 * 86_400_000)[0]
  return first ? first.at : null
}
