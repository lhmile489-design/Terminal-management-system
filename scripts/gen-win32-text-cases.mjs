// S08 对拍用例生成（文本与解析类）：期望值全部来自原版代码或 node 内置函数，不手写。
//   - netstat：原版 parseNetstat；含一份本机真实 netstat -ano 的原始字节（GBK 表头），走 Buffer 解码
//   - meta：原版 readProcessMeta（child_process 换成桩，stdout 由这里指定）
//   - decode：Buffer.toString('utf8')；number：Number()；lower：toLowerCase 全表；space：/\s/ 全表
//
// 用法（在 mygo/console 下）：node scripts/gen-win32-text-cases.mjs
// 输出里所有非 ASCII 字符都写成 \uXXXX（按 UTF-16 码元），文件是纯 ASCII。

import './platform-hooks.mjs'
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ORIGINAL_WIN32 } from './platform-hooks.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '../internal/platform/win32/testdata/win32_text_cases.json')
const proc = await import(pathToFileURL(resolve(ORIGINAL_WIN32, 'process.ts')).href)

const cp = (n) => String.fromCodePoint(n)

// ---- netstat ----
const L = (local, pid, state = 'LISTENING') => `  TCP    ${local}    0.0.0.0:0    ${state}    ${pid}`
const netstatInputs = [
  // 同端口两个 PID：0.0.0.0:P 与 [::]:P 分属两个进程，不得合并
  [L('0.0.0.0:3000', 100), L('[::]:3000', 200)].join('\r\n'),
  // 同 PID 双栈：合并成一行，families [4, 6]
  [L('0.0.0.0:5173', 300), L('[::]:5173', 300), L('127.0.0.1:5173', 300)].join('\r\n'),
  [L('[::1]:5174', 400), L('0.0.0.0:5174', 400)].join('\n'),
  // PID 门槛：<= 4 丢弃
  [L('0.0.0.0:445', 4), L('0.0.0.0:446', 5), L('0.0.0.0:447', 0)].join('\r\n'),
  // 端口门槛与 Number 语义
  ['0.0.0.0:0', '0.0.0.0:', '0.0.0.0:0x1F', '0.0.0.0:1e3', '0.0.0.0:3000.5', '0.0.0.0:+80', '0.0.0.0:-1', 'noport', '0.0.0.0:Infinity', '0.0.0.0:0b11', '0.0.0.0:0o17', '0.0.0.0:1_000', '0.0.0.0:.5e1', '0.0.0.0:5.']
    .map((a, i) => L(a, 1000 + i)).join('\r\n'),
  // PID 的 Number 语义
  ['0x10', '1e2', '12.0', '12.5', '', 'abc', '9007199254740993', '99999999999999999999', 'Infinity']
    .map((p) => `  TCP 0.0.0.0:8080 0.0.0.0:0 LISTENING ${p}`).join('\n'),
  // LISTENING 大小写与子串、非 ASCII 折叠
  ['  TCP 0.0.0.0:81 0.0.0.0:0 listening 501', '  TCP 0.0.0.0:82 0.0.0.0:0 XLISTENINGX 502',
    '  TCP 0.0.0.0:83 0.0.0.0:0 LI' + cp(0x17f) + 'TENING 503', '  TCP 0.0.0.0:84 0.0.0.0:0 ESTABLISHED 504',
    '  TCP 0.0.0.0:85 LISTENING 505', 'LISTENING', '  UDP 0.0.0.0:86 *:* 506'].join('\r\n'),
  // 分隔符：tab、NBSP、U+3000、U+FEFF 是 JS 空白；U+0085 不是
  ['TCP\t0.0.0.0:91\t0.0.0.0:0\tLISTENING\t601', 'TCP' + cp(0xa0) + '0.0.0.0:92 x LISTENING 602',
    cp(0x3000) + 'TCP 0.0.0.0:93 x LISTENING' + cp(0x3000) + '603', cp(0xfeff) + ' TCP 0.0.0.0:94 x LISTENING 604',
    'TCP' + cp(0x85) + '0.0.0.0:95 x LISTENING 605', 'TCP 0.0.0.0:96 x LISTENING 606' + cp(0x85)].join('\n'),
  // 换行：只认 \n 与 \r\n，孤立 \r 不切
  L('0.0.0.0:97', 701) + '\r' + L('0.0.0.0:98', 702) + '\r\r\n' + L('0.0.0.0:99', 703),
  '',
  '\r\n\r\n',
]
const netstatBytes = []
try {
  netstatBytes.push(execFileSync('netstat.exe', ['-ano'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }))
} catch (e) {
  console.log('跳过真实 netstat：', e.message)
}
const netstat = [
  ...netstatInputs.map((input) => ({ input, rows: proc.parseNetstat(input) })),
  ...netstatBytes.map((buf) => ({ hex: buf.toString('hex'), rows: proc.parseNetstat(buf.toString('utf8')) })),
]

