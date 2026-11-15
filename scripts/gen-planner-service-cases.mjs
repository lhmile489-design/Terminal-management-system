// S12 服务层对拍用例生成：跑原版 src/main/services/PlannerService.ts，期望值全部来自原版，不手写。
//
// 每个场景：初始 planner.json（可无）+ 工作组列表 + plannerNotify + 一串操作。
// 每步记录：返回值或错误文案、执行后的 snapshot、这一步发出的 changed 次数与 reminder 列表。
// internal/planner/service_test.go 读同一份文件逐步重放比对。
//
// 桩：electron（app.getPath 指向临时目录、isPackaged=false）、node:crypto（randomUUID 给 id-1、id-2……）、
// ConfigStore（只有 get()）、Date.now（每个场景自己的时钟）。PlannerService 真读真写临时目录。
// 绝不碰真实 %APPDATA%。
//
// 用法（在 mygo/console 下）：node --experimental-transform-types scripts/gen-planner-service-cases.mjs
// （原版构造函数用了参数属性 `private config`，只做类型擦除的默认模式不认）
// 时区固定 Asia/Shanghai，与 internal/planner 的 TestMain 一致。输出纯 ASCII（非 ASCII 写成 \uXXXX）。

process.env.TZ = 'Asia/Shanghai'
delete process.env.MILE_PLANNER_TICK_MS
delete process.env.MILE_PLANNER_NOW

import './platform-hooks.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { crud } from './planner-scenarios-crud.mjs'
import { sched } from './planner-scenarios-sched.mjs'
import { tick } from './planner-scenarios-tick.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '../internal/planner/testdata/planner_service_cases.json')
const ORIGINAL = resolve(here, '../../../mile-terminal-management/src/main/services/PlannerService.ts')
const { PlannerService } = await import(pathToFileURL(ORIGINAL).href)

const realNow = Date.now
const root = mkdtempSync(join(tmpdir(), 'mile-s12-'))
let n = 0

// 一个日期时刻（东八区本地）转 Unix ms
const at = (date, time = '00:00') => new Date(`${date}T${time}:00`).getTime()

function run(sc) {
  const appData = join(root, String(n++))
  const dir = join(appData, 'mile-terminal')
  mkdirSync(dir, { recursive: true })
  globalThis.__appData = appData
  globalThis.__idSeq = 0
  if (sc.file !== undefined) writeFileSync(join(dir, 'planner.json'), sc.file, 'utf8')
  if (sc.backup !== undefined) writeFileSync(join(dir, 'planner.json.bak'), sc.backup, 'utf8')

  let clock = sc.clock ?? at('2026-11-14', '09:00')
  Date.now = () => clock
  const cfg = { groups: sc.groups ?? [], settings: { plannerNotify: sc.notify ?? true } }
  const config = { get: () => cfg }

  const svc = new PlannerService(config)
  let changed = 0
  let reminders = []
  svc.on('changed', () => changed++)
  svc.on('reminder', (f) => reminders.push(f))

  const steps = []
  // lite：大批量场景只在最后一步存快照，其余步只记返回值 / 错误 / 事件，免得文件膨胀
  const last = sc.ops.length - 1
  for (const [k, op] of sc.ops.entries()) {
    if (op.clock !== undefined) {
      clock = op.clock
      steps.push({ clock })
      continue
    }
    if (op.groups !== undefined) {
      cfg.groups = op.groups
      steps.push({ groups: op.groups })
      continue
    }
    if (op.notify !== undefined) {
      cfg.settings.plannerNotify = op.notify
      steps.push({ notify: op.notify })
      continue
    }
    changed = 0
    reminders = []
    // 参数先过一遍 JSON：Go 侧收到的就是这份 JSON，两边看到的入参完全相同
    const args = JSON.parse(JSON.stringify(op.args ?? []))
    const step = { op: op.op, args }
    try {
      const r = svc[op.op](...args)
      step.result = r === undefined ? null : r
    } catch (err) {
      step.error = err instanceof Error ? err.message : String(err)
    }
    if (!sc.lite || k === last) step.snapshot = svc.snapshot()
    if (sc.lite && step.result && typeof step.result === 'object') step.result = { id: step.result.id }
    step.changed = changed
    step.reminders = reminders
    steps.push(step)
  }
  const file = join(dir, 'planner.json')
  // 磁盘原文：只读场景里主文件与备份都是坏的，必须原样留着
  const disk = existsSync(file) ? readFileSync(file, 'utf8') : null
  const bak = join(dir, 'planner.json.bak')
  const diskBackup = existsSync(bak) ? readFileSync(bak, 'utf8') : null
  return { name: sc.name, file: sc.file ?? null, backup: sc.backup ?? null, clock: sc.clock ?? at('2026-11-14', '09:00'),
    lite: !!sc.lite, groups: sc.groups ?? [], notify: sc.notify ?? true, steps, disk, diskBackup }
}

const scenarios = [...crud, ...sched, ...tick]

const cases = scenarios.map(run)

