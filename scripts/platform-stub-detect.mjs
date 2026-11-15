// S16 对拍桩：替换原版 DetectService.ts 的 '../platform'。直接用原版 win32 实现
// （它的 node:child_process / node:fs 已由 platform-hooks 换成桩，不起进程）；detect 只读其中两项。

import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const { win32 } = await import(
  pathToFileURL(resolve(here, '../../../mile-terminal-management/src/main/platform/win32/index.ts')).href
)

export const platform = win32
