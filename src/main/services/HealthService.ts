import { EventEmitter } from 'node:events'
import { request } from 'node:http'
import type { EntryHealth, EntryRuntime, LaunchEntry } from '@shared/types'
import type { EntryService } from './EntryService'
import type { ScannerService } from './ScannerService'

/** 窗口可见时的探测间隔。固定值，不跟 scanIntervalMs：那是用户为本机开销选的，这里影响的是被探服务 */
const VISIBLE_INTERVAL_MS = 15_000
/** 窗口不可见时降频 */
const HIDDEN_INTERVAL_MS = 60_000
/** 单次探测的总时限：连接、响应头、读体都算在内 */
const PROBE_TIMEOUT_MS = 2000
/** 响应体最多读这么多字节，到了就关 socket，不管服务还在不在写 */
const MAX_BODY_BYTES = 4096

interface ProbeResult {
  statusCode?: number
  latencyMs?: number
  reason?: string
}

/**
 * 本机 HTTP 健康检查（PRD-FEATURE-UPGRADE P0-1）。
 *
 * 目标只由主进程决定：主机是回环地址，端口与地址族取自本条目自己的监听行
 * （EntryService.ownListenPids 过滤后的快照行）。渲染层只能给路径，且路径在
 * sanitizeEdit 里按字符白名单校过。找不到自己的监听行就不发请求 —— 同一端口可以被
 * 两个进程分别绑 IPv4 / IPv6，按端口去探可能探到别人的服务。
 *
 * 结果只在内存，只用于展示与就绪时刻，不参与任何终止授权，也不触发自动重启。
 */
export class HealthService extends EventEmitter {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private stopped = false
  private states = new Map<string, EntryHealth>()
  /** 每个条目上一次见到的「运行中端口」，只在它变化时提前探测 */
  private seenPort = new Map<string, number>()

  constructor(
    private entries: EntryService,
    private scanner: ScannerService
  ) {
    super()
    this.entries.on('runtime', (rt: EntryRuntime) => {
      // 条目离开运行态就立刻转 off，不等下一轮
      if (rt.status !== 'running' || !rt.port) {
        this.seenPort.delete(rt.entryId)
        if (rt.status !== 'running') this.setState(rt.entryId, { state: 'off' })
        return
      }
      // 运行态推送很频繁（预检、自动重启倒计时都会推），只在刚拿到端口时提前探一次，
      // 不让用户干等 15 秒；其余照常排程
      if (this.seenPort.get(rt.entryId) === rt.port) return
      this.seenPort.set(rt.entryId, rt.port)
      if (this.enabled(this.entries.get(rt.entryId))) this.kick()
    })
    // 新 PID 进监听表要十来秒：还在 unknown 的条目每轮采集后补探一次，不干等 15 秒
    this.scanner.on('diff', () => {
      if ([...this.states.values()].some((h) => h.state === 'unknown')) this.kick()
    })
    // 删掉的条目、关掉检查的条目，状态一并清掉
    this.entries.on('changed', (list: LaunchEntry[]) => {
      const ids = new Set(list.map((e) => e.id))
      for (const id of [...this.states.keys()]) {
        const entry = list.find((e) => e.id === id)
        if (!ids.has(id) || !this.enabled(entry)) this.setState(id, { state: 'off' }, !ids.has(id))
      }
    })
  }

  start(): void {
    this.stopped = false
    this.schedule()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  list(): EntryHealth[] {
    return [...this.states.values()]
  }

  private enabled(entry: LaunchEntry | null | undefined): boolean {
    return !!entry && entry.kind === 'service' && entry.healthCheck?.enabled === true
  }

  private schedule(): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    const interval = this.scanner.isVisible() ? VISIBLE_INTERVAL_MS : HIDDEN_INTERVAL_MS
    this.timer = setTimeout(() => void this.tick().finally(() => this.schedule()), interval)
  }

  /** 提前跑一轮，之后照常排程 */
  private kick(): void {
    if (this.stopped) return
    void this.tick().finally(() => this.schedule())
  }

