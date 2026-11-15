// S21a 对拍用例生成：跑原版 src/main/services/EntryService.ts，期望值全部来自原版，不手写。
//
// 场景见 entry-scenarios.mjs。config / detect / sessions / scanner / ownership 用记录调用的假对象；
// '../platform' 换成 platform-stub-entry.mjs（可控的假平台，能覆盖「本平台不支持」那条分支），
// node:crypto 换成可预测的 id-N。Date.now 固定，临时夹具目录写盘时替换成 <FIX>。
//
// 每步记录：步骤字段 + result 或 error + calls（本步新增的配置落盘 / 会话终止）+ events（changed 广播）。
// internal/entries/entries_test.go 读同一份文件逐步重放比对。
//
// 用法（在 mygo/console 下）：node --experimental-transform-types scripts/gen-entry-cases.mjs
// 输出纯 ASCII（非 ASCII 写成 \uXXXX）。

import './platform-hooks.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SCENARIOS, FIX, GROUPS } from './entry-scenarios.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '../internal/entries/testdata/entry_cases.json')
const ORIGINAL = resolve(here, '../../../mile-terminal-management/src/main/services/EntryService.ts')

const root = join(tmpdir(), 'mile-entry-fixture')
mkdirSync(join(root, 'proj'), { recursive: true })
mkdirSync(join(root, 'proj2'), { recursive: true })
globalThis.__appData = join(root, 'appdata')
mkdirSync(globalThis.__appData, { recursive: true })

const realNow = Date.now
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r))
}

const swapIn = (v) => JSON.parse(JSON.stringify(v).split(FIX).join(JSON.stringify(root).slice(1, -1)))

let version = 0
async function run(sc) {
  const clock = 1_700_000_000_000
  Date.now = () => clock
  globalThis.__idSeq = 0

  const mod = await import(pathToFileURL(ORIGINAL).href + '?v=' + ++version)
  const { EntryService } = mod

  const calls = []
  const events = []
  const state = {
    version: 16,
    entries: swapIn(sc.entries ?? []),
    groups: swapIn(GROUPS),
    settings: {},
    updatedAt: 0
  }
  // 种子数据的快照：写进 JSON，Go 侧照它重建（scenario 之间互不相同）
  const state0 = JSON.parse(JSON.stringify({ entries: state.entries, groups: state.groups }))
  const config = {
    get: () => state,
    patch: (p) => {
      const rec = JSON.parse(JSON.stringify(p))
      Object.assign(state, p)
      calls.push(['config.patch', rec])
      return state
    }
  }
  const sessions = {
    on: () => {},
    kill: (id) => calls.push(['sessions.kill', id])
  }
  const svc = new EntryService(config, {}, sessions, {}, {})
  svc.on('changed', (list) => events.push(list))

  const rec = (v) => JSON.parse(JSON.stringify(v))
  const steps = []
  for (const st of sc.steps) {
    const step = { ...st }
    const callsBefore = calls.length
    const eventsBefore = events.length
    try {
      switch (st.op) {
        case 'add':
          step.result = rec(await svc.add(swapIn(st.input)))
          break
        case 'edit':
          step.result = rec(await svc.edit(st.id, swapIn(st.patch ?? {})))
          break
        case 'sanitize': {
          const target = state.entries.find((e) => e.id === st.id)
          const clean = svc.sanitizeEdit(target, swapIn(st.patch ?? {}))
          // 记录 `{...target, ...clean}`：与原版 edit 里展开后落盘的结果同形
          step.result = rec({ ...target, ...clean })
          break
        }
        case 'runtime': {
          const cur = svc.runtimes.get(st.id) ?? { entryId: st.id, status: 'idle' }
          svc.runtimes.set(st.id, { ...cur, status: st.status })
          break
        }
        case 'remove':
          svc.remove(st.id)
          break
        case 'reorder':
          step.result = rec(svc.reorder(st.ids))
          break
        case 'list':
          step.result = rec(svc.list())
          break
        case 'capturePort':
          step.result = mod.capturePort(swapIn(st.chunk))
          break
        case 'taskStatus':
          step.result = mod.taskStatus(st.code, st.stoppedByUser)
          break
        case 'isSafeRelative':
          step.result = mod.isSafeRelative(st.p)
          break
        case 'normalizePath':
          step.result = mod.normalizePath(st.p)
          break
        case 'groupEnv':
          step.result = svc.groupEnv(st.groupId)
          break
        case 'startAfter':
          svc.assertStartAfter(st.id, st.deps)
          break
        default:
          throw new Error('unknown op ' + st.op)
      }
    } catch (e) {
      step.error = String(e.message)
    }
    await settle()
    step.calls = calls.slice(callsBefore)
    step.events = events.slice(eventsBefore)
    steps.push(step)
  }

  Date.now = realNow
  return { name: sc.name, entries: state0.entries, groups: state0.groups, steps }
}

const cases = []
for (const sc of SCENARIOS) cases.push(await run(sc))

const payload = {
  generatedFrom: 'mile-terminal-management/src/main/services/EntryService.ts + node ' + process.version,
  cases
}
let json = JSON.stringify(payload, null, 1)
// 夹具根目录写盘时换回占位符，测试在不同机器上跑才可比
json = json.split(JSON.stringify(root).slice(1, -1)).join(FIX)
json = json.replace(/[^\x00-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, json + '\n', 'utf8')
console.log(`wrote ${out}`)
console.log(`  scenarios ${cases.length}, steps ${cases.reduce((a, c) => a + c.steps.length, 0)}`)
console.log(`  errors ${cases.reduce((a, c) => a + c.steps.filter((s) => s.error).length, 0)}`)
console.log(`  calls ${cases.reduce((a, c) => a + c.steps.reduce((b, s) => b + s.calls.length, 0), 0)}`)
