import { create } from 'zustand'
import type {
  GroupPatch,
  NewProjectGroup,
  ProjectGroup
} from '@shared/types'

interface GroupsStore {
  groups: ProjectGroup[]
  init: () => Promise<void>
  setGroups: (list: ProjectGroup[]) => void
  add: (input: NewProjectGroup) => Promise<ProjectGroup>
  patch: (id: string, patch: GroupPatch) => Promise<ProjectGroup>
  remove: (id: string) => Promise<void>
  reorder: (ids: string[]) => Promise<void>
  /** 按 id 查找，找不到返回 undefined */
  groupOf: (id: string) => ProjectGroup | undefined
}

export const useGroups = create<GroupsStore>((set, get) => ({
  groups: [],

  init: async () => {
    const groups = await window.mile.group.list()
    set({ groups })
  },

  setGroups: (groups) => set({ groups }),

  groupOf: (id) => get().groups.find((g) => g.id === id),

  add: async (input: NewProjectGroup) => {
    const group = await window.mile.group.add(input)
    set((s) => ({
      groups: s.groups.some((g) => g.id === group.id)
        ? s.groups
        : [...s.groups, group]
    }))
    return group
  },

  patch: async (id, patch) => {
    const group = await window.mile.group.patch(id, patch)
    set((s) => ({
      groups: s.groups.map((g) => (g.id === id ? group : g))
    }))
    return group
  },

  remove: async (id) => {
    await window.mile.group.remove(id)
    set((s) => ({ groups: s.groups.filter((g) => g.id !== id) }))
  },

  reorder: async (ids) => {
    // 先本地重排，再以主进程推送为准
    set((s) => {
      const rank = new Map(ids.map((id, i) => [id, i]))
      return {
        groups: [...s.groups].sort(
          (a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9)
        )
      }
    })
    await window.mile.group.reorder(ids)
  }
}))
