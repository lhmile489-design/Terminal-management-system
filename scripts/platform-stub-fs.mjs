// S08 对拍桩：替换原版 win32/*.ts 里的 node:fs，文件是否存在由生成脚本指定，不看真实磁盘。
// globalThis.__fs = { exists: Set<string>, lstat: Set<string> }：
//   exists 是 existsSync 认得的路径；lstat 是 lstatSync 认得的路径（应用执行别名只在后者里）。

globalThis.__fs = { exists: new Set(), lstat: new Set() }

export function existsSync(p) {
  return globalThis.__fs.exists.has(p)
}

export function lstatSync(p) {
  if (globalThis.__fs.lstat.has(p)) return {}
  const err = new Error(`ENOENT: no such file or directory, lstat '${p}'`)
  err.code = 'ENOENT'
  throw err
}
