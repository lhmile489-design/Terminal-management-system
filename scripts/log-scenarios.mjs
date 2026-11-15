// S19 对拍场景：每个场景是一串步骤，生成脚本在原版 LogService.ts 上逐步回放并记录，
// Go 侧（internal/logs/logs_test.go）拿同一串步骤在 Go 实现上回放并逐项比对。
//
// 步骤字段：
//   op      clock / session / dropSession / data / dataRepeat / exit / fire / query / clear / badListener
//   id      会话 id；query 的筛选条件放 q
// 会话列表由场景自己维护（session / dropSession），模拟 SessionService.list() 的当前快照。
// 不放进来的（Go 有意不同，见 MIGRATION-PLAN §6）：limit 为 null / 小数、会话标题为空串。

export const SCENARIOS = [
  {
    name: 'lines-basic',
    recordLines: true,
    steps: [
      { op: 'session', id: 's1', title: '终端一' },
      { op: 'data', id: 's1', data: 'hello\nworld\n' },
      { op: 'query', q: {} },
      // 没有换行结尾的一段先留在 partial，不进日志
      { op: 'data', id: 's1', data: 'abc' },
      { op: 'query', q: {} },
      { op: 'data', id: 's1', data: 'def\n' },
      { op: 'query', q: {} },
      // \r\n 与只有 \r 的行尾
      { op: 'data', id: 's1', data: 'crlf\r\nlone\rmore\n' },
      { op: 'query', q: {} },
    ],
  },
  {
    name: 'cursor-col1',
    recordLines: true,
    steps: [
      { op: 'session', id: 's1', title: '终端一' },
      // ConPTY 用绝对光标定位跳行，不总发 \n
      { op: 'data', id: 's1', data: 'first\x1b[5;1Hsecond\x1b[12;1Hthird' },
      { op: 'query', q: {} },
      { op: 'data', id: 's1', data: '\nfourth\n' },
      { op: 'query', q: {} },
      // 定位到其他列是同一行内的重绘，不切行
      { op: 'data', id: 's1', data: 'aaa\x1b[1;5Hbbb\n' },
      { op: 'query', q: {} },
    ],
  },
  {
    name: 'ansi-and-redraw',
    recordLines: true,
    steps: [
      { op: 'session', id: 's1', title: '终端一' },
      { op: 'data', id: 's1', data: '\x1b[32m[ok]\x1b[0m 构建完成\n' },
      // OSC 设置窗口标题
      { op: 'data', id: 's1', data: '\x1b]0;my title\x07done\n' },
      // 进度条用裸 \r 原地重写，取最后一段
      { op: 'data', id: 's1', data: '# 10%\r# 50%\r# 100%\n' },
      // ConPTY 在末尾补 \r + 擦除序列，那一段清理完是空的
      { op: 'data', id: 's1', data: 'payload\r\x1b[K' },
      { op: 'data', id: 's1', data: '\n' },
      // 只有控制字符或空白的行不进日志
      { op: 'data', id: 's1', data: '\x1b[2K\r\n   \n' },
      { op: 'query', q: {} },
    ],
  },
  {
    name: 'levels',
    recordLines: true,
    steps: [
      { op: 'session', id: 's1', title: '终端一' },
      { op: 'data', id: 's1', data: 'ok\n' },
      { op: 'data', id: 's1', data: 'TypeError: boom\n' },
      { op: 'data', id: 's1', data: 'warning: deprecated api\n' },
      { op: 'data', id: 's1', data: '启动失败\n' },
      { op: 'data', id: 's1', data: '警告：端口占用\n' },
      { op: 'data', id: 's1', data: 'EADDRINUSE :::3000\n' },
      { op: 'data', id: 's1', data: 'error and warn together\n' },
      { op: 'query', q: {} },
      { op: 'query', q: { level: 'error' } },
      { op: 'query', q: { level: 'warn' } },
      { op: 'query', q: { level: 'info' } },
      // 空串等于不筛（原版用真值判断）
      { op: 'query', q: { level: '' } },
    ],
  },
  {
    name: 'truncate',
    recordLines: true,
    steps: [
      { op: 'session', id: 's1', title: '终端一' },
      { op: 'dataRepeat', id: 's1', unit: 'a', count: 600 },
      { op: 'data', id: 's1', data: '\n' },
      { op: 'query', q: {} },
      // 汉字一个码元
      { op: 'dataRepeat', id: 's1', unit: '汉', count: 600 },
      { op: 'data', id: 's1', data: '\n' },
      { op: 'query', q: {} },
      // 第 500 个码元正好是代理对的前一半
      { op: 'dataRepeat', id: 's1', unit: 'a', count: 499 },
      { op: 'data', id: 's1', data: '\u{1f600}\n' },
      { op: 'query', q: {} },
    ],
  },
  {
    name: 'ring-buffer',
    recordLines: false,
    steps: [
      { op: 'session', id: 's1', title: '终端一' },
      { op: 'dataRepeat', id: 's1', unit: 'x\n', count: 5005 },
      { op: 'query', q: { limit: 3 } },
      { op: 'dataRepeat', id: 's1', unit: 'y\n', count: 10 },
      { op: 'query', q: { limit: 2 } },
      // total 证明缓冲仍是 5000 行；不用 limit:5000 —— 那会把 5000 行整份写进对拍数据
      { op: 'query', q: { limit: 1 } },
      { op: 'clear' },
      { op: 'query', q: {} },
      { op: 'data', id: 's1', data: 'after clear\n' },
      { op: 'query', q: {} },
    ],
  },
  {
    name: 'exit-race',
    recordLines: true,
    steps: [
      { op: 'session', id: 's1', title: '终端一' },
      // exit 先到，末块后到：收尾推后，末行仍在
      { op: 'data', id: 's1', data: 'head\nlast line without newline' },
      { op: 'exit', id: 's1' },
      { op: 'query', q: {} },
      { op: 'data', id: 's1', data: ' continued\n' },
      { op: 'query', q: {} },
      { op: 'fire', ms: 120 },
      { op: 'query', q: {} },
      // exit 之后再没有数据：到点把残段收尾
      { op: 'data', id: 's1', data: 'dangling' },
      { op: 'exit', id: 's1' },
      { op: 'fire', ms: 120 },
      { op: 'query', q: {} },
      // 没到点之前不出现
      { op: 'data', id: 's1', data: 'later' },
      { op: 'exit', id: 's1' },
      { op: 'query', q: {} },
      { op: 'fire', ms: 120 },
      { op: 'query', q: {} },
    ],
  },
  {
    name: 'clear',
    recordLines: true,
    steps: [
      { op: 'session', id: 's1', title: '终端一' },
      { op: 'data', id: 's1', data: 'kept\npending' },
      { op: 'exit', id: 's1' },
      { op: 'clear' },
      { op: 'fire', ms: 120 },
      { op: 'query', q: {} },
      // clear 不重置全局序号
      { op: 'data', id: 's1', data: 'after\n' },
      { op: 'query', q: {} },
    ],
  },
  {
    name: 'query-filters',
    recordLines: false,
    steps: [
      { op: 'session', id: 's1', title: '终端一', projectId: 'p1' },
      { op: 'session', id: 's2', title: '终端二', projectId: 'p2' },
      { op: 'session', id: 's3', title: '自由终端' },
      { op: 'data', id: 's1', data: 'Alpha\nbeta\nerror one\n' },
      { op: 'data', id: 's2', data: 'gamma\nDELTA\nerror two\n' },
      { op: 'data', id: 's3', data: 'epsilon\n' },
      { op: 'query', q: {} },
      { op: 'query', q: { sessionId: 's2' } },
      { op: 'query', q: { sessionId: '' } },
      { op: 'query', q: { entryId: 'p1' } },
      { op: 'query', q: { entryId: 'nope' } },
      { op: 'query', q: { text: 'ERROR' } },
      { op: 'query', q: { text: '  delta  ' } },
      { op: 'query', q: { text: '' } },
      { op: 'query', q: { text: '不存在' } },
      { op: 'query', q: { level: 'error', text: 'one' } },
      { op: 'query', q: { level: 'info', sessionId: 's3' } },
      { op: 'query', q: { limit: 1 } },
      { op: 'query', q: { limit: 0 } },
      { op: 'query', q: { limit: -3 } },
      { op: 'query', q: { limit: 5001 } },
      { op: 'query', q: { limit: 2 } },
      // 会话列表变了：新行用新标题，旧行不变
      { op: 'dropSession', id: 's1' },
      { op: 'data', id: 's1', data: 'from gone session\n' },
      { op: 'query', q: {} },
      { op: 'query', q: { sessionId: 's1' } },
    ],
  },
  {
    name: 'sources',
    recordLines: false,
    steps: [
      { op: 'session', id: 's1', title: '终端一' },
      { op: 'session', id: 's2', title: '终端二' },
      { op: 'data', id: 's2', data: 'b1\nb2\n' },
      { op: 'data', id: 's1', data: 'a1\n' },
      { op: 'data', id: 's2', data: 'b3\n' },
      { op: 'query', q: {} },
      { op: 'dropSession', id: 's2' },
      { op: 'query', q: {} },
      { op: 'clear' },
      { op: 'query', q: {} },
    ],
  },
  {
    name: 'bad-listener',
    recordLines: true,
    steps: [
      { op: 'session', id: 's1', title: '终端一' },
      { op: 'data', id: 's1', data: 'before\n' },
      { op: 'badListener' },
      { op: 'data', id: 's1', data: 'after\n' },
      { op: 'query', q: {} },
    ],
  },
]
