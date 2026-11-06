import { EventEmitter } from 'node:events'
import type { LaunchEntry, LogLine, OutputAlert } from '@shared/types'
import { isErrorLine } from '../lib/outputText'
import type { EntryService } from './EntryService'
import type { LogService } from './LogService'

/** 同一条目的同一关键词在这段时间内只告警一次 */
const DEDUP_WINDOW_MS = 60_000
/** 系统通知延迟发出：这段时间内条目崩溃了就只发崩溃通知 */
/*
 * 3 秒而不是 1 秒：服务经 cmd → npm → node 链条启动，node 退出后 npm 收尾、ConPTY 发
 * exit 还要约 1 秒。实测命中行到 crashed 事件间隔约 1170 ms（verify-alert §5），1 秒的
 * 延迟会让告警通知先弹出去，同一次崩溃收到两条通知。
 */
const NOTIFY_DELAY_MS = 3000
/** 每个条目在内存里最多留这么多条命中 */
const MAX_HITS_PER_ENTRY = 50
const MAX_LINE_CHARS = 200
/** 通用错误行命中时用的去重键，不会与用户关键词撞上（关键词不允许控制字符） */
const ERROR_LINE_KEY = '\u0000error'

/**
 * 输出关键词告警（PRD-FEATURE-UPGRADE P1-1）。
 *
 * 匹配对象是 LogService 已经切好、去掉 ANSI 与 `\r` 重绘的可见行，规则不另写一份
 * （CLAUDE.md：输出文本规则只在 outputText.ts）。关键词按纯子串、不区分大小写匹配，
 * 不接受正则。命中记录只在内存，不落盘。
 */
export class AlertService extends EventEmitter {
  private lastHit = new Map<string, number>()
  private hits = new Map<string, OutputAlert[]>()
  private pending = new Map<string, NodeJS.Timeout[]>()
  /**
   * 最近一次崩溃时刻。LogService 在会话退出后还会延迟收尾末行，末行命中的告警
   * 排在崩溃之后，只撤「崩溃前排队的」挡不住它，所以到期时再看一次这里。
   */
  private lastCrash = new Map<string, number>()

  constructor(
    private entries: EntryService,
    logs: LogService
  ) {
    super()
    logs.onLine((line) => this.check(line))
    // 删掉的条目，命中记录与去重状态一并丢掉
    this.entries.on('changed', (list: LaunchEntry[]) => {
      const ids = new Set(list.map((e) => e.id))
      for (const id of [...this.hits.keys()]) if (!ids.has(id)) this.forget(id)
    })
  }

  /** 条目崩溃：撤掉它排队中的告警通知，只留崩溃通知。命中记录照常保留 */
  noteCrash(entryId: string): void {
    this.lastCrash.set(entryId, Date.now())
    this.cancelPending(entryId)
  }

  private cancelPending(entryId: string): void {
    for (const t of this.pending.get(entryId) ?? []) clearTimeout(t)
    this.pending.delete(entryId)
  }

  list(entryId: string): OutputAlert[] {
    return [...(this.hits.get(entryId) ?? [])]
  }

  dispose(): void {
    for (const id of [...this.pending.keys()]) this.cancelPending(id)
  }

  private check(line: LogLine): void {
    if (!line.entryId) return
    const entry = this.entries.get(line.entryId)
    if (!entry) return
    const words = entry.alertKeywords ?? []
    if (words.length === 0 && !entry.alertOnErrors) return

    const hay = line.text.toLowerCase()
    let keyword: string | null | undefined = words.find((w) => hay.includes(w.toLowerCase()))
    if (keyword === undefined && entry.alertOnErrors && isErrorLine(line.text)) keyword = null
    if (keyword === undefined) return

    const dedupKey = `${entry.id}\u0000${keyword === null ? ERROR_LINE_KEY : keyword.toLowerCase()}`
    const now = Date.now()
    const last = this.lastHit.get(dedupKey)
    if (last !== undefined && now - last < DEDUP_WINDOW_MS) return
    this.lastHit.set(dedupKey, now)

    const alert: OutputAlert = {
      entryId: entry.id,
      sessionId: line.sessionId,
      name: entry.name,
      keyword,
      line: line.text.slice(0, MAX_LINE_CHARS),
      at: now
    }
    const list = this.hits.get(entry.id) ?? []
    list.push(alert)
    if (list.length > MAX_HITS_PER_ENTRY) list.splice(0, list.length - MAX_HITS_PER_ENTRY)
    this.hits.set(entry.id, list)

    this.emit('alert', alert)

    const timer = setTimeout(() => {
      const left = (this.pending.get(entry.id) ?? []).filter((t) => t !== timer)
      if (left.length) this.pending.set(entry.id, left)
      else this.pending.delete(entry.id)
      // 崩溃前后各一个延迟窗口内的告警都并进崩溃通知，不再单独弹
      const crashedAt = this.lastCrash.get(entry.id)
      if (crashedAt !== undefined && Math.abs(Date.now() - crashedAt) < NOTIFY_DELAY_MS * 2) return
      this.emit('notify', alert)
    }, NOTIFY_DELAY_MS)
    this.pending.set(entry.id, [...(this.pending.get(entry.id) ?? []), timer])
  }

  private forget(entryId: string): void {
    this.cancelPending(entryId)
    this.lastCrash.delete(entryId)
    this.hits.delete(entryId)
    const prefix = `${entryId}\u0000`
    for (const k of [...this.lastHit.keys()]) if (k.startsWith(prefix)) this.lastHit.delete(k)
  }
}
