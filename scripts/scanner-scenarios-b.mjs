// S15 对拍场景（二）：调度、互斥、失败推送、可见性、table()、元数据刷新、关注进程、关键字规整、上限。

const T0 = 1_700_000_000_000
const W = (o) => ({ world: o })
const R = { op: 'refresh' }
const P = (pid, name = 'node.exe', cmd = null, ppid = 1) => [pid, ppid, name, T0, cmd]

export const scenariosB = [
  {
    // start → 一轮采集，结束后按开始时刻排下一轮；fire 触发定时器
    name: 'schedule-cadence',
    clock: T0,
    steps: [
      W({ listens: [[1, 10]], procs: [P(10)], cost: 700 }),
      { op: 'start' },
      { op: 'fire' },
      // 单轮超过周期：立即接下一轮（wait 0）
      W({ cost: 2500 }),
      { op: 'fire' },
      W({ cost: 0 }),
      { op: 'fire' },
      // 不可见：降频到 10s；周期 1000 不可见也是 10000；周期 10000 不可见仍是 10000
      { op: 'setVisible', args: [false] },
      { op: 'setVisible', args: [false] },
      { op: 'isVisible' },
      { settings: { scanIntervalMs: 1000 } },
      { op: 'reschedule' },
      { settings: { scanIntervalMs: 10000 } },
      { op: 'reschedule' },
      { settings: { scanIntervalMs: 5000 } },
      // 恢复可见：立即补一次采集，并按新周期排
      { op: 'setVisible', args: [true] },
      { op: 'isVisible' },
      { op: 'stop' },
      { op: 'stop' },
    ],
  },
  {
    // 互斥：进行中时到来的 refresh 被丢弃。原版 tick 是 async，同步连续调用时第二次看到 running=true
    name: 'tick-mutex',
    clock: T0,
    steps: [
      W({ listens: [[1, 10]], procs: [P(10)] }),
      { op: 'refreshTwice' },
    ],
  },
  {
    name: 'failure-push',
    clock: T0,
    steps: [
      // 从没成功过：失败态里 lastSuccessAt 为 null，unmanaged / watched 为空
      W({ failListen: 'netstat 退出码 1' }),
      R,
      W({ failListen: null, listens: [[3000, 10]], procs: [P(10, 'node.exe', 'node C:\\a\\b.js')] }),
      R,
      W({ listens: [[3000, 10], [3001, 11]], procs: [P(10, 'node.exe', 'node C:\\a\\b.js'), P(11, 'node.exe', 'node C:\\x\\y.js')] }),
      R,
      // 元数据失败（未知 PID 触发刷新）：推失败态，带上次的 unmanaged；快照不变
      W({ listens: [[3000, 10], [3001, 11], [3002, 12]], failMeta: 'CIM 超时' }),
      { advance: 1000 },
      R,
      W({ failMeta: null, procs: [P(10, 'node.exe', 'node C:\\a\\b.js'), P(11, 'node.exe', 'node C:\\x\\y.js'), P(12)] }),
      { advance: 1000 },
      R,
    ],
  },
  {
    // 没有 error 监听器：只推失败态，不报错
    name: 'failure-no-listener',
    clock: T0,
    noErrorListener: true,
    steps: [W({ failListen: 'boom' }), R],
  },
  {
    // 元数据缓存：已知 PID 不刷；新 PID 刷；30 秒到期刷（> 30000 才算过期）
    name: 'meta-cache',
    clock: T0,
    steps: [
      W({ listens: [[1, 10]], procs: [P(10), P(11)] }),
      R,
      { advance: 1000 },
      W({ listens: [[1, 10], [2, 11]] }),
      R,
      { advance: 29000 },
      R,
      { advance: 1 },
      R,
      // 不在 mine 里的未知 PID 同样触发刷新（resolveMeta 只看 byPid）
      W({ listens: [[1, 10], [9, 99]] }),
      { advance: 100 },
      R,
      { advance: 100 },
      R,
    ],
  },
  {
    // table()：3 秒新鲜度、hint PID 不在 byPid 或不在 mine 都刷新；每次都重读监听行
    name: 'table-freshness',
    clock: T0,
    steps: [
      W({ listens: [[1, 10]], procs: [P(10), P(11)], mine: [10] }),
      { op: 'table', args: [[]] },
      { advance: 3000 },
      { op: 'table', args: [[10]] },
      { advance: 1 },
      { op: 'table', args: [[10]] },
      { op: 'table', args: [[11]] },
      W({ mine: [10, 11] }),
      { op: 'table', args: [[11]] },
      { op: 'table', args: [[11]] },
      { op: 'table', args: [[12]] },
      // 13 在 mine 里但 byPid 没有行：仍要刷新（只看 mine 会漏）
      W({ mine: [10, 11, 13] }),
      { op: 'table', args: [[12]] },
      { op: 'table', args: [[13]] },
      W({ failMeta: 'x' }),
      { advance: 5000 },
      { op: 'table', args: [[]] },
      W({ failMeta: null, failListen: 'y' }),
      { op: 'table', args: [[]] },
    ],
  },
  {
    name: 'watched',
    clock: T0,
    selfPid: 50,
    config: { watchedKeywords: ['Redis', 'mongo', '', 'redis'] },
    steps: [
      W({ listens: [[3000, 10]], procs: [
        P(10, 'node.exe', 'node redis-proxy.js'),
        P(20, 'redis-server.exe', 'redis-server --port 6379'),
        P(21, 'Mongod.EXE', null),
        P(22, 'x.exe', 'x --db=' + 'm'.repeat(200) + ' mongo'),
        P(23, 'other.exe', 'nothing here'),
        P(50, 'mile.exe', 'mile redis'),
        P(60, 'cmd.exe', 'redis', 4),
        P(61, 'redis.exe', 'r', 60),
        P(70, 'redis-x.exe', 'r'),
      ], mine: [70, 10, 20, 21, 22, 23, 50, 60, 61, 99], usage: { 20: [4, 40], 10: [1, 10] } }),
      { op: 'register', args: ['s', 60] },
      R,
      { advance: 1000 },
      W({ usage: { 20: [8, 41], 10: [2, 10] } }),
      R,
      // 整表替换：非数组抛错、非字符串跳过、规整后落盘
      { op: 'setWatched', args: ['redis'] },
      { op: 'setWatched', args: [null] },
      { op: 'setWatched', args: [{ 0: 'a' }] },
      { op: 'setWatched', args: [[1, null, '  MONGO ', ['x'], 'Mongo', ' \u3000 ', '\u00a0x\u00a0']] },
      { op: 'setWatched', args: [[]] },
    ],
  },
  {
    // 匹配串是「名字 + 空格 + 命令行」：跨边界的关键字带不带空格结果不同
    name: 'watched-boundary',
    clock: T0,
    config: { watchedKeywords: ['srv.exe --', 'app.exe-x'] },
    steps: [
      W({ listens: [], procs: [P(30, 'srv.exe', '--flag'), P(31, 'app.exe', '-x'), P(32, 'Q.EXE', null)] }),
      R,
      { op: 'setWatched', args: [['q.exe ']] },
    ],
  },
  {
    name: 'watched-limits',
    clock: T0,
    config: { watchedKeywords: ['w'] },
    steps: [
      W({ listens: [], procs: Array.from({ length: 60 }, (_, i) => P(100 + i, `w${i}.exe`, 'c'.repeat(158 + (i % 5)) + (i % 2 ? '\ud83d\ude00' : ''))) }),
      R,
      { op: 'setWatched', args: [Array.from({ length: 25 }, (_, i) => `k${i}`)] },
      { op: 'setWatched', args: [['x'.repeat(70), 'y'.repeat(64), 'Z'.repeat(63) + '\u0130']] },
      { op: 'setWatched', args: [['\ud83d\ude00'.repeat(40)]] },
    ],
  },
  {
    name: 'hide-once-cap',
    clock: T0,
    steps: [
      W({ listens: [[1, 10]], procs: [P(10)] }),
      R,
      { op: 'hideOnceMany', args: [1, 1000, 80] },
      // 满 1000 后不再记：第 1001 个（pid 1001）的 80 端口仍会提醒
      W({ listens: [[1, 10], [80, 1000], [80, 1001]], procs: [P(10), P(1000, 'node.exe', null), P(1001, 'node.exe', null)] }),
      { op: 'hideOnce', args: [1001, 80] },
    ],
  },
  {
    name: 'ignore-cap',
    clock: T0,
    config: { ignoredListeners: Array.from({ length: 499 }, (_, i) => ({ processName: 'n', port: i + 1 })) },
    steps: [
      W({ listens: [[1, 10]], procs: [P(10)] }),
      { op: 'ignore', args: ['n', 1] },
      { op: 'ignore', args: ['n', 600] },
      { op: 'ignore', args: ['n', 601] },
    ],
  },
]
