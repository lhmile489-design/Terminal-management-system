// S17 对拍用例生成：跑原版 src/main/services/PrecheckService.ts，期望值全部来自原版，不手写。
//
// 场景定义在 precheck-scenarios.mjs。每个场景在临时目录里建成真实目录树（含 PATH 用的 bin 目录），原版真读真 stat；
// statfs 与 findFreePort 由 platform-stub-precheck.mjs 按场景给值并记录调用；process.versions.node 按场景改写。
// DetectService 用原版真实实现（只用到 lockfileFor）。结果里的场景目录换成占位 <ROOT>。
//
// 用法（在 mygo/console 下）：node --experimental-transform-types scripts/gen-precheck-cases.mjs
// 输出纯 ASCII（非 ASCII 写成 \uXXXX）。

import './platform-hooks.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { scenarios } from './precheck-scenarios.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '../internal/precheck/testdata/precheck_cases.json')
const SERVICES = resolve(here, '../../../mile-terminal-management/src/main/services')
const { PrecheckService, resolveCwd } = await import(pathToFileURL(join(SERVICES, 'PrecheckService.ts')).href)
const { DetectService } = await import(pathToFileURL(join(SERVICES, 'DetectService.ts')).href)
const svc = new PrecheckService(new DetectService())

const root = mkdtempSync(join(tmpdir(), 'mile-s17-'))
const B = String.fromCharCode(92)

function build(dir, files) {
  mkdirSync(dir, { recursive: true })
  for (const [rel, v] of Object.entries(files)) {
    const p = join(dir, rel)
    mkdirSync(dirname(p), { recursive: true })
    if (typeof v === 'string') writeFileSync(p, v, 'utf8')
    else if (v.dir) mkdirSync(p, { recursive: true })
  }
}

const sub = (x, dir) => JSON.parse(JSON.stringify(x).split('<ROOT>').join(JSON.stringify(dir).slice(1, -1)))
const mask = (x, dir) => (x === undefined ? null : JSON.parse(JSON.stringify(x).split(JSON.stringify(dir).slice(1, -1)).join('<ROOT>')))

const cases = []
for (const s of scenarios) {
  const dir = join(root, s.name)
  build(dir, s.files)
  if (s.path === null) delete process.env.PATH
  else process.env.PATH = s.path.map((p) => (p === '' ? '' : join(dir, p))).join(';')
  Object.defineProperty(process.versions, 'node', { value: s.node, configurable: true, writable: true })
  globalThis.__precheck = { statfs: s.statfs, freePort: s.freePort, statfsCalls: [], freePortCalls: [] }

  const entry = sub(s.entry, dir)
  const c = { ...s, resolvedCwd: mask(resolveCwd(entry), dir) }
  try {
    c.result = mask(await svc.run(entry, sub(s.snapshot, dir), sub(s.all, dir)), dir)
  } catch (err) {
    c.error = err.message
  }
  c.freePortCalls = globalThis.__precheck.freePortCalls
  c.statfsCalls = mask(globalThis.__precheck.statfsCalls, dir)
  cases.push(c)
}

// resolveCwd 的纯函数输入（不建目录）
const P = 'C:' + B + 'proj'
const cwdInputs = [
  { path: P }, { path: P, cwd: '' }, { path: P, cwd: 'a/b' }, { path: P, cwd: 'a' + B + 'b' + B }, { path: P, cwd: '../x' },
  { path: P, cwd: 'D:' + B + 'x' }, { path: P, cwd: 'D:x' }, { path: P, cwd: '/x' }, { path: P, cwd: B + B + 'srv' + B + 'share' },
  { path: P, cwd: 'D:' }, { path: P, cwd: './' }, { path: P, cwd: '.' }, { path: 'C:/proj/', cwd: 'sub' }, { path: '', cwd: 'sub' },
  { path: '', cwd: '' }, { path: P, cwd: 'C:/' }, { path: P, cwd: '中文/目录' },
]
const resolveCases = cwdInputs.map((i) => ({ ...i, result: resolveCwd(i) }))

rmSync(root, { recursive: true, force: true })
const payload = { node: process.version, cases, resolveCwd: resolveCases }
const json = JSON.stringify(payload, null, 1).replace(/[^\x00-\x7e]/g, (ch) => B + 'u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, json + '\n', 'utf8')
console.log(`wrote ${out}: ${cases.length} cases (${cases.filter((c) => c.error).length} errors), ${resolveCases.length} resolveCwd`)
