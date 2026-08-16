import { EventEmitter } from 'node:events'
import { basename } from 'node:path'
import { cpus, totalmem, freemem } from 'node:os'
import pidusage from 'pidusage'
import type {
  ListenerGroup,
  ListenerSnapshot,
  ScanDiff,
  ScanSnapshot,
  SystemLoad,
  UnmanagedListener,
  WatchedProcess
} from '@shared/types'
import {
  readListenPorts,
  readProcessMeta,
  type ListenRow,
  type ProcessMeta,
  type ProcessTable
} from '../lib/winProcess'
import { classifyGroup, traceLaunchSource } from '../lib/attribution'
import type { OwnershipService } from './OwnershipService'
import type { ConfigStore } from './ConfigStore'

const BACKGROUND_INTERVAL_MS = 10_000
/** 元数据兜底刷新周期：没有新 PID 时也定期刷一次，纠正 cwd/命令行的陈旧值 */
const META_MAX_AGE_MS = 30_000

/** 条目预期端口的提供方，由 EntryService 注入。避免 Scanner 反向依赖启动台 */
export interface EntryExpectation {
  id: string
  port?: number
  cwd: string
  pid?: number
  /** 该条目当前会话，用于把会话的后代进程归到条目名下 */
  sessionId?: string
}

export type ExpectationSource = () => EntryExpectation[]

/** 归属重校验允许的元数据陈旧上限，比采集缓存严格得多 —— 误杀窗口就在这几秒里 */
const VERIFY_MAX_AGE_MS = 3000

/** 关注进程关键字数量与长度上限，避免每轮在几千个进程上跑无限多次匹配 */
const MAX_KEYWORDS = 20
const MAX_KEYWORD_LEN = 64

/** 单次采集下发的关注命中数上限：一个 `e` 这样的关键字能命中整张进程表 */
const MAX_WATCHED = 50

/**
 * 下发命令行的截断长度，PRD §5.5。
 *
 * 关注是按命令行匹配的，不给片段用户就不知道为什么命中；但完整参数里可能带
 * token 或密码，整条摊到界面上不合适。截断是折中，不是装饰。
 */
const WATCHED_CMD_MAX = 160

export class ScannerService extends EventEmitter {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private visible = true
  /** 应用启动时的 (pid:port) 基线，用于「本次会话新出现」判定，PRD §7 */
  private baseline: Set<string> | null = null
  private hiddenOnce = new Set<string>()
  private previous = new Map<number, ListenerSnapshot>()
  private lastSuccessAt: number | null = null
  private latest: ScanSnapshot | null = null
  private meta: ProcessMeta | null = null
  private cpuBaseline = new Map<number, { at: number; total: number }>()

  private expectations: ExpectationSource = () => []

  constructor(
    private ownership: OwnershipService,
    private config: ConfigStore
  ) {
    super()
  }

  /** EntryService 构造完成后回注，打破二者的循环依赖 */
  setExpectationSource(source: ExpectationSource): void {
    this.expectations = source
  }

  /**
   * 供归属重校验用的进程表。终止前必须拿新鲜数据，不能复用采集缓存 ——
   * 缓存最长 30 秒，期间 PID 可能已被回收复用。
   */
  async table(hintPids: number[] = []): Promise<ProcessTable> {
    const stale = !this.meta || Date.now() - this.meta.at > VERIFY_MAX_AGE_MS
    const unknown = this.meta ? hintPids.some((p) => !this.meta!.byPid.has(p)) : true
    if (stale || unknown) this.meta = await readProcessMeta()
    const listens = await readListenPorts()
    return { ...this.meta!, listens }
  }

