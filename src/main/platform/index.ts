import type { Platform } from './types'
import { win32 } from './win32'
import { darwin } from './darwin'

/**
 * 当前平台的实现。服务层只从这里取，不直接 import win32 / darwin。
 * 两个实现都会被打进包里（体积可以忽略），运行时按 process.platform 选一个。
 */
export const platform: Platform = process.platform === 'darwin' ? darwin : win32

export type { ListenRow, ProcessMeta, ProcessRow, ProcessTable, TerminalKind } from './types'
