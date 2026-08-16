import { create } from 'zustand'
import type {
  ListenerGroup,
  ListenerSnapshot,
  ScanDiff,
  SystemLoad,
  UnmanagedListener,
  WatchedProcess
} from '@shared/types'

const SPARK_POINTS = 30

interface ScannerStore {
  listeners: ListenerSnapshot[]
  unmanaged: UnmanagedListener[]
  watched: WatchedProcess[]
  keywords: string[]
  system: SystemLoad
  cpuHistory: number[]
  memHistory: number[]
  portConflicts: number
  at: number | null
  lastSuccessAt: number | null
  failed: boolean
  init: () => Promise<void>
  applyDiff: (diff: ScanDiff) => void
  ignore: (processName: string, port: number) => void
  hideOnce: (pid: number, port: number) => void
  setGroup: (processName: string, group: ListenerGroup | null) => Promise<void>
  addKeyword: (keyword: string) => Promise<void>
  removeKeyword: (keyword: string) => Promise<void>
}

export const useScanner = create<ScannerStore>((set, get) => ({
  listeners: [],
  unmanaged: [],
  watched: [],
  keywords: [],
  system: { cpu: null, memory: 0 },
  cpuHistory: [],
  memHistory: [],
  portConflicts: 0,
  at: null,
  lastSuccessAt: null,
  failed: false,

  init: async () => {
    const [snap, keywords] = await Promise.all([
      window.mile.scanner.snapshot(),
      window.mile.scanner.watchedKeywords()
    ])
    set({ keywords })
    if (!snap) return
    set({
      listeners: snap.listeners,
      unmanaged: snap.unmanaged,
      watched: snap.watched,
      system: snap.system,
      portConflicts: snap.portConflicts,
      at: snap.at,
      lastSuccessAt: snap.lastSuccessAt,
      failed: snap.failed
    })
  },

  // 主进程只推变化部分，这里就地合并，不整表替换
  applyDiff: (diff) =>
    set((s) => {
      if (diff.failed) {
        return { failed: true, lastSuccessAt: diff.lastSuccessAt, system: diff.system }
      }

      const byPid = new Map(s.listeners.map((l) => [l.pid, l]))
      for (const pid of diff.removedPids) byPid.delete(pid)
      for (const l of [...diff.added, ...diff.updated]) byPid.set(l.pid, l)

      return {
        listeners: [...byPid.values()].sort((a, b) => (a.ports[0] ?? 0) - (b.ports[0] ?? 0)),
        unmanaged: diff.unmanaged,
        watched: diff.watched,
        system: diff.system,
        cpuHistory: push(s.cpuHistory, diff.system.cpu ?? 0),
        memHistory: push(s.memHistory, diff.system.memory),
        portConflicts: diff.portConflicts,
        at: diff.at,
        lastSuccessAt: diff.lastSuccessAt,
        failed: false
      }
    }),

  ignore: (processName, port) => {
    window.mile.scanner.ignore(processName, port)
    set((s) => ({ unmanaged: s.unmanaged.filter((u) => u.port !== port) }))
  },

  hideOnce: (pid, port) => {
    window.mile.scanner.hideOnce(pid, port)
    set((s) => ({ unmanaged: s.unmanaged.filter((u) => !(u.pid === pid && u.port === port)) }))
  },

  /**
   * 分组改动就地先应用一次，不等下一轮采集。
   * 采集周期最长 10 秒，点了「提升」十秒不动会让人以为按钮坏了。
   */
  setGroup: async (processName, group) => {
    await window.mile.scanner.setGroup(processName, group)
    const key = processName.toLowerCase()
    set((s) => ({
      listeners: s.listeners.map((l) =>
        l.processName.toLowerCase() === key
          ? { ...l, group: group ?? l.group, groupOverridden: group !== null }
          : l
      )
    }))
  },

  // 关键字的权威规整在主进程（去重、限长、限量），这里用它的返回值而不是本地拼
  addKeyword: async (keyword) => {
    const next = await window.mile.scanner.setWatchedKeywords([...get().keywords, keyword])
    set({ keywords: next })
  },

  removeKeyword: async (keyword) => {
    const next = await window.mile.scanner.setWatchedKeywords(
      get().keywords.filter((k) => k !== keyword)
    )
    set({ keywords: next })
  }
}))

function push(list: number[], value: number): number[] {
  return [...list, value].slice(-SPARK_POINTS)
}
