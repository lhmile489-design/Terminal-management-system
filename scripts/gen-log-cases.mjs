// S19 对拍用例生成：跑原版 src/main/services/LogService.ts，期望值全部来自原版，不手写。
//
// 场景见 log-scenarios.mjs。原版只用到 sessions 上的 on('data' | 'exit') 与 list()，
// 所以这里用真的 EventEmitter + 一个可变会话列表顶替 SessionService（它的类型 import 是 type-only，不加载）。
// Date.now 与 setTimeout 换成场景自己的时钟与手动队列，不真等。
//
// 每步记录：步骤字段 + result 或 error + timers（仍待触发的定时器毫秒数，升序）
// + events（recordLines 为真时，本步 onLine 收到的行）。
// internal/logs/logs_test.go 读同一份文件逐步重放比对。
//
// 用法（在 mygo/console 下）：node --experimental-transform-types scripts/gen-log-cases.mjs
// 输出纯 ASCII（非 ASCII 写成 \uXXXX）。

import './platform-hooks.mjs'
import { EventEmitter } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SCENARIOS } from './log-scenarios.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '../internal/logs/testdata/log_cases.json')
const ORIGINAL = resolve(here, '../../../mile-terminal-management/src/main/services/LogService.ts')

const realNow = Date.now
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r))
}

let version = 0
async function run(sc) {
  let clock = sc.clock ?? 1_700_000_000_000
  Date.now = () => clock

  const { LogService } = await import(pathToFileURL(ORIGINAL).href + '?v=' + ++version)

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

  const bus = new EventEmitter()
  let metas = []
  const sessions = {
    on: (ev, fn) => bus.on(ev, fn),
    list: () => metas.map((m) => ({ ...m })),
  }

  const svc = new LogService(sessions)
  const emitted = []
  let record = sc.recordLines === true
  svc.onLine((line) => {
    if (record) emitted.push(JSON.parse(JSON.stringify(line)))
  })

  const pendingMs = () =>
    queue
      .filter((t) => !t.cleared && !t.fired)
      .map((t) => t.ms)
      .sort((a, b) => a - b)

  const steps = []
  for (const st of sc.steps) {
    const rec = { ...st }
    const before = emitted.length
    try {
      switch (st.op) {
        case 'clock':
          clock = st.ms
          break
        case 'session':
          metas.push({
            id: st.id,
            projectId: st.projectId ?? null,
            kind: 'shell',
            title: st.title,
            command: '',
            cwd: '',
            pid: 4000 + metas.length,
            status: 'running',
            startedAt: clock,
          })
          break
        case 'dropSession':
          metas = metas.filter((m) => m.id !== st.id)
          break
        case 'data':
          bus.emit('data', { id: st.id, chunk: st.data })
          break
        case 'dataRepeat':
          bus.emit('data', { id: st.id, chunk: st.unit.repeat(st.count) })
          break
        case 'exit':
          bus.emit('exit', { id: st.id, exitCode: 0 })
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
        case 'query':
          rec.result = JSON.parse(JSON.stringify(svc.query(st.q ?? {})))
          break
        case 'clear':
          svc.clear()
          break
        case 'badListener':
          svc.onLine(() => {
            throw new Error('listener boom')
          })
          break
        default:
          throw new Error('unknown op ' + st.op)
      }
    } catch (e) {
      rec.error = String(e.message)
    }
    await settle()
    if (record) rec.events = emitted.slice(before)
    rec.timers = pendingMs()
    steps.push(rec)
  }

  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
  Date.now = realNow
  return { name: sc.name, clock: sc.clock ?? 1_700_000_000_000, recordLines: record, steps }
}

const cases = []
for (const sc of SCENARIOS) cases.push(await run(sc))

const payload = {
  generatedFrom: 'mile-terminal-management/src/main/services/LogService.ts + node ' + process.version,
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
console.log(`  events ${cases.reduce((a, c) => a + c.steps.reduce((b, s) => b + (s.events?.length ?? 0), 0), 0)}`)
