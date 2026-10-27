/**
 * 基础组件，UI-REFACTOR §6。视图只组合这些组件，不再手写圆角、阴影和状态配色。
 * 样式在 styles/ui.css（无 @layer，类名统一 ui- 前缀）。
 */
export { Button, IconButton } from './Button'
export { Pill, StatusDot } from './Pill'
export { Segmented, type SegmentOption } from './Segmented'
export { Tabs, tabPanelProps, type TabItem } from './Tabs'
export { Field, TextInput, Select, Switch, Stepper } from './Form'
export { DialogShell, Drawer } from './Overlay'
export { confirm, ConfirmHost, type ConfirmOptions } from './Confirm'
export { toast, dismissToast, ToastHost, type ToastTone, type ToastInput } from './Toast'
export { MenuButton, type MenuItem } from './Menu'
export { SplitPane } from './SplitPane'
export { BentoGrid, Tile, TileHeader, TileBody, StatValue } from './Bento'
