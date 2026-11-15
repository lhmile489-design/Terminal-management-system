// S15 对拍场景（一）：一轮采集的结果 —— 归属、分组、条目反查、cwd 推断、新端口提醒、增量、指标、系统负载。
//
// 世界格式：
//   listens: [[port, pid, families?], ...]
//   procs:   [[pid, ppid, name, startedAt?, commandLine?, execPath?], ...]，mine 缺省为全部 pid
//   usage:   { pid: [cpu, memory] } 或 'fail'；cpus: [[user, nice, sys, idle, irq], ...]；mem: [total, free]
// 步骤：{ world } 合并进世界；{ expect } 设条目预期；{ clock } / { advance }；其余是方法调用。

const T0 = 1_700_000_000_000
const W = (o) => ({ world: o })
const R = { op: 'refresh' }

// 一个典型的本机：explorer → code → cmd → node（vite），另有后台 svchost、外部 python
const baseProcs = [
  [1000, 4, 'explorer.exe', T0 - 9e6, 'C:\\Windows\\explorer.exe', 'C:\\Windows\\explorer.exe'],
  [1100, 1000, 'Code.exe', T0 - 8e6, '"C:\\Users\\u\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe"', 'C:\\Users\\u\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe'],
  [1200, 1100, 'cmd.exe', T0 - 7e6, 'cmd.exe /c npm run dev', 'C:\\Windows\\System32\\cmd.exe'],
  [1300, 1200, 'node.exe', T0 - 6e6, '"node" "D:\\work\\shop\\node_modules\\vite\\bin\\vite.js"', 'C:\\Program Files\\nodejs\\node.exe'],
  [1400, 1000, 'python.exe', T0 - 5e6, 'python D:\\tools\\srv\\main.py', 'C:\\Python312\\python.exe'],
  [800, 600, 'svchost.exe', T0 - 1e7, 'C:\\Windows\\system32\\svchost.exe -k RPCSS', 'C:\\Windows\\System32\\svchost.exe'],
  [600, 4, 'services.exe', T0 - 2e7, null, null],
  [2000, 1000, 'other.exe', T0 - 1e6, 'other', 'D:\\x\\other.exe'],
]

