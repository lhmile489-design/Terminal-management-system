// S18 对拍桩：替换原版 SessionService.ts 的 'node-pty'、'node:os'、'../platform'。
//
// 状态全放在 globalThis.__sess（生成脚本每个场景新建一份）：
//   calls    按发生顺序记录的调用（spawn / pty.write / pty.resize / pty.kill / killTree）
//   spawned  已 spawn 的数量，pid = 4000 + 100 * 序号
//   ptys     假 pty 列表，生成脚本用它灌入输出与触发退出
//   flags    按 pid 开关：writeThrows / resizeThrows / killThrows
//   envKeys  spawn 时只记录这些环境变量键（真实 process.env 太大，也不稳定）
//
// 平台层固定为一个 PowerShell 7 的假 shell：defaultShell / shellArgs / shellInit 的真实取值
// 已在 S08 对拍过，这里只要会话层拿到什么就原样用什么。

export const homedir = () => 'C:\\Users\\test'

export const platform = {
  defaultShell: () => ({ file: 'C:\\pwsh\\pwsh.exe', title: 'PowerShell 7' }),
  shellArgs: () => ['-NoLogo'],
  shellInit: () => 'INIT\r',
  killTree: async (pid) => {
    globalThis.__sess.calls.push(['killTree', pid])
  },
}

export function spawn(file, args, opts) {
  const S = globalThis.__sess
  const pid = 4000 + 100 * S.spawned++
  let dataCb = () => {}
  let exitCb = () => {}
  const flag = (name) => S.flags[pid]?.[name] === true
  const pty = {
    pid,
    onData: (cb) => {
      dataCb = cb
    },
    onExit: (cb) => {
      exitCb = cb
    },
    write: (d) => {
      S.calls.push(['pty.write', pid, d])
      if (flag('writeThrows')) throw new Error('pty write failed')
    },
    resize: (c, r) => {
      S.calls.push(['pty.resize', pid, c, r])
      if (flag('resizeThrows')) throw new Error('pty resize failed')
    },
    kill: () => {
      S.calls.push(['pty.kill', pid])
      if (flag('killThrows')) throw new Error('pty kill failed')
    },
    feed: (s) => dataCb(s),
    exit: (code) => exitCb({ exitCode: code, signal: 0 }),
  }
  const env = {}
  for (const k of S.envKeys) if (k in opts.env) env[k] = opts.env[k]
  S.calls.push(['spawn', { file, args, cwd: opts.cwd, cols: opts.cols, rows: opts.rows, env }])
  S.ptys.push(pty)
  return pty
}
