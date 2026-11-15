// S14 对拍场景。前五组照抄原版 scripts/verify-review-ownership.cjs 的合成用例，之后是边界。
// 表格式：{ rows: [[pid, ppid, startedAt|null], ...], mine?: [pid...] }，mine 缺省为全部 pid。

const T0 = 1_700_000_000_000
const R = 5000 // ROOT_PID
const C = 5100 // CHILD_PID
const tb = (rows, mine) => (mine ? { rows, mine } : { rows })
const v = (pid, table) => ({ op: 'verify', pid, table })
const k = (pid, table, sessionId) => ({ op: 'assertKillable', pid, table, sessionId })
const reg = (s, pid, tok = 'tok') => ({ op: 'register', args: [s, pid, tok] })
const unreg = (s) => ({ op: 'unregister', args: [s] })
const has = { op: 'hasTracked' }

export const scenarios = [
  {
    name: 'review-1-root-unchanged',
    clock: T0,
    steps: [
      reg('s1', R),
      v(R, tb([[R, 1000, T0 - 200], [C, R, T0 + 500]])),
      v(C, tb([[R, 1000, T0 - 200], [C, R, T0 + 500]])),
    ],
  },
  {
    name: 'review-2-root-pid-reused',
    clock: T0,
    steps: [
      reg('s1', R),
      v(R, tb([[R, 1000, T0 - 200]])),
      v(R, tb([[R, 1000, T0 + 30_000], [C, R, T0 + 31_000]])),
      v(C, tb([[R, 1000, T0 + 30_000], [C, R, T0 + 31_000]])),
      k(R, tb([[R, 1000, T0 + 30_000]]), 's1'),
    ],
  },
  {
    name: 'review-3-first-seen-after-reuse',
    clock: T0,
    steps: [reg('s1', R), v(R, tb([[R, 1000, T0 + 30_000]]))],
  },
  {
    name: 'review-4-child-older-than-root',
    clock: T0,
    steps: [reg('s1', R), v(C, tb([[R, 1000, T0 - 200], [C, R, T0 - 10_000]]))],
  },
  {
    name: 'review-5-assert-session',
    clock: T0,
    steps: [
      reg('s1', R),
      reg('s2', 6000, 'tok2'),
      k(R, tb([[R, 1000, T0 - 200], [6000, 1000, T0 - 100]]), 's1'),
      k(6000, tb([[R, 1000, T0 - 200], [6000, 1000, T0 - 100]]), 's1'),
      k(C, tb([[R, 1000, T0 - 200], [C, R, T0], [6000, 1000, T0 - 100]]), 's2'),
      k(9999, tb([[R, 1000, T0 - 200], [9999, 1000, T0]]), 's1'),
      k(R, tb([[R, 1000, T0 - 200]], []), 's1'),
    ],
  },
  {
    name: 'empty-registry',
    clock: T0,
    steps: [
      has,
      v(R, tb([[R, 1000, T0]])),
      v(R, tb([[R, 1000, T0]], [])),
      k(R, tb([[R, 1000, T0]]), 's1'),
      k(R, tb([[R, 1000, T0]], []), 's1'),
      unreg('nope'),
      has,
    ],
  },
  {
    // 不同用户：即便父链命中登记根也判 foreign，processGroup / sessionId 照样带出
    name: 'foreign-beats-group',
    clock: T0,
    steps: [
      reg('s1', R),
      v(C, tb([[R, 1000, T0 - 200], [C, R, T0]], [R])),
      v(R, tb([[R, 1000, T0 - 200], [C, R, T0]], [C])),
      k(C, tb([[R, 1000, T0 - 200], [C, R, T0]], [R]), 's1'),
    ],
  },
  {
    name: 'chain-stops',
    clock: T0,
    steps: [
      reg('s1', 4),
      reg('s2', R),
      // ppid <= 4 就停，即使 4 本身登记过
      v(7000, tb([[7000, 4, T0], [4, 0, T0 - 100]])),
      v(7001, tb([[7001, 3, T0]])),
      v(7002, tb([[7002, 0, T0]])),
      v(7003, tb([[7003, -1, T0]])),
      // ppid 5 不停，继续上溯（5 没有行，断链）
      v(7004, tb([[7004, 5, T0]])),
      // 自环
      v(7005, tb([[7005, 7005, T0]])),
      // 断链：中间进程不在表里
      v(7006, tb([[7006, 7007, T0], [R, 1000, T0 - 200]])),
      // 中间进程在，往上命中根
      v(7006, tb([[7006, 7007, T0], [7007, R, T0], [R, 1000, T0 - 200]])),
      // 根 PID 自己就是 4：直接命中登记（cursor 先查登记表再查 ppid）
      v(4, tb([[4, 0, T0 - 100]])),
      // 被查询的 PID 不在表里
      v(8888, tb([[R, 1000, T0 - 200]])),
      // 两个进程互为父子的环
      v(7010, tb([[7010, 7011, T0], [7011, 7010, T0]])),
    ],
  },
  {
    // 上溯上限：hop 0 查 pid 自己，最多查到第 11 层祖先
    name: 'max-ascent',
    clock: T0,
    steps: [
      reg('s1', R),
      ...[10, 11, 12, 13].map((depth) => {
        const rows = [[R, 1000, T0 - 200]]
        let parent = R
        for (let d = depth; d >= 1; d--) {
          const pid = 20000 + depth * 100 + d
          rows.push([pid, parent, T0 + d])
          parent = pid
        }
        return v(parent, tb(rows))
      }),
    ],
  },
  {
    name: 'started-at-missing-or-zero',
    clock: T0,
    steps: [
      reg('s1', R),
      v(R, tb([[R, 1000, null]])),
      v(R, tb([[R, 1000, 0]])),
      v(C, tb([[R, 1000, null], [C, R, T0]])),
      // 根缺行：从子进程上溯时 roots 命中 R，但 R 不在表里
      v(C, tb([[C, R, T0]])),
      // 根正常、子进程缺 / 为 0
      v(C, tb([[R, 1000, T0 - 200], [C, R, null]])),
      v(C, tb([[R, 1000, T0 - 200], [C, R, 0]])),
      // 负的创建时间是真值，照常比较
      v(C, tb([[R, 1000, T0 - 200], [C, R, -5]])),
    ],
  },
  {
    name: 'register-slack-boundary',
    clock: T0,
    steps: [
      reg('a', 5001),
      reg('b', 5002),
      reg('c', 5003),
      v(5001, tb([[5001, 1000, T0 + 5000]])),
      v(5002, tb([[5002, 1000, T0 + 5001]])),
      v(5003, tb([[5003, 1000, T0 - 3_600_000]])),
      // 首次观察被拒不钉住：之后看到合规的创建时间仍可钉住
      v(5002, tb([[5002, 1000, T0 + 4000]])),
      v(5002, tb([[5002, 1000, T0 + 4000 + 1000]])),
      v(5002, tb([[5002, 1000, T0 + 4000 + 1001]])),
      // 拨钟后再登记：registeredAt 跟着变
      { clock: T0 + 60_000 },
      reg('d', 5004),
      v(5004, tb([[5004, 1000, T0 + 65_000]])),
    ],
  },
  {
    name: 'same-process-boundary',
    clock: T0,
    steps: [
      reg('s1', R),
      // 从子进程第一次观察，也会钉住根的创建时间
      v(C, tb([[R, 1000, T0 - 200], [C, R, T0]])),
      v(R, tb([[R, 1000, T0 - 200 + 1000]])),
      v(R, tb([[R, 1000, T0 - 200 - 1000]])),
      v(R, tb([[R, 1000, T0 - 200 + 1001]])),
      v(R, tb([[R, 1000, T0 - 200 - 1001]])),
      // 被拒后钉住的值不变
      v(R, tb([[R, 1000, T0 - 200]])),
      // 子进程创建时间下界：根创建时间 - 1000
      v(C, tb([[R, 1000, T0 - 200], [C, R, T0 - 200 - 1000]])),
      v(C, tb([[R, 1000, T0 - 200], [C, R, T0 - 200 - 1001]])),
      // 子进程下界跟钉住值走，不跟本次读数走
      v(C, tb([[R, 1000, T0 - 200 + 900], [C, R, T0 - 200 - 1000]])),
      v(C, tb([[R, 1000, T0 - 200 + 900], [C, R, T0 - 200 - 1001]])),
    ],
  },
  {
    name: 'duplicate-root-and-reregister',
    clock: T0,
    steps: [
      reg('s1', R),
      reg('s2', R),
      v(R, tb([[R, 1000, T0 - 200]])),
      k(R, tb([[R, 1000, T0 - 200]]), 's1'),
      k(R, tb([[R, 1000, T0 - 200]]), 's2'),
      // 重登 s1：Map 位置不变，s2 仍在后面，所以仍归 s2
      { clock: T0 + 10 },
      reg('s1', R, 'tok3'),
      v(R, tb([[R, 1000, T0 - 200]])),
      unreg('s2'),
      v(R, tb([[R, 1000, T0 - 200]])),
      has,
      // 重登换新 PID：旧 PID 不再归属
      reg('s1', 6000),
      v(R, tb([[R, 1000, T0 - 200]])),
      v(6000, tb([[6000, 1000, T0]])),
      unreg('s1'),
      has,
      v(6000, tb([[6000, 1000, T0]])),
    ],
  },
  {
    // 重登会丢掉钉住的创建时间：同一 PID 换了个进程，重登后重新钉
    name: 'reregister-resets-pin',
    clock: T0,
    steps: [
      reg('s1', R),
      v(R, tb([[R, 1000, T0 - 200]])),
      v(R, tb([[R, 1000, T0 + 3000]])),
      reg('s1', R),
      v(R, tb([[R, 1000, T0 + 3000]])),
      v(R, tb([[R, 1000, T0 - 200]])),
    ],
  },
  {
    name: 'nested-sessions',
    clock: T0,
    steps: [
      reg('outer', R),
      reg('inner', C),
      // 孙进程先碰到内层根
      v(5200, tb([[R, 1000, T0 - 200], [C, R, T0], [5200, C, T0 + 10]])),
      k(5200, tb([[R, 1000, T0 - 200], [C, R, T0], [5200, C, T0 + 10]]), 'outer'),
      // 内层根校验失败时直接判 null，不继续往上找外层根
      v(5200, tb([[R, 1000, T0 - 200], [C, R, T0 + 9000], [5200, C, T0 + 9010]])),
      v(C, tb([[R, 1000, T0 - 200], [C, R, T0 + 9000]])),
      unreg('inner'),
      v(5200, tb([[R, 1000, T0 - 200], [C, R, T0 + 9000], [5200, C, T0 + 9010]])),
    ],
  },
  {
    // ppid 恰为 5 不停：登记根是 5 时能命中
    name: 'ppid-5-continues',
    clock: T0,
    steps: [reg('s5', 5), v(7004, tb([[7004, 5, T0], [5, 0, T0 - 100]]))],
  },
  {
    // 根创建时间很小（<= 1000）时，子进程缺创建时间仍拒绝：不能拿 0 去比
    name: 'small-root-time-child-missing',
    clock: 2000,
    steps: [
      reg('s1', R),
      v(C, tb([[R, 1000, 500], [C, R, null]])),
      v(C, tb([[R, 1000, 500], [C, R, 0]])),
      v(C, tb([[R, 1000, 500], [C, R, 1]])),
      v(C, tb([[R, 1000, -100], [C, R, -1100]])),
      v(C, tb([[R, 1000, -100], [C, R, -1101]])),
    ],
  },
  {
    // 注销后再登记同一会话：必须重新生效
    name: 'unregister-then-register',
    clock: T0,
    steps: [
      reg('s1', R),
      unreg('s1'),
      has,
      reg('s1', R),
      has,
      v(R, tb([[R, 1000, T0 - 200]])),
      reg('s2', 6000),
      unreg('s1'),
      reg('s1', R),
      // s1 现在排在 s2 后面
      v(6000, tb([[6000, 1000, T0]])),
      unreg('s2'),
      v(6000, tb([[6000, 1000, T0]])),
      v(R, tb([[R, 1000, T0 - 200]])),
    ],
  },
  {
    name: 'assert-messages',
    clock: T0,
    steps: [
      reg('s1', R),
      k(C, tb([[R, 1000, T0 - 200], [C, R, T0]]), 's1'),
      k(C, tb([[R, 1000, T0 - 200], [C, R, T0]]), ''),
      k(C, tb([[R, 1000, T0 - 200], [C, R, T0]]), '会话甲'),
      k(9000, tb([[9000, 1000, T0]]), 's1'),
      k(9000, tb([[9000, 1000, T0]], []), 's1'),
      k(R, tb([[R, 1000, T0 + 9000]]), 's1'),
    ],
  },
]
