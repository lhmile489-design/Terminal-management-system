// S13 对拍用例生成：用 node 直接跑原版 src/main/lib/attribution.ts（经 platform-hooks 解析 ../platform 与 @shared），
// 把合成进程表、入参与原版输出写成 JSON，internal/scanner/attribution_test.go 读同一份文件比对。期望值全部来自原版函数。
//
// 用法（在 mygo/console 下）：node scripts/gen-attribution-cases.mjs
// 输出里所有非 ASCII 字符都写成 \uXXXX（按 UTF-16 码元），文件是纯 ASCII。

import './platform-hooks.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '../internal/scanner/testdata/attribution_cases.json')
const src = resolve(here, '../../../mile-terminal-management/src/main/lib/attribution.ts')
const { traceLaunchSource, classifyGroup } = await import(pathToFileURL(src).href)

const cp = (n) => String.fromCodePoint(n)
const row = (pid, ppid, name, extra = {}) => ({ pid, ppid, name, ...extra })

// ---- traceLaunchSource：手写场景 ----
const named = []
const trace = (label, rows, pid, owned = false) => named.push({ label, rows, pid, owned })

trace('owned 直接判 mile', [row(100, 50, 'node.exe'), row(50, 10, 'code.exe')], 100, true)
trace('owned 且不在表里', [], 999, true)
trace('npm 链跳过中间层到 VS Code', [
  row(500, 400, 'node.exe'), row(400, 300, 'npm.cmd'), row(300, 200, 'cmd.exe'), row(200, 100, 'Code.exe'), row(100, 8, 'explorer.exe'),
], 500)
trace('起点自身是 code.exe 不算', [row(200, 100, 'code.exe'), row(100, 8, 'explorer.exe')], 200)
trace('起点自身是 code.exe 且父不在表里', [row(200, 100, 'code.exe')], 200)
trace('起点不在表里', [row(1, 0, 'x')], 12345)
trace('父进程已退出', [row(500, 400, 'node.exe'), row(400, 300, 'cmd.exe')], 500)
trace('ppid 为 4 到顶', [row(500, 4, 'node.exe')], 500)
trace('ppid 为 5 继续', [row(500, 5, 'node.exe'), row(5, 1, 'services.exe')], 500)
trace('ppid 为 0', [row(500, 0, 'node.exe')], 500)
trace('ppid 为负', [row(500, -1, 'node.exe')], 500)
trace('自指', [row(500, 500, 'node.exe')], 500)
trace('自指的父是来源', [row(500, 400, 'node.exe'), row(400, 400, 'cursor.exe')], 500)
trace('两点成环', [row(500, 400, 'node.exe'), row(400, 500, 'cmd.exe')], 500)
trace('三点成环含来源', [row(10, 20, 'node.exe'), row(20, 30, 'cmd.exe'), row(30, 10, 'wt.exe')], 10)
trace('中间层 node 的命令行含 claude-code 被跳过', [
  row(500, 400, 'node.exe'), row(400, 300, 'node.exe', { commandLine: 'node C:\\npm\\claude-code\\cli.js' }), row(300, 8, 'WindowsTerminal.exe'),
], 500)
trace('非中间层按命令行认出 claude', [row(500, 400, 'node.exe'), row(400, 8, 'helper.exe', { commandLine: 'helper --from ANTHROPIC' })], 500)
trace('命令行含 .vscode 路径', [row(500, 400, 'node.exe'), row(400, 8, 'tsserver.exe', { commandLine: 'C:\\Users\\a\\.vscode\\ext\\tsserver.exe' })], 500)
trace('命令行含 .vscode-server', [row(500, 400, 'node.exe'), row(400, 8, 'srv.exe', { commandLine: 'x\\.VSCODE-SERVER\\y' })], 500)
trace('命令行含 .cursor', [row(500, 400, 'node.exe'), row(400, 8, 'x.exe', { commandLine: 'C:\\.cursor\\x.exe' })], 500)
trace('命令行含 codex-cli', [row(500, 400, 'node.exe'), row(400, 8, 'x.exe', { commandLine: 'codex-cli run' })], 500)
trace('命令行为空串', [row(500, 400, 'node.exe'), row(400, 8, 'x.exe', { commandLine: '' })], 500)
trace('名字优先于命令行', [row(500, 400, 'node.exe'), row(400, 8, 'cursor.exe', { commandLine: 'claude-code' })], 500)
trace('命令行规则顺序 claude 先于 vscode', [row(500, 400, 'node.exe'), row(400, 8, 'x.exe', { commandLine: '\\.vscode\\ claude-code' })], 500)
trace('名字大写', [row(500, 400, 'node.exe'), row(400, 8, 'WEBSTORM64.EXE')], 500)
trace('中间层名字大写也跳过', [row(500, 400, 'node.exe'), row(400, 300, 'CMD.EXE'), row(300, 8, 'idea64.exe')], 500)
trace('带空格的进程名', [row(500, 400, 'node.exe'), row(400, 8, 'Code - Insiders.exe')], 500)
trace('U+0130 开头不认', [row(500, 400, 'node.exe'), row(400, 8, cp(0x130) + 'dea64.exe')], 500)
// U+0130 小写成 i + U+0307，夹在 i 后面的字母前就断开了子串；strings.ToLower 给单个 i 会认出来
trace('U+0130 在命令行不认', [row(500, 400, 'node.exe'), row(400, 8, 'x.exe', { commandLine: 'anthrop' + cp(0x130) + 'c' })], 500)
trace('长 s 不折成 s', [row(500, 400, 'node.exe'), row(400, 8, cp(0x17f) + 'vchost.exe')], 500)
// pid 4（System）在表里时也不再往上看：ppid <= 4 是到顶，不是「父不在表里」
trace('ppid 为 4 且 4 在表里', [row(500, 4, 'node.exe'), row(4, 0, 'svchost.exe')], 500)
trace('ppid 为 3 且 3 在表里', [row(500, 3, 'node.exe'), row(3, 0, 'services.exe')], 500)
trace('ppid 为 5 且 5 在表里', [row(500, 5, 'node.exe'), row(5, 0, 'services.exe')], 500)
trace('终端是来源', [row(500, 400, 'pwsh.exe'), row(400, 8, 'mintty.exe')], 500)
trace('服务是来源', [row(500, 400, 'node.exe'), row(400, 8, 'svchost.exe')], 500)
trace('未知进程不是来源继续上溯', [row(500, 400, 'node.exe'), row(400, 300, 'foo.exe'), row(300, 8, 'explorer.exe')], 500)

