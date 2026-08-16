import {
  Gauge,
  Rocket,
  Terminal,
  ListMagnifyingGlass,
  Stethoscope,
  Gear,
  type Icon
} from '@phosphor-icons/react'
import { ThemeToggle } from './ThemeToggle'

export type ViewId = 'dashboard' | 'launchpad' | 'terminal' | 'logs' | 'diagnose' | 'settings'

const NAV: { id: ViewId; label: string; icon: Icon }[] = [
  { id: 'dashboard', label: '工作台', icon: Gauge },
  { id: 'launchpad', label: '启动台', icon: Rocket },
  { id: 'terminal', label: '终端', icon: Terminal },
  // 日志紧跟终端：两者看的是同一批输出，一个逐会话交互、一个跨会话检索
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
      className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-line bg-panel py-3"
    >
      {NAV.map((item) => (
        <RailButton
          key={item.id}
          {...item}
          active={active === item.id}
          onClick={() => onChange(item.id)}
        />
      ))}

      <div className="mt-auto flex flex-col items-center gap-1">
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
      className={`pressable group relative flex h-10 w-10 items-center justify-center rounded-[8px] ${
        active ? 'bg-raised text-ink-strong' : 'text-ink-faint hover:bg-raised hover:text-ink'
      }`}
    >
      <IconCmp size={18} weight={active ? 'fill' : 'regular'} />

      {active && (
        <span className="absolute top-1/2 -left-3 h-5 w-[2px] -translate-y-1/2 bg-info" aria-hidden />
      )}

      <span
        role="tooltip"
        className="pointer-events-none absolute left-[calc(100%+10px)] z-50 rounded-[6px] border border-line bg-card px-2.5 py-1 text-[12px] whitespace-nowrap text-ink opacity-0 transition-opacity group-hover:opacity-100"
      >
        {label}
      </span>
    </button>
  )
}
