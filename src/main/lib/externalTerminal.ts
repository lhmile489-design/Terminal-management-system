import { spawn } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import type { Settings } from '@shared/types'

type TerminalKind = Settings['externalTerminal']

const LABEL: Record<TerminalKind, string> = {
  wt: 'Windows Terminal',
  pwsh: 'PowerShell 7',
  powershell: 'PowerShell',
  cmd: 'CMD',
  gitbash: 'Git Bash'
}

/** 新窗口的标题。含空格是有意的：Node 会给它加引号，start 才把它当标题而不是程序名 */
export const EXTERNAL_TERMINAL_TITLE = 'Mile Terminal'

function candidates(kind: TerminalKind): string[] {
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  const local = process.env.LOCALAPPDATA ?? ''
  switch (kind) {
    case 'wt':
      // 应用执行别名是重解析点，existsSync 认不出，下面用 lstat 判
      return local ? [join(local, 'Microsoft', 'WindowsApps', 'wt.exe')] : []
    case 'pwsh':
      return [
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        ...(local ? [join(local, 'Microsoft', 'WindowsApps', 'pwsh.exe')] : [])
      ]
    case 'powershell':
      return [join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]
    case 'cmd':
      return [process.env.ComSpec ?? join(root, 'System32', 'cmd.exe')]
    case 'gitbash':
      return [
        'C:\\Program Files\\Git\\git-bash.exe',
        'C:\\Program Files (x86)\\Git\\git-bash.exe',
        ...(local ? [join(local, 'Programs', 'Git', 'git-bash.exe')] : [])
      ]
  }
}

/**
 * 各终端的固定参数。**目录从不出现在参数里**，一律经 spawn 的 cwd 选项传：
 * wt 用 `-d .`、Git Bash 用 `--cd-to-here` 表示「就在当前目录」。
 * 把路径塞进参数会有两个坑：wt 把 `;` 当子命令分隔符，cmd 会解释 `&` `|` 这类字符。
 */
function fixedArgs(kind: TerminalKind): string[] {
  switch (kind) {
    case 'wt':
      return ['-d', '.']
    case 'pwsh':
    case 'powershell':
      return ['-NoLogo', '-NoExit']
    case 'cmd':
      return ['/K']
    case 'gitbash':
      return ['--cd-to-here']
  }
}

function present(p: string): boolean {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * 用设置里选的外部终端打开一个目录。cwd 必须是调用方已按登记条目解析并校验过的目录。
 *
 * 经 `cmd /d /c start "标题" <终端> <固定参数>` 拉起：直接 spawn 控制台程序拿不到自己的
 * 控制台窗口，stdin 一关就退出（实测 PowerShell / CMD 都是 3 秒内消失）。命令行上的每一段
 * 都是代码里的常量，没有任何来自条目或用户的字符串。
 */
export function openExternalTerminal(kind: TerminalKind, cwd: string): void {
  if (!(kind in LABEL)) throw new Error(`外部终端设置非法：${String(kind)}`)
  // cmd 不能把 UNC 路径当工作目录，会静默退回 C:\Windows，用户会以为开对了地方
  if (cwd.startsWith('\\\\')) throw new Error('外部终端不支持网络路径')
  const exe = candidates(kind).find(present)
  if (!exe) throw new Error(`未找到 ${LABEL[kind]}，可在设置里换一个外部终端`)
  const comspec = process.env.ComSpec ?? 'cmd.exe'
  const child = spawn(comspec, ['/d', '/c', 'start', EXTERNAL_TERMINAL_TITLE, exe, ...fixedArgs(kind)], {
    cwd,
    windowsHide: true,
    stdio: 'ignore'
  })
  child.on('error', () => undefined)
  child.unref()
}
