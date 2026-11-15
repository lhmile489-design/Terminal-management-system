// S18 对拍用例生成：跑原版 src/main/services/SessionService.ts，期望值全部来自原版，不手写。
//
// 场景见 session-scenarios.mjs。原版的 node-pty / node:os / '../platform' 由 platform-stub-session.mjs 顶替
// （hook 规则 2f）；OwnershipService / ScannerService 在这里用记录调用的假对象代替。
//
// 桩与假对象：
//   Date.now           场景自己的时钟
//   setTimeout/clear   手动队列：fire 步骤按毫秒数触发，不真等
//   process.env        只留 MILE_TEST_BASE，spawn 桩只记录固定键与 input.env 的键
//   假 pty             feed / exit 由步骤驱动；write / resize / kill 可按 pid 开关抛错
//
// 每步记录：步骤字段 + result 或 error + calls（本步新增的调用）+ events（本步新增的 data / exit 事件）
// + timers（仍待触发的定时器毫秒数，升序）。
// internal/sessions/golden_test.go 读同一份文件逐步重放比对。
//
// 用法（在 mygo/console 下）：node --experimental-transform-types scripts/gen-session-cases.mjs
// 输出纯 ASCII（非 ASCII 写成 \uXXXX）。

import './platform-hooks.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SCENARIOS } from './session-scenarios.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '../internal/sessions/testdata/session_cases.json')
const ORIGINAL = resolve(here, '../../../mile-terminal-management/src/main/services/SessionService.ts')

const FIXED_ENV_KEYS = [
  'MILE_TEST_BASE',
  'MILE_RUN_TOKEN',
  'MILE_SESSION_ID',
  'LANG',
  'LC_ALL',
  'PYTHONIOENCODING',
  'FORCE_COLOR',
  'TERM',
  'npm_config_progress',
]

const realNow = Date.now
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r))
}

const codePoints = (s) => [...s]
function summarize(s) {
  const cps = codePoints(s)
  const rec = { len: s.length, head: cps.slice(0, 8).join(''), tail: cps.slice(-8).join('') }
  if (s.length <= 200) rec.full = s
  return rec
}