// 深度边界：来源放在第 k 层（起点为第 0 层），中间全是未知进程
for (const k of [1, 10, 11, 12, 13, 14]) {
  const rows = []
  for (let i = 0; i < k; i++) rows.push(row(1000 + i, 1000 + i + 1, i === 0 ? 'node.exe' : 'foo.exe'))
  rows.push(row(1000 + k, 8, 'code.exe'))
  trace(`来源在第 ${k} 层`, rows, 1000)
}
// 长链没有来源，最后一层的父不在表里
{
  const rows = []
  for (let i = 0; i < 20; i++) rows.push(row(2000 + i, 2000 + i + 1, 'cmd.exe'))
  trace('20 层中间层', rows, 2000)
}

// ---- traceLaunchSource：确定性伪随机表 ----
let seed = 0x5eed1234
const rand = () => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
  return seed / 0x100000000
}
const pick = (xs) => xs[Math.floor(rand() * xs.length)]
const names = [
  'node.exe', 'cmd.exe', 'npm.cmd', 'pnpm.exe', 'bun.exe', 'powershell.exe', 'conhost.exe', 'python.exe',
  'Code.exe', 'cursor.exe', 'idea64.exe', 'claude.exe', 'codex.exe', 'wt.exe', 'explorer.exe', 'svchost.exe',
  'foo.exe', 'java.exe', 'vite.exe', 'NODE.EXE', 'Cursor.EXE', '', ' code.exe', 'code.exe ', cp(0x3a3) + '.exe',
]
const cmds = [undefined, undefined, undefined, '', 'claude-code', 'C:\\x\\.vscode\\a', 'codex-cli', 'C:\\.cursor\\', 'plain', 'ANTHROPIC']
const randomCases = []
for (let n = 0; n < 600; n++) {
  const size = 1 + Math.floor(rand() * 16)
  const pids = Array.from({ length: size }, (_, i) => 100 + i * 7)
  const rows = pids.map((pid, i) => {
    const r = rand()
    let ppid
    if (r < 0.65) ppid = pids[i + 1] ?? pick([0, 4, 5, 9999])
    else if (r < 0.75) ppid = pick(pids) // 可能成环或自指
    else if (r < 0.85) ppid = pick([0, 1, 4, 5])
    else ppid = 50000 + i // 父不在表里
    const extra = {}
    const c = pick(cmds)
    if (c !== undefined) extra.commandLine = c
    return row(pid, ppid, pick(names), extra)
  })
  randomCases.push({ rows, pid: rand() < 0.95 ? pids[0] : 77777, owned: rand() < 0.05 })
}

