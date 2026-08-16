import { create } from 'zustand'
import type { Settings } from '@shared/types'

/**
 * 设置只读镜像，供终端等组件消费。
 *
 * 写操作不走这里 —— 设置页直接调 IPC 并以主进程回执为准，主进程再广播回来。
 * 若两边都能写，校验失败时界面与磁盘就会不一致。
 */
interface SettingsStore {
  settings: Settings | null
  init: () => Promise<void>
  set: (settings: Settings) => void
}

export const useSettings = create<SettingsStore>((set) => ({
  settings: null,
  init: async () => set({ settings: await window.mile.settings.get() }),
  set: (settings) => set({ settings })
}))
