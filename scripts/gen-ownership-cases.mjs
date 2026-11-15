// S14 对拍用例生成：跑原版 src/main/services/OwnershipService.ts，期望值全部来自原版，不手写。
//
// 每个场景：一串步骤。步骤是拨钟、register / unregister、verify / assertKillable / hasTracked。
// 进程表用 [pid, ppid, startedAt] 三元组合成（startedAt 可为 null 表示缺字段），mine 默认是全部 pid。
// 每步记录返回值或错误文案。internal/ownership/ownership_test.go 读同一份文件逐步重放比对。
//
// 桩：Date.now（场景自己的时钟）。原版不读文件、不起进程，不碰任何真实数据。
//
// 用法（在 mygo/console 下）：node scripts/gen-ownership-cases.mjs
// 输出纯 ASCII（非 ASCII 写成 \uXXXX）。

import './platform-hooks.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { scenarios } from './ownership-scenarios.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '../internal/ownership/testdata/ownership_cases.json')
const ORIGINAL = resolve(here, '../../../mile-terminal-management/src/main/services/OwnershipService.ts')
const { OwnershipService } = await import(pathToFileURL(ORIGINAL).href)

const realNow = Date.now

function table(t) {
  const rows = t.rows
  const byPid = new Map()
  for (const [pid, ppid, startedAt] of rows) {
    const row = { pid, ppid, name: 'x' }
    if (startedAt !== null) row.startedAt = startedAt
    byPid.set(pid, row)
  }
  const mine = new Set(t.mine ?? rows.map((r) => r[0]))
  return { byPid, mine, at: 0, listens: [] }
}

async function run(sc) {
  let clock = sc.clock ?? 1_700_000_000_000
  Date.now = () => clock
  const own = new OwnershipService()
  const steps = []
  for (const st of sc.steps) {
    if (st.clock !== undefined) {
      clock = st.clock
      steps.push({ clock })
      continue
    }
    const rec = { ...st }
    try {
      if (st.op === 'register') own.register(...st.args)
      else if (st.op === 'unregister') own.unregister(...st.args)
      else if (st.op === 'verify') rec.result = own.verify(st.pid, table(st.table))
      else if (st.op === 'assertKillable') rec.result = await own.assertKillable(st.pid, table(st.table), st.sessionId)
      else if (st.op === 'hasTracked') rec.result = own.hasTracked()
      else throw new Error('unknown op ' + st.op)
    } catch (e) {
      rec.error = String(e.message)
    }
    steps.push(rec)
  }
  Date.now = realNow
  return { name: sc.name, clock: sc.clock ?? 1_700_000_000_000, steps }
}

const cases = []
for (const sc of scenarios) cases.push(await run(sc))

// 原版 token 是 randomUUID 格式，Go 侧只校验格式，不对拍值
const token = new OwnershipService().issueToken()

const payload = {
  generatedFrom: 'mile-terminal-management/src/main/services/OwnershipService.ts + node ' + process.version,
  tokenSample: token,
  cases,
}
const json = JSON.stringify(payload, null, 1).replace(/[^\x00-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, json + '\n', 'utf8')
console.log(`wrote ${out}`)
console.log(`  scenarios ${cases.length}, steps ${cases.reduce((a, c) => a + c.steps.length, 0)}`)
console.log(`  errors ${cases.reduce((a, c) => a + c.steps.filter((s) => s.error).length, 0)}`)
