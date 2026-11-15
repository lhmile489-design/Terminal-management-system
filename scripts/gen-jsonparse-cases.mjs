// S16 对拍：JSON.parse 的值与报错文案。期望值全部由本机 node 的 JSON.parse 算出，不手写。
// DetectService.detect 把 JSON.parse 的 err.message 拼进警告，internal/detect/jsjson.go 要逐字一致。
//
// 用法（在 mygo/console 下）：node scripts/gen-jsonparse-cases.mjs
// 输出纯 ASCII（非 ASCII 写成 \uXXXX，按 UTF-16 码元）。
// 输入不放字面孤立代理：readFile(..., 'utf8') 读出的文本不可能含孤立代理（非法序列已换成 U+FFFD）。
// 转义出来的孤立代理照常覆盖：两边的值都按 U+FFFD 比（Go 解码 testdata 时同样替换）。

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '../internal/detect/testdata/jsonparse_cases.json')
const B = String.fromCharCode(92) // 反斜杠
const C = (n) => String.fromCharCode(n)

const inputs = [
  '', ' ', '\n', '{', '}', '[', ']', ':', ',', 'x', '{}', '[]', '{ }', '[ ]',
  '{"a":1', '{"a":1,}', '[1,]', '[1', '[1,', '[1 2]', '{"a"', '{"a":', '{"a" 1}', '{"a":1 "b":2}',
  '{a:1}', "{'a':1}", '{"a":1,"b"}', '{,}', '[,]', '{"a":1}}', '{} x', '[] []', '1 2',
  '"abc', '"a' + B + 'x"', '"' + B, '"' + B + 'u12"', '"' + B + 'u12G4"', '"' + B + 'u00e9"', '"' + B + 'uD83D' + B + 'uDE00"',
  '"' + B + 'n' + B + 't' + B + 'r' + B + 'b' + B + 'f' + B + '/' + B + B + B + '""',
  '"a' + C(1) + '"', '"a' + C(0x1f) + 'b"', '"tab' + C(9) + '"', '"' + B + C(0x4e2d) + '"',
  '-', '-x', '--1', '01', '-01', '00', '0', '-0', '0.', '1.', '1.x', '.5', '1e', '1e+', '1E-', '1e5', '1.5e-3', '-0.0',
  '123456789', '1234567890', '12345678901234567890', '1e400', '-1e400', '1e-400', '0x10', '+1', 'Infinity', 'NaN',
  'tru', 'true', 'truex', 'trux', 'nul', 'null', 'nulL', 'f', 'fals', 'false', 'falsy', 't',
  'undefined', '[object Object]', 'NaN ', C(0xfeff) + '{}', C(0xa0) + '{}', C(0x3000) + '1',
  '{\n  "a": 1,\n  "b": 2\n  "c": 3\n}', '{\r\n"a":1\r\n,}', '{\r"a"\r\r:1,\n\n}', '\r\n\r\n x',
  '{"name":"a","scripts":{"dev":"vite"}', '{"name": "my-app", "version": "1.0.0", }',
  '{"dependencies":{"vue":"^3"},"devDependencies":{"vite":"^5"},}', '{"name":"中文项目","x":}',
  '{"emoji":"' + C(0xd83d) + C(0xde00) + '", oops}', '{"lone":"' + B + 'uD83D"} z', '"' + B + 'uDE00x"',
  '{"b":"1","2":"x","a":"y","1":"z","b":"last","__proto__":"p","10":"t","-1":"m","01":"lead","4294967295":"big","4294967294":"max","n":3,"o":{},"arr":[1]}',
  '{"' + B + 'u0031":"esc-index","' + B + 'u0061":"esc-a","1":"plain"}',
  '{"a":[1,2,{"b":[true,false,null]}],"c":{"d":{"e":"f"}}}', '[[[[[]]]]]', '{"":""}', '[1,2,3,"x",null]',
  'x'.repeat(30), '{"long":' + 'x'.repeat(30) + '}', '{"aaaaaaaaaaaaaaaaaaaa":1,}', '{"key":"value","k2":"v2"}}',
  // 上下文截取的边界：源长 20 / 21，错误位置在 len-11 / len-10
  'x' + ' '.repeat(19), 'x' + ' '.repeat(20), ' '.repeat(10) + 'x' + ' '.repeat(10), ' '.repeat(11) + 'x' + ' '.repeat(9),
  ' '.repeat(9) + 'x' + ' '.repeat(11), '[' + '1,'.repeat(10) + '}', '{"a":' + '1'.repeat(14) + 'x}',
  // 码元高字节恰好是 0x22 / 0x5C / 控制字符的非 Latin-1 字符：不能当成引号、反斜杠或控制字符
  '"' + C(0x122) + C(0x15c) + C(0x101) + C(0x2222) + '"', '{"' + C(0x122) + '":"' + C(0x5c22) + '"}',
  '{"3":"a","1":"b","2":"c","1":"d","0":"e","x":"f","5":"g"}',
]


// 值的描述：对象记键序，JSON.stringify 保留顺序；__proto__ 用 Object.keys + 属性描述读出来
function describe(v) {
  if (v === null) return { t: 'null' }
  if (Array.isArray(v)) return { t: 'array', elems: v.map(describe) }
  switch (typeof v) {
    case 'boolean': return { t: 'bool', b: v }
    case 'number': return { t: 'number', n: Object.is(v, -0) ? '-0' : String(v) }
    case 'string': return { t: 'string', s: v }
    default: {
      const keys = Object.keys(v)
      return { t: 'object', keys, props: keys.map((k) => describe(Object.getOwnPropertyDescriptor(v, k).value)) }
    }
  }
}

const cases = inputs.map((input) => {
  try {
    return { input, value: describe(JSON.parse(input)) }
  } catch (e) {
    return { input, error: e.message }
  }
})

const payload = { node: process.version, v8: process.versions.v8, cases }
const json = JSON.stringify(payload, null, 1).replace(/[^\x00-\x7e]/g, (c) => B + 'u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, json + '\n', 'utf8')
console.log(`wrote ${out}: ${cases.length} cases, ${cases.filter((c) => c.error).length} errors`)
