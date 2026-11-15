// S15 纯函数对拍：直接调原版 ScannerService.ts 文件末尾的模块私有函数（platform-hooks 追加了导出），
// 大批量输入覆盖 JS 字符串语义（trim 空白集、toLowerCase 特例、slice 按 UTF-16、正则 \b 与非贪婪）。
//
// 用法（在 mygo/console 下）：node --experimental-transform-types scripts/gen-scanner-fn-cases.mjs
// 输出纯 ASCII。孤立代理在 JSON 里写成 \udXXX，Go 解出来是 U+FFFD，测试侧按偏差处理。

import './platform-hooks.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '../internal/scanner/testdata/scanner_fn_cases.json')
const SRC = resolve(here, '../../../mile-terminal-management/src/main/services/ScannerService.ts')
const m = await import(pathToFileURL(SRC).href)

const cp = (...xs) => String.fromCodePoint(...xs)
const SPACES = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2005, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff, 0x85, 0x180e, 0x200b]

// guessCwd：手写边界 + 确定性伪随机拼接
const guess = [
  'node C:\\a.js', 'node C:\\ab\\c.js', 'node C:\\abc\\d.js', 'node C:/x/y/z.mjs', 'node c:\\r\\s\\main.ts.js',
  'node "C:\\p q\\node_modules\\.bin\\vite.cjs"', 'node C:\\node_modules\\x.js', 'node C:\\r\\NODE_MODULES\\x.ts',
  'node C:\\r\\Node_Modules/x.ts', 'node C:\\r\\node_modulesx\\a.js', 'node C:\\r\\x.json', 'node C:\\r\\x.jsx',
  'node C:\\r\\x.js.map', 'node C:\\r\\x.ts2', 'node C:\\r\\x.js_', 'node C:\\r\\x.js-1', 'node C:\\r\\x.js' + cp(0xe9),
  'node C:\\r\\x.js' + cp(0x4e2d), 'node ./rel/a.js', '', 'node /usr/x/a.js', 'node C:\\a|b\\c.js D:\\ok\\d.js',
  'node C:\\a"b\\c.js', "node C:\\a'b\\c.js", 'node C:\\a*b\\c.js', 'node C:\\a?b\\c.js', 'node C:\\a<b\\c.js',
  'node C:\\a\nb\\c.js', 'node C:\\a\rb\\c.js', 'node C:\\a b\\c d\\e.js', 'node 1:\\a\\b.js', 'node CC:\\a\\b.js',
  'x C:\\' + cp(0x4e2d, 0x6587) + '\\' + cp(0x1f600) + '\\a.js', 'x C:\\' + cp(0x1f600) + '\\a.js', 'x C:\\' + cp(0x1f600) + 'a.js',
  'x C:\\a\\node_modules\\b\\node_modules\\c.js', 'x C:\\.js', 'x C:\\\\.js', 'x C:/.ts', 'x C:\\a\\.mjs',
  'x C:' + cp(0x212a) + '\\a.js', 'x C:\\r\\NODE_MODULE' + cp(0x17f) + '\\a.js', 'x C:\\r\\node_' + cp(0x212a) + 'odules\\a.js',
  'x D:\\a.js C:\\b\\c.js', 'x C:\\a\\b.TS', 'x C:\\a\\b.Js', 'x C:\\w\\a.js' + cp(0x2028),
]
let seed = 7
const rnd = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n)
const PIECES = ['C:', 'c:', 'D:', '\\', '/', 'node_modules', 'NODE_MODULES', 'a', 'bb', ' ', '"', '.js', '.ts', '.mjs', '.cjs', '.json', 'x', '|', '\n', cp(0x4e2d), cp(0x1f600), '..', '.', '-']
for (let i = 0; i < 400; i++) {
  let s = 'node '
  for (let j = 0, k = 2 + rnd(10); j < k; j++) s += PIECES[rnd(PIECES.length)]
  guess.push(s)
}
// 偏向命中的随机：盘符开头 + 若干段 + 扩展名，中间随机插入 node_modules 与干扰字符
const SEG = ['a', 'Src', 'node_modules', 'NODE_MODULES', 'x y', cp(0x4e2d), cp(0x1f600), '.bin', '..', 'p-q', 'v1.2']
const EXT = ['.js', '.ts', '.mjs', '.cjs', '.json', '.jsx', '.js.map', '.TS']
const SEP = ['\\', '/']
for (let i = 0; i < 400; i++) {
  let s = ['node ', '"node" "', 'tsx '][rnd(3)] + ['C:', 'd:', 'Z:'][rnd(3)] + SEP[rnd(2)]
  for (let j = 0, k = rnd(5); j < k; j++) s += SEG[rnd(SEG.length)] + SEP[rnd(2)]
  s += ['index', 'main', 'vite'][rnd(3)] + EXT[rnd(EXT.length)]
  if (rnd(3) === 0) s += ['"', ' --port 3000', ' C:\\other\\b.js', '|x', '\n'][rnd(5)]
  guess.push(s)
}

