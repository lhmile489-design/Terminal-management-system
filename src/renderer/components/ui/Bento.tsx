import { useRef } from 'react'
import type { Icon } from '@phosphor-icons/react'
import { ICON_SIZE } from '../../lib/icons'

type Tone = 'live' | 'warn' | 'fault'

/**
 * 便当网格，UI-REFACTOR §3.1。固定 4 列，靠容器查询在内容区 < 56rem 时退 2 列、< 38rem 时退 1 列。
 * 不提供列数属性：内联 --cols 会盖过容器查询，窄窗口下就不会退列了。
 */
export function BentoGrid({
  children,
  className = ''
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className="ui-bento-wrap">
      <div className={`ui-bento ${className}`}>{children}</div>
    </div>
  )
}

/**
 * 磁贴。状态色只进描边（§4.6），不染底色。`interactive` 才有悬停上浮；
 * 拖拽中 `dragging` 让位给 FLIP 动画，不再上浮。
 */
export function Tile({
  as: Tag = 'section',
  span,
  rows,
  tone,
  interactive,
  dragging,
  className = '',
  children,
  ...rest
}: {
  as?: 'section' | 'article' | 'div'
  span?: 2 | 3 | 'full'
  rows?: 2
  tone?: Tone
  interactive?: boolean
  dragging?: boolean
  className?: string
  children: React.ReactNode
} & Omit<React.HTMLAttributes<HTMLElement>, 'className' | 'children'>): React.JSX.Element {
  return (
    <Tag
      {...rest}
      className={`ui-tile ${className}`}
      data-span={span}
      data-rows={rows}
      data-tone={tone}
      data-interactive={interactive || undefined}
      data-dragging={dragging || undefined}
    >
      {children}
    </Tag>
  )
}

export function TileHeader({
  title,
  icon: IconCmp,
  sub,
  actions,
  id,
  level = 2
}: {
  title: React.ReactNode
  icon?: Icon
  sub?: React.ReactNode
  actions?: React.ReactNode
  id?: string
  level?: 2 | 3
}): React.JSX.Element {
  const H = level === 2 ? 'h2' : 'h3'
  return (
    <div className="ui-tile-head">
      {IconCmp && (
        <span className="ui-tile-head-icon">
          <IconCmp size={ICON_SIZE.title} aria-hidden />
        </span>
      )}
      <H id={id} className="ui-tile-title">
        {title}
      </H>
      {sub != null && <span className="ui-tile-sub">{sub}</span>}
      {actions && <div className="ui-tile-actions">{actions}</div>}
    </div>
  )
}

export function TileBody({
  children,
  className = ''
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return <div className={`ui-tile-body ${className}`}>{children}</div>
}

/**
 * 统计数字：Manrope + tabular-nums，刷新时不左右跳。
 * 数值变化时新值淡入加 2px 位移（§4.4）：按值换 key 让内层 span 重挂载、重放动画；
 * 首次挂载不放，否则每次切页面所有数字都会闪一下。
 */
export function StatValue({
  value,
  unit,
  size = 'lg'
}: {
  value: string | number
  unit?: string
  size?: 'lg' | 'md'
}): React.JSX.Element {
  const mounted = useRef(false)
  const animate = mounted.current
  mounted.current = true
  return (
    <span className="ui-stat" data-size={size}>
      <span key={String(value)} className="ui-stat-v" data-changed={animate || undefined}>
        {value}
      </span>
      {unit && <span className="ui-stat-unit">{unit}</span>}
    </span>
  )
}
