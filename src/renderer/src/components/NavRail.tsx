import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Monitor,
  type Icon
} from '@phosphor-icons/react'
import type { ThemePreference } from '@shared/types'
import { ICON, ICON_SIZE } from '../lib/icons'
import { useTheme } from '../store/theme'

export type ViewId =
  | 'services'
  | 'dashboard'
  | 'terminal'
  | 'settings'
  | 'about'

interface NavLeaf {
  id: ViewId
  label: string
  icon: Icon
}

interface NavTop extends NavLeaf {
  /** Ctrl+N 快捷键，UI-REFACTOR §5.2 */
  key: number
  /**
   * 过渡期子项：旧页面在阶段 4 / 6 合并进新页面之前，挂在对应一级项下面。
   * aria-label 保留旧名，既有 harness 按名称导航不受影响。
   */
  children?: NavLeaf[]
}

/** 5 项一级导航，UI-REFACTOR Q9 / Q10 / Q19 */
export const NAV_TOP: NavTop[] = [
  // 总览是默认首页，排第一位（用户 2026-10-27 要求）
  { id: 'dashboard', label: '总览', icon: ICON.navOverview, key: 1 },
  {
    id: 'services',
    label: '服务',
    icon: ICON.navServices,
    key: 2
  },
  {
    id: 'terminal',
    label: '终端',
    icon: ICON.navTerminal,
    key: 3
  },
  { id: 'settings', label: '设置', icon: ICON.navSettings, key: 4 },
  { id: 'about', label: '关于', icon: ICON.navAbout, key: 5 }
]

/** Ctrl+1..5 对应的视图 */
export const NAV_HOTKEYS: Record<number, ViewId> = Object.fromEntries(NAV_TOP.map((t) => [t.key, t.id]))

const COLLAPSE_KEY = 'mile.nav.collapsed'

const THEME_CYCLE: ThemePreference[] = ['light', 'dark', 'system']
const THEME_META: Record<ThemePreference, { icon: Icon; label: string }> = {
  light: { icon: ICON.themeLight, label: '浅色' },
  dark: { icon: ICON.themeDark, label: '深色' },
  system: { icon: Monitor, label: '跟随系统' }
}

function groupOf(view: ViewId): ViewId {
  const top = NAV_TOP.find((t) => t.id === view || t.children?.some((c) => c.id === view))
  return top?.id ?? view
}

export function NavRail({
  active,
  onChange
}: {
  active: ViewId
  onChange: (id: ViewId) => void
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === '1')
  const [tip, setTip] = useState<{ label: string; top: number; left: number } | null>(null)
  const navRef = useRef<HTMLElement>(null)
  const indRef = useRef<HTMLSpanElement>(null)
  const [indReady, setIndReady] = useState(false)
  const preference = useTheme((s) => s.preference)
  const setTheme = useTheme((s) => s.set)

  const group = groupOf(active)
  const topBar = NAV_TOP.filter((t) => t.key <= 3)
  const bottom = NAV_TOP.filter((t) => t.key > 3)

  // 指示条滑到当前页那一项：首次只定位，之后才开过渡
  useLayoutEffect(() => {
    const el = navRef.current?.querySelector<HTMLElement>('[aria-current="page"]')
    const ind = indRef.current
    if (!el || !ind) return
    ind.style.transform = `translateY(${el.offsetTop + (el.offsetHeight - 20) / 2}px)`
    if (!indReady) requestAnimationFrame(() => setIndReady(true))
  }, [active, collapsed, indReady])

  const toggleCollapsed = (): void => {
    setCollapsed((v) => {
      localStorage.setItem(COLLAPSE_KEY, v ? '0' : '1')
      return !v
    })
    setTip(null)
  }

  const showTip = (label: string) => (e: React.SyntheticEvent<HTMLElement>) => {
    if (!collapsed) return
    const r = e.currentTarget.getBoundingClientRect()
    setTip({ label, top: r.top + r.height / 2 - 13, left: r.right + 8 })
  }
  const tipHandlers = (label: string): React.HTMLAttributes<HTMLElement> => ({
    onMouseEnter: showTip(label),
    onFocus: showTip(label),
    onMouseLeave: () => setTip(null),
    onBlur: () => setTip(null)
  })

  const item = (leaf: NavLeaf, opts: { kbd?: number; sub?: boolean; groupActive?: boolean }): React.JSX.Element => {
    // 一级项与某个子项同 id 时（服务 → 前端启动台），当前页标记只给子项，避免两处同时 aria-current
    const shadowedByChild = !opts.sub && !!NAV_TOP.find((t) => t.id === leaf.id)?.children?.some((c) => c.id === leaf.id)
    const current = active === leaf.id && !shadowedByChild
    const IconCmp = leaf.icon
    return (
      <button
        key={`${opts.sub ? 'sub' : 'top'}-${leaf.label}`}
        type="button"
        className="ui-nav-item"
        aria-label={leaf.label}
        aria-current={current ? 'page' : undefined}
        data-group-active={opts.groupActive || undefined}
        data-sub={opts.sub || undefined}
        onClick={() => onChange(leaf.id)}
        {...tipHandlers(opts.kbd ? `${leaf.label}  Ctrl ${opts.kbd}` : leaf.label)}
      >
        <IconCmp size={opts.sub ? ICON_SIZE.inline : ICON_SIZE.title} weight={current ? 'fill' : 'regular'} aria-hidden />
        <span className="ui-nav-label">{leaf.label}</span>
        {opts.kbd && <span className="ui-nav-kbd" aria-hidden>Ctrl {opts.kbd}</span>}
      </button>
    )
  }

  const top = (t: NavTop): React.JSX.Element[] => [
    item(t, { kbd: t.key, groupActive: !!t.children && group === t.id }),
    ...(t.children ?? []).map((c) => item(c, { sub: true }))
  ]

  const theme = THEME_META[preference]
  const nextTheme = THEME_CYCLE[(THEME_CYCLE.indexOf(preference) + 1) % THEME_CYCLE.length]
  const ThemeIcon = theme.icon
  const collapseLabel = collapsed ? '展开导航' : '折叠导航'

  return (
    <nav ref={navRef} aria-label="主导航" className="ui-nav" data-collapsed={collapsed || undefined}>
      <span ref={indRef} className="ui-nav-indicator" data-ready={indReady || undefined} aria-hidden />
      {topBar.flatMap(top)}
      <div className="ui-nav-sep" />
      {bottom.flatMap(top)}
      <button
        type="button"
        className="ui-nav-item"
        aria-label={`主题：${theme.label}，点击切换为${THEME_META[nextTheme].label}`}
        onClick={() => void setTheme(nextTheme)}
        {...tipHandlers(`主题：${theme.label}`)}
      >
        <ThemeIcon size={ICON_SIZE.title} aria-hidden />
        <span className="ui-nav-label">主题 · {theme.label}</span>
      </button>
      <button
        type="button"
        className="ui-nav-item"
        aria-label={collapseLabel}
        aria-expanded={!collapsed}
        onClick={toggleCollapsed}
        {...tipHandlers(collapseLabel)}
      >
        <ICON.collapseNav size={ICON_SIZE.title} aria-hidden />
        <span className="ui-nav-label">折叠导航</span>
      </button>
      {tip &&
        createPortal(
          <span role="tooltip" className="ui-nav-tip" style={{ top: tip.top, left: tip.left }}>
            {tip.label}
          </span>,
          document.body
        )}
    </nav>
  )
}