// normalizeKeywords：每组一个数组
const norm = [
  [], [''], ['  '], ['A', 'a', ' A '], ['x'.repeat(70)], ['y'.repeat(64)],
  [cp(0x130)], ['I' + cp(0x130)], [cp(0x3a3) + 'A' + cp(0x3a3)], ['A' + cp(0x3a3)], [cp(0x1f600).repeat(40)],
  ['a'.repeat(63) + cp(0x1f600)], ['a'.repeat(63) + cp(0x130)], Array.from({ length: 25 }, (_, i) => 'k' + i),
  Array.from({ length: 25 }, (_, i) => 'k' + (i % 3)), ['', 'a', '', 'b'],
  ...SPACES.map((c) => [cp(c) + 'q' + cp(c)]),
  [cp(0xdf)], ['STRASSE'], [cp(0x1e9e)], [cp(0xfb00)], ['\u0049\u0307'],
]

// truncate
const trunc = [
  [null, 5], ['', 5], ['abc', 3], ['abcd', 3], ['ab' + cp(0x1f600), 3], ['ab' + cp(0x1f600), 4], ['a' + cp(0x1f600) + 'b', 2],
  ['x'.repeat(160), 160], ['x'.repeat(161), 160], [cp(0x1f600).repeat(81), 160], ['x' + cp(0x1f600).repeat(80), 160],
]

// countConflicts / matchEntry：小规模穷举
const L = (pid, ports, entryId) => ({ pid, ports, entryId })
const conflicts = [
  { exps: [], listeners: [L(1, [3000])] },
  { exps: [{ id: 'a', port: 3000, cwd: 'x' }], listeners: [] },
  { exps: [{ id: 'a', port: 3000, cwd: 'x' }], listeners: [L(1, [3000], 'a')] },
  { exps: [{ id: 'a', port: 3000, cwd: 'x' }], listeners: [L(1, [3000], 'a'), L(2, [3000])] },
  // 两个外来占用者：一个预期端口只算一次冲突
  { exps: [{ id: 'a', port: 3000, cwd: 'x' }], listeners: [L(1, [3000]), L(2, [3000]), L(3, [3000], 'b')] },
  { exps: [{ id: 'a', port: 3000, cwd: 'x' }, { id: 'b', port: 3000, cwd: 'y' }], listeners: [L(1, [3000], 'a'), L(2, [3000], 'b')] },
  { exps: [{ id: 'a', port: 0, cwd: 'x' }, { id: 'b', cwd: 'y' }], listeners: [L(1, [0]), L(2, [3000])] },
  { exps: [{ id: 'a', port: 4000, cwd: 'x' }, { id: 'a', port: 4000, cwd: 'x' }], listeners: [L(1, [3000, 4000])] },
]
const match = []
const exps = [
  { id: 'p', cwd: 'D:\\p', pid: 10 },
  { id: 's', cwd: 'D:\\s', sessionId: 'S' },
  { id: 'e', cwd: 'D:\\Work\\Shop' },
  { id: 'f', cwd: 'D:\\work\\shop\\' },
  { id: 'g', cwd: 'D:\\work' },
  { id: 'r', cwd: 'rel\\dir' },
]
for (const pid of [10, 11]) {
  for (const sid of [undefined, '', 'S', 'T']) {
    for (const cwd of [undefined, '', 'd:\\work\\shop', 'D:\\work\\shop\\..\\shop', 'D:\\work\\shopping', 'D:\\work\\shop\\sub', 'D:\\WORK\\x', 'D:/work/y', 'D:\\other', 'rel\\dir\\a']) {
      match.push({ pid, sessionId: sid ?? null, cwd: cwd ?? null })
    }
  }
}

const S = (v) => (v === undefined ? null : v)
const payload = {
  generatedFrom: 'mile-terminal-management/src/main/services/ScannerService.ts + node ' + process.version,
  guessCwd: guess.map((input) => ({ input, result: S(m.guessCwd(input)) })),
  normalize: norm.map((input) => ({ input, result: m.normalizeKeywords(input) })),
  truncate: trunc.map(([v, n]) => ({ input: v, max: n, result: S(m.truncate(v ?? undefined, n)) })),
  conflicts: conflicts.map((c) => ({ ...c, result: m.countConflicts(c.exps, c.listeners) })),
  matchExps: exps,
  match: match.map((c) => ({ ...c, result: S(m.matchEntry(exps, c.pid, c.cwd ?? undefined, c.sessionId ?? undefined)) })),
}
const json = JSON.stringify(payload, null, 1).replace(/[^\x00-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, json + '\n', 'utf8')
console.log(`wrote ${out}: guessCwd ${payload.guessCwd.length}, normalize ${payload.normalize.length}, truncate ${payload.truncate.length}, conflicts ${payload.conflicts.length}, match ${payload.match.length}`)
