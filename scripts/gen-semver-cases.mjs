// S06 对拍用例生成：用 node 直接跑原版 src/main/lib/semver.ts，把输入与 satisfies 的输出写成 JSON，
// internal/precheck/semver_test.go 读同一份文件比对。期望值全部来自原版函数，不手写。
//
// 用法（在 mygo/console 下）：node scripts/gen-semver-cases.mjs
// 输出里所有非 ASCII 字符都写成 \uXXXX（按 UTF-16 码元），文件是纯 ASCII。

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { satisfies } from '../../../mile-terminal-management/src/main/lib/semver.ts'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '../internal/precheck/testdata/semver_cases.json')

const cp = (n) => String.fromCodePoint(n)
const NBSP = cp(0xa0)
const ZWNBSP = cp(0xfeff)
const NEL = cp(0x85)
const LS = cp(0x2028)
const PS = cp(0x2029)
const IDEO = cp(0x3000)
const HUGE = '9'.repeat(400) // Number 解析为 Infinity
const BIG = '9'.repeat(20)
const TWO53P1 = '9007199254740993' // 2^53 + 1，解析时舍入到 2^53

const versions = [
  '22.11.0', 'v22.11.0', '  22.11.0  ', NBSP + '22.11.0', ZWNBSP + '20.0.0', IDEO + '18.0.0' + IDEO,
  '20.0.0-rc.1', '20.0.0+build.5', '0.2.9', '0.3.0', '0.0.3', '0.0.4', '1.2.3', '22.0.0', '22.1',
  'abc', '', '22', '22.11.x', NEL + '22.11.0', LS + '22.11.0', '00022.011.0',
  HUGE + '.0.0', TWO53P1 + '.0.0', BIG + '.0.0', '20.0.0' + NEL,
]

const ranges = [
  '>=20', '>=20.0.0 <23', '>=20.0.0<23', '>20', '<=22.11.0', '<22', '>22.11.0', '=22.11.0', '22.11.0',
  '22', '22.x', '22.*', '22.11', '22.11.x', '2', '*', 'x', '', '   ', '||', '||||', ' || ',
  '^20.0.0', '^20', '^0.2.3', '^0.0.3', '^0.2', '^0', '^1.2.3', '~20.11', '~20.11.1', '~0.2.3', '~22',
  '>=22 || >=18', '18 || 20', '18 || 22.11.0 || 24', 'v22', '>=v20.1.0', '^v20', '~v22.11',
  'latest', 'lts/*', '>=foo', 'foo || >=20', '>=20 foo', '20 foo', '>=', '<', '^', '~',
  '>=20' + NBSP + '<23', '>=20' + NEL + '<23', '>=20' + LS + '<23', '>=20' + ZWNBSP + '<23',
  '>=20' + IDEO + '<23', '>=20' + PS + '<23',
  '>=' + TWO53P1, '<=' + BIG + '.0.0', '>=' + HUGE, '22.' + HUGE, '22.' + HUGE + '.0',
  '>=99999999999999999999999', '>=0022.011', '2.x.5', '22.x.5', '^22.x', '~22.x.5', '>=22.x', '<22.x',
  '22.11.0-rc.1', '>=20.0.0-rc.1',
]

const cases = []
for (const version of versions) {
  for (const range of ranges) {
    cases.push({ version, range, result: satisfies(version, range) })
  }
}

const json = JSON.stringify({ generatedFrom: 'mile-terminal-management/src/main/lib/semver.ts', cases }, null, 1)
  .replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, json + '\n', 'utf8')
const yes = cases.filter((c) => c.result === true).length
const no = cases.filter((c) => c.result === false).length
const nul = cases.filter((c) => c.result === null).length
console.log(`wrote ${out}: ${cases.length} 条，true ${yes}，false ${no}，null ${nul}`)
