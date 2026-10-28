/**
 * 「含义 → 图标」对照表，docs/UI/UI-REFACTOR.md 第 4.5 节（Q17）。
 *
 * 每个含义只对应一个 Phosphor 图标，视图里不直接 import 图标组件，统一从这里取，
 * 这样「启动」在卡片、详情、命令面板里长得一样。尺寸只有两档：行内 16、导航与磁贴标题 20。
 * 默认 regular，只有选中态用 fill。
 */
import {
  ArrowClockwise,
  ArrowDown,
  ArrowUp,
  ArrowsIn,
  ArrowsOut,
  ArrowSquareOut,
  Bell,
  Check,
  CheckCircle,
  Copy,
  DotsThree,
  FolderOpen,
  Folders,
  Gauge,
  Gear,
  Hammer,
  Info,
  Keyboard,
  Lock,
  MagnifyingGlass,
  Moon,
  Package,
  Play,
  Plug,
  Plus,
  Prohibit,
  SidebarSimple,
  SlidersHorizontal,
  Stack,
  Stethoscope,
  Stop,
  Sun,
  TerminalWindow,
  Trash,
  DownloadSimple,
  UploadSimple,
  Warning,
  WarningCircle,
  X,
  type Icon
} from '@phosphor-icons/react'

export const ICON = {
  start: Play,
  stop: Stop,
  restart: ArrowClockwise,
  kill: Prohibit,
  output: TerminalWindow,
  diagnose: Stethoscope,
  build: Hammer,
  config: SlidersHorizontal,
  overview: Gauge,
  openFolder: FolderOpen,
  artifact: Package,
  openExternal: ArrowSquareOut,
  remove: Trash,
  more: DotsThree,
  moveUp: ArrowUp,
  moveDown: ArrowDown,
  maximize: ArrowsOut,
  restore: ArrowsIn,
  close: X,
  copy: Copy,
  copied: Check,
  check: Check,
  locked: Lock,
  port: Plug,
  group: Folders,
  activity: Bell,
  search: MagnifyingGlass,
  shortcuts: Keyboard,
  prodWarning: Warning,
  failed: WarningCircle,
  success: CheckCircle,
  info: Info,
  themeLight: Sun,
  themeDark: Moon,
  collapseNav: SidebarSimple,
  add: Plus,
  export: UploadSimple,
  import: DownloadSimple,
  // 导航
  navServices: Stack,
  navOverview: Gauge,
  navTerminal: TerminalWindow,
  navSettings: Gear,
  navAbout: Info
} satisfies Record<string, Icon>

export type IconName = keyof typeof ICON

/** 两档尺寸 */
export const ICON_SIZE = { inline: 16, title: 20 } as const
