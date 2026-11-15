// S07 对拍探针：用 node 直接跑原版 src/main/lib/portScanner.ts 的 findFreePort，输出一行 JSON。
// 由 internal/platform/freeport_test.go 在占住端口的同时调用，比较两边对「哪个端口空闲」的判断。
//
// 用法：node scripts/probe-freeport.mjs <startPort> <maxTries>
// 原版文件只读，不改。

import { findFreePort } from '../../../mile-terminal-management/src/main/lib/portScanner.ts'

const [start, tries] = process.argv.slice(2).map(Number)
const port = await findFreePort(start, tries)
process.stdout.write(JSON.stringify({ port }) + '\n')