// ---- meta ----
const metaInputs = [
  '', '   \r\n', cp(0xfeff) + '\n',
  '{"procs":[{"pid":10,"ppid":1,"name":"a.exe","exe":"C:\\\\a.exe","cmd":"a --x","at":1700000000123},{"pid":11,"ppid":10,"name":"b.exe","exe":null,"cmd":null,"at":null}],"mine":[10,11]}',
  '{"procs":{"pid":12,"ppid":0,"name":"solo.exe"},"mine":12}',
  '{"procs":null,"mine":null}',
  '{}',
  '{"procs":[],"mine":[]}',
  cp(0xfeff) + ' {"procs":[{"pid":13,"ppid":1,"name":"' + cp(0x4e2d) + '.exe","cmd":"x ' + cp(0x1f600) + '"}],"mine":[13]} \r\n',
  '{"procs":[{"pid":14,"ppid":1,"name":"dup1"},{"pid":14,"ppid":2,"name":"dup2"}],"mine":[14,14]}',
  'null', '5', '"str"', '[]', 'true', '{bad json', '{"procs":[1]}',
]
const meta = []
for (const stdout of metaInputs) {
  globalThis.__reply = () => ({ err: null, stdout, stderr: '' })
  try {
    const m = await proc.readProcessMeta()
    const rows = [...m.byPid.values()].sort((a, b) => a.pid - b.pid)
    meta.push({ stdout, ok: true, rows, mine: [...m.mine].sort((a, b) => a - b) })
  } catch (e) {
    meta.push({ stdout, ok: false, error: e.message === '进程元数据采集无输出' ? e.message : '' })
  }
}

// ---- Buffer utf8 解码 ----
const hexes = [
  '', '41', 'c3a9', 'e4b8ad', 'f09f9880', 'd6d0cec4', 'ff', 'fe41', 'c0af', 'c1bf', 'e080af', 'e09f80',
  'eda080', 'edbfbf', 'ee8080', 'f08f8080', 'f4908080', 'f5808080', 'c3', 'e4b8', 'f09f98', 'e4b841', 'f09f9841',
  '80', '8080', 'bf41', 'c3c3a9', 'e4e4b8ad', 'f0f09f9880', 'f8888080', 'fc84808080', 'efbbbf41', '41d6d0cec442',
  'e4b8ade4b8', 'f4bfbfbf', 'f48fbfbf', 'e0a080', 'c280', 'dfbf', '00', '7f',
]
const decode = hexes.map((hex) => ({ hex, text: Buffer.from(hex, 'hex').toString('utf8') }))

// ---- Number() ----
const numInputs = [
  '', ' ', '0', '-0', '+0', '1', '01', '007', '1.', '.1', '.', '1.5', '1e3', '1E3', '1e+3', '1e-3', '1e', 'e3',
  '0x1F', '0X1f', '0x', '-0x1', '0b101', '0o17', '0o8', '0b2', '1_000', 'Infinity', '-Infinity', '+Infinity',
  'infinity', 'inf', 'NaN', 'nan', '1e309', '-1e309', '1e-400', '9007199254740993', '99999999999999999999999',
  ' 42 ', '\t42\n', cp(0xa0) + '42', cp(0xfeff) + '42', cp(0x85) + '42', cp(0x3000) + '42' + cp(0x2028),
  '4 2', '42abc', '0x1p3', '1.2.3', '+-1', '--1', '0x' + 'f'.repeat(20), cp(0xff11), '12' + cp(0x660),
]
const enc = (n) => (Number.isFinite(n) ? n : String(n))
const number = numInputs.map((s) => ({ s, n: enc(Number(s)), isInt: Number.isInteger(Number(s)) }))

// ---- toLowerCase 全表（只列与自身不同的码点）与 \s 全表 ----
const lower = []
const space = []
for (let c = 0; c <= 0x10ffff; c++) {
  if (c >= 0xd800 && c <= 0xdfff) continue
  const ch = cp(c)
  const lo = ch.toLowerCase()
  if (lo !== ch) lower.push([c, lo])
  if (/\s/.test(ch)) space.push(c)
}

// ---- Final_Sigma：对每个码点 c 量两条 ----
//   sigmaX：('A' + c + 'Σ').toLowerCase() 以 ς 结尾（= c 可忽略 或 c 有大小写）
//   sigmaY：('1' + c + 'Σ').toLowerCase() 以 ς 结尾（= c 有大小写且不可忽略）
// Go 侧用同样的输入跑 jsToLower 逐码点比，等价于把 Cased / Case_Ignorable 两个集合都对上
const SIGMA = cp(0x3a3)
const FINAL = cp(0x3c2)
const sigmaX = []
const sigmaY = []
for (let c = 0; c <= 0x10ffff; c++) {
  if ((c >= 0xd800 && c <= 0xdfff) || c === 0x3a3) continue
  const ch = cp(c)
  if (('A' + ch + SIGMA).toLowerCase().endsWith(FINAL)) sigmaX.push(c)
  if (('1' + ch + SIGMA).toLowerCase().endsWith(FINAL)) sigmaY.push(c)
}

const json = JSON.stringify({
  generatedFrom: 'mile-terminal-management/src/main/platform/win32/process.ts + node ' + process.version,
  netstat, meta, decode, number, lower, space, sigmaX, sigmaY,
})
  .replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, json + '\n', 'utf8')
console.log(`wrote ${out}: netstat ${netstat.length}（真实 ${netstatBytes.length}），meta ${meta.length}，decode ${decode.length}，number ${number.length}，lower ${lower.length}，space ${space.length}，sigmaX ${sigmaX.length}，sigmaY ${sigmaY.length}`)