// ── 开发钩子：MILE_PLANNER_TICK_MS / MILE_PLANNER_NOW 在模块加载时读，每组用 ?v=N 重新加载一份模块 ──
// legacy 标记的是 V8 非标准日期写法（Date.parse 的实现定义部分），Go 只实现 ISO 8601，见 MIGRATION-PLAN §6
const { app } = await import('./platform-stub-electron.mjs')
const realSetInterval = globalThis.setInterval
const devInputs = [
  { packaged: false },
  { packaged: false, tick: '' }, { packaged: false, tick: '0' }, { packaged: false, tick: '-5' },
  { packaged: false, tick: 'abc' }, { packaged: false, tick: '1000' }, { packaged: false, tick: '1e3' },
  { packaged: false, tick: ' 500 ' }, { packaged: false, tick: '0x10' }, { packaged: false, tick: '2.5' },
  { packaged: false, tick: '2147483648' },
  { packaged: false, now: '' }, { packaged: false, now: '1763100000000' }, { packaged: false, now: ' 1763100000000 ' },
  { packaged: false, now: '1.5' }, { packaged: false, now: '-5' }, { packaged: false, now: 'abc' },
  { packaged: false, now: '2026-11-14' }, { packaged: false, now: '2026-11' }, { packaged: false, now: '2026' },
  { packaged: false, now: '2026-11-14T09:00' }, { packaged: false, now: '2026-11-14T09:00:30' },
  { packaged: false, now: '2026-11-14T09:00:00Z' }, { packaged: false, now: '2026-11-14T09:00:00.5+08:00' },
  { packaged: false, now: '2026-11-14T09:00:00.123456-02:30' }, { packaged: false, now: '+002026-11-14T09:00Z' },
  { packaged: false, now: '2026-11-14T24:00' }, { packaged: false, now: '2026-11-14T24:01' },
  { packaged: false, now: '2026-02-29' }, { packaged: false, now: '2024-02-29' }, { packaged: false, now: '2026-13-01' },
  { packaged: false, now: '2026-11-14T25:00' },
  { packaged: false, now: '2026-02-31' }, { packaged: false, now: '2026-04-31' }, { packaged: false, now: '2026-02-32' },
  { packaged: false, now: '2026-00-10' }, { packaged: false, now: '2026-01-00' }, { packaged: false, now: '2026-11-14T23:60' },
  { packaged: false, now: '2026-11-14T09:00:60' }, { packaged: false, now: '2026-11-14T09:00:00.1234567890Z' },
  { packaged: false, now: '2026-11-14T9:00' }, { packaged: false, now: '-000001-01-01T00:00Z' },
  { packaged: false, now: '-000000-01-01T00:00Z' }, { packaged: false, now: '2026-11-14T09:00:00,5Z' },
  { packaged: false, now: '2026-11-14T24:00:00.000' }, { packaged: false, now: '2026-11-14T24:00:00.001' },
  { packaged: false, now: '2026-11-14t09:00z', legacy: true }, { packaged: false, now: '2026-11-14T09:00+0800', legacy: true },
  { packaged: false, now: '2026-11-14 09:00', legacy: true }, { packaged: false, now: 'Nov 14 2026', legacy: true },
  { packaged: false, now: '0', legacy: true },
  { packaged: false, tick: '1000', now: '1763100000000' },
  { packaged: true, tick: '1000', now: '1763100000000' },
]
const WALL = 1700000000000
const devCases = []
for (const [k, c] of devInputs.entries()) {
  if (c.tick === undefined) delete process.env.MILE_PLANNER_TICK_MS
  else process.env.MILE_PLANNER_TICK_MS = c.tick
  if (c.now === undefined) delete process.env.MILE_PLANNER_NOW
  else process.env.MILE_PLANNER_NOW = c.now
  app.isPackaged = c.packaged
  const appData = join(root, 'dev' + k)
  mkdirSync(join(appData, 'mile-terminal'), { recursive: true })
  globalThis.__appData = appData
  const mod = await import(pathToFileURL(ORIGINAL).href + '?v=' + k)
  let delay = null
  globalThis.setInterval = (fn, ms) => { delay = ms; return { unref() {} } }
  Date.now = () => WALL
  const svc = new mod.PlannerService({ get: () => ({ groups: [], settings: { plannerNotify: true } }) })
  svc.startScheduler()
  svc.dispose()
  devCases.push({ ...c, legacy: !!c.legacy, wall: WALL, tickMs: delay, now: c.now ?? null, nowResult: svc.now() })
}
globalThis.setInterval = realSetInterval
app.isPackaged = false
delete process.env.MILE_PLANNER_TICK_MS
delete process.env.MILE_PLANNER_NOW
Date.now = realNow

const payload = {
  generatedFrom: 'mile-terminal-management/src/main/services/PlannerService.ts + node ' + process.version,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  cases,
  dev: devCases,
}
const json = JSON.stringify(payload, null, 1).replace(/[^\x00-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, json + '\n', 'utf8')
console.log(`wrote ${out}`)
console.log(`  dev ${devCases.length}`)
console.log(`  scenarios ${cases.length}, steps ${cases.reduce((a, c) => a + c.steps.length, 0)}`)
