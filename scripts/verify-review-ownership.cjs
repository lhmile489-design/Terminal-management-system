/**
 * 归属判定的 PID 复用防护（2026-10-27 审查修复）。
 *
 * 真实的 PID 复用要等系统回收，harness 等不到。OwnershipService 是纯逻辑，
 * 输入只有登记表与进程表，所以这里用 esbuild 把源码单独打包，喂合成的进程表：
 *
 * 1. 根 PID 还是登记时那个进程 → owned。
 * 2. 根 PID 被另一个更晚创建的进程复用 → 不是 owned（以前只比「登记时刻 - 60s」，会放行）。
 * 3. 子进程早于根进程创建 → 不可能是它的后代 → 不是 owned。
 * 4. 归属命中的会话与调用方要停的会话不一致 → assertKillable 拒绝。
 *
 * 不起 Electron、不起子进程、不碰配置。
 *
 *   node scripts/verify-review-ownership.cjs
 */
const { join } = require('node:path')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { buildSync } = require('esbuild')

const ROOT = join(__dirname, '..')
const OUT_DIR = mkdtempSync(join(tmpdir(), 'mile-own-'))
const OUT = join(OUT_DIR, 'ownership.cjs')
buildSync({
  entryPoints: [join(ROOT, 'src/main/services/OwnershipService.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: OUT,
  logLevel: 'silent'
})
const { OwnershipService } = require(OUT)

let pass = 0
let fail = 0
function check(name, ok, detail) {
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? ` — ${detail}` : ''}`)
}

/** 合成进程表：rows 为 [pid, ppid, startedAt] */
function table(rows) {
  const byPid = new Map(rows.map(([pid, ppid, startedAt]) => [pid, { pid, ppid, name: 'x', startedAt }]))
  return { byPid, mine: new Set(rows.map((r) => r[0])), at: Date.now(), listens: [] }
}

const ROOT_PID = 5000
const CHILD_PID = 5100
const t0 = Date.now()

console.log('\n=== 1. 根进程未变 ===')
{
  const own = new OwnershipService()
  own.register('s1', ROOT_PID, 'tok')
  // 根进程在登记前 200ms 由 ConPTY 创建，子进程更晚
  const tb = table([[ROOT_PID, 1000, t0 - 200], [CHILD_PID, ROOT_PID, t0 + 500]])
  check('根进程判为 owned', own.verify(ROOT_PID, tb).ownership === 'owned', own.verify(ROOT_PID, tb).ownership)
  check('其子进程判为 owned', own.verify(CHILD_PID, tb).ownership === 'owned', own.verify(CHILD_PID, tb).ownership)
}

console.log('\n=== 2. 根 PID 被复用 ===')
{
  const own = new OwnershipService()
  own.register('s1', ROOT_PID, 'tok')
  // 先观察到一次真实的根进程：钉住它的创建时间
  own.verify(ROOT_PID, table([[ROOT_PID, 1000, t0 - 200]]))
  // 根进程退出、系统把 5000 分给了 30 秒后才创建的新进程（仍在旧逻辑的 60s 宽限内）
  const reused = table([[ROOT_PID, 1000, t0 + 30_000], [CHILD_PID, ROOT_PID, t0 + 31_000]])
  const v = own.verify(ROOT_PID, reused)
  check('复用后的根 PID 不再判为 owned', v.ownership !== 'owned', v.ownership)
  const c = own.verify(CHILD_PID, reused)
  check('复用进程的子进程不判为 owned', c.ownership !== 'owned', c.ownership)
  let threw = false
  try { own.assertKillable(ROOT_PID, reused) } catch { threw = true }
  // assertKillable 是 async，同步 try 抓不到 —— 用 promise 判
  void threw
}

console.log('\n=== 3. 首次观察就已被复用 ===')
{
  const own = new OwnershipService()
  own.register('s1', ROOT_PID, 'tok')
  // 登记后第一次看到这个 PID 时，它的创建时间已在登记 30 秒之后：不是我们 spawn 的那个
  const tb = table([[ROOT_PID, 1000, Date.now() + 30_000]])
  const v = own.verify(ROOT_PID, tb)
  check('创建时间晚于登记太多的根 PID 不判为 owned', v.ownership !== 'owned', v.ownership)
}

console.log('\n=== 4. 子进程早于根进程 ===')
{
  const own = new OwnershipService()
  own.register('s1', ROOT_PID, 'tok')
  // ppid 指向根，但它创建得比根还早 —— 只可能是 PPID 被复用后的巧合
  const tb = table([[ROOT_PID, 1000, t0 - 200], [CHILD_PID, ROOT_PID, t0 - 10_000]])
  const v = own.verify(CHILD_PID, tb)
  check('早于根进程创建的「子进程」不判为 owned', v.ownership !== 'owned', v.ownership)
}

;(async () => {
  console.log('\n=== 5. assertKillable 绑定会话 ===')
  const own = new OwnershipService()
  own.register('s1', ROOT_PID, 'tok')
  own.register('s2', 6000, 'tok2')
  const tb = table([[ROOT_PID, 1000, t0 - 200], [6000, 1000, t0 - 100]])
  const ok = await own.assertKillable(ROOT_PID, tb, 's1').then(() => 'ok', (e) => String(e))
  check('会话一致时放行', ok === 'ok', ok)
  const wrong = await own.assertKillable(6000, tb, 's1').then(() => 'ok', (e) => String(e))
  check('PID 属于别的会话时拒绝', /会话/.test(wrong), wrong)

  const own2 = new OwnershipService()
  own2.register('s1', ROOT_PID, 'tok')
  own2.verify(ROOT_PID, table([[ROOT_PID, 1000, t0 - 200]]))
  const reused = table([[ROOT_PID, 1000, t0 + 30_000]])
  const r = await own2.assertKillable(ROOT_PID, reused, 's1').then(() => 'ok', (e) => String(e))
  check('PID 复用后 assertKillable 拒绝', r !== 'ok', r)

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  try { rmSync(OUT_DIR, { recursive: true, force: true }) } catch { /* 交系统清理 */ }
  process.exit(fail === 0 ? 0 : 1)
})()