  start(): void {
    const at = Date.now()
    void this.tick().finally(() => this.schedule(at))
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  snapshot(): ScanSnapshot | null {
    return this.latest
  }

  /** 路径白名单：只有最近一次采集里出现过的目录才允许在资源管理器打开 */
  knownPath(target: string): boolean {
    return this.latest?.listeners.some((l) => l.cwd === target) ?? false
  }

  /** 窗口不可见时降频到 10s；恢复可见立即补一次采集，PRD §3.1 */
  setVisible(visible: boolean): void {
    if (this.visible === visible) return
    this.visible = visible
    this.schedule()
    if (visible) void this.tick()
  }

  refresh(): void {
    void this.tick()
  }

  /** 采集周期设置变更后立即换节奏，否则要等当前 timer 走完才生效 */
  reschedule(): void {
    this.schedule()
  }

  ignore(processName: string, port: number): void {
    const list = this.config.get().ignoredListeners
    if (!list.some((i) => i.processName === processName && i.port === port)) {
      this.config.patch({ ignoredListeners: [...list, { processName, port }] })
    }
    void this.tick()
  }

  hideOnce(pid: number, port: number): void {
    this.hiddenOnce.add(`${pid}:${port}`)
    void this.tick()
  }

  /**
   * 从上一轮**开始**时刻计时，而不是结束时刻。一轮里 pidusage 约 1s，
   * 按结束时刻排会让实际节奏退化到 3s 以上，对不上 PRD 的 2 秒要求。
   * 单轮超过周期时立即接下一轮，由互斥锁兜住不会重入。
   */
  private schedule(startedAt = Date.now()): void {
    if (this.timer) clearTimeout(this.timer)
    const base = this.config.get().settings.scanIntervalMs
    const interval = this.visible ? base : Math.max(base, BACKGROUND_INTERVAL_MS)
    const wait = Math.max(0, interval - (Date.now() - startedAt))

    this.timer = setTimeout(() => {
      const at = Date.now()
      void this.tick().finally(() => this.schedule(at))
    }, wait)
  }

  /** 互斥锁：上一轮未完成则跳过本轮，防止子进程堆积，PRD §3.1 */
  private async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const listens = await readListenPorts()
      const meta = await this.resolveMeta(listens)
      await this.publish(this.build({ ...meta, listens }))
    } catch (err) {
      this.emit('error', err)
      this.publishFailure()
    } finally {
      this.running = false
    }
  }

  /**
   * 分层采集：端口用 netstat（~55ms）每轮取；进程元数据走 CIM（~3.5s），
   * 只在出现未知 PID 或缓存过期时刷新。否则 2 秒周期根本跑不完一轮。
   */
  private async resolveMeta(listens: ListenRow[]): Promise<ProcessMeta> {
    const stale = !this.meta || Date.now() - this.meta.at > META_MAX_AGE_MS
    const unknown = this.meta ? listens.some((l) => !this.meta!.byPid.has(l.pid)) : true
    if (stale || unknown) this.meta = await readProcessMeta()
    return this.meta!
  }

  private build(table: ProcessTable): ScanSnapshot {
    const at = Date.now()
    const portsByPid = new Map<number, Set<number>>()
    for (const l of table.listens) {
      if (!table.mine.has(l.pid)) continue
      const set = portsByPid.get(l.pid) ?? new Set<number>()
      set.add(l.port)
      portsByPid.set(l.pid, set)
    }

    if (this.baseline === null) {
      this.baseline = new Set(
        [...portsByPid].flatMap(([pid, ports]) => [...ports].map((p) => `${pid}:${p}`))
      )
    }

    const config = this.config.get()
    const ignored = config.ignoredListeners
    const overrides = new Map(
      config.groupOverrides.map((o) => [o.processName.toLowerCase(), o.group])
    )
    const expectations = this.expectations()
    const listeners: ListenerSnapshot[] = []
    const unmanaged: UnmanagedListener[] = []

    for (const [pid, portSet] of portsByPid) {
      const row = table.byPid.get(pid)
      const verdict = this.ownership.verify(pid, table)
      if (verdict.ownership === 'foreign') continue

      const ports = [...portSet].sort((a, b) => a - b)
      const cwd = row?.commandLine ? guessCwd(row.commandLine) : undefined
      const entryId = matchEntry(expectations, pid, cwd, verdict.sessionId)

      // 用户手动定过的分组优先于推断，PRD §5.2。但覆盖是按进程名生效的：
      // 把某个 node.exe 移回后台后，不能把刚从启动台拉起的服务一起带走 ——
      // 「我的服务」里找不到自己刚启动的东西，是最难自查的一种困惑
      const pinned = verdict.ownership === 'owned' || entryId !== undefined
      const override = row && !pinned ? overrides.get(row.name.toLowerCase()) : undefined
      const group = override ?? classifyGroup(row, verdict.ownership, entryId)

      listeners.push({
        pid,
        ports,
        processName: row?.name ?? `pid ${pid}`,
        execPath: row?.execPath,
        cwd,
        cpu: null,
        memory: 0,
        startedAt: row?.startedAt,
        ownership: verdict.ownership,
        entryId,
        sessionId: verdict.sessionId,
        group,
        groupOverridden: override !== undefined,
        // 展示用徽标，绝不参与权限判定，PRD §5.3
        launchSource: traceLaunchSource(pid, table.byPid, verdict.ownership === 'owned')
      })

      if (verdict.ownership !== 'external') continue
      // 后台组不进新端口提醒：GUI 应用与系统进程开的端口不是用户要纳管的东西，PRD §5.4
      if (group !== 'mine') continue
      for (const port of ports) {
        const key = `${pid}:${port}`
        if (this.baseline.has(key) || this.hiddenOnce.has(key)) continue
        if (ignored.some((i) => i.processName === (row?.name ?? '') && i.port === port)) continue
        unmanaged.push({
          pid,
          port,
          processName: row?.name ?? `pid ${pid}`,
          cwd,
          guessedName: cwd ? basename(cwd) : (row?.name ?? `pid ${pid}`),
          startedAt: row?.startedAt
        })
      }
    }

    listeners.sort((a, b) => (a.ports[0] ?? 0) - (b.ports[0] ?? 0))
    this.lastSuccessAt = at

    return {
      at,
      listeners,
      unmanaged,
      watched: this.matchWatched(table),
      system: systemLoad(),
      portConflicts: countConflicts(expectations, listeners),
      failed: false,
      lastSuccessAt: at
    }
  }

  /**
   * 关注进程，PRD §5.5。只在当前用户的进程里匹配 —— 与监听表同一条边界，
   * 不能因为「只是看一眼」就把别人的进程列出来。
   *
   * 本应用自己的进程排除掉：关键字写 `node` 时整个 Electron 进程树都会命中，
   * 那不是用户想观察的东西。
   */
  private matchWatched(table: ProcessTable): WatchedProcess[] {
    const keywords = normalizeKeywords(this.config.get().watchedKeywords)
    if (keywords.length === 0) return []

    const out: WatchedProcess[] = []
    for (const pid of table.mine) {
      if (out.length >= MAX_WATCHED) break
      if (pid === process.pid) continue
      const row = table.byPid.get(pid)
      if (!row) continue
      if (this.ownership.verify(pid, table).ownership === 'owned') continue

      const haystack = `${row.name} ${row.commandLine ?? ''}`.toLowerCase()
      const keyword = keywords.find((k) => haystack.includes(k))
      if (!keyword) continue

      out.push({
        pid,
        processName: row.name,
        keyword,
        commandLine: truncate(row.commandLine, WATCHED_CMD_MAX),
        cpu: null,
        memory: 0,
        startedAt: row.startedAt
      })
    }
    return out.sort((a, b) => a.pid - b.pid)
  }

  /**
   * 手动提升 / 移回，PRD §5.2。按进程名存而不是 PID：PID 每次重启都变，
   * 存 PID 等于这个设置只在本次运行有效，下次开机全丢。
   */
  setGroup(processName: string, group: ListenerGroup | null): void {
    if (typeof processName !== 'string' || !processName.trim()) return
    const name = processName.trim()
    const rest = this.config
      .get()
      .groupOverrides.filter((o) => o.processName.toLowerCase() !== name.toLowerCase())
    this.config.patch({
      groupOverrides: group === null ? rest : [...rest, { processName: name, group }]
    })
    void this.tick()
  }

  /** 关注关键字整表替换，逐项规整后落盘，PRD §5.5 */
  setWatchedKeywords(keywords: unknown): string[] {
    if (!Array.isArray(keywords)) throw new Error('关注关键字必须是数组')
    const clean = normalizeKeywords(keywords)
    this.config.patch({ watchedKeywords: clean })
    void this.tick()
    return clean
  }

  /** pidusage 批量取 CPU/内存，不走 PowerShell，PRD §3.2 */
  private async attachMetrics(listeners: MetricTarget[]): Promise<void> {
    if (listeners.length === 0) return
    const pids = listeners.map((l) => l.pid)
    let stats: Record<string, { cpu: number; memory: number }> = {}
    try {
      stats = (await pidusage(pids)) as Record<string, { cpu: number; memory: number }>
    } catch {
      return
    }

    const cores = cpus().length || 1
    for (const l of listeners) {
      const s = stats[String(l.pid)]
      if (!s) continue
      l.memory = s.memory
      // 首轮没有增量基线，显示 — 而非 0
      const seen = this.cpuBaseline.has(l.pid)
      this.cpuBaseline.set(l.pid, { at: Date.now(), total: s.cpu })
      l.cpu = seen ? Math.round((s.cpu / cores) * 10) / 10 : null
    }
  }

  private async publish(snapshot: ScanSnapshot): Promise<void> {
    // 关注进程与监听进程一起取指标：pidusage 一次批量调用比分两次便宜，
    // 且两边都是「当前用户的进程」，没有额外的边界问题
    await this.attachMetrics([...snapshot.listeners, ...snapshot.watched])
    const diff = this.diff(snapshot)
    this.latest = snapshot
    this.previous = new Map(snapshot.listeners.map((l) => [l.pid, l]))
    for (const pid of this.cpuBaseline.keys()) {
      if (!this.previous.has(pid)) this.cpuBaseline.delete(pid)
    }
    this.emit('diff', diff)
  }

  private publishFailure(): void {
    const diff: ScanDiff = {
      at: Date.now(),
      added: [],
      updated: [],
      removedPids: [],
      unmanaged: this.latest?.unmanaged ?? [],
      watched: this.latest?.watched ?? [],
      system: systemLoad(),
      portConflicts: this.latest?.portConflicts ?? 0,
      failed: true,
      lastSuccessAt: this.lastSuccessAt
    }
    this.emit('diff', diff)
  }

  /** 只推变化部分，避免每 2 秒重排整表，PRD §3.2 */
  private diff(next: ScanSnapshot): ScanDiff {
    const added: ListenerSnapshot[] = []
    const updated: ListenerSnapshot[] = []

    for (const l of next.listeners) {
      const prev = this.previous.get(l.pid)
      if (!prev) added.push(l)
      else if (changed(prev, l)) updated.push(l)
    }

    const nextPids = new Set(next.listeners.map((l) => l.pid))
    const removedPids = [...this.previous.keys()].filter((p) => !nextPids.has(p))

    return {
      at: next.at,
      added,
      updated,
      removedPids,
      unmanaged: next.unmanaged,
      watched: next.watched,
      system: next.system,
      portConflicts: next.portConflicts,
      failed: false,
      lastSuccessAt: next.lastSuccessAt
    }
  }
}

