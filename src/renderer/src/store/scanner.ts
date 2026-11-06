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
/** 按条目的资源趋势：60 点，2 秒采集约 2 分钟 */
const ENTRY_TREND_POINTS = 60

export interface EntryTrend {
  cpu: number[]
  memory: number[]
}

/** 端口占用历史最多留这么多条，只在内存，应用重启后清空 */
const PORT_HISTORY_MAX = 200

/** 一条端口占用事件。进程名是进程自己能写的，只用于展示 */
export interface PortEvent {
  seq: number
  at: number
  kind: 'start' | 'stop'
  port: number
  pid: number
  processName: string
  entryId?: string
}

interface ScannerStore {
  listeners: ListenerSnapshot[]
  unmanaged: UnmanagedListener[]
  watched: WatchedProcess[]
  keywords: string[]
  system: SystemLoad
  cpuHistory: number[]
  memHistory: number[]
  /**
   * 按 entryId 汇总的 CPU / 内存趋势，只在内存。只覆盖监听端口的进程：不监听的子进程
   * 不在快照里。条目没有监听行（停止、崩溃）时整条缓冲删掉。
   */
  entryTrends: Record<string, EntryTrend>
  /** 端口开始 / 停止监听的事件，新的在前，最多 PORT_HISTORY_MAX 条 */
  portHistory: PortEvent[]
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
  entryTrends: {},
  portHistory: [],
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
      const listeners = [...byPid.values()].sort((a, b) => (a.ports[0] ?? 0) - (b.ports[0] ?? 0))

      return {
        listeners,
        entryTrends: nextTrends(s.entryTrends, listeners),
        portHistory: nextPortHistory(s.portHistory, s.listeners, diff),
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

let portSeq = 0

/**
 * 端口占用历史（PRD-FEATURE-UPGRADE P1-4）。
 *
 * - added：新 PID 的每个端口记一条「开始监听」。
 * - removedPids：只给 PID，端口与进程名要从上一份监听表里查。
 * - updated：同一 PID 端口集合变了（多开或关掉一个端口），按差集记。
 * 首次 init 的快照不进历史：那是「启动时就在」的状态，不是这次会话里发生的变化。
 */
function nextPortHistory(prev: PortEvent[], before: ListenerSnapshot[], diff: ScanDiff): PortEvent[] {
  const old = new Map(before.map((l) => [l.pid, l]))
  const events: PortEvent[] = []
  const add = (kind: PortEvent['kind'], l: ListenerSnapshot, port: number): void => {
    events.push({ seq: ++portSeq, at: diff.at, kind, port, pid: l.pid, processName: l.processName, entryId: l.entryId })
  }
  for (const pid of diff.removedPids) {
    const l = old.get(pid)
    if (l) for (const p of l.ports) add('stop', l, p)
  }
  for (const l of diff.added) for (const p of l.ports) add('start', l, p)
  for (const l of diff.updated) {
    const was = old.get(l.pid)
    if (!was) continue
    const before = new Set(was.ports)
    const after = new Set(l.ports)
    for (const p of was.ports) if (!after.has(p)) add('stop', was, p)
    for (const p of l.ports) if (!before.has(p)) add('start', l, p)
  }
  if (events.length === 0) return prev
  return [...events.reverse(), ...prev].slice(0, PORT_HISTORY_MAX)
}

function push(list: number[], value: number): number[] {
  return [...list, value].slice(-SPARK_POINTS)
}

/**
 * 每轮采集按 entryId 汇总一次。同一 PID 只算一次：快照本来就按 PID 一行，这里再防一层，
 * 监听行带上地址族之后双栈进程也不会被数两遍。没有监听行的条目删掉缓冲。
 */
function nextTrends(prev: Record<string, EntryTrend>, listeners: ListenerSnapshot[]): Record<string, EntryTrend> {
  const sums = new Map<string, { cpu: number; memory: number; pids: Set<number> }>()
  for (const l of listeners) {
    if (!l.entryId) continue
    const s = sums.get(l.entryId) ?? { cpu: 0, memory: 0, pids: new Set<number>() }
    if (s.pids.has(l.pid)) continue
    s.pids.add(l.pid)
    s.cpu += l.cpu ?? 0
    s.memory += l.memory
    sums.set(l.entryId, s)
  }
  const out: Record<string, EntryTrend> = {}
  for (const [id, s] of sums) {
    const old = prev[id] ?? { cpu: [], memory: [] }
    out[id] = {
      cpu: [...old.cpu, s.cpu].slice(-ENTRY_TREND_POINTS),
      memory: [...old.memory, s.memory].slice(-ENTRY_TREND_POINTS)
    }
  }
  return out
}
