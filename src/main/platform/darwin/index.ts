import { execFile, spawn } from 'node:child_process'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import type { LaunchMode } from '@shared/types'
import type { AttributionTables, BinaryName, Platform, TerminalKind } from '../types'
import { readListenPorts, readProcessMeta } from './process'

/**
 * macOS 实现（docs/MACOS-PORTING.md §3）。
 *
 * 在 Windows 上写成、只过了 typecheck，**未在真机运行过**。阶段 4 的 macOS 专项
 * harness（proctable / killgroup / path / shell）先在 Mac 上跑红再跑绿，才算可用。
 */

/** npm 生态与运行时直接 spawn 绝对路径，不经任何 shell（红线 3） */
const BINARIES: Record<BinaryName, string[]> = {
  npm: ['npm'],
  pnpm: ['pnpm'],
  yarn: ['yarn'],
  bun: ['bun'],
  java: ['java'],
  mvn: ['mvn'],
  gradle: ['gradle'],
  python: ['python3', 'python'],
  go: ['go'],
  cargo: ['cargo']
}

const ATTRIBUTION: AttributionTables = {
  transparent: new Set([
    'zsh', 'bash', 'sh', 'fish', 'login', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun',
    'python', 'python3'
  ]),
  sourceByName: [
    { source: 'vscode', names: ['code', 'code helper', 'code helper (plugin)', 'electron', 'codium'] },
    { source: 'cursor', names: ['cursor', 'cursor helper', 'cursor helper (plugin)'] },
    { source: 'jetbrains', names: ['webstorm', 'idea', 'pycharm', 'goland', 'rustrover'] },
    { source: 'claude', names: ['claude'] },
    { source: 'codex', names: ['codex'] },
    { source: 'terminal', names: ['terminal', 'iterm2', 'alacritty', 'wezterm-gui', 'kitty', 'ghostty'] },
    { source: 'explorer', names: ['finder'] },
    { source: 'service', names: ['launchd'] }
  ],
  sourceByCmd: [
    { source: 'claude', needles: ['claude-code', 'anthropic'] },
    { source: 'codex', needles: ['codex-cli'] },
    { source: 'vscode', needles: ['/visual studio code.app/', '/.vscode/', '/.vscode-server/'] },
    { source: 'cursor', needles: ['/cursor.app/', '/.cursor/'] }
  ],
  devRuntime: new Set([
    'node', 'bun', 'deno', 'python', 'python3', 'java', 'dotnet', 'go', 'ruby', 'php', 'nginx',
    'httpd', 'caddy', 'mysqld', 'postgres', 'redis-server', 'mongod', 'esbuild', 'vite', 'cargo', 'hugo'
  ]),
  systemDirs: ['/system/', '/usr/libexec/', '/usr/sbin/', '/library/apple/']
}

const TERMINALS: readonly TerminalKind[] = ['terminal', 'iterm']
const TERMINAL_APP: Partial<Record<TerminalKind, string>> = { terminal: 'Terminal', iterm: 'iTerm' }

/** 进程组整组发信号。组已不存在（ESRCH）就是已经结束了 */
function signalGroup(pgid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, sig)
    return true
  } catch {
    return false
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 固定目录探测（§6 决策 2 的 A）：不执行任何东西，只看目录在不在 */
function knownBinDirs(): string[] {
  const home = homedir()
  const dirs = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    join(home, '.volta', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, 'go', 'bin'),
    join(home, '.local', 'bin')
  ]
  // nvm / fnm：取版本号最大的那一个 node
  for (const root of [join(home, '.nvm', 'versions', 'node'), join(home, '.local', 'share', 'fnm', 'node-versions')]) {
    try {
      const versions = readdirSync(root).sort(compareVersionDesc)
      if (versions[0]) {
        const nvm = join(root, versions[0], 'bin')
        const fnm = join(root, versions[0], 'installation', 'bin')
        dirs.unshift(existsSync(fnm) ? fnm : nvm)
      }
    } catch {
      // 没装
    }
  }
  return dirs.filter((d) => existsSync(d))
}

