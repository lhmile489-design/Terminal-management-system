import type { Icon } from '@phosphor-icons/react'
import { ICON_SIZE } from '../../lib/icons'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

/**
 * 按钮，UI-REFACTOR §4.4。按下缩到 0.96、松开回弹由 ui.css 统一给；
 * `failed` 为 true 时抖动并变红，调用方在约 400ms 后自己清掉。
 * 禁用不压整块透明度，换弱化底色 + 可见边框，文字仍过 4.5:1。
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  icon: IconCmp,
  failed,
  children,
  type = 'button',
  ...rest
}: {
  variant?: Variant
  size?: 'sm' | 'md'
  icon?: Icon
  failed?: boolean
} & React.ComponentPropsWithRef<'button'>): React.JSX.Element {
  return (
    <button
      {...rest}
      type={type}
      className={`ui-btn ${rest.className ?? ''}`}
      data-variant={variant}
      data-size={size}
      data-failed={failed || undefined}
    >
      {IconCmp && <IconCmp size={ICON_SIZE.inline} aria-hidden />}
      {children}
    </button>
  )
}

/**
 * 纯图标按钮。`label` 必填：同时作为 aria-label 和悬停提示，
 * 杜绝「没有可读名称的图标按钮」。
 */
export function IconButton({
  label,
  icon: IconCmp,
  size = 'sm',
  tone,
  failed,
  pressed,
  type = 'button',
  ...rest
}: {
  label: string
  icon: Icon
  size?: 'sm' | 'md'
  tone?: 'danger'
  failed?: boolean
  pressed?: boolean
} & Omit<React.ComponentPropsWithRef<'button'>, 'aria-label' | 'title' | 'children'>): React.JSX.Element {
  return (
    <button
      {...rest}
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={`ui-iconbtn ${rest.className ?? ''}`}
      data-size={size}
      data-tone={tone}
      data-failed={failed || undefined}
    >
      <IconCmp size={ICON_SIZE.inline} weight={pressed ? 'fill' : 'regular'} aria-hidden />
    </button>
  )
}
