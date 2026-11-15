// S21b 对拍用例生成：跑原版 src/main/services/EntryService.ts 的命令构造，期望值全部来自原版。
//
// 场景见 command-scenarios.mjs。夹具目录与 PATH 都由本脚本建好；Go 测试建同样结构的目录，
// 把 <FIX> 换成自己的临时路径。setTimeout 换成不触发的桩（spawnSession 会给 dev 会话
// 排一个 60 秒的端口捕获计时器，不需要它真的跑）。
//
// 用法（在 mygo/console 下）：node --experimental-transform-types scripts/gen-command-cases.mjs
// 输出纯 ASCII（非 ASCII 写成 \uXXXX）。

import './platform-hooks.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SCENARIOS, FIX } from './command-scenarios.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '../internal/entries/testdata/command_cases.json')
const ORIGINAL = resolve(here, '../../../mile-terminal-management/src/main/services/EntryService.ts')
const PRECHECK = resolve(here, '../../../mile-terminal-management/src/main/services/PrecheckService.ts')

const root = join(tmpdir(), 'mile-command-fixture')
const mk = (rel, body = '') => {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, body, 'utf8')
}

// PATH 只留夹具 bin：whichAny 只可能命中这些假可执行文件
const BINS = ['npm.cmd', 'pnpm.cmd', 'yarn.cmd', 'bun.exe', 'java.exe', 'mvn.cmd', 'gradle.bat', 'python.exe', 'go.exe', 'cargo.exe']
for (const b of BINS) mk(join('bin', b), '')
mkdirSync(join(root, 'proj', 'target'), { recursive: true })
mkdirSync(join(root, 'proj', 'bin'), { recursive: true })
mkdirSync(join(root, 'proj', 'cmd'), { recursive: true })
mkdirSync(join(root, 'proj2'), { recursive: true })
mkdirSync(join(root, 'outside'), { recursive: true })
mk(join('proj', 'package.json'), JSON.stringify({ name: 'p', scripts: { dev: 'next dev', build: 'next build' } }))
mk(join('proj', 'manage.py'), '')
mk(join('proj', 'mvnw.cmd'), '')
mk(join('proj', 'gradlew.bat'), '')
mk(join('proj', 'main.py'), '')
mk(join('proj', 'target', 'app.jar'), '')
mk(join('proj', 'bin', 'app.exe'), '')
mk(join('proj', 'cmd', 'package.json'), JSON.stringify({ name: 'sub', scripts: { dev: 'next dev' } }))
mk(join('proj2', 'package.json'), JSON.stringify({ name: 'q', scripts: {} }))

process.env.PATH = join(root, 'bin')
globalThis.__appData = join(root, 'appdata')
mkdirSync(globalThis.__appData, { recursive: true })

const realNow = Date.now
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r))
}

const swapIn = (v) => JSON.parse(JSON.stringify(v).split(FIX).join(JSON.stringify(root).slice(1, -1)))

let version = 0
async function run(sc) {
  Date.now = () => 1_700_000_000_000
  globalThis.setTimeout = () => 0
  globalThis.clearTimeout = () => {}

  const mod = await import(pathToFileURL(ORIGINAL).href + '?v=' + ++version)
  const { EntryService } = mod
  const { resolveCwd } = await import(pathToFileURL(PRECHECK).href + '?v=' + version)

  const calls = []
  const state = { version: 16, entries: [], groups: [], settings: {}, updatedAt: 0 }
  const config = { get: () => state, patch: (p) => (Object.assign(state, p), calls.push(['config.patch', JSON.parse(JSON.stringify(p))]), state) }
  const sessions = {
    on: () => {},
    kill: () => {},
    create: (input) => {
      calls.push(['sessions.create', JSON.parse(JSON.stringify(input))])
      return { id: 'sess-1', pid: 4000, startedAt: 1_700_000_000_000 }
    }
  }
  const svc = new EntryService(config, {}, sessions, {}, {})
  const events = []
  svc.on('changed', (list) => events.push(list))

  const steps = []
  for (const st of sc.steps) {
    const step = { ...st }
    const callsBefore = calls.length
    const eventsBefore = events.length
    try {
      const entry = swapIn(st.entry)
      // update() 要能在 config 里找到这条，才和 Go 侧一致地落到 config.patch
      state.entries = [JSON.parse(JSON.stringify(entry))]
      if (st.op === 'build') {
        const cmd = await svc.buildCommand(entry, resolveCwd(entry), st.script ?? null)
        step.result = JSON.parse(JSON.stringify(cmd))
      } else if (st.op === 'spawn') {
        const rt = await svc.spawnSession(entry, st.script ?? null, st.kind)
        step.result = JSON.parse(JSON.stringify(rt))
      } else {
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
  return { name: sc.name, steps }
}

const cases = []
for (const sc of SCENARIOS) cases.push(await run(sc))

globalThis.setTimeout = realSetTimeout
globalThis.clearTimeout = realClearTimeout

let json = JSON.stringify({ generatedFrom: 'mile-terminal-management/src/main/services/EntryService.ts + node ' + process.version, cases }, null, 1)
json = json.split(JSON.stringify(root).slice(1, -1)).join(FIX)
json = json.replace(/[^\x00-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, json + '\n', 'utf8')
console.log(`wrote ${out}`)
console.log(`  scenarios ${cases.length}, steps ${cases.reduce((a, c) => a + c.steps.length, 0)}`)
console.log(`  errors ${cases.reduce((a, c) => a + c.steps.filter((s) => s.error).length, 0)}`)