function compareVersionDesc(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number)
  const pb = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pb[i] || 0) - (pa[i] || 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * 从登录 shell 读 PATH（§6 决策 2 的 B，设置项默认关）。会执行用户自己的 .zshrc，
 * 不是项目代码。命令是常量，超时 3 秒，失败就保持固定目录探测的结果。
 */
function loginShellPath(): Promise<string | null> {
  const shell = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/zsh'
  return new Promise((done) => {
    execFile(shell, ['-ilc', 'printf %s "$PATH"'], { timeout: 3000, encoding: 'utf8' }, (err, stdout) => {
      done(err || !stdout.trim() ? null : stdout.trim())
    })
  })
}

function mergePath(...parts: (string | undefined | null)[]): string {
  const out: string[] = []
  for (const p of parts) {
    for (const d of (p ?? '').split(delimiter)) if (d && !out.includes(d)) out.push(d)
  }
  return out.join(delimiter)
}

export const darwin: Platform = {
  id: 'darwin',

  readListenPorts,
  readProcessMeta,

  /**
   * node-pty 在 Unix 上用 setsid 起子进程，根进程是会话首进程，pgid === pid。
   * SIGTERM 整组，最多等 2 秒，仍活着就 SIGKILL 整组。调用方在这之前已经过
   * OwnershipService.assertKillable 重校验（红线 2）。
   *
   * 已知缺口（§3.2 第 4 点）：另起进程组的后代（如 concurrently 的子进程）不在这一组里，
   * 需要按 ppid 链补杀，留到 Mac 上用 verify-darwin-killgroup 先跑红再实现。
   */
  async killTree(rootPid) {
    if (!signalGroup(rootPid, 'SIGTERM')) return
    for (let i = 0; i < 20; i++) {
      await sleep(100)
      if (!groupAlive(rootPid)) return
    }
    signalGroup(rootPid, 'SIGKILL')
  },

  binaries: BINARIES,
  wrapperFile: { maven: 'mvnw', gradle: 'gradlew' },
  // 没有批处理：可执行文件直接 spawn
  wrapBatch(file, args) {
    return { file, args }
  },

  // §6 决策 4：HBuilderX 与 C++ 可执行文件首版只登记
  unsupportedLaunchModes: new Set<LaunchMode>(['cpp-exe']),
  requiresExecBit: true,
  hbuilderxCandidates() {
    return []
  },

  defaultShell() {
    const file = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/zsh'
    return { file, title: 'Shell' }
  },
  shellArgs() {
    return ['-l']
  },
  shellInit() {
    return null
  },

  terminalKinds: TERMINALS,
  defaultTerminal: 'terminal',

  /** `open -a <应用> <目录>`：目录是参数数组的一项，不经 shell，不拼字符串 */
  openExternalTerminal(kind, cwd) {
    const app = TERMINAL_APP[kind]
    if (!app) throw new Error(`外部终端设置非法：${String(kind)}`)
    const child = spawn('/usr/bin/open', ['-a', app, cwd], { stdio: 'ignore', detached: true })
    child.on('error', () => undefined)
    child.unref()
  },

  // 保留大小写：区分大小写的卷上 A 和 a 是两个目录。能取到真实路径就用真实路径
  pathKey(p) {
    const abs = resolve(p).replace(/\/+$/, '')
    try {
      return realpathSync.native(abs)
    } catch {
      return abs
    }
  },

  preparePath(opts) {
    process.env.PATH = mergePath(knownBinDirs().join(delimiter), process.env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin')
    if (!opts.loginShellPath) return
    // 读到之前启动的会话用的是固定目录探测的结果；读失败就保持原样
    void loginShellPath().then((fromShell) => {
      if (fromShell) process.env.PATH = mergePath(fromShell, process.env.PATH)
    })
  },

  attribution: ATTRIBUTION,

  globalHotkey: 'Command+Alt+M'
}