export const scenariosA = [
  {
    name: 'basic-first-tick-baseline',
    clock: T0,
    steps: [
      W({ listens: [[5173, 1300], [5173, 1300, [6]], [135, 800], [8000, 1400], [9999, 2000]], procs: baseProcs, mine: [1000, 1100, 1200, 1300, 1400, 800, 600], usage: { 1300: [12, 1000], 1400: [3, 2000], 800: [1, 300] }, cpus: [[100, 0, 50, 850, 0]], mem: [1000, 400] }),
      R,
      // 第二轮：基线已定，同一批不进新端口提醒；CPU 有了基线
      { advance: 2000 },
      W({ usage: { 1300: [24.6, 1100], 1400: [3, 2000], 800: [1.04, 300] }, cpus: [[150, 0, 80, 900, 0], [10, 0, 10, 80, 0]] }),
      R,
      // 第三轮：新的外部 node 监听进来 → 进 unmanaged；python 的 8000 是基线不提醒
      { advance: 2000 },
      W({ listens: [[5173, 1300], [135, 800], [8000, 1400], [3000, 3000], [3001, 3000]], procs: [...baseProcs, [3000, 1000, 'node.exe', T0 + 3000, 'node D:\\work\\api\\server.js', 'C:\\Program Files\\nodejs\\node.exe']], mine: [1000, 1100, 1200, 1300, 1400, 800, 600, 3000] }),
      R,
      { op: 'knownPath', args: ['D:\\work\\api'] },
      { op: 'knownPath', args: ['d:\\work\\api'] },
      { op: 'knownPath', args: ['D:\\work\\shop'] },
      // 推不出目录的监听项（svchost）cwd 是 undefined，空串不在白名单里
      { op: 'knownPath', args: [''] },
      { op: 'listenRows' },
      // 第四轮：3000 消失 → removedPids；1300 换端口 → updated
      { advance: 2000 },
      W({ listens: [[5174, 1300], [135, 800], [8000, 1400]] }),
      R,
    ],
  },
  {
    name: 'owned-and-entries',
    clock: T0,
    steps: [
      W({ listens: [[5173, 1300], [4000, 4100], [4001, 4200], [4002, 4300], [4003, 4400]], procs: [
        ...baseProcs,
        [4000, 1000, 'cmd.exe', T0 - 100, 'cmd.exe', null],
        [4100, 4000, 'node.exe', T0, '"node" "server.cjs"', null],
        [4200, 1000, 'java.exe', T0, 'java -jar D:\\work\\boot\\target\\app.jar', null],
        [4300, 1000, 'node.exe', T0, 'node D:\\WORK\\Shop\\sub\\tool.mjs', null],
        [4400, 1000, 'node.exe', T0, 'node D:\\work\\shopping\\x.ts', null],
      ] }),
      { op: 'register', args: ['sess-a', 4000] },
      { expect: [
        { id: 'e-root', port: 4000, cwd: 'D:\\work\\root', sessionId: 'sess-a' },
        { id: 'e-pid', port: 4001, cwd: 'D:\\work\\boot', pid: 4200 },
        { id: 'e-shop', port: 5173, cwd: 'D:\\work\\shop' },
        { id: 'e-dup', port: 5173, cwd: 'D:\\work\\shop2' },
        { id: 'e-noport', cwd: 'D:\\nowhere' },
        { id: 'e-zero', port: 0, cwd: 'D:\\z' },
      ] },
      R,
      // 会话注销后 4100 变成 external；e-root 的 cwd 不再回填
      { op: 'unregister', args: ['sess-a'] },
      { advance: 1000 },
      R,
      // 基线之后本应用新拉起的服务开端口：owned，不进新端口提醒（同时出现的外部 node 进）
      W({ listens: [[5173, 1300], [4500, 4500], [4600, 4600]], procs: [
        ...baseProcs,
        [4500, 1000, 'node.exe', T0 + 3000, 'node D:\\new\\x.js', null],
        [4600, 1000, 'node.exe', T0 + 3000, 'node D:\\ext\\x.js', null],
      ] }),
      { op: 'register', args: ['sess-b', 4500] },
      { advance: 1000 },
      R,
    ],
  },
  {
    name: 'group-overrides',
    clock: T0,
    config: { groupOverrides: [{ processName: 'PYTHON.EXE', group: 'background' }, { processName: 'svchost.exe', group: 'mine' }, { processName: 'node.exe', group: 'background' }] },
    steps: [
      W({ listens: [[8000, 1400], [135, 800], [5173, 1300], [6000, 6100]], procs: [...baseProcs, [6000, 1000, 'cmd.exe', T0 - 100, null, null], [6100, 6000, 'node.exe', T0, null, null]] }),
      { op: 'register', args: ['s', 6000] },
      { expect: [{ id: 'e1', cwd: 'D:\\work\\shop' }] },
      R,
      // 改分组：设置 / 覆盖同名（大小写不敏感）/ 清除 / 空白名忽略
      { op: 'setGroup', args: ['  Python.exe  ', 'mine'] },
      { op: 'setGroup', args: ['svchost.exe', null] },
      { op: 'setGroup', args: ['   ', 'mine'] },
      { op: 'setGroup', args: ['', 'mine'] },
      { op: 'setGroup', args: ['other.exe', 'background'] },
    ],
  },
  {
    name: 'unmanaged-filters',
    clock: T0,
    // 第二项端口相同、进程名不同：不能把 node.exe 的 3000 一起忽略掉
    config: { ignoredListeners: [{ processName: 'node.exe', port: 3001 }, { processName: 'other.exe', port: 3000 }] },
    steps: [
      W({ listens: [[5173, 1300]], procs: baseProcs }),
      R,
      W({ listens: [[5173, 1300], [3000, 3000], [3001, 3000], [3002, 3000], [7000, 7000], [7001, 7100]], procs: [...baseProcs,
        [3000, 1000, 'node.exe', T0, 'node index.js', null],
        [7000, 1000, 'chrome.exe', T0, 'chrome', 'C:\\Program Files\\Google\\Chrome\\chrome.exe'],
        [7100, 1000, 'node.exe', T0, 'node C:\\Windows\\x.js', 'C:\\Windows\\node.exe'],
      ] }),
      R,
      { op: 'hideOnce', args: [3002, 3002] },
      { op: 'hideOnce', args: [3000, 3002] },
      { op: 'ignore', args: ['node.exe', 3000] },
      { op: 'ignore', args: ['node.exe', 3000] },
      // 没有行的 pid（进程表里查不到）：processName 为 pid N，忽略按空名匹配
      W({ listens: [[5173, 1300], [3005, 9100]], mine: [...baseProcs.map((p) => p[0]), 9100] }),
      R,
      { op: 'ignore', args: ['', 3005] },
    ],
  },
  {
    name: 'foreign-and-missing-rows',
    clock: T0,
    steps: [
      // mine 不含 2000：foreign 不进监听表；9200 在 mine 里但进程表没有行
      W({ listens: [[9999, 2000], [8080, 9200], [8081, 9200], [8080, 9201]], procs: baseProcs, mine: [1000, 9200, 9201] }),
      R,
      { op: 'listenRows' },
    ],
  },
  {
    name: 'cwd-guess',
    clock: T0,
    steps: [
      W({ listens: [[1, 10], [2, 11], [3, 12], [4, 13], [5, 14], [6, 15], [7, 16], [8, 17], [9, 18], [10, 19], [11, 20], [12, 21], [13, 22], [14, 23]], procs: [
        [10, 1, 'node.exe', T0, 'node C:\\a.js'],
        [11, 1, 'node.exe', T0, 'node C:\\ab\\c.js'],
        [12, 1, 'node.exe', T0, 'node C:/x/y/z.mjs --port 1'],
        [13, 1, 'node.exe', T0, 'node "C:\\p q\\node_modules\\.bin\\vite.cjs"'],
        [14, 1, 'node.exe', T0, 'node C:\\node_modules\\x.js'],
        [15, 1, 'node.exe', T0, 'node C:\\r\\NODE_MODULES\\x.ts'],
        [16, 1, 'node.exe', T0, 'node C:\\r\\x.json'],
        [17, 1, 'node.exe', T0, 'node C:\\r\\x.jsx'],
        [18, 1, 'node.exe', T0, 'tsx c:\\r\\s\\main.ts.js'],
        [19, 1, 'node.exe', T0, 'node C:\\\u4e2d\u6587\\\u76ee\u5f55\\a.js'],
        [20, 1, 'node.exe', T0, 'node ./rel/a.js'],
        [21, 1, 'node.exe', T0, ''],
        [22, 1, 'node.exe', T0, 'node /usr/x/a.js'],
        [23, 1, 'node.exe', T0, 'node C:\\a|b\\c.js D:\\ok\\d.js'],
      ] }),
      R,
    ],
  },
  {
    name: 'metrics-edge',
    clock: T0,
    steps: [
      W({ listens: [[1, 10], [2, 11], [3, 12]], procs: [[10, 1, 'a.exe', T0], [11, 1, 'b.exe', T0], [12, 1, 'c.exe', T0]], usage: { 10: [5, 100], 11: [0.05, 0] }, cpus: [[0, 0, 0, 0, 0]], mem: [3, 1] }),
      R,
      // 0.05 / 1 核 → 0.1（Math.round(0.5) = 1）；-0.05 → -0（Math.round(-0.5) = -0）
      W({ usage: { 10: [7.45, 100], 11: [0.05, 0], 12: [1, 5] }, cpus: [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0]] }),
      { advance: 1000 },
      R,
      W({ usage: { 10: [-0.05, 100], 11: [0.25, 1], 12: [1, 5] } }),
      { advance: 1000 },
      R,
      // pidusage 整体失败：指标保持初始值（cpu null、memory 0），但基线不清
      W({ usage: 'fail' }),
      { advance: 1000 },
      R,
      // 进程消失后基线清掉；重新出现时又是首轮
      W({ listens: [[1, 10]], usage: { 10: [1, 1] } }),
      { advance: 1000 },
      R,
      W({ listens: [[1, 10], [2, 11]], usage: { 10: [1, 1], 11: [2, 2] } }),
      { advance: 1000 },
      R,
      // 系统负载：dTotal <= 0 时 cpu 为 null
      W({ cpus: [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0]] }),
      R,
      W({ cpus: [[10, 1, 2, 7, 3], [0, 0, 0, 0, 0]], mem: [7, 2] }),
      R,
      // Math.round 的一半：1 核下 0.05 → 0.5 → 1 → 0.1；-0.05 → -0.5 → -0（math.Round 会得 -1）；
      // 内存 128 / 2048 * 1000 = 62.5（二进制精确）→ 63 → 6.3
      W({ usage: { 10: [-0.05, 1], 11: [0.05, 1] }, cpus: [[0, 0, 0, 0, 0]], mem: [2048, 1920] }),
      { advance: 1000 },
      R,
      // os.cpus() 为空：核数按 1（`|| 1`），系统 CPU 无增量为 null
      W({ cpus: [] }),
      { advance: 1000 },
      R,
    ],
  },
  {
    name: 'diff-changed-fields',
    clock: T0,
    steps: [
      W({ listens: [[1, 10], [2, 10], [5, 11]], procs: [[10, 1, 'node.exe', T0, 'node C:\\w\\a.js'], [11, 1, 'node.exe', T0, 'node C:\\w\\b.js']], usage: { 10: [1, 5], 11: [1, 5] } }),
      R,
      { advance: 1000 },
      R,
      // 只改了不比较的字段（cwd / execPath / startedAt）：不进 updated
      W({ procs: [[10, 1, 'node.exe', T0 + 1, 'node C:\\other\\a.js', 'C:\\n.exe'], [11, 1, 'node.exe', T0, 'node C:\\w\\b.js']] }),
      { advance: 1000 },
      R,
      // memory 变 → updated；端口顺序变但集合相同 → 排序后相同，不进 updated
      W({ listens: [[2, 10], [1, 10], [5, 11]], usage: { 10: [1, 6], 11: [1, 5] } }),
      { advance: 1000 },
      R,
      // entryId 变 → updated（条目按 cwd 认领）
      { expect: [{ id: 'eb', cwd: 'C:\\w' }] },
      { advance: 1000 },
      R,
      // 排序：按首个端口升序，同端口稳定
      W({ listens: [[5, 11], [5, 12], [1, 10]], procs: [[10, 1, 'node.exe', T0], [11, 1, 'node.exe', T0], [12, 1, 'node.exe', T0]] }),
      { advance: 1000 },
      R,
      // 只有 groupOverridden 变（分组本来就是 mine，手动钉成 mine）→ updated
      { op: 'setGroup', args: ['node.exe', 'mine'] },
      // 只有启动来源变（父进程换成 VS Code；元数据过期才会重读）→ updated
      W({ procs: [[10, 1100, 'node.exe', T0], [11, 1, 'node.exe', T0], [12, 1, 'node.exe', T0], [1100, 1, 'Code.exe', T0, 'Code.exe', 'C:\\Users\\u\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe']] }),
      { advance: 31000 },
      R,
      // 一次消失多个：removedPids 按上一轮的顺序
      W({ listens: [] }),
      { advance: 1000 },
      R,
    ],
  },
  {
    name: 'port-conflicts',
    clock: T0,
    steps: [
      W({ listens: [[3000, 10], [3000, 11, [6]], [4000, 12]], procs: [[10, 1, 'node.exe', T0, 'node C:\\a\\x.js'], [11, 1, 'node.exe', T0, 'node C:\\b\\x.js'], [12, 1, 'node.exe', T0, 'node C:\\c\\x.js']] }),
      { expect: [{ id: 'a', port: 3000, cwd: 'C:\\a' }, { id: 'b', port: 3000, cwd: 'C:\\b' }, { id: 'c', port: 4000, cwd: 'C:\\c' }, { id: 'd', port: 4000, cwd: 'C:\\d' }, { id: 'e', port: 5000, cwd: 'C:\\e' }] },
      R,
      // 失败态带上次的冲突数
      W({ failListen: 'netstat 退出码 1' }),
      R,
    ],
  },
  {
    // 同首端口很多行：Array.prototype.sort 稳定，按监听行首次出现顺序
    name: 'stable-sort',
    clock: T0,
    steps: [
      W({ listens: Array.from({ length: 40 }, (_, i) => [[7, 9, 7, 3][i % 4], 300 - i]), procs: Array.from({ length: 40 }, (_, i) => [300 - i, 1, 'node.exe', T0]) }),
      R,
    ],
  },
  {
    // 一次消失 8 个 PID：removedPids 按上一轮监听表的顺序
    name: 'removed-order',
    clock: T0,
    steps: [
      W({ listens: Array.from({ length: 8 }, (_, i) => [100 + i, [41, 47, 43, 42, 48, 44, 46, 45][i]]), procs: [41, 42, 43, 44, 45, 46, 47, 48].map((p) => [p, 1, 'a.exe', T0]) }),
      R,
      W({ listens: [] }),
      { advance: 1000 },
      R,
    ],
  },
]
