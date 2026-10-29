/**
 * 渲染层的平台差异只有两件事：主修饰键（Windows Ctrl / macOS Cmd）与标题栏形态。
 * 平台名由 preload 下发，渲染层不做任何特权判断。
 */
export const IS_MAC = window.mile.platform === 'darwin'

/** 快捷键的主修饰键是否按下：Windows 看 Ctrl，macOS 看 Cmd */
export function primaryKey(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return IS_MAC ? e.metaKey : e.ctrlKey
}

/** 界面上显示的主修饰键名称 */
export const MOD_LABEL = IS_MAC ? 'Cmd' : 'Ctrl'

/** 全局快捷键的显示文案，与主进程 platform.globalHotkey 对应 */
export const GLOBAL_HOTKEY_LABEL = IS_MAC ? 'Cmd+Alt+M' : 'Ctrl+Alt+M'
