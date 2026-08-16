import type { LaunchSource, ListenerGroup } from '@shared/types'
import type { ProcessRow } from './winProcess'

/** 与 OwnershipService 一致的上溯上限，PRD §5.3 */
const MAX_ASCENT = 12

/**
 * 上溯时跳过的中间层：shell、包管理器与运行时包装。
 *
 * 不跳过的话所有 npm 启动的服务来源都是「终端」—— 链条是
 * VS Code → cmd.exe → npm.cmd → node → vite，真正有信息量的是最上面那一层。
 */
const TRANSPARENT = new Set([
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'bash.exe',
  'sh.exe',
  'zsh.exe',
  'conhost.exe',
  'openconsole.exe',
  'node.exe',
  'npm.cmd',
  'npm.exe',
  'pnpm.exe',
  'pnpm.cmd',
  'yarn.exe',
  'yarn.cmd',
  'bun.exe',
  'npx.cmd',
  'py.exe',
  'python.exe',
  'python3.exe'
])

/**
 * 来源识别表，按进程名匹配。**仅用于展示**，PRD §5.3。
 *
 * 进程名是进程自己可以随便起的，当不了凭据。停不停得了一个进程只看
 * OwnershipService 的三重凭据，与这里的结论无关。
 */
const SOURCE_BY_NAME: { source: LaunchSource; names: string[] }[] = [
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
]

/** 命令行里出现即判为该来源，用于名字是通用 node.exe 但由 CLI 拉起的情况 */
const SOURCE_BY_CMD: { source: LaunchSource; needles: string[] }[] = [
  { source: 'claude', needles: ['claude-code', 'anthropic'] },
  { source: 'codex', needles: ['codex-cli'] },
  { source: 'vscode', needles: ['\\.vscode\\', '\\.vscode-server\\'] },
  { source: 'cursor', needles: ['\\.cursor\\'] }
]

function sourceOf(row: ProcessRow): LaunchSource | null {
  const name = row.name.toLowerCase()
  for (const rule of SOURCE_BY_NAME) {
    if (rule.names.includes(name)) return rule.source
  }
  const cmd = row.commandLine?.toLowerCase()
  if (cmd) {
    for (const rule of SOURCE_BY_CMD) {
      if (rule.needles.some((n) => cmd.includes(n))) return rule.source
    }
  }
  return null
}

/**
 * 沿父链最多 12 层找启动来源，PRD §5.3。
 *
 * 本应用启动的进程直接判为 mile —— 这一层已经由归属判定确认过，不必再猜。
 * 上溯途中撞到 TRANSPARENT 里的中间层就继续往上；撞到认得的应用就停。
 */
export function traceLaunchSource(
  pid: number,
  byPid: Map<number, ProcessRow>,
  owned: boolean
): LaunchSource {
  if (owned) return 'mile'

  let cursor = pid
  for (let hop = 0; hop < MAX_ASCENT; hop++) {
    const row = byPid.get(cursor)
    if (!row) return 'unknown'

    // 起点自身不算来源：一个 node.exe 的来源是拉起它的东西，不是它自己
    if (hop > 0 && !TRANSPARENT.has(row.name.toLowerCase())) {
      const hit = sourceOf(row)
      if (hit) return hit
    }

    if (row.ppid <= 4 || row.ppid === cursor) return 'unknown'
    cursor = row.ppid
  }
  return 'unknown'
}

/** 常见开发运行时与服务进程，监听端口时归「我的服务」 */
const DEV_RUNTIME = new Set([
  'node.exe',
  'bun.exe',
  'deno.exe',
  'python.exe',
  'python3.exe',
  'pythonw.exe',
  'java.exe',
  'dotnet.exe',
  'go.exe',
  'ruby.exe',
  'php.exe',
  'nginx.exe',
  'httpd.exe',
  'caddy.exe',
  'mysqld.exe',
  'postgres.exe',
  'redis-server.exe',
  'mongod.exe',
  'esbuild.exe',
  'vite.exe',
  'cargo.exe',
  'hugo.exe'
])

/** 系统目录下的进程归后台：装在这里的东西不是用户此刻在开发的项目 */
const SYSTEM_DIRS = [
  'c:\\windows\\',
  'c:\\program files\\windowsapps\\',
  '\\microsoft\\windowsapps\\'
]

/**
 * 分组推断，PRD §5.2。
 *
 * 判据只用于「默认排在哪一组」，不影响能否停止 —— 那由归属判定决定。
 * 用户手动提升或移回的结论优先于这里的一切推断。
 */
export function classifyGroup(
  row: ProcessRow | undefined,
  ownership: string,
  entryId: string | undefined
): ListenerGroup {
  // 本应用启动的、或已关联启动台条目的，一定是用户在开发的东西
  if (ownership === 'owned' || entryId) return 'mine'
  if (!row) return 'background'

  const exec = row.execPath?.toLowerCase() ?? ''
  if (SYSTEM_DIRS.some((d) => exec.includes(d))) return 'background'
  if (DEV_RUNTIME.has(row.name.toLowerCase())) return 'mine'
  return 'background'
}
