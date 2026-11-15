// S15 对拍桩：替换原版 ScannerService.ts 的 '../platform'、'pidusage'、'node:os'。
// 平台的其余部分（id、pathKey、attribution 表）用原版 win32 实现本身；只有两个采集函数换成
// 生成脚本控制的假数据（globalThis.__scan），不跑 netstat / PowerShell。

import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const { win32 } = await import(
  pathToFileURL(resolve(here, '../../../mile-terminal-management/src/main/platform/win32/index.ts')).href
)

export const platform = {
  ...win32,
  readListenPorts: async () => globalThis.__scan.readListenPorts(),
  readProcessMeta: async () => globalThis.__scan.readProcessMeta(),
}

export default async function pidusage(pids) {
  return globalThis.__scan.pidusage(pids)
}

export const cpus = () => globalThis.__scan.cpus()
export const totalmem = () => globalThis.__scan.totalmem()
export const freemem = () => globalThis.__scan.freemem()
