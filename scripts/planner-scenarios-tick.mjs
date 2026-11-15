// S12 服务层对拍场景（三）：tick 触发引擎。
// 覆盖：到点弹、提前量、过点 1 小时内补弹、超过 1 小时记错过、snooze 到点重弹、暂停不弹也不记、
// 关联任务完成后停止、plannerNotify 关闭、工作组已删除的组名、跨日 / 跨周 / 工作日、missed 上限 200、
// 无变化不写盘、同一时刻不重复弹。

const G = (id, name = id) => ({ id, name, env: 'dev', createdAt: 1, order: 0 })
const groups = [G('g1', '前端'), G('g2', '后端')]
const at = (date, time = '00:00') => new Date(`${date}T${time}:00`).getTime()
const MIN = 60_000

// 先建看板、任务、日程，再拨钟 tick
const setup = (schedules, tasks = []) => [
  { op: 'addBoard', args: ['g1'] },
  ...tasks.map((t) => ({ op: 'addTask', args: ['id-1', t] })),
  ...schedules.map((s) => ({ op: 'addSchedule', args: ['id-1', s] })),
]

export const tick = [
  {
    name: 'tick-once-ontime',
    groups,
    clock: at('2026-11-14', '09:00'),
    ops: [
      ...setup([{ title: '准点', date: '2026-11-14', time: '10:00' }, { title: '提前15', date: '2026-11-14', time: '10:00', leadMinutes: 15 }]),
      { op: 'tick' },
      { clock: at('2026-11-14', '09:45') },
      { op: 'tick' },
      { op: 'tick' },
      { clock: at('2026-11-14', '10:00') },
      { op: 'tick' },
      { clock: at('2026-11-14', '10:30') },
      { op: 'tick' },
    ],
  },
  {
    name: 'tick-late-and-missed',
    groups,
    clock: at('2026-11-14', '08:00'),
    ops: [
      ...setup([
        { title: '晚 59 分', date: '2026-11-14', time: '09:01' },
        { title: '晚整 1 小时', date: '2026-11-14', time: '09:00' },
        { title: '晚 61 分', date: '2026-11-14', time: '08:59' },
        { title: '提前 1 天晚 2 小时', date: '2026-11-15', time: '08:00', leadMinutes: 1440 },
      ]),
      { clock: at('2026-11-14', '10:00') },
      { op: 'tick' },
      { op: 'tick' },
    ],
  },
  {
    name: 'tick-daily-backlog',
    groups,
    clock: at('2026-11-01', '08:00'),
    ops: [
      ...setup([
        { title: '每天', date: '2026-11-01', time: '09:00', repeat: { kind: 'daily' } },
        { title: '工作日', date: '2026-11-01', time: '09:00', repeat: { kind: 'workdays' } },
        { title: '周二四', date: '2026-11-01', time: '09:00', repeat: { kind: 'weekly', days: [2, 4] }, until: '2026-11-12' },
        { title: '每月 31', date: '2026-10-01', time: '09:00', repeat: { kind: 'monthly', day: 31 } },
      ]),
      // 两周没开：之前每一次都进 missed，最近一次（今天 09:00，晚 30 分）弹出
      { clock: at('2026-11-14', '09:30') },
      { op: 'tick' },
      { clock: at('2026-11-15', '09:00') },
      { op: 'tick' },
      { clock: at('2026-11-30', '09:00') },
      { op: 'tick' },
    ],
  },
  {
    name: 'tick-snooze',
    groups,
    clock: at('2026-11-14', '09:00'),
    ops: [
      ...setup([{ title: '稍后', date: '2026-11-14', time: '09:00' }]),
      { op: 'tick' },
      { op: 'editSchedule', args: ['id-1', 'id-2', { title: '稍后', snoozeUntil: at('2026-11-14', '09:10') }] },
      { clock: at('2026-11-14', '09:09') },
      { op: 'tick' },
      { clock: at('2026-11-14', '09:10') },
      { op: 'tick' },
      { op: 'tick' },
      // 暂停中的 snooze 不弹也不清
      { op: 'editSchedule', args: ['id-1', 'id-2', { title: '稍后', snoozeUntil: at('2026-11-14', '09:20'), paused: true }] },
      { clock: at('2026-11-14', '09:30') },
      { op: 'tick' },
      // plannerNotify 关闭时 snooze 到点只清掉、不弹
      { op: 'editSchedule', args: ['id-1', 'id-2', { title: '稍后', paused: false }] },
      { op: 'editSchedule', args: ['id-1', 'id-2', { title: '稍后', snoozeUntil: at('2026-11-14', '09:31') }] },
      { notify: false },
      { clock: at('2026-11-14', '09:40') },
      { op: 'tick' },
    ],
  },
  {
    name: 'tick-paused-and-notify-off',
    groups,
    notify: false,
    clock: at('2026-11-14', '08:00'),
    ops: [
      ...setup([
        { title: '关通知', date: '2026-11-14', time: '09:00' },
        { title: '关通知过点', date: '2026-11-14', time: '06:00' },
        { title: '暂停', date: '2026-11-14', time: '09:00', paused: true },
      ]),
      { clock: at('2026-11-14', '09:00') },
      { op: 'tick' },
      { notify: true },
      { op: 'tick' },
    ],
  },
  {
    name: 'tick-stop-when-done',
    groups,
    clock: at('2026-11-14', '08:00'),
    ops: [
      ...setup(
        [
          { taskId: 'id-2', date: '2026-11-14', time: '09:00', repeat: { kind: 'daily' } },
          { taskId: 'id-2', date: '2026-11-14', time: '09:00', repeat: { kind: 'daily' }, stopWhenTaskDone: false },
          { taskId: 'id-3', date: '2026-11-14', time: '09:00', repeat: { kind: 'daily' } },
          { taskId: 'id-3', date: '2026-11-20', time: '09:00', repeat: { kind: 'daily' } },
        ],
        [{ title: '甲' }, { title: '乙' }],
      ),
      { clock: at('2026-11-14', '09:00') },
      { op: 'tick' },
      { op: 'editTask', args: ['id-1', 'id-2', { status: 'done' }] },
      { op: 'editTask', args: ['id-1', 'id-3', { status: 'canceled' }] },
      // 两天没开：id-4 先补齐 missed 再停；id-5 还没到第一次就因任务取消直接停
      { clock: at('2026-11-16', '12:00') },
      { op: 'tick' },
      { op: 'tick' },
      { op: 'removeTask', args: ['id-1', 'id-2'] },
      { op: 'editSchedule', args: ['id-1', 'id-5', { title: '', paused: false }] },
      { op: 'tick' },
    ],
  },
  {
    name: 'tick-group-deleted',
    groups,
    clock: at('2026-11-14', '08:59'),
    ops: [
      ...setup([{ title: '组没了', date: '2026-11-14', time: '09:00' }]),
      { groups: [G('g2', '后端')] },
      { clock: at('2026-11-14', '09:00') },
      { op: 'tick' },
    ],
  },
  {
    name: 'tick-missed-cap',
    groups,
    clock: at('2025-01-01', '00:00'),
    ops: [
      ...setup([{ title: '一年没开', date: '2025-01-01', time: '09:00', repeat: { kind: 'daily' } }]),
      { clock: at('2025-09-01', '12:00') },
      { op: 'tick' },
      { clock: at('2025-09-03', '12:00') },
      { op: 'tick' },
    ],
  },
  {
    name: 'tick-file-lastfired',
    groups,
    clock: at('2026-11-14', '09:05'),
    file: JSON.stringify({
      version: 1,
      boards: [{ id: 'b1', groupId: 'g1', createdAt: 1, order: 0, tasks: [{ id: 't1', title: 'x', status: 'done', order: 0 }], schedules: [
        { id: 's1', title: '已弹过', date: '2026-11-14', time: '09:00', repeat: { kind: 'none' }, leadMinutes: 0, stopWhenTaskDone: true, paused: false, lastFiredAt: at('2026-11-14', '09:00') },
        { id: 's2', title: '每天已弹', date: '2026-11-13', time: '09:00', repeat: { kind: 'daily' }, leadMinutes: 0, stopWhenTaskDone: true, paused: false, lastFiredAt: at('2026-11-13', '09:00') },
        { id: 's3', title: '任务已完成', taskId: 't1', date: '2026-11-20', time: '09:00', repeat: { kind: 'daily' }, leadMinutes: 0, stopWhenTaskDone: true, paused: false },
        { id: 's4', title: '任务已完成但不停', taskId: 't1', date: '2026-11-20', time: '09:00', repeat: { kind: 'daily' }, leadMinutes: 0, stopWhenTaskDone: false, paused: false },
        { id: 's5', title: '任务丢了', taskId: 'gone', date: '2026-11-20', time: '09:00', repeat: { kind: 'daily' }, leadMinutes: 0, stopWhenTaskDone: true, paused: false },
      ] }],
    }),
    ops: [{ op: 'tick' }, { op: 'tick' }],
  },
  {
    // 关联任务已完成：昨天那次进 missed 并当场暂停，今天 30 分钟前那次本可以弹，但已暂停所以不弹
    name: 'tick-stop-mid-loop',
    groups,
    clock: at('2026-11-14', '09:30'),
    file: JSON.stringify({
      version: 1,
      boards: [{ id: 'b1', groupId: 'g1', createdAt: 1, order: 0, tasks: [{ id: 't1', title: 'x', status: 'done', order: 0 }], schedules: [
        { id: 's1', title: '停在中途', taskId: 't1', date: '2026-11-01', time: '09:00', repeat: { kind: 'daily' }, leadMinutes: 0, stopWhenTaskDone: true, paused: false, lastFiredAt: at('2026-11-12', '09:00') },
      ] }],
    }),
    ops: [{ op: 'tick' }],
  },
  {
    // 这一轮唯一的变化是「关联任务已完成 → 收尾暂停」，必须写盘
    name: 'tick-stop-only',
    groups,
    clock: at('2026-11-14', '09:05'),
    file: JSON.stringify({
      version: 1,
      boards: [{ id: 'b1', groupId: 'g1', createdAt: 1, order: 0, tasks: [{ id: 't1', title: 'x', status: 'canceled', order: 0 }], schedules: [
        { id: 's1', title: '只会被收尾暂停', taskId: 't1', date: '2026-11-20', time: '09:00', repeat: { kind: 'daily' }, leadMinutes: 0, stopWhenTaskDone: true, paused: false },
      ] }],
    }),
    ops: [{ op: 'tick' }, { op: 'tick' }],
  },
  {
    // 已知原版问题 I6：每天重复 + 提前 1440 分钟只隔天弹一次。
    // 上一次触发时刻 = 下一次的提醒时刻，from = lastFiredAt + 1 把它挡在窗口外，之后再也追不上。
    // 同板放一条提前 0 分钟的对照：每天都弹
    name: 'tick-known-issue-i6',
    groups,
    clock: at('2026-11-14', '08:00'),
    ops: [
      ...setup([
        { title: '提前一天', date: '2026-11-16', time: '09:00', repeat: { kind: 'daily' }, leadMinutes: 1440 },
        { title: '准点', date: '2026-11-16', time: '09:00', repeat: { kind: 'daily' } },
        { title: '工作日提前一天', date: '2026-11-16', time: '09:00', repeat: { kind: 'workdays' }, leadMinutes: 1440 },
      ]),
      ...Array.from({ length: 24 * 7 }, (_, h) => [{ clock: at('2026-11-14', '08:00') + h * 3_600_000 }, { op: 'tick' }]).flat(),
    ],
  },
]