let version = 0
async function run(sc) {
  let clock = sc.clock ?? 1_700_000_000_000
  Date.now = () => clock
  process.env.MILE_TEST_BASE = 'base'

  const S = { calls: [], spawned: 0, ptys: [], flags: {}, envKeys: [...FIXED_ENV_KEYS] }
  globalThis.__sess = S

  const { SessionService } = await import(pathToFileURL(ORIGINAL).href + '?v=' + ++version)

  // 手动定时器队列
  const queue = []
  globalThis.setTimeout = (fn, ms) => {
    const t = { fn, ms, cleared: false, fired: false }
    queue.push(t)
    return t
  }
  globalThis.clearTimeout = (t) => {
    if (t) t.cleared = true
  }

  let tokenN = 0
  const gate = { assertFails: false, tableFails: false }
  const own = {
    issueToken: () => `tok-${++tokenN}`,
    register: (sid, pid, token) => S.calls.push(['own.register', sid, pid, token]),
    unregister: (sid) => S.calls.push(['own.unregister', sid]),
    assertKillable: async (pid, _table, sid) => {
      S.calls.push(['own.assertKillable', pid, sid])
      if (gate.assertFails) throw new Error('assert failed')
    },
  }
  const scanner = {
    table: async (pids) => {
      S.calls.push(['scanner.table', pids])
      if (gate.tableFails) throw new Error('table failed')
      return { byPid: new Map(), mine: new Set(), at: 0, listens: [] }
    },
  }

  const svc = new SessionService(own)
  const events = []
  svc.on('data', (e) => events.push({ type: 'data', id: e.id, ...summarize(e.chunk) }))
  svc.on('exit', (e) => events.push({ type: 'exit', id: e.id, exitCode: e.exitCode }))

  const ids = []
  const idOf = (st) => (st.id !== undefined ? st.id : ids[st.n])
  const ptyOf = (st) => S.ptys[st.n]
  const pendingMs = () =>
    queue
      .filter((t) => !t.cleared && !t.fired)
      .map((t) => t.ms)
      .sort((a, b) => a - b)

  const steps = []
  for (const st of sc.steps) {
    const rec = { ...st }
    const callsBefore = S.calls.length
    const eventsBefore = events.length
    try {
      switch (st.op) {
        case 'clock':
          clock = st.ms
          break
        case 'scanner':
          gate.tableFails = st.tableFails === true
          gate.assertFails = st.assertFails === true
          svc.setScanner(scanner)
          break
        case 'flag': {
          const pid = ptyOf(st).pid
          S.flags[pid] = { ...(S.flags[pid] ?? {}), [st.name]: st.value }
          break
        }
        case 'createShell':
        case 'create': {
          const extra = st.input && typeof st.input === 'object' && st.input.env ? Object.keys(st.input.env) : []
          S.envKeys = [...FIXED_ENV_KEYS, ...extra]
          const meta = st.op === 'createShell' ? svc.createShell(st.input, st.at) : svc.create(st.input)
          ids.push(meta.id)
          rec.result = JSON.parse(JSON.stringify(meta))
          break
        }
        case 'feed':
          ptyOf(st).feed(st.data)
          break
        case 'feedRepeat':
          ptyOf(st).feed(st.unit.repeat(st.count))
          break
        case 'exit':
          ptyOf(st).exit(st.code)
          break
        case 'fire': {
          const due = queue.filter((t) => !t.cleared && !t.fired && t.ms === st.ms)
          for (const t of due) {
            if (t.cleared || t.fired) continue
            t.fired = true
            t.fn()
          }
          break
        }
        case 'write':
          svc.write(idOf(st), st.data)
          break
        case 'resize':
          svc.resize(idOf(st), st.cols, st.rows)
          break
        case 'history':
          rec.result = summarize(svc.history(idOf(st)))
          break
        case 'list':
          rec.result = JSON.parse(JSON.stringify(svc.list()))
          break
        case 'stop':
          svc.stop(idOf(st))
          break
        case 'kill':
          await svc.kill(idOf(st))
          break
        case 'ownedPids':
          rec.result = svc.ownedPids()
          break
        case 'sessionIdByPid':
          rec.result = svc.sessionIdByPid(st.pid)
          break
        case 'liveCount':
          rec.result = svc.liveCount()
          break
        case 'disposeAll':
          await svc.disposeAll()
          break
        default:
          throw new Error('unknown op ' + st.op)
      }
    } catch (e) {
      rec.error = String(e.message)
    }
    await settle()
    rec.calls = S.calls.slice(callsBefore)
    rec.events = events.slice(eventsBefore)
    rec.timers = pendingMs()
    steps.push(rec)
  }

  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
  Date.now = realNow
  return { name: sc.name, clock: sc.clock ?? 1_700_000_000_000, steps }
}

const cases = []
for (const sc of SCENARIOS) cases.push(await run(sc))

const payload = {
  generatedFrom: 'mile-terminal-management/src/main/services/SessionService.ts + node ' + process.version,
  envKeys: FIXED_ENV_KEYS,
  cases,
}
const json = JSON.stringify(payload, null, 1).replace(
  /[^\x00-\x7e]/g,
  (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, json + '\n', 'utf8')
console.log(`wrote ${out}`)
console.log(`  scenarios ${cases.length}, steps ${cases.reduce((a, c) => a + c.steps.length, 0)}`)
console.log(`  errors ${cases.reduce((a, c) => a + c.steps.filter((s) => s.error).length, 0)}`)
console.log(`  events ${cases.reduce((a, c) => a + c.steps.reduce((b, s) => b + s.events.length, 0), 0)}`)
console.log(`  calls ${cases.reduce((a, c) => a + c.steps.reduce((b, s) => b + s.calls.length, 0), 0)}`)
