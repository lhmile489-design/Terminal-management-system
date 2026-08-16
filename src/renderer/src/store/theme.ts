import { create } from 'zustand'
import type { ResolvedTheme, ThemePreference } from '@shared/types'

interface ThemeStore {
  preference: ThemePreference
  resolved: ResolvedTheme
  init: () => Promise<void>
  set: (preference: ThemePreference) => Promise<void>
}

/** 切换瞬间抑制过渡，避免整屏渐变闪烁 */
function apply(resolved: ResolvedTheme): void {
  const root = document.documentElement
  root.classList.add('theme-switching')
  root.dataset.theme = resolved
  requestAnimationFrame(() => root.classList.remove('theme-switching'))
}

export const useTheme = create<ThemeStore>((set) => ({
  preference: 'system',
  resolved: 'light',

  init: async () => {
    const state = await window.mile.theme.get()
    apply(state.resolved)
    set(state)

    window.mile.theme.onChange((next) => {
      apply(next.resolved)
      set(next)
    })
  },

  set: async (preference) => {
    const next = await window.mile.theme.set(preference)
    apply(next.resolved)
    set(next)
  }
}))