// ---- classifyGroup ----
const groupRows = [
  undefined,
  row(1, 0, 'node.exe'),
  row(1, 0, 'NODE.EXE'),
  row(1, 0, 'node.exe', { execPath: 'C:\\Windows\\System32\\node.exe' }),
  row(1, 0, 'node.exe', { execPath: 'C:\\Program Files\\WindowsApps\\x\\node.exe' }),
  row(1, 0, 'python.exe', { execPath: 'C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe' }),
  row(1, 0, 'node.exe', { execPath: 'D:\\tools\\node.exe' }),
  row(1, 0, 'node.exe', { execPath: '' }),
  row(1, 0, 'svchost.exe', { execPath: 'C:\\WINDOWS\\system32\\svchost.exe' }),
  row(1, 0, 'svchost.exe'),
  row(1, 0, 'foo.exe', { execPath: 'D:\\foo.exe' }),
  row(1, 0, 'java.exe', { execPath: 'C:\\windowsx\\java.exe' }),
  row(1, 0, 'mysqld.exe', { execPath: 'C:\\Program Files\\MySQL\\mysqld.exe' }),
  row(1, 0, 'hugo.exe'),
  row(1, 0, cp(0x130) + 'node.exe'),
  row(1, 0, 'node.exe', { execPath: cp(0x130) + 'C:\\Windows\\node.exe' }),
  row(1, 0, 'node.exe', { execPath: 'C:/Windows/node.exe' }),
]
const ownerships = ['owned', 'external', 'foreign', '']
const entryIds = [undefined, '', 'e1']
const groups = []
for (const r of groupRows) {
  for (const o of ownerships) {
    for (const e of entryIds) {
      groups.push({ row: r ?? null, ownership: o, entryId: e ?? null, result: classifyGroup(r, o, e) })
    }
  }
}

const runTrace = (c) => {
  const byPid = new Map(c.rows.map((r) => [r.pid, r]))
  return { ...c, result: traceLaunchSource(c.pid, byPid, c.owned) }
}
const data = {
  maxAscent: 12,
  named: named.map(runTrace),
  random: randomCases.map(runTrace),
  groups,
}

const nonAscii = new RegExp('[' + String.fromCharCode(0x7f) + '-' + String.fromCharCode(0xffff) + ']', 'g')
const json = JSON.stringify(data, null, 1).replace(nonAscii, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, json + '\n')

const tally = (xs) => xs.reduce((m, c) => ((m[c.result] = (m[c.result] ?? 0) + 1), m), {})
console.log('named', named.length, tally(data.named))
console.log('random', randomCases.length, tally(data.random))
console.log('groups', groups.length, tally(groups))