/** attachMetrics 只需要这三个字段，监听项与关注项都满足 */
interface MetricTarget {
  pid: number
  cpu: number | null
  memory: number
}

function changed(a: ListenerSnapshot, b: ListenerSnapshot): boolean {
  return (
    a.cpu !== b.cpu ||
    a.memory !== b.memory ||
    a.ownership !== b.ownership ||
    a.entryId !== b.entryId ||
    // 分组变了必须进 updated，否则手动提升后要等这个 PID 消失才换组
    a.group !== b.group ||
    a.groupOverridden !== b.groupOverridden ||
    a.launchSource !== b.launchSource ||
    a.ports.join() !== b.ports.join()
  )
}

/** 关键字规整：去空、小写、去重、限长限量。空字符串会命中一切，必须挡掉 */
function normalizeKeywords(input: unknown[]): string[] {
  const out: string[] = []
  for (const raw of input) {
    if (typeof raw !== 'string') continue
    const k = raw.trim().toLowerCase().slice(0, MAX_KEYWORD_LEN)
    if (!k || out.includes(k)) continue
    out.push(k)
    if (out.length >= MAX_KEYWORDS) break
  }
  return out
}

function truncate(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

/**
 * 端口反查条目：PID 精确匹配 → 会话归属 → 工作目录全等 → 目录前缀匹配，PRD §14。
 * 端口相同**不作为**匹配依据 —— 那正是「因为端口一样就当成自己的」的错误。
 *
 * 会话归属这一层是必需的：真正监听端口的往往是 cmd.exe → npm → node 链条末端的
 * node.exe，而条目记的是根 PID；且这类进程的命令行常是相对路径（`"node" "vite.js"`），
 * 推不出 cwd。归属校验已经沿父链确认过它属于哪个会话，直接用这个结论。
 */
function matchEntry(
  expectations: EntryExpectation[],
  pid: number,
  cwd?: string,
  sessionId?: string
): string | undefined {
  const byPid = expectations.find((e) => e.pid === pid)
  if (byPid) return byPid.id

  if (sessionId) {
    const bySession = expectations.find((e) => e.sessionId === sessionId)
    if (bySession) return bySession.id
  }

  if (!cwd) return undefined
  const exact = expectations.find((e) => sameDir(e.cwd, cwd))
  if (exact) return exact.id

  const prefix = expectations.find((e) => cwd.toLowerCase().startsWith(`${e.cwd.toLowerCase()}\\`))
  return prefix?.id
}

/**
 * 预期端口被非本条目的进程占用即为冲突，PRD §3.4。
 *
 * 必须看全部占用者：同一端口能被 IPv4 与 IPv6 两个进程同时占住（实测 Vite 绑
 * 0.0.0.0、Next 绑 ::，两边 bind 都成功）。`find` 只看第一行时，占用者恰好是自己
 * 的那一条会被判成不冲突，两条同抢 3000 只数出 1 个 —— 少的正是「我这条也中招了」。
 */
function countConflicts(
  expectations: EntryExpectation[],
  listeners: ListenerSnapshot[]
): number {
  let count = 0
  for (const exp of expectations) {
    if (!exp.port) continue
    const others = listeners.filter(
      (l) => l.ports.includes(exp.port as number) && l.entryId !== exp.id
    )
    if (others.length > 0) count++
  }
  return count
}

function sameDir(a: string, b: string): boolean {
  return a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()
}

interface CpuTicks {
  idle: number
  total: number
}

function readCpuTicks(): CpuTicks {
  let idle = 0
  let total = 0
  for (const c of cpus()) {
    idle += c.times.idle
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq
  }
  return { idle, total }
}

let prevTicks: CpuTicks | null = null

/** 全机 CPU 取两次 tick 的增量；首轮无基线返回 null，渲染层显示 — */
function systemLoad(): SystemLoad {
  const mem = totalmem()
  const ticks = readCpuTicks()
  let cpu: number | null = null

  if (prevTicks) {
    const dTotal = ticks.total - prevTicks.total
    const dIdle = ticks.idle - prevTicks.idle
    if (dTotal > 0) cpu = Math.round((1 - dIdle / dTotal) * 1000) / 10
  }
  prevTicks = ticks

  return { cpu, memory: Math.round(((mem - freemem()) / mem) * 1000) / 10 }
}

/**
 * 从命令行里的脚本路径推测项目目录；纯字符串处理，不触碰磁盘。
 *
 * 脚本通常在 node_modules 里（如 <root>/node_modules/vite/bin/vite.js），
 * 直接取脚本父目录会得到 `vite/bin` 这种无意义的名字，所以在 node_modules
 * 处截断，拿到的才是项目根。
 */
function guessCwd(commandLine: string): string | undefined {
  const match = commandLine.match(/([a-zA-Z]:[\\/](?:[^"'*?<>|\r\n]*?))\.(?:js|cjs|mjs|ts)\b/)
  const script = match?.[1]
  if (!script) return undefined

  const nm = script.search(/[\\/]node_modules[\\/]/i)
  if (nm > 0) return script.slice(0, nm)

  const cut = Math.max(script.lastIndexOf('\\'), script.lastIndexOf('/'))
  return cut > 2 ? script.slice(0, cut) : undefined
}
