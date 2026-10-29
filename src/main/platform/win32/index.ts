import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { LaunchMode } from '@shared/types'
import type { AttributionTables, BinaryName, Platform } from '../types'
import { readListenPorts, readProcessMeta } from './process'
import { openExternalTerminal, WIN_TERMINALS } from './terminal'

/**
 * Windows 实现。这里的每一行都是从服务层原样搬来的，行为与 2.3.0 一致：
 * 进程采集走 netstat + CIM，终止走 taskkill /T /F，批处理经 cmd /d /s /c 转发。
 */

const SHELL_CANDIDATES = [
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
]

let cachedShell: string | null = null

function isPowerShell(file: string): boolean {
  return /powershell\.exe$|pwsh\.exe$/i.test(file)
}

/** 包管理器与运行时的可执行文件候选名，经 whichAny 在 PATH 里定位，用户不能指定 */
const BINARIES: Record<BinaryName, string[]> = {
  npm: ['npm.cmd', 'npm.exe'],
  pnpm: ['pnpm.cmd', 'pnpm.exe'],
  yarn: ['yarn.cmd', 'yarn.exe'],
  bun: ['bun.exe'],
  java: ['java.exe'],
  mvn: ['mvn.cmd', 'mvn.bat', 'mvn'],
  gradle: ['gradle.cmd', 'gradle.bat', 'gradle'],
  python: ['python.exe', 'python3.exe', 'py.exe', 'python', 'python3'],
  go: ['go.exe', 'go'],
  cargo: ['cargo.exe', 'cargo']
}

const ATTRIBUTION: AttributionTables = {
  // 不跳过的话所有 npm 启动的服务来源都是「终端」——
  // 链条是 VS Code → cmd.exe → npm.cmd → node → vite，真正有信息量的是最上面那一层
  transparent: new Set([
    'cmd.exe', 'powershell.exe', 'pwsh.exe', 'bash.exe', 'sh.exe', 'zsh.exe', 'conhost.exe',
    'openconsole.exe', 'node.exe', 'npm.cmd', 'npm.exe', 'pnpm.exe', 'pnpm.cmd', 'yarn.exe',
    'yarn.cmd', 'bun.exe', 'npx.cmd', 'py.exe', 'python.exe', 'python3.exe'
  ]),
  sourceByName: [
    { source: 'vscode', names: ['code.exe', 'code - insiders.exe', 'codium.exe'] },
    { source: 'cursor', names: ['cursor.exe'] },
    {
      source: 'jetbrains',
      names: ['webstorm64.exe', 'webstorm.exe', 'idea64.exe', 'idea.exe', 'pycharm64.exe', 'pycharm.exe']
    },
    { source: 'claude', names: ['claude.exe'] },
    { source: 'codex', names: ['codex.exe'] },
    {
      source: 'terminal',
      names: ['windowsterminal.exe', 'wt.exe', 'alacritty.exe', 'wezterm-gui.exe', 'mintty.exe']
    },
    { source: 'explorer', names: ['explorer.exe'] },
    { source: 'service', names: ['services.exe', 'svchost.exe', 'wininit.exe'] }
  ],
  sourceByCmd: [
    { source: 'claude', needles: ['claude-code', 'anthropic'] },
    { source: 'codex', needles: ['codex-cli'] },
    { source: 'vscode', needles: ['\\.vscode\\', '\\.vscode-server\\'] },
    { source: 'cursor', needles: ['\\.cursor\\'] }
  ],
  devRuntime: new Set([
    'node.exe', 'bun.exe', 'deno.exe', 'python.exe', 'python3.exe', 'pythonw.exe', 'java.exe',
    'dotnet.exe', 'go.exe', 'ruby.exe', 'php.exe', 'nginx.exe', 'httpd.exe', 'caddy.exe',
    'mysqld.exe', 'postgres.exe', 'redis-server.exe', 'mongod.exe', 'esbuild.exe', 'vite.exe',
    'cargo.exe', 'hugo.exe'
  ]),
  // 系统目录下的进程归后台：装在这里的东西不是用户此刻在开发的项目
  systemDirs: ['c:\\windows\\', 'c:\\program files\\windowsapps\\', '\\microsoft\\windowsapps\\']
}

export const win32: Platform = {
  id: 'win32',

  readListenPorts,
  readProcessMeta,

  // Vite/webpack 会拉起子进程，pty.kill() 只结束 conhost 根进程，必须带树终止。
  // 等 taskkill 回调再 resolve：退出清理靠这一步确认进程树已结束
  killTree(rootPid) {
    return new Promise<void>((done) => {
      try {
        execFile(
          'taskkill.exe',
          ['/PID', String(rootPid), '/T', '/F'],
          { windowsHide: true, timeout: 5000 },
          () => done()
        )
      } catch {
        // taskkill 不可用时由调用方退回 pty.kill
        done()
      }
    })
  },

  binaries: BINARIES,
  wrapperFile: { maven: 'mvnw.cmd', gradle: 'gradlew.bat' },

  // npm.cmd / mvnw.cmd 是批处理文件，CreateProcess 不能直接执行，必须经 cmd.exe。
  // 参数仍以数组传入由 node-pty 负责转义，脚本名另有白名单，不做字符串拼接
  wrapBatch(file, args) {
    return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', file, ...args] }
  },

  unsupportedLaunchModes: new Set<LaunchMode>(),
  requiresExecBit: false,

  // 它不在 PATH，所以按绝对路径探测，顺序即优先级。测试可用 MILE_HBUILDERX_CLI 指向夹具里的假 cli
  hbuilderxCandidates() {
    const override = process.env.MILE_HBUILDERX_CLI
    if (override) return [override]
    const localAppData = process.env.LOCALAPPDATA
    const list = [
      'D:\\HBuilderX\\cli.exe',
      'C:\\Program Files\\HBuilderX\\cli.exe',
      'D:\\Program Files\\HBuilderX\\cli.exe',
      'C:\\HBuilderX\\cli.exe'
    ]
    if (localAppData) list.push(join(localAppData, 'HBuilderX', 'cli.exe'))
    return list
  },

  defaultShell() {
    if (!cachedShell) {
      cachedShell = SHELL_CANDIDATES.find((p) => existsSync(p)) ?? process.env.ComSpec ?? 'cmd.exe'
    }
    return { file: cachedShell, title: 'PowerShell' }
  },

  shellArgs(file) {
    return isPowerShell(file) ? ['-NoLogo', '-NoExit'] : []
  },

  // ConPTY 默认代码页 936，中文与进度条会乱码
  shellInit(file) {
    return isPowerShell(file)
      ? "chcp 65001 > $null; [Console]::OutputEncoding = [Text.Encoding]::UTF8; Clear-Host\r"
      : null
  },

  terminalKinds: WIN_TERMINALS,
  defaultTerminal: 'wt',
  openExternalTerminal,

  // 大小写不敏感，且要消掉 `a\b\..\b` 这类等价写法
  pathKey(p) {
    return resolve(p).replace(/[\\/]+$/, '').toLowerCase()
  },

  preparePath() {
    // Windows 的 GUI 应用继承完整的用户 PATH，不需要补
  },

  attribution: ATTRIBUTION,

  globalHotkey: 'Ctrl+Alt+M'
}
