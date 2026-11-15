// S15 对拍用例生成：跑原版 src/main/services/ScannerService.ts，期望值全部来自原版，不手写。
//
// 一个场景 = 初始配置 + 一串步骤。步骤改「世界」（监听行、进程表、pidusage 读数、cpus、内存、时钟），
// 或调扫描器的公开方法。每步记录：这一步里发出的 diff 与 error、定时器的设置 / 清除、方法返回值、
// 之后的 snapshot、累计的 netstat / CIM 调用次数、配置里扫描器会改的三项。
// internal/scanner/scanner_test.go 用同一个世界模型重放比对。
//
// 桩：'../platform'（id / pathKey / attribution 用原版 win32 本身，两个采集函数读世界）、pidusage、
// node:os、Date.now、process.pid、setTimeout / clearTimeout（只记录，由步骤 fire 手动触发）、ConfigStore（内存里的 get / patch）。
// 绝不碰真实 %APPDATA%，不跑 netstat / PowerShell。
//
// 用法（在 mygo/console 下）：node --experimental-transform-types scripts/gen-scanner-cases.mjs
// 输出纯 ASCII（非 ASCII 写成 \uXXXX）。

import './platform-hooks.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { scenariosA } from './scanner-scenarios-a.mjs'
import { scenariosB } from './scanner-scenarios-b.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '../internal/scanner/testdata/scanner_cases.json')
const SRC = resolve(here, '../../../mile-terminal-management/src/main/services')
const { OwnershipService } = await import(pathToFileURL(resolve(SRC, 'OwnershipService.ts')).href)

const realNow = Date.now
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const realPid = process.pid
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r))
}

// 世界 → 原版采集函数的返回值
function makeWorld(state) {
  return {
    readListenPorts() {
      state.reads.listen++
      if (state.world.cost) state.clock += state.world.cost
      if (state.world.failListen) throw new Error(state.world.failListen)
      return (state.world.listens ?? []).map(([port, pid, fam = [4]]) => ({ port, pid, families: fam }))
    },
    readProcessMeta() {
      state.reads.meta++
      if (state.world.failMeta) throw new Error(state.world.failMeta)
      const byPid = new Map()
      for (const [pid, ppid, name, startedAt, cmd, exe] of state.world.procs ?? []) {
        const row = { pid, ppid, name }
        if (exe != null) row.execPath = exe
        if (cmd != null) row.commandLine = cmd
        if (startedAt != null) row.startedAt = startedAt
        byPid.set(pid, row)
      }
      const mine = new Set(state.world.mine ?? (state.world.procs ?? []).map((p) => p[0]))
      return { byPid, mine, at: state.clock }
    },
    pidusage(pids) {
      if (state.world.usage === 'fail') throw new Error('pidusage failed')
      const res = {}
      for (const p of pids) {
        const u = state.world.usage?.[p]
        if (u) res[String(p)] = { cpu: u[0], memory: u[1] }
      }
      return res
    },
    cpus() {
      return (state.world.cpus ?? [[0, 0, 0, 0, 0]]).map(([user, nice, sys, idle, irq]) => ({ times: { user, nice, sys, idle, irq } }))
    },
    totalmem: () => (state.world.mem ?? [100, 50])[0],
    freemem: () => (state.world.mem ?? [100, 50])[1],
  }
}

const pick = (cfg) => ({ ignoredListeners: cfg.ignoredListeners, groupOverrides: cfg.groupOverrides, watchedKeywords: cfg.watchedKeywords })
const tableOut = (t) => ({
  byPid: [...t.byPid.keys()].sort((a, b) => a - b),
  mine: [...t.mine].sort((a, b) => a - b),
  at: t.at,
  listens: t.listens,
})

