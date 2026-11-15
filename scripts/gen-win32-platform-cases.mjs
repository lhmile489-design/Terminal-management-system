// S08 对拍用例生成（平台函数类）：跑原版 win32/index.ts、terminal.ts、powershell.ts，
// child_process 与 fs 换成桩（不起进程、不看真实磁盘），环境变量与当前目录由这里指定。
// 每个场景重新 import 一份原版模块（?v=N），因为原版有模块级缓存（cachedShell、psPath）且
// SHELL_CANDIDATES / PS_CANDIDATES 在模块加载时读 SystemRoot。
//
// 用法（在 mygo/console 下）：node scripts/gen-win32-platform-cases.mjs
// 输出里所有非 ASCII 字符都写成 \uXXXX（按 UTF-16 码元），文件是纯 ASCII。

import './platform-hooks.mjs'
import { ORIGINAL_WIN32 } from './platform-hooks.mjs'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '../internal/platform/win32/testdata/win32_platform_cases.json')
const base = pathToFileURL(ORIGINAL_WIN32).href + '/'
const cp = (n) => String.fromCodePoint(n)

const ENV_KEYS = ['SystemRoot', 'ComSpec', 'LOCALAPPDATA', 'MILE_HBUILDERX_CLI', '=C:', '=D:']
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
const realCwd = process.cwd

let version = 0
// 场景：env 里值为 null 的键表示 undefined（删掉），exists / lstat 是桩认得的路径
async function scenario({ env = {}, cwd = 'C:\\Work\\proj', exists = [], lstat = [] }) {
  for (const k of ENV_KEYS) delete process.env[k]
  for (const [k, v] of Object.entries(env)) if (v !== null) process.env[k] = v
  process.cwd = () => cwd
  globalThis.__fs = { exists: new Set(exists), lstat: new Set(lstat) }
  globalThis.__calls = []
  globalThis.__reply = () => ({ err: null, stdout: '', stderr: '' })
  version++
  const idx = await import(`${base}index.ts?v=${version}`)
  const ps = await import(`${base}powershell.ts?v=${version}`)
  const term = await import(`${base}terminal.ts?v=${version}`)
  return { w: idx.win32, ps, term }
}

const FULL = { SystemRoot: 'C:\\WINDOWS', ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }
const envs = [
  FULL,
  {},
  { SystemRoot: 'D:\\Win', ComSpec: '', LOCALAPPDATA: '' },
  { ...FULL, MILE_HBUILDERX_CLI: 'E:\\fixture\\cli.exe' },
  { ...FULL, MILE_HBUILDERX_CLI: '' },
  { ...FULL, LOCALAPPDATA: 'C:/Users/u/AppData/Local/' },
  { ...FULL, LOCALAPPDATA: 'relative\\local' },
]

const cases = { pathKey: [], env: [], shell: [], isPowerShell: [], terminal: [], runPowerShell: [], killTree: [] }

// ---- pathKey：resolve + 去尾分隔符 + toLowerCase ----
{
  const paths = [
    'C:\\A\\b\\..\\C\\', 'c:/x/y/', 'C:\\', 'C:', 'C:foo', 'D:foo\\bar', 'D:', 'E:rel', '\\', '/', '\\\\server\\share',
    '\\\\server\\share\\dir\\', '//server/share/x', '\\\\server', '\\\\?\\C:\\x', '\\\\.\\pipe\\x', 'rel\\a', '.', '..',
    '..\\..\\..\\..', '', 'a/./b//c///', 'C:\\a\\..\\..\\..', 'C:\\' + cp(0x130) + 'x', 'C:\\' + cp(0x3a3) + 'A' + cp(0x3a3),
    'C:\\Stra' + cp(0xdf) + 'e', 'C:\\' + cp(0x4e2d) + cp(0x6587) + '\\' + cp(0x1f600), 'C:\\K' + cp(0x212a), 'C:\\x.', 'C:\\x\\.\\',
    'C:\\a\\...\\b', 'C:\\a\\..b\\c', 'Z:\\', 'c:\\', '1:\\x', 'C:\\a:b', 'CON', 'C:\\CON\\x',
  ]
  const ctx = [
    { cwd: 'C:\\Work\\proj', env: { '=D:': 'D:\\dcwd' } },
    { cwd: 'C:\\Work\\proj', env: {} },
    { cwd: 'C:\\Work\\proj', env: { '=D:': 'E:\\other' } },
    { cwd: 'D:\\', env: { '=C:': 'C:' } },
    { cwd: '\\\\srv\\sh\\w', env: {} },
  ]
  for (const c of ctx) {
    const { w } = await scenario({ env: c.env, cwd: c.cwd })
    for (const p of paths) cases.pathKey.push({ cwd: c.cwd, env: c.env, p, key: w.pathKey(p) })
  }
}

