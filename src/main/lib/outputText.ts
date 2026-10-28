/**
 * 会话输出的文本处理，日志中心与诊断共用一套规则（2.3.0）。
 *
 * 以前 LogService 与 EntryService 各有一份错误行判定：日志中心认 exception、ENOENT、中文「错误」，
 * 诊断认 BUILD FAILURE 却不认 exception，同一次崩溃一边标红一边捕获不到。现在都从这里取。
 *
 * 转义序列一律写成 \x1b 这种可见形式，不敲字面 ESC 字节 —— 字面控制字符在编辑、复制、
 * diff 里会悄悄丢掉，那时正则静默地什么都不匹配。
 */

/** CSI（颜色与光标移动）与 OSC（设置窗口标题，以 BEL 或 ST 收尾） */
export const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
/** 剩下的裸控制字符（退格、响铃…）留着会在界面上显示成方块 */
const CONTROL = /[\x00-\x08\x0b-\x1f]/g
/**
 * ConPTY 换行不一定发 \n：它常用绝对光标定位跳到下一行行首（实测 \x1b[5;1H）。
 * 只认「回到第 1 列」这种形式，定位到其他列是同一行内的重绘。
 */
export const CURSOR_TO_COL1 = /\x1b\[[0-9]+;1[Hf]/g

/**
 * 错误行。只认明确的词形，拿不准就不算 —— 宁可少标，不要把普通输出染成红的。
 * `[A-Za-z]+(Exception|Error)\b` 认 Java / JS 的异常类名（RuntimeException、TypeError），
 * 光靠 `\bexception\b` 认不出带前缀的类名。
 */
export const ERROR_RE =
  /\b(error|err!|failed|failure|exception|cannot find|not found|ELIFECYCLE|ENOENT|EADDRINUSE|BUILD FAILURE|APPLICATION FAILED TO START)\b|[A-Za-z]+(?:Exception|Error)\b|错误|失败/i
export const WARN_RE = /\b(warn|warning|deprecated|deprecation)\b|警告/i

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

export function isErrorLine(text: string): boolean {
  return ERROR_RE.test(text)
}

/**
 * 取这一行最后一次「画出了东西」的重绘结果。进度条用裸 \r 原地重写同一行，要取最后一段；
 * 但 ConPTY 在输出末尾还会补 \r + 擦除序列，那一段清理完是空的，所以从后往前找第一个有内容的段。
 */
export function lastVisiblePaint(raw: string): string {
  const paints = raw.split('\r')
  for (let i = paints.length - 1; i >= 0; i--) {
    const text = paints[i].replace(ANSI, '').replace(CONTROL, '').trimEnd()
    if (text.trim()) return text
  }
  return ''
}

/** 一段原始终端输出切成可见行（去 ANSI、去进度条重绘、去空行），只留最后 limit 行 */
export function visibleTail(raw: string, limit: number, maxChars = 300): string[] {
  const lines: string[] = []
  for (const part of raw.replace(CURSOR_TO_COL1, '\n').split(/\r?\n/)) {
    const text = lastVisiblePaint(part)
    if (text) lines.push(text.slice(0, maxChars))
  }
  return lines.slice(-limit)
}

/**
 * 从可见行里挑「最后一个错误行」。npm / pnpm 在脚本失败后自己追加的 `npm error …` 收尾块
 * 只说明「脚本以非零码退出」，真正的原因在它前面；有别的错误行时优先用别的。
 */
export function pickLastError(lines: string[]): string | undefined {
  const errors = lines.filter(isErrorLine)
  const real = errors.filter((l) => !/^\s*(npm|pnpm|yarn)( ERR!| error|:)|ELIFECYCLE/i.test(l))
  return (real.length ? real : errors).pop()
}
