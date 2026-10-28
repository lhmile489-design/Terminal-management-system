import { create } from 'zustand'
import type { SessionMeta } from '@shared/types'

interface SessionStore {
  sessions: SessionMeta[]
  activeId: string | null
  refresh: () => Promise<void>
  /** 工作目录由主进程决定（用户主目录），渲染层不能指定 */
  openShell: () => Promise<void>
  /** 开在某个已登记条目的目录里；目录由主进程按条目解析，这里只给 id。返回新会话 id */
  openShellAt: (entryId: string) => Promise<string>
  select: (id: string) => void
  /** 启动台创建的会话不经过本 store，先拉列表再选中 */
  focus: (id: string) => Promise<void>
  stop: (id: string) => Promise<void>
  markExited: (id: string, exitCode: number) => void
}

export const useSessions = create<SessionStore>((set, get) => ({
  sessions: [],
  activeId: null,

  refresh: async () => {
    const sessions = await window.mile.session.list()
    set((s) => ({
      sessions,
      activeId: sessions.some((x) => x.id === s.activeId) ? s.activeId : (sessions[0]?.id ?? null)
    }))
  },

  openShell: async () => {
    const meta = await window.mile.session.create({ kind: 'shell', title: 'PowerShell' })
    set((s) => ({ sessions: [...s.sessions, meta], activeId: meta.id }))
  },

  openShellAt: async (entryId) => {
    const meta = await window.mile.session.create({ kind: 'shell', entryId })
    set((s) => ({
      sessions: s.sessions.some((x) => x.id === meta.id) ? s.sessions : [...s.sessions, meta],
      activeId: meta.id
    }))
    return meta.id
  },

  markExited: (id, exitCode) =>
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, status: exitCode === 0 ? 'stopped' : 'crashed', exitCode } : x
      )
    })),

  select: (id) => set({ activeId: id }),

  focus: async (id) => {
    const sessions = await window.mile.session.list()
    set({ sessions, activeId: sessions.some((x) => x.id === id) ? id : (sessions[0]?.id ?? null) })
  },

  stop: async (id) => {
    await window.mile.session.stop(id)
    await get().refresh()
  }
}))