  /** 互斥：上一轮没探完不开新一轮，避免对慢服务堆积请求 */
  private async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      await Promise.all(this.entries.list().map((e) => this.checkOne(e)))
    } finally {
      this.running = false
    }
  }

  private async checkOne(entry: LaunchEntry): Promise<void> {
    if (!this.enabled(entry)) {
      if (this.states.has(entry.id)) this.setState(entry.id, { state: 'off' })
      return
    }
    const rt = this.entries.runtimeOf(entry.id)
    if (!rt || rt.status !== 'running' || !rt.port) {
      this.setState(entry.id, { state: 'off' })
      return
    }

    const host = this.pickHost(entry.id, rt.port)
    if (!host) {
      this.setState(entry.id, { state: 'unknown', reason: '还没在监听表里找到本服务的监听' })
      return
    }

    const r = await probe(host, rt.port, entry.healthCheck!.path)
    // 探测期间条目可能已经停了或关了检查，结果作废
    const now = this.entries.runtimeOf(entry.id)
    if (!now || now.status !== 'running' || now.port !== rt.port || !this.enabled(this.entries.get(entry.id))) return

    const ok = r.statusCode !== undefined && r.statusCode >= 200 && r.statusCode < 400
    // 首次 ok 作为启动就绪时刻（P1-2）；EntryService 只认等待中的那一次
    if (ok) this.entries.noteHealthOk(entry.id)
    this.setState(entry.id, {
      state: ok ? 'ok' : 'fail',
      statusCode: r.statusCode,
      latencyMs: r.latencyMs,
      reason: ok ? undefined : (r.reason ?? `HTTP ${r.statusCode}`)
    })
  }

  /**
   * 本条目自己的监听行里选回环地址：有 IPv4 就用 127.0.0.1，只有 IPv6 才用 ::1。
   * 族解析不出（macOS lsof 的 `*:P`）时按 IPv4 处理。找不到自己的行返回 null。
   */
  private pickHost(entryId: string, port: number): string | null {
    const own = this.entries.ownListenPids(entryId)
    if (own.size === 0) return null
    const rows = this.scanner.listenRows().filter((r) => r.port === port && own.has(r.pid))
    if (rows.length === 0) return null
    const families = new Set(rows.flatMap((r) => r.families))
    if (families.has(4) || families.size === 0) return '127.0.0.1'
    return '::1'
  }

  private setState(
    entryId: string,
    patch: Omit<EntryHealth, 'entryId' | 'checkedAt'>,
    remove = false
  ): void {
    const prev = this.states.get(entryId)
    const next: EntryHealth = { entryId, checkedAt: Date.now(), ...patch }
    if (remove) this.states.delete(entryId)
    else this.states.set(entryId, next)
    // off → off 不重复推送；其余每次探测都推，概览页要显示最近一次的时间与延迟
    if (prev?.state === 'off' && next.state === 'off') return
    if (!prev && next.state === 'off') return
    this.emit('health', next)
  }
}

/**
 * 发一次 GET。只走 http，不跟随重定向（3xx 当作已响应），不带凭据。
 * 响应头到达即记录状态码与延迟；随后读体计数，满 4KB 或总时限到了都主动 destroy。
 */
export function probe(host: string, port: number, path: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    const done = (r: ProbeResult): void => {
      if (settled) return
      settled = true
      resolve(r)
    }

    const req = request({
      host,
      port,
      path,
      method: 'GET',
      agent: false,
      headers: { 'User-Agent': 'MileTerminal-HealthCheck', Connection: 'close' }
    })

    const killer = setTimeout(() => {
      done({ reason: '超时' })
      req.destroy()
    }, PROBE_TIMEOUT_MS)

    req.on('response', (res) => {
      done({ statusCode: res.statusCode, latencyMs: Date.now() - started })
      let bytes = 0
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes >= MAX_BODY_BYTES) req.destroy()
      })
      res.on('end', () => clearTimeout(killer))
      res.on('close', () => clearTimeout(killer))
      res.on('error', () => undefined)
    })

    req.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(killer)
      done({ reason: err.code === 'ECONNREFUSED' ? '连接被拒' : (err.code ?? '请求失败') })
    })

    req.end()
  })
}