// ---- 与环境有关的常量与列表 ----
for (const env of envs) {
  const { w } = await scenario({ env })
  globalThis.__calls = []
  const wrapped = w.wrapBatch('C:\\p\\npm.cmd', ['run', 'dev', 'a b', '&|'])
  cases.env.push({
    env,
    wrapBatch: wrapped,
    hbuilderx: w.hbuilderxCandidates(),
  })
}

// ---- defaultShell / shellArgs / shellInit（缓存：第二次调用不受 exists 变化影响）----
{
  const shellScenarios = [
    { env: FULL, exists: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'] },
    { env: FULL, exists: ['C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'] },
    { env: FULL, exists: [] },
    { env: {}, exists: ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'] },
    { env: {}, exists: [] },
    { env: { ComSpec: '' }, exists: [] },
    { env: { SystemRoot: 'D:\\Win' }, exists: ['D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'] },
  ]
  for (const s of shellScenarios) {
    const { w } = await scenario(s)
    const first = w.defaultShell()
    globalThis.__fs = { exists: new Set(), lstat: new Set() }
    const second = w.defaultShell()
    cases.shell.push({ ...s, first, second, args: w.shellArgs(first.file), init: w.shellInit(first.file) })
  }
}

// ---- isPowerShell（经 shellArgs / shellInit 观察）----
{
  const { w } = await scenario({ env: FULL })
  const files = [
    'powershell.exe', 'PWSH.EXE', 'C:\\x\\PowerShell.Exe', 'pwsh.exe.bak', 'xpwsh.exe', 'pwsh', 'cmd.exe', '',
    'powershell.exe ', 'pwsh' + cp(0x17f) + '.exe', 'C:\\pwsh.exe\\cmd.exe', 'powers' + cp(0x17f) + 'ell.exe', 'POWERSHELL.EXE',
    'pwsh.ex' + cp(0x212a), 'a\npwsh.exe', 'pwsh.exe\n',
  ]
  for (const f of files) cases.isPowerShell.push({ file: f, args: w.shellArgs(f), init: w.shellInit(f) })
}

// ---- openExternalTerminal：只量 spawn 的 argv 与 cwd，不起进程 ----
{
  const L = FULL.LOCALAPPDATA
  const all = [
    L + '\\Microsoft\\WindowsApps\\wt.exe', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', L + '\\Microsoft\\WindowsApps\\pwsh.exe',
    'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'C:\\WINDOWS\\system32\\cmd.exe',
    'C:\\Program Files\\Git\\git-bash.exe', 'C:\\Program Files (x86)\\Git\\git-bash.exe', L + '\\Programs\\Git\\git-bash.exe',
    'C:\\Windows\\System32\\cmd.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  ]
  const termScenarios = [
    { env: FULL, lstat: all },
    // wt 只在 lstat 里认得（应用执行别名），exists 认不出：原版用 lstat，必须找得到
    { env: FULL, lstat: [L + '\\Microsoft\\WindowsApps\\wt.exe'], exists: [] },
    { env: FULL, lstat: [], exists: all },
    { env: FULL, lstat: [L + '\\Microsoft\\WindowsApps\\pwsh.exe', 'C:\\Program Files (x86)\\Git\\git-bash.exe', L + '\\Programs\\Git\\git-bash.exe'] },
    { env: {}, lstat: all },
    { env: { ComSpec: '' }, lstat: all },
    { env: { ...FULL, LOCALAPPDATA: '' }, lstat: all },
  ]
  const kinds = ['wt', 'pwsh', 'powershell', 'cmd', 'gitbash', 'terminal', 'iterm', 'bogus', '']
  const cwds = [
    'E:\\proj\\a & b; c | d', 'E:\\proj', 'e:/proj/', '\\\\server\\share\\proj', '//server/share/proj', '\\\\?\\C:\\x',
    '\\\\.\\C:\\x', 'rel\\dir', '\\rooted', 'C:\\' + cp(0x4e2d) + cp(0x6587),
  ]
  for (const s of termScenarios) {
    for (const kind of kinds) {
      for (const cwd of cwds) {
        const { term } = await scenario(s)
        let error = null
        try {
          term.openExternalTerminal(kind, cwd)
        } catch (e) {
          error = e.message
        }
        const spawns = globalThis.__calls.filter((c) => c.fn === 'spawn')
          .map((c) => ({ file: c.file, args: c.args, cwd: c.opts.cwd, windowsHide: c.opts.windowsHide, stdio: c.opts.stdio }))
        cases.terminal.push({ ...s, kind, cwd, error, spawns })
      }
    }
  }
}

// ---- runPowerShell：可执行文件选择、argv、超时、maxBuffer、错误文案 ----
{
  const scripts = ['Write-Output 1', '', 'a"b\'c\r\n$x = `1`', cp(0x4e2d) + cp(0x6587) + cp(0x1f600), cp(0xfeff) + 'x']
  const replies = [
    { err: null, stdout: 'ok\r\n', stderr: '' },
    { err: { message: 'Command failed: x' }, stdout: '', stderr: '  boom\r\n  ' },
    { err: { message: 'Command failed: y' }, stdout: '', stderr: '  \r\n ' },
    { err: { message: 'spawn ENOENT' }, stdout: '', stderr: '' },
  ]
  const psScenarios = [
    { env: FULL, exists: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe'] },
    { env: FULL, exists: ['C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'] },
    { env: FULL, exists: [] },
    { env: {}, exists: ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'] },
  ]
  for (const s of psScenarios) {
    for (const script of scripts) {
      for (const reply of replies) {
        const { ps } = await scenario(s)
        globalThis.__reply = () => ({ err: reply.err && new Error(reply.err.message), stdout: reply.stdout, stderr: reply.stderr })
        let result = null
        let error = null
        try {
          result = await ps.runPowerShell(script)
        } catch (e) {
          error = e.message
        }
        const c = globalThis.__calls[0]
        cases.runPowerShell.push({
          ...s, script, reply, result, error,
          call: { file: c.file, args: c.args, timeout: c.opts.timeout, maxBuffer: c.opts.maxBuffer, windowsHide: c.opts.windowsHide, encoding: c.opts.encoding },
        })
      }
    }
  }
  // readProcessMeta 用 15000，readListenPorts 用 4000 / 16MB
  const { w } = await scenario({ env: FULL, exists: [] })
  globalThis.__reply = () => ({ err: null, stdout: '{"procs":[],"mine":[]}', stderr: '' })
  await w.readProcessMeta()
  await w.readListenPorts()
  cases.collect = globalThis.__calls.map((c) => ({ file: c.file, args: c.args[0] === '-NoProfile' ? c.args.slice(0, 5) : c.args, timeout: c.opts.timeout, maxBuffer: c.opts.maxBuffer }))
}

// ---- killTree ----
for (const pid of [1234, 0, 4, 2147483647]) {
  const { w } = await scenario({ env: FULL })
  await w.killTree(pid)
  const c = globalThis.__calls[0]
  cases.killTree.push({ pid, file: c.file, args: c.args, timeout: c.opts.timeout, windowsHide: c.opts.windowsHide })
}

// ---- 常量与表 ----
{
  const { w } = await scenario({ env: FULL })
  const proc = await import(`${base}process.ts?v=${version}`)
  const term = await import(`${base}terminal.ts?v=${version}`)
  const a = w.attribution
  cases.constants = {
    id: w.id,
    binaries: w.binaries,
    wrapperFile: w.wrapperFile,
    unsupportedLaunchModes: [...w.unsupportedLaunchModes],
    requiresExecBit: w.requiresExecBit,
    terminalKinds: w.terminalKinds,
    defaultTerminal: w.defaultTerminal,
    globalHotkey: w.globalHotkey,
    externalTerminalTitle: term.EXTERNAL_TERMINAL_TITLE,
    metaScript: proc.META_SCRIPT,
    attribution: {
      transparent: [...a.transparent], sourceByName: a.sourceByName, sourceByCmd: a.sourceByCmd,
      devRuntime: [...a.devRuntime], systemDirs: a.systemDirs,
    },
  }
}

for (const k of ENV_KEYS) {
  if (saved[k] === undefined) delete process.env[k]
  else process.env[k] = saved[k]
}
process.cwd = realCwd

const json = JSON.stringify({ generatedFrom: 'mile-terminal-management/src/main/platform/win32/*.ts + node ' + process.version, ...cases })
  .replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, json + '\n', 'utf8')
const n = Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, Array.isArray(v) ? v.length : 1]))
console.log(`wrote ${out}: ${JSON.stringify(n)}`)
// 确认没碰原版目录：只读过、没写过（这里不做写入，打印一行源文件大小作为读取证据）
console.log('original index.ts bytes', readFileSync(resolve(ORIGINAL_WIN32, 'index.ts')).length)
