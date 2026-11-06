/**
 * 复制文本，成功返回 true。
 *
 * 不用 navigator.clipboard.writeText：它要求文档有焦点，窗口失焦（托盘、另一个窗口在前）
 * 时以 NotAllowedError 拒绝。以前调用方把这个错误吞掉，界面照样显示「已复制」，剪贴板却是空的。
 * 经主进程的 Electron clipboard 写入，没有焦点要求。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await window.mile.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
