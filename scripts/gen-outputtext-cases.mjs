// S05 对拍用例生成：用 node 直接跑原版 src/main/lib/outputText.ts，把输入和原版输出写成 JSON，
// internal/logs/outputtext_test.go 读同一份文件比对。期望值全部来自原版函数，不手写。
//
// 用法（在 mygo/console 下）：node scripts/gen-outputtext-cases.mjs
// 需要 Node 22.18+（默认开启 TypeScript 类型擦除）。原版文件只读，不改。
//
// 输出里所有非 ASCII 字符都写成 \uXXXX（按 UTF-16 码元），保证文件是纯 ASCII、没有 emoji 与不可见字符；
// 截断在代理对中间产生的孤立代理项也原样以 \uXXXX 写出，Go 解码时变成 U+FFFD。

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  stripAnsi,
  isErrorLine,
  lastVisiblePaint,
  visibleTail,
  pickLastError,
  WARN_RE
} from '../../../mile-terminal-management/src/main/lib/outputText.ts'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '../internal/logs/testdata/outputtext_cases.json')

const E = '\x1b'
const cp = (n) => String.fromCodePoint(n)
const LONG_S = cp(0x17f)
const KELVIN = cp(0x212a)
const NBSP = cp(0xa0)
const IDEO_SPACE = cp(0x3000)
const ZWNBSP = cp(0xfeff)
const NEL = cp(0x85)
const LS = cp(0x2028)
const EMOJI = cp(0x1f600)

const classifyTexts = [
  'npm ERR! code ELIFECYCLE',
  'npm error Lifecycle script "dev" failed',
  'Error: listen EADDRINUSE: address already in use :::3000',
  '[ERROR] BUILD FAILURE',
  '***************************\nAPPLICATION FAILED TO START',
  'APPLICATION FAILED TO ' + LONG_S + 'TART',
  // 唯一只靠 s 折叠才能命中的关键词：JS 不折叠 U+017F，必须判为非错误行
  'listen EADDRINU' + LONG_S + 'E',
  'java.lang.RuntimeException: boom',
  'TypeError: x is not a function',
  'typeerror in lower case',
  'Uncaught ReferenceError',
  '编译错误：找不到符号',
  '启动失败',
  '构建成功',
  'warning: something',
  '(node:1234) DeprecationWarning: Buffer() is deprecated',
  'deprecation notice',
  '警告：磁盘空间不足',
  'WARN some thing',
  'warned',
  'no problems here',
  'errors: 0',
  'stderr output',
  'terror',
  'Errors found',
  '中文error中文',
  'ERRORS',
  'failed.',
  'refailed',
  'Cannot find module x',
  'cannot  find x',
  'Not Found',
  'ENOENTX',
  'ENOENT: no such file',
  'ERR!x',
  'err! ',
  'exception_handler',
  'MyCustomException',
  'Exception',
  KELVIN + 'ERROR',
  'error' + KELVIN,
  'warning' + LONG_S,
  '',
  E + '[31merror' + E + '[0m'
]

const paintInputs = [
  'progress 10%\rprogress 50%\rprogress 100%',
  'done\r' + E + '[K',
  'text\r\r',
  E + '[32mgreen' + E + '[0m',
  E + ']0;title\x07shown',
  E + ']0;title' + E + '\\shown2',
  'a\bb\x07c',
  'trail ' + NBSP + IDEO_SPACE + ZWNBSP,
  'x' + NEL,
  NEL,
  IDEO_SPACE + IDEO_SPACE,
  '   ',
  'tab\t\v\f',
  '',
  'mid' + E + '[5Gend',
  LS + 'line',
  '  lead and trail  ',
  'first\r   \r' + E + '[2K',
  E + '[?25l' + E + '[?25h'
]

const conpty =
  E + '[1;1Hline one' + E + '[2;1Hline two' + E + '[3;5Hsame line' + '\r\n' +
  'progress 1%\rprogress 99%\r' + E + '[K\r\nlast'

const tailCases = [
  { raw: conpty, limit: 30 },
  { raw: conpty, limit: 2 },
  { raw: conpty, limit: 1 },
  { raw: conpty, limit: 0 },
  { raw: conpty, limit: -1 },
  { raw: conpty, limit: 99 },
  { raw: 'a\n\nb\r\n\r\nc\n', limit: 30 },
  { raw: 'x' + E + '[10;1fy' + E + '[;1Hz', limit: 30 },
  { raw: 'abcd' + EMOJI + 'ef', limit: 30, maxChars: 5 },
  { raw: 'abcd' + EMOJI + 'ef', limit: 30, maxChars: 6 },
  { raw: 'abcd' + EMOJI + 'ef', limit: 30, maxChars: 4 },
  { raw: 'abcdef', limit: 30, maxChars: 0 },
  { raw: 'abcdef', limit: 30, maxChars: -2 },
  { raw: '中'.repeat(400) + '\n' + 'e'.repeat(350), limit: 30 },
  { raw: '', limit: 30 },
  { raw: '\r\n\r\n', limit: 30 },
  {
    raw:
      '> app@1.0.0 dev\r\n> vite\r\n\r\n' + E + '[31mError: listen EADDRINUSE: address already in use :::5173' + E +
      '[0m\r\nnpm ERR! code ELIFECYCLE\r\nnpm ERR! errno 1\r\n',
    limit: 30
  },
  {
    raw: '[INFO] Building\n[ERROR] BUILD FAILURE\n[ERROR] Failed to execute goal\r' + E + '[K',
    limit: 30
  }
]

const pickCases = [
  ['starting', 'Error: Cannot find module x', 'npm ERR! code ELIFECYCLE', 'npm ERR! errno 1'],
  ['npm error code 1', 'npm error path x failed'],
  [],
  ['ok', 'fine'],
  [NBSP + IDEO_SPACE + 'npm: failed', 'Exception here', ZWNBSP + 'pnpm ERR! failed'],
  ['yarn error x failed', 'pnpm ERR! failed'],
  ['real error first', 'something ELIFECYCLE failed'],
  ['NPM ERROR boom', 'npmx: error'],
  [NEL + 'npm error y'],
  ['编译错误', '启动失败', 'npm error 失败']
]

const stripInputs = [
  E + '[1;31mred' + E + '[0m',
  E + ']8;;http://x' + E + '\\link' + E + ']8;;' + E + '\\',
  E + '[?1049h' + E + '[H' + E + '[2J',
  'plain',
  E + 'Xnot csi',
  E + '[12'
]

const cases = {
  generatedFrom: 'mile-terminal-management/src/main/lib/outputText.ts',
  classify: classifyTexts.map((text) => ({ text, error: isErrorLine(text), warn: WARN_RE.test(text) })),
  paint: paintInputs.map((raw) => ({ raw, out: lastVisiblePaint(raw) })),
  tail: tailCases.map((c) => ({
    raw: c.raw,
    limit: c.limit,
    maxChars: c.maxChars ?? null,
    out: c.maxChars === undefined ? visibleTail(c.raw, c.limit) : visibleTail(c.raw, c.limit, c.maxChars)
  })),
  pick: pickCases.map((lines) => ({ lines, out: pickLastError(lines) ?? null })),
  strip: stripInputs.map((raw) => ({ raw, out: stripAnsi(raw) }))
}

const json = JSON.stringify(cases, null, 1).replace(
  /[\u007f-\uffff]/g,
  (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, json + '\n', 'utf8')
console.log(
  `wrote ${out}: classify ${cases.classify.length}, paint ${cases.paint.length}, tail ${cases.tail.length}, ` +
    `pick ${cases.pick.length}, strip ${cases.strip.length}`
)
