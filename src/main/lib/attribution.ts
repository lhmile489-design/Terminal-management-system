import type { LaunchSource, ListenerGroup } from '@shared/types'
import { platform, type ProcessRow } from '../platform'

/** 与 OwnershipService 一致的上溯上限，PRD §5.3 */
const MAX_ASCENT = 12

/**
 * 进程名表（中间层、来源、开发运行时、系统目录）按平台不同，放在 platform/<os>/ 里。
 * 这里只留判定逻辑，两个平台共用。
 *
 * 来源识别**仅用于展示**，PRD §5.3：进程名是进程自己可以随便起的，当不了凭据。
 * 停不停得了一个进程只看 OwnershipService 的三重凭据，与这里的结论无关。
 */
const T = platform.attribution

function sourceOf(row: ProcessRow): LaunchSource | null {
  const name = row.name.toLowerCase()
  for (const rule of T.sourceByName) {
    if (rule.names.includes(name)) return rule.source
  }
  const cmd = row.commandLine?.toLowerCase()
  if (cmd) {
    for (const rule of T.sourceByCmd) {
      if (rule.needles.some((n) => cmd.includes(n))) return rule.source
    }
  }
  return null
}

/**
 * 沿父链最多 12 层找启动来源，PRD §5.3。
 *
 * 本应用启动的进程直接判为 mile —— 这一层已经由归属判定确认过，不必再猜。
 * 上溯途中撞到中间层（shell、包管理器）就继续往上；撞到认得的应用就停。
 * 不跳过中间层的话所有 npm 启动的服务来源都是「终端」。
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

    // 起点自身不算来源：一个 node 进程的来源是拉起它的东西，不是它自己
    if (hop > 0 && !T.transparent.has(row.name.toLowerCase())) {
      const hit = sourceOf(row)
      if (hit) return hit
    }

    // Windows 的 0 / 4 是 System Idle / System，macOS 的 1 是 launchd，都到顶了
    if (row.ppid <= 4 || row.ppid === cursor) return 'unknown'
    cursor = row.ppid
  }
  return 'unknown'
}

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

  // 系统目录下的进程归后台：装在这里的东西不是用户此刻在开发的项目
  const exec = row.execPath?.toLowerCase() ?? ''
  if (T.systemDirs.some((d) => exec.includes(d))) return 'background'
  if (T.devRuntime.has(row.name.toLowerCase())) return 'mine'
  return 'background'
}
