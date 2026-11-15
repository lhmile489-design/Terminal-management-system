// S17 对拍桩：替换原版 PrecheckService.ts 的 node:fs/promises 与 ../lib/portScanner。
//
// readFile / stat 原样转给真实 node:fs/promises（场景在临时目录里建成真实目录树）；
// statfs 与 findFreePort 的结果由生成脚本按场景经 globalThis.__precheck 指定，并记下 findFreePort 的调用参数。

import { readFile as realReadFile, stat as realStat } from 'node:fs/promises'

export const readFile = realReadFile
export const stat = realStat

export async function statfs(target) {
  const cfg = globalThis.__precheck
  cfg.statfsCalls.push(target)
  if (cfg.statfs === 'throw') throw new Error('statfs stub failure')
  return { bsize: cfg.statfs.bsize, bavail: cfg.statfs.bavail }
}

export async function findFreePort(start) {
  const cfg = globalThis.__precheck
  cfg.freePortCalls.push(start)
  const v = cfg.freePort[String(start)]
  return v === undefined ? null : v
}
