// S12 对拍用例生成：用 node 直接跑原版 src/shared/planner.ts 的纯函数，
// 把输入与原版输出写成 JSON，internal/planner/schedule_test.go 读同一份文件比对。
// 期望值全部来自原版函数，不手写。
//
// 用法（在 mygo/console 下）：node scripts/gen-planner-cases.mjs
// 需要 Node 22.18+（默认开启 TypeScript 类型擦除）。原版文件只读，不改。
// 输出里所有非 ASCII 字符都写成 \uXXXX（按 UTF-16 码元），文件是纯 ASCII。
//
// 注意：localDate / scheduleMoment / timeOfDay / pendingFires 都依赖系统本地时区，
// 生成器与 Go 测试必须在同一台机器同一时区跑，否则期望值对不上。
// 在生成时把 process.env.TZ 与运行时刻录进文件，方便排查。

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isValidDate,
  localDate,
  daysBetween,
  boardProgress,
  boardStatus,
  taskDueTone,
  isValidTime,
  scheduleMoment,
  timeOfDay,
  repeatMatches,
  pendingFires,
  nextFireAt,
} from '../../../mile-terminal-management/src/shared/planner.ts'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '../internal/planner/testdata/planner_cases.json')

// ── 通用工具 ──────────────────────────────────────────────────────────
const pad2 = (n) => String(n).padStart(2, '0')
const ymd = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`
const d = (s) => s // 别名，便于读用例

// ── isValidDate ──────────────────────────────────────────────────────
const dates = [
  '2026-11-14', '2026-02-28', '2024-02-29', '2023-02-29', '2026-02-30', '2026-13-01',
  '2026-00-10', '2026-01-00', '2026-01-32', '1970-01-01', '1969-12-31', '2999-12-31',
  '3000-01-01', '2026-1-5', '26-11-14', '2026/11/14', '', 'abc', ' 2026-11-14',
  '2026-11-14 ', '2026-11-14\n', null, undefined, 5, {}, [], '2026-11-14T00:00:00Z',
]
const isValidDateCases = dates.map((v) => ({ input: v === undefined ? '__undefined__' : v, output: isValidDate(v) }))

// ── isValidTime ──────────────────────────────────────────────────────
const times = [
  '00:00', '23:59', '15:30', '24:00', '23:60', '1:30', '15:3', '15:30x', '', 'abc',
  ' 15:30', '15:30 ', '15:30:00', '25:00', '-1:00', '15:-30', null, 5,
]
const isValidTimeCases = times.map((v) => ({ input: v, output: isValidTime(v) }))

// ── localDate ────────────────────────────────────────────────────────
// 用 UTC 时间点扫：跨日、跨月、跨年、东八区凌晨 vs 深夜。
const atms = [
  Date.UTC(2026, 10, 14, 0, 0), Date.UTC(2026, 10, 14, 15, 59),
  Date.UTC(2026, 10, 14, 16, 0), Date.UTC(2026, 10, 14, 16, 1),
  Date.UTC(2026, 0, 1, 0, 0), Date.UTC(2026, 11, 31, 23, 59),
  Date.UTC(2024, 1, 29, 12, 0), 0, 86400000, -86400000,
  Date.UTC(2026, 10, 14, 7, 59), Date.UTC(2026, 10, 14, 8, 0),
]
const localDateCases = atms.map((at) => ({ input: at, output: localDate(at) }))

// ── timeOfDay ────────────────────────────────────────────────────────
const timeOfDayCases = atms.map((at) => ({ input: at, output: timeOfDay(at) }))

// ── daysBetween ──────────────────────────────────────────────────────
const pairs = [
  ['2026-11-14', '2026-11-14'], ['2026-11-14', '2026-11-15'], ['2026-11-15', '2026-11-14'],
  ['2026-01-01', '2026-12-31'], ['2024-02-28', '2024-03-01'], ['2023-02-28', '2023-03-01'],
  ['2026-11-14', '2027-11-14'], ['2026-12-31', '2027-01-01'],
]
const daysBetweenCases = pairs.map(([a, b]) => ({ a, b, output: daysBetween(a, b) }))

// ── boardProgress / boardStatus / taskDueTone ────────────────────────
const task = (status, extra = {}) => ({ id: 't' + Math.random().toString(36).slice(2, 8), title: 't', status, order: 0, ...extra })
const boards = [
  { tasks: [], endDate: undefined },
  { tasks: [task('todo')], endDate: undefined },
  { tasks: [task('done')], endDate: undefined },
  { tasks: [task('todo'), task('done'), task('doing')], endDate: undefined },
  { tasks: [task('canceled'), task('done')], endDate: undefined },
  { tasks: [task('canceled')], endDate: undefined },
  { tasks: [task('todo'), task('done')], endDate: '2026-11-20' },
  { tasks: [task('todo'), task('done')], endDate: '2026-11-14' },
  { tasks: [task('todo'), task('done')], endDate: '2026-11-17' }, // 剩 3 天 = SOON_DAYS
  { tasks: [task('todo'), task('done')], endDate: '2026-11-18' }, // 剩 4 天
  { tasks: [task('todo'), task('done')], endDate: '2026-11-10' }, // 已超期
  { tasks: [task('done'), task('done')], endDate: '2026-11-10' }, // 已完成 + 超期：complete 优先
  { tasks: [task('done'), task('done')], endDate: '2026-11-14' }, // 已完成 + 今天结束：complete 优先
  { tasks: [task('done')], endDate: 'not-a-date' },
  { tasks: [task('todo')], endDate: '2026-02-30' }, // 非法日期当作没填
]
const today = '2026-11-14'
const boardProgressCases = boards.map((b) => ({ input: { tasks: b.tasks.map((t, i) => ({ ...t, order: i })) }, output: boardProgress(b) }))
const boardStatusCases = boards.map((b) => ({ input: { tasks: b.tasks.map((t, i) => ({ ...t, order: i })), endDate: b.endDate }, today, output: boardStatus(b, today) }))

const dueCases = [
  { dueDate: '2026-11-14', status: 'todo' },
  { dueDate: '2026-11-14', status: 'done' },
  { dueDate: '2026-11-14', status: 'canceled' },
  { dueDate: '2026-11-13', status: 'todo' },
  { dueDate: '2026-11-13', status: 'doing' },
  { dueDate: '2026-11-15', status: 'todo' },
  { dueDate: '2026-11-30', status: 'todo' },
  { dueDate: undefined, status: 'todo' },
  { dueDate: 'bad', status: 'todo' },
  { dueDate: '2026-02-30', status: 'todo' },
].map((t, i) => ({ ...t, id: 'x' + i, title: 'x', order: 0 }))
const taskDueToneCases = dueCases.map((t) => ({ input: t, today, output: taskDueTone(t, today) }))

// ── scheduleMoment ───────────────────────────────────────────────────
const scheduleMomentCases = [
  ['2026-11-14', '15:00'], ['2026-11-14', '00:00'], ['2026-11-14', '23:59'],
  ['2026-02-30', '10:00'], ['2024-02-29', '12:00'], ['bad', '10:00'], ['2026-11-14', 'bad'],
].map(([date, tm]) => ({ date, time: tm, output: scheduleMoment(date, tm) }))

// ── repeatMatches ────────────────────────────────────────────────────
// 2026-11-14 是周六。构造一组重复规则 × 一周七天的矩阵，外加 monthly 几个边界。
const repeats = [
  { kind: 'none' }, { kind: 'daily' }, { kind: 'workdays' },
  { kind: 'weekly', days: [0] }, { kind: 'weekly', days: [6] }, { kind: 'weekly', days: [1, 3, 5] },
  { kind: 'weekly', days: [0, 6] }, { kind: 'weekly', days: [] },
  { kind: 'monthly', day: 14 }, { kind: 'monthly', day: 31 }, { kind: 'monthly', day: 29 },
]
const repeatDates = [
  '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15',
  '2026-11-30', '2026-11-29', '2026-02-28', '2024-02-29', '2026-01-31', '2026-04-30', '2026-04-31',
]
const repeatMatchesCases = []
for (const r of repeats) {
  for (const date of repeatDates) {
    // isValidDate 非法的日期原版会怎么走？repeatMatches 不校验，new Date 会给出 NaN.getDay()，行为未定义。
    // 只挑合法日期跑，免得产生依赖运行时实现的输出。
    if (!isValidDate(date)) continue
    repeatMatchesCases.push({ repeat: r, date, output: repeatMatches(r, date) })
  }
}

// ── pendingFires ─────────────────────────────────────────────────────
// now = 2026-11-14 12:00:00 本地时间，便于人脑推演。
// 用 new Date(y,m,d,h,mi) 与原版保持一致。
const now = new Date(2026, 10, 14, 12, 0, 0, 0).getTime()

const schedule1 = {
  id: 's1', title: 'once', date: '2026-11-14', time: '15:00',
  repeat: { kind: 'none' }, leadMinutes: 0, stopWhenTaskDone: false, paused: false,
}
const schedule2 = { ...schedule1, id: 's2', leadMinutes: 15 }
const schedule3 = { ...schedule1, id: 's3', leadMinutes: 1440 } // 提前一天
const schedule4 = { ...schedule1, id: 's4', paused: true }
const schedule5 = { ...schedule1, id: 's5', date: '2026-11-14', time: '11:00' } // 已过
const schedule6 = {
  ...schedule1, id: 's6', date: '2026-11-14', time: '12:30', leadMinutes: 30, // 触发时刻 12:30 - 30 = 12:00 弹
}
const dailySched = {
  id: 'sd', title: 'daily', date: '2026-11-10', time: '09:00',
  repeat: { kind: 'daily' }, leadMinutes: 0, stopWhenTaskDone: false, paused: false,
}
const workdaysSched = { ...dailySched, id: 'sw', repeat: { kind: 'workdays' } }
const weeklySched = { ...dailySched, id: 'swk', repeat: { kind: 'weekly', days: [1, 4] } } // 周一、周四
const monthlySched = { ...dailySched, id: 'sm', repeat: { kind: 'monthly', day: 14 } }
const monthlySched31 = { ...dailySched, id: 'sm31', repeat: { kind: 'monthly', day: 31 } }
const untilSched = { ...dailySched, id: 'su', until: '2026-11-15' }
const untilBadSched = { ...dailySched, id: 'sub', until: 'bad' }
const leadAndRepeatSched = { ...dailySched, id: 'sl', leadMinutes: 30 }
const lead1440Sched = { ...dailySched, id: 'sl1440', leadMinutes: 1440 }

// 窗口：[now-1min, now+1h]：应只命中 now 附近触发
const win1 = [now - 60_000, now + 3_600_000]
// 窗口：[now-24h, now]：应命中今天 09:00 的 daily / 周一到周五的 workdays
const win2 = [now - 86_400_000, now]
// 窗口：[now, now+48h]：跨日
const win3 = [now, now + 2 * 86_400_000]
// 窗口：[now, now+7d]：跨周
const win4 = [now, now + 7 * 86_400_000]
// 窗口：[now, now+35d]：跨月
const win5 = [now, now + 35 * 86_400_000]
// 窗口：[now-365d, now]：跨年夜
const win6 = [new Date(2025, 11, 31, 23, 0).getTime(), new Date(2026, 0, 1, 2, 0).getTime()]

const fireCases = []
const pushFires = (label, s, fromMs, toMs) => {
  fireCases.push({ label, schedule: s, fromMs, toMs, output: pendingFires(s, fromMs, toMs) })
}
// none
pushFires('once-3h', schedule1, ...win1)
pushFires('once-30m-lead', schedule6, ...win1)
pushFires('once-paused', schedule4, ...win1)
pushFires('once-lead-15', schedule2, ...win1)
pushFires('once-lead-1440-cross', schedule3, now + 12 * 3_600_000, now + 20 * 3_600_000) // 11-15 00:00 - 24h = 11-14 00:00 弹
pushFires('once-past', schedule5, ...win1)
pushFires('once-before-window', schedule1, now - 4 * 3_600_000, now - 3_600_000)
// daily
pushFires('daily-1h', dailySched, ...win1)
pushFires('daily-24h', dailySched, ...win2)
pushFires('daily-48h', dailySched, ...win3)
pushFires('daily-lead-30', leadAndRepeatSched, ...win3)
pushFires('daily-lead-1440', lead1440Sched, ...win3)
// workdays
pushFires('workdays-7d', workdaysSched, ...win4)
// weekly
pushFires('weekly-7d', weeklySched, ...win4)
// monthly
pushFires('monthly-35d', monthlySched, ...win5)
pushFires('monthly-31-35d', monthlySched31, ...win5)
// until
pushFires('daily-until-11-15', untilSched, ...win4)
pushFires('daily-until-bad', untilBadSched, ...win3)
// 跨年
const newyearSched = { ...dailySched, id: 'ny', date: '2025-12-30', time: '00:30' }
pushFires('daily-newyear', newyearSched, ...win6)

// ── nextFireAt ───────────────────────────────────────────────────────
const nextFireCases = [
  { label: 'once-future', schedule: schedule1, now, output: nextFireAt(schedule1, now) },
  { label: 'once-past', schedule: schedule5, now, output: nextFireAt(schedule5, now) },
  { label: 'once-paused', schedule: schedule4, now, output: nextFireAt(schedule4, now) },
  { label: 'daily', schedule: dailySched, now, output: nextFireAt(dailySched, now) },
  { label: 'workdays', schedule: workdaysSched, now, output: nextFireAt(workdaysSched, now) },
  { label: 'monthly', schedule: monthlySched, now, output: nextFireAt(monthlySched, now) },
  { label: 'until-passed', schedule: { ...untilSched, until: '2026-11-12' }, now, output: nextFireAt({ ...untilSched, until: '2026-11-12' }, now) },
  { label: 'lead-30', schedule: leadAndRepeatSched, now, output: nextFireAt(leadAndRepeatSched, now) },
]

const payload = {
  generatedFrom: 'mile-terminal-management/src/shared/planner.ts + node ' + process.version,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  now,
  today,
  isValidDate: isValidDateCases,
  isValidTime: isValidTimeCases,
  localDate: localDateCases,
  timeOfDay: timeOfDayCases,
  daysBetween: daysBetweenCases,
  boardProgress: boardProgressCases,
  boardStatus: boardStatusCases,
  taskDueTone: taskDueToneCases,
  scheduleMoment: scheduleMomentCases,
  repeatMatches: repeatMatchesCases,
  pendingFires: fireCases,
  nextFireAt: nextFireCases,
}
const json = JSON.stringify(payload, null, 1)
  .replace(/[^\x00-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, json + '\n', 'utf8')
console.log(`wrote ${out}`)
console.log(`  isValidDate ${isValidDateCases.length}, isValidTime ${isValidTimeCases.length}, localDate ${localDateCases.length}, timeOfDay ${timeOfDayCases.length}`)
console.log(`  daysBetween ${daysBetweenCases.length}, boardProgress ${boardProgressCases.length}, boardStatus ${boardStatusCases.length}, taskDueTone ${taskDueToneCases.length}`)
console.log(`  scheduleMoment ${scheduleMomentCases.length}, repeatMatches ${repeatMatchesCases.length}, pendingFires ${fireCases.length}, nextFireAt ${nextFireCases.length}`)