let n = 0
async function run(sc) {
  const state = { clock: sc.clock ?? 1_700_000_000_000, world: {}, reads: { listen: 0, meta: 0 } }
  globalThis.__scan = makeWorld(state)
  Date.now = () => state.clock
  Object.defineProperty(process, 'pid', { value: sc.selfPid ?? 1, configurable: true })
  let timers = []
  const pending = new Map()
  let nextHandle = 1
  globalThis.setTimeout = (fn, ms) => {
    const h = nextHandle++
    pending.set(h, fn)
    timers.push({ set: ms })
    return h
  }
  globalThis.clearTimeout = (h) => {
    pending.delete(h)
    timers.push({ clear: true })
  }

  const { ScannerService } = await import(pathToFileURL(resolve(SRC, 'ScannerService.ts')).href + `?v=${++n}`)
  let cfg = {
    ignoredListeners: [],
    groupOverrides: [],
    watchedKeywords: [],
    ...(sc.config ?? {}),
    settings: { scanIntervalMs: 2000, ...(sc.config?.settings ?? {}) },
  }
  const config = { get: () => cfg, patch: (p) => (cfg = { ...cfg, ...p }) }
  const own = new OwnershipService()
  const scanner = new ScannerService(own, config)
  let exps = []
  scanner.setExpectationSource(() => exps)
  let diffs = []
  let errors = []
  scanner.on('diff', (d) => diffs.push(JSON.parse(JSON.stringify(d))))
  if (!sc.noErrorListener) scanner.on('error', (e) => errors.push(String(e.message)))

  const steps = []
  for (const st of sc.steps) {
    if (st.clock !== undefined) { state.clock = st.clock; steps.push({ clock: st.clock }); continue }
    if (st.advance !== undefined) { state.clock += st.advance; steps.push({ clock: state.clock }); continue }
    if (st.world) { state.world = { ...state.world, ...st.world }; steps.push({ world: st.world }); continue }
    if (st.expect) { exps = st.expect; steps.push({ expect: st.expect }); continue }
    if (st.settings) { cfg = { ...cfg, settings: { ...cfg.settings, ...st.settings } }; steps.push({ settings: st.settings }); continue }

    const rec = { op: st.op, args: st.args ?? [] }
    try {
      const a = st.args ?? []
      switch (st.op) {
        case 'register': own.register(a[0], a[1], 'tok'); break
        case 'unregister': own.unregister(a[0]); break
        case 'refresh': scanner.refresh(); break
        case 'refreshTwice': scanner.refresh(); scanner.refresh(); break
        case 'start': scanner.start(); break
        case 'stop': scanner.stop(); break
        case 'fire': {
          const last = [...pending.entries()].pop()
          if (!last) throw new Error('no pending timer')
          pending.delete(last[0])
          last[1]()
          break
        }
        case 'setVisible': scanner.setVisible(a[0]); break
        case 'reschedule': scanner.reschedule(); break
        case 'ignore': scanner.ignore(a[0], a[1]); break
        case 'hideOnce': scanner.hideOnce(a[0], a[1]); break
        case 'hideOnceMany': for (let i = 0; i < a[1]; i++) { scanner.hideOnce(a[0] + i, a[2]); await flush() } break
        case 'setGroup': scanner.setGroup(a[0], a[1]); break
        case 'setWatched': rec.result = scanner.setWatchedKeywords(a[0]); break
        case 'table': rec.result = tableOut(await scanner.table(a[0] ?? [])); break
        case 'knownPath': rec.result = scanner.knownPath(a[0]); break
        case 'isVisible': rec.result = scanner.isVisible(); break
        case 'listenRows': rec.result = scanner.listenRows(); break
        default: throw new Error('unknown op ' + st.op)
      }
    } catch (e) {
      rec.error = String(e.message)
    }
    await flush()
    if (st.op === 'hideOnceMany') {
      rec.diffCount = diffs.length
      rec.diffs = diffs.slice(-1)
    } else {
      rec.diffs = diffs
    }
    rec.errors = errors
    rec.timers = timers
    rec.snapshot = scanner.snapshot() === null ? null : JSON.parse(JSON.stringify(scanner.snapshot()))
    rec.reads = { ...state.reads }
    rec.config = pick(cfg)
    diffs = []
    errors = []
    timers = []
    steps.push(rec)
  }
  scanner.stop()
  return { name: sc.name, clock: sc.clock ?? 1_700_000_000_000, selfPid: sc.selfPid ?? 1, noErrorListener: !!sc.noErrorListener, config: sc.config ?? {}, steps }
}

const cases = []
for (const sc of [...scenariosA, ...scenariosB]) cases.push(await run(sc))
Date.now = realNow
globalThis.setTimeout = realSetTimeout
globalThis.clearTimeout = realClearTimeout
Object.defineProperty(process, 'pid', { value: realPid, configurable: true })

const payload = {
  generatedFrom: 'mile-terminal-management/src/main/services/ScannerService.ts + node ' + process.version,
  cases,
}
const json = JSON.stringify(payload, null, 1).replace(/[^\x00-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, json + '\n', 'utf8')
console.log(`wrote ${out} (${(json.length / 1024).toFixed(0)} KB)`)
console.log(`  scenarios ${cases.length}, steps ${cases.reduce((a, c) => a + c.steps.length, 0)}`)
