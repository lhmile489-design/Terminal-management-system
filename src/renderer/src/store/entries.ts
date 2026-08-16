import { create } from 'zustand'
import type {
  EntryEdit,
  EntryRuntime,
  LaunchEntry,
  NewLaunchEntry,
  PrecheckResult
} from '@shared/types'

const IDLE: EntryRuntime = { entryId: '', status: 'idle', portUnknown: false }

interface EntriesStore {
  entries: LaunchEntry[]
  runtimes: Record<string, EntryRuntime>
  /** 正在等待主进程回执的条目，用于禁用按钮防重复点击 */
  busy: Record<string, boolean>
  error: string | null
  init: () => Promise<void>
  setEntries: (list: LaunchEntry[]) => void
  setRuntime: (runtime: EntryRuntime) => void
  runtimeOf: (id: string) => EntryRuntime
  add: (input: NewLaunchEntry) => Promise<LaunchEntry>
  /**
   * 条目写入口。校验失败返回 false，错误落到 error 字段 ——
   * 编辑面板读 error 显示在面板内，避免对话框盖住外面的横幅让人以为没反应。
   */
  edit: (id: string, patch: EntryEdit) => Promise<boolean>
  remove: (id: string) => Promise<void>
  reorder: (ids: string[]) => Promise<void>
  start: (id: string) => Promise<PrecheckResult | null>
  stop: (id: string) => Promise<void>
  restart: (id: string) => Promise<PrecheckResult | null>
  install: (id: string) => Promise<void>
  /** 执行条目已声明的某个脚本，供命令面板用；失败时错误落到 error 字段 */
  runScript: (id: string, script: string) => Promise<EntryRuntime | null>
  precheck: (id: string) => Promise<PrecheckResult>
  clearError: () => void
}

export const useEntries = create<EntriesStore>((set, get) => ({
  entries: [],
  runtimes: {},
  busy: {},
  error: null,

  init: async () => {
    const [entries, runtimes] = await Promise.all([
      window.mile.entry.list(),
      window.mile.entry.runtimes()
    ])
    set({ entries, runtimes: Object.fromEntries(runtimes.map((r) => [r.entryId, r])) })
  },

  setEntries: (entries) => set({ entries }),

  setRuntime: (runtime) =>
    set((s) => ({ runtimes: { ...s.runtimes, [runtime.entryId]: runtime } })),

  runtimeOf: (id) => get().runtimes[id] ?? { ...IDLE, entryId: id },

  add: async (input) => {
    const entry = await window.mile.entry.add(input)
    /*
     * 主进程在 add 里同步 emit('changed')，那条广播比 invoke 回执先到，列表里已经有
     * 这一条了。无条件 push 会出现两张一样的卡片，直到下一次广播整体覆盖才消失。
     * 按 id 判在，两种到达顺序都只留一条。
     */
    set((s) => (s.entries.some((e) => e.id === entry.id)
      ? s
      : { entries: [...s.entries, entry] }))
    return entry
  },

  edit: async (id, patch) => {
    const next = await guard(set, id, () => window.mile.entry.edit(id, patch))
    if (!next) return false
    set((s) => ({ entries: s.entries.map((e) => (e.id === id ? next : e)) }))
    return true
  },

  remove: async (id) => {
    await window.mile.entry.remove(id)
    set((s) => ({ entries: s.entries.filter((e) => e.id !== id) }))
  },

  reorder: async (ids) => {
    // 先本地重排让拖拽不闪，再以主进程回执为准
    set((s) => {
      const rank = new Map(ids.map((id, i) => [id, i]))
      return {
        entries: [...s.entries].sort(
          (a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9)
        )
      }
    })
    set({ entries: await window.mile.entry.reorder(ids) })
  },

  start: async (id) => guard(set, id, async () => {
    const result = await window.mile.entry.start(id)
    return result.ok ? null : result.precheck
  }),

  stop: async (id) => {
    await guard(set, id, () => window.mile.entry.stop(id))
  },

  restart: async (id) => guard(set, id, async () => {
    const result = await window.mile.entry.restart(id)
    return result.ok ? null : result.precheck
  }),

  install: async (id) => {
    await guard(set, id, () => window.mile.entry.install(id))
  },

  runScript: async (id, script) =>
    await guard(set, id, () => window.mile.entry.runScript(id, script)),

  precheck: async (id) => await window.mile.entry.precheck(id),

  clearError: () => set({ error: null })
}))

/**
 * 主进程会对非受控进程、非法脚本名等直接抛错，这里统一收口到 error 字段。
 * 吞掉异常会让「拒绝终止外部进程」这类安全拦截静默失败，必须显示出来。
 */
async function guard<T>(
  set: (partial: Partial<EntriesStore> | ((s: EntriesStore) => Partial<EntriesStore>)) => void,
  id: string,
  fn: () => Promise<T>
): Promise<T | null> {
  set((s) => ({ busy: { ...s.busy, [id]: true }, error: null }))
  try {
    return await fn()
  } catch (err) {
    set({ error: cleanIpcError(err) })
    return null
  } finally {
    set((s) => {
      const busy = { ...s.busy }
      delete busy[id]
      return { busy }
    })
  }
}

/** Electron 会给 invoke 的异常加 "Error invoking remote method ..." 前缀 */
function cleanIpcError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
