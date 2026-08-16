import { randomUUID } from 'node:crypto'
import type { CredentialResult, Ownership, OwnershipVerdict } from '@shared/types'
import type { ProcessTable } from '../lib/winProcess'

interface Tracked {
  sessionId: string
  rootPid: number
  runToken: string
  /** 根进程创建时刻，用于识别 PID 复用 */
  startedAt: number
}

const MAX_ASCENT = 12

/**
 * 三重凭据归属识别，PRD §6。
 *
 * 凭据 1（运行 token）来自本进程的会话登记表：我们注入 MILE_RUN_TOKEN 时就知道
 * 根 PID 与 token 的对应关系，无需回读目标进程环境块。读取他进程环境块需要
 * PROCESS_VM_READ + 解析 PEB，没有原生模块做不到，因此对非根进程凭据 1 记为
 * unknown，由凭据 2、3 共同定案 —— 这个方向只会漏判（把自己的判成 external），
 * 不会误判（把外部的判成 owned），符合「宁可不停也不误杀」的安全取向。
 */
export class OwnershipService {
  private tracked = new Map<string, Tracked>()

  issueToken(): string {
    return randomUUID()
  }

  register(sessionId: string, rootPid: number, runToken: string): void {
    this.tracked.set(sessionId, { sessionId, rootPid, runToken, startedAt: Date.now() })
  }

  unregister(sessionId: string): void {
    this.tracked.delete(sessionId)
  }

  /** 判定单个 PID。table 由 ScannerService 一次采集后复用，避免逐个起子进程 */
  verify(pid: number, table: ProcessTable): OwnershipVerdict {
    const sameUser: CredentialResult = table.mine.has(pid) ? 'hit' : 'miss'

    const root = this.findOwningRoot(pid, table)
    const processGroup: CredentialResult = root ? 'hit' : 'miss'
    const token: CredentialResult = root?.rootPid === pid ? 'hit' : 'unknown'

    let ownership: Ownership
    if (sameUser === 'miss') {
      ownership = 'foreign'
    } else if (token === 'hit' || processGroup === 'hit') {
      ownership = 'owned'
    } else {
      ownership = 'external'
    }

    return { pid, ownership, token, processGroup, sameUser, sessionId: root?.sessionId }
  }

  /** 沿 ParentProcessId 链上溯，命中任一已登记会话根进程即属本应用 */
  private findOwningRoot(pid: number, table: ProcessTable): Tracked | null {
    const roots = new Map<number, Tracked>()
    for (const t of this.tracked.values()) roots.set(t.rootPid, t)
    if (roots.size === 0) return null

    let cursor = pid
    for (let hop = 0; hop < MAX_ASCENT; hop++) {
      const hit = roots.get(cursor)
      // 父链上溯可能撞到 PID 复用：登记时刻晚于目标进程启动时刻则不可能是其祖先
      if (hit) {
        const row = table.byPid.get(pid)
        if (!row?.startedAt || row.startedAt >= hit.startedAt - 60_000) return hit
        return null
      }
      const row = table.byPid.get(cursor)
      if (!row || row.ppid <= 4 || row.ppid === cursor) return null
      cursor = row.ppid
    }
    return null
  }

  /**
   * 终止前重校验（PRD §6.3 步骤 4）。从判定到执行之间 PID 可能被回收复用，
   * 不重校验就是误杀窗口。
   */
  async assertKillable(pid: number, table: ProcessTable): Promise<OwnershipVerdict> {
    const verdict = this.verify(pid, table)
    if (verdict.ownership !== 'owned') {
      throw new Error(`拒绝终止 PID ${pid}：归属判定为 ${verdict.ownership}，非本应用启动`)
    }
    return verdict
  }

  hasTracked(): boolean {
    return this.tracked.size > 0
  }
}
