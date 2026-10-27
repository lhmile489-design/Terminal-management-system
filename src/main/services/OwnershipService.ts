import { randomUUID } from 'node:crypto'
import type { CredentialResult, Ownership, OwnershipVerdict } from '@shared/types'
import type { ProcessTable } from '../lib/winProcess'

interface Tracked {
  sessionId: string
  rootPid: number
  runToken: string
  /** 登记时刻。根进程由我们 spawn，它的 OS 创建时间只会早于这个时刻（留时钟抖动余量） */
  registeredAt: number
  /**
   * 根进程的 OS 创建时间，首次在进程表里看到时钉住。之后同一 PID 的创建时间
   * 变了，就是根进程已退出、PID 被系统分给了别的进程。
   */
  rootCreatedAt?: number
}

const MAX_ASCENT = 12
/** 根进程创建时间可以比登记时刻晚多少（同机时钟的读数抖动） */
const REGISTER_SLACK_MS = 5000
/** 同一进程两次读出的创建时间允许的差（CIM 时间换算的精度） */
const SAME_PROCESS_MS = 1000

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
    this.tracked.set(sessionId, { sessionId, rootPid, runToken, registeredAt: Date.now() })
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
      if (hit) return this.rootStillOurs(hit, pid, table) ? hit : null
      const row = table.byPid.get(cursor)
      if (!row || row.ppid <= 4 || row.ppid === cursor) return null
      cursor = row.ppid
    }
    return null
  }

  /**
   * 命中的登记根是否仍是我们 spawn 的那个进程，且 pid 确实可能是它的后代。
   * 读不到创建时间一律拒绝 —— 「读不到就信任」会在 CIM 暂时失效时开放误杀窗口。
   */
  private rootStillOurs(hit: Tracked, pid: number, table: ProcessTable): boolean {
    const rootAt = table.byPid.get(hit.rootPid)?.startedAt
    if (!rootAt) return false
    if (hit.rootCreatedAt === undefined) {
      // 首次观察：我们 spawn 的根进程不可能创建得比登记还晚
      if (rootAt > hit.registeredAt + REGISTER_SLACK_MS) return false
      hit.rootCreatedAt = rootAt
    } else if (Math.abs(rootAt - hit.rootCreatedAt) > SAME_PROCESS_MS) {
      // 同一 PID 的创建时间变了：根进程已退出，PID 被系统复用
      return false
    }
    if (pid === hit.rootPid) return true
    const at = table.byPid.get(pid)?.startedAt
    // 后代不可能早于祖先创建；早于根的「子进程」只可能是 PPID 复用造成的巧合
    return !!at && at >= hit.rootCreatedAt - SAME_PROCESS_MS
  }

  /**
   * 终止前重校验（PRD §6.3 步骤 4）。从判定到执行之间 PID 可能被回收复用，
   * 不重校验就是误杀窗口。传 sessionId 时还要求归属命中的就是这个会话 ——
   * 停 A 会话不能因为 PID 恰好落在 B 会话的树里就被放行。
   */
  async assertKillable(pid: number, table: ProcessTable, sessionId?: string): Promise<OwnershipVerdict> {
    const verdict = this.verify(pid, table)
    if (verdict.ownership !== 'owned') {
      throw new Error(`拒绝终止 PID ${pid}：归属判定为 ${verdict.ownership}，非本应用启动`)
    }
    if (sessionId !== undefined && verdict.sessionId !== sessionId) {
      throw new Error(`拒绝终止 PID ${pid}：它属于会话 ${verdict.sessionId}，不是要停的会话 ${sessionId}`)
    }
    return verdict
  }

  hasTracked(): boolean {
    return this.tracked.size > 0
  }
}
