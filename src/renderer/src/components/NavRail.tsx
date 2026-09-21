import {
  Gauge,
  Rocket,
  Terminal,
  ListMagnifyingGlass,
  Stethoscope,
  Gear,
  BookOpen,
  TreeStructure,
  type Icon
} from '@phosphor-icons/react'
import { ThemeToggle } from './ThemeToggle'

export type ViewId = 'dashboard' | 'launchpad' | 'backend' | 'terminal' | 'logs' | 'diagnose' | 'settings' | 'about'

const NAV: { id: ViewId; label: string; icon: Icon }[] = [
  { id: 'dashboard', label: '工作台', icon: Gauge },
  { id: 'launchpad', label: '前端启动台', icon: Rocket },
  { id: 'backend', label: '后端控制台', icon: TreeStructure },
  { id: 'terminal', label: '终端', icon: Terminal },
  { id: 'logs', label: '日志', icon: ListMagnifyingGlass },
  { id: 'diagnose', label: '诊断', icon: Stethoscope }
]

export function NavRail({
  active,
  onChange
}: {
  active: ViewId
  onChange: (id: ViewId) => void
}): React.JSX.Element {
  return (
    <nav
      aria-label="主导航"
      className="flex w-12 shrink-0 flex-col items-center gap-0.5 border-r border-line bg-panel py-2"
    >
      {NAV.map((item) => (
        <RailButton
          key={item.id}
          {...item}
          active={active === item.id}
          onClick={() => onChange(item.id)}
        />
      ))}

      <div className="mt-auto flex flex-col items-center gap-0.5">
        <RailButton
          id="about"
          label="关于"
          icon={BookOpen}
          active={active === 'about'}
          onClick={() => onChange('about')}
        />
        <ThemeToggle />
        <RailButton
          id="settings"
          label="设置"
          icon={Gear}
          active={active === 'settings'}
          onClick={() => onChange('settings')}
        />
      </div>
    </nav>
  )
}

function RailButton({
  label,
  icon: IconCmp,
  active,
  onClick
}: {
  id: ViewId
  label: string
  icon: Icon
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      className={`pressable group relative flex h-9 w-9 items-center justify-center rounded-[7px] transition-colors duration-150 ${
        active
          ? 'bg-raised text-ink-strong'
          : 'text-ink-faint/70 hover:bg-raised/60 hover:text-ink'
      }`}
    >
      <IconCmp size={16} weight={active ? 'fill' : 'regular'} />

      {/* 选中指示线 */}
      {active && (
        <span
          className="absolute top-1/2 -left-[3px] h-4 w-[2px] -translate-y-1/2 rounded-r-full bg-accent"
          aria-hidden
        />
      )}

      {/* 悬停 tooltip */}
      <span
        role="tooltip"
        className="pointer-events-none absolute left-[calc(100%+8px)] z-50 rounded-[5px] border border-line bg-card px-2 py-1 font-mono text-[11px] whitespace-nowrap text-ink opacity-0 transition-opacity duration-150 group-hover:opacity-100 shadow-[var(--shadow-lift)]"
      >
        {label}
      </span>
    </button>
  )
}
