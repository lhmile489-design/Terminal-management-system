import { Sun, Moon, Monitor, type Icon } from '@phosphor-icons/react'
import type { ThemePreference } from '@shared/types'
import { useTheme } from '../store/theme'

const CYCLE: ThemePreference[] = ['light', 'dark', 'system']
const META: Record<ThemePreference, { icon: Icon; label: string }> = {
  light: { icon: Sun, label: '浅色' },
  dark: { icon: Moon, label: '深色' },
  system: { icon: Monitor, label: '跟随系统' }
}

export function ThemeToggle(): React.JSX.Element {
  const preference = useTheme((s) => s.preference)
  const setTheme = useTheme((s) => s.set)

  const { icon: IconCmp, label } = META[preference]
  const next = CYCLE[(CYCLE.indexOf(preference) + 1) % CYCLE.length]

  return (
    <button
      type="button"
      onClick={() => void setTheme(next)}
      aria-label={`主题：${label}，点击切换为${META[next].label}`}
      className="pressable group relative flex h-10 w-10 items-center justify-center rounded-[8px] text-ink-faint hover:bg-raised hover:text-ink"
    >
      <IconCmp size={17} weight="regular" />
      <span
        role="tooltip"
        className="pointer-events-none absolute left-[calc(100%+10px)] z-50 rounded-[6px] border border-line bg-card px-2.5 py-1 text-[12px] whitespace-nowrap text-ink opacity-0 -translate-x-1 transition-[opacity,transform] duration-200 [transition-timing-function:cubic-bezier(0.34,1.56,0.64,1)] group-hover:translate-x-0 group-hover:opacity-100"
      >
        {label}
      </span>
    </button>
  )
}
