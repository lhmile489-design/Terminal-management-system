/**
 * 自绘 SVG 图标集。统一 20×20 viewBox，stroke-only 线条风格。
 * 不依赖任何第三方图标库。
 */

interface IconProps {
  size?: number
  strokeWidth?: number
  className?: string
}

function Icon({
  size = 14,
  strokeWidth = 1.6,
  className = '',
  children
}: IconProps & { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {children}
    </svg>
  )
}

export function IconPlay(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <polygon points="5,3 17,10 5,17" />
    </Icon>
  )
}

export function IconStop(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <rect x="4" y="4" width="12" height="12" rx="2" />
    </Icon>
  )
}

export function IconRestart(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M4 10a6 6 0 1 0 1.5-4" />
      <polyline points="4,4 4,10 10,10" />
    </Icon>
  )
}

export function IconTerminal(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <rect x="2" y="3" width="16" height="14" rx="2" />
      <path d="M6 8l3 2.5L6 13" />
      <path d="M12 13h4" />
    </Icon>
  )
}

export function IconStethoscope(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M6 3v4a4 4 0 0 0 8 0V3" />
      <path d="M10 11v3a3 3 0 0 0 6 0v-1" />
      <circle cx="16" cy="13" r="1" fill="currentColor" stroke="none" />
    </Icon>
  )
}

export function IconEdit(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M14.5 3.5a2 2 0 0 1 2.83 2.83l-9.9 9.9-3.76.94.94-3.76z" />
    </Icon>
  )
}

export function IconFolder(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M2 7a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7z" />
    </Icon>
  )
}

export function IconFolderOpen(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M2 7a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v1" />
      <path d="M2 11l1.5 6h13l1.5-6H2z" />
    </Icon>
  )
}

export function IconPackage(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M10 2l7 4v8l-7 4-7-4V6z" />
      <polyline points="10,2 10,14" />
      <path d="M3.5 6l6.5 3.5 6.5-3.5" />
    </Icon>
  )
}

export function IconPushPin(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M12 2l2 2-1.5 4.5 3 3-4.5 1.5L10 18l-1-5L4.5 11.5l3-3z" />
      <line x1="4" y1="16" x2="8" y2="12" />
    </Icon>
  )
}

export function IconTrash(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <polyline points="3,5 5,5 17,5" />
      <path d="M6 5V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v1" />
      <rect x="5" y="5" width="10" height="12" rx="1" />
      <line x1="9" y1="9" x2="9" y2="14" />
      <line x1="12" y1="9" x2="12" y2="14" />
    </Icon>
  )
}

export function IconExternalLink(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M11 4H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-6" />
      <polyline points="14,2 18,2 18,6" />
      <line x1="10" y1="10" x2="18" y2="2" />
    </Icon>
  )
}

export function IconGrid(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <rect x="2" y="2" width="7" height="7" rx="1" />
      <rect x="11" y="2" width="7" height="7" rx="1" />
      <rect x="2" y="11" width="7" height="7" rx="1" />
      <rect x="11" y="11" width="7" height="7" rx="1" />
    </Icon>
  )
}

export function IconList(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <rect x="2" y="3" width="16" height="4" rx="1" />
      <rect x="2" y="9" width="16" height="4" rx="1" />
      <rect x="2" y="15" width="16" height="4" rx="1" />
    </Icon>
  )
}

export function IconChevronDown(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <polyline points="4,7 10,13 16,7" />
    </Icon>
  )
}

export function IconChevronRight(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <polyline points="7,4 13,10 7,16" />
    </Icon>
  )
}

export function IconWarning(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M10 2L2 17h16z" />
      <line x1="10" y1="9" x2="10" y2="13" />
      <circle cx="10" cy="15.5" r="0.6" fill="currentColor" stroke="none" />
    </Icon>
  )
}

export function IconX(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <line x1="4" y1="4" x2="16" y2="16" />
      <line x1="16" y1="4" x2="4" y2="16" />
    </Icon>
  )
}

export function IconArrowRight(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <line x1="3" y1="10" x2="17" y2="10" />
      <polyline points="11,4 17,10 11,16" />
    </Icon>
  )
}

export function IconRocket(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M10 2c2 0 6 2 6 8l-2 4H6L4 10c0-6 4-8 6-8z" />
      <path d="M7 14l-2 4h10l-2-4" />
      <circle cx="10" cy="8" r="1.5" fill="currentColor" stroke="none" />
    </Icon>
  )
}

export function IconPlus(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <line x1="10" y1="3" x2="10" y2="17" />
      <line x1="3" y1="10" x2="17" y2="10" />
    </Icon>
  )
}

export function IconCommand(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M7 7H5a2 2 0 1 0 2 2V7z" />
      <path d="M13 7h2a2 2 0 1 1-2 2V7z" />
      <path d="M7 13H5a2 2 0 1 1 2-2v2z" />
      <path d="M13 13h2a2 2 0 1 0-2-2v2z" />
      <line x1="7" y1="7" x2="13" y2="7" />
      <line x1="7" y1="13" x2="13" y2="13" />
      <line x1="7" y1="7" x2="7" y2="13" />
      <line x1="13" y1="7" x2="13" y2="13" />
    </Icon>
  )
}

/** 任务下拉用的 CaretDown */
export function IconCaretDown(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M5 8l5 5 5-5" fill="currentColor" stroke="none" />
    </Icon>
  )
}
