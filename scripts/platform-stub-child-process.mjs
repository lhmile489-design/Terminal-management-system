// S08 对拍桩：替换原版 win32/*.ts 里的 node:child_process，只记录调用，不起任何进程。
// globalThis.__calls 收集每次调用；globalThis.__reply(file, args) 决定 execFile 回调收到什么。

globalThis.__calls = []
globalThis.__reply = () => ({ err: null, stdout: '', stderr: '' })

export function execFile(file, args, opts, cb) {
  globalThis.__calls.push({ fn: 'execFile', file, args, opts })
  const r = globalThis.__reply(file, args)
  queueMicrotask(() => cb(r.err, r.stdout, r.stderr))
  return { on() { return this } }
}

export function spawn(file, args, opts) {
  globalThis.__calls.push({ fn: 'spawn', file, args, opts })
  return { on() { return this }, unref() {} }
}
