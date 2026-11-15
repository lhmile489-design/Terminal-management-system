// S16 对拍用例生成：跑原版 src/main/services/DetectService.ts，期望值全部来自原版，不手写。
//
// 场景定义在 detect-scenarios.mjs。每个场景在临时目录里建成真实的目录树，原版真读真 stat；
// 结果里的绝对路径换成占位 <ROOT>（临时根）与 <ORIG>（原项目 scripts 目录），Go 测试换回自己的路径。
// 原项目的三个夹具目录（fixture / fixture-mono / fixture-task）只读引用，不复制、不修改。
//
// 用法（在 mygo/console 下）：node --experimental-transform-types scripts/gen-detect-cases.mjs
// 输出纯 ASCII（非 ASCII 写成 \uXXXX）。

import './platform-hooks.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { detectScenarios, faviconScenarios, cleanInputs, hrefInputs } from './detect-scenarios.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '../internal/detect/testdata/detect_cases.json')
const ORIGINAL = resolve(here, '../../../mile-terminal-management/src/main/services/DetectService.ts')
const ORIG_SCRIPTS = resolve(here, '../../../mile-terminal-management/scripts')
const mod = await import(pathToFileURL(ORIGINAL).href)
const svc = new mod.DetectService()

const root = mkdtempSync(join(tmpdir(), 'mile-s16-'))
const B = String.fromCharCode(92)

function build(dir, files) {
  mkdirSync(dir, { recursive: true })
  for (const [rel, v] of Object.entries(files)) {
    const p = join(dir, rel)
    mkdirSync(dirname(p), { recursive: true })
    if (typeof v === 'string') writeFileSync(p, v, 'utf8')
    else if (v.dir) mkdirSync(p, { recursive: true })
    else if (v.b64 !== undefined) writeFileSync(p, Buffer.from(v.b64, 'base64'))
    else if (v.size !== undefined) writeFileSync(p, Buffer.alloc(v.size, 0x41))
  }
}

const mask = (x) => JSON.parse(JSON.stringify(x).split(JSON.stringify(root).slice(1, -1)).join('<ROOT>')
  .split(JSON.stringify(ORIG_SCRIPTS).slice(1, -1)).join('<ORIG>'))

const payload = { detect: [], favicon: [], profiles: [], lockfile: [], scan: [], clean: [], hrefs: [], fixtures: [] }

for (const s of detectScenarios) {
  const dir = join(root, 'd', s.name)
  build(dir, s.files)
  payload.detect.push({ name: s.name, files: s.files, result: mask(await svc.detect(dir)) })
  payload.lockfile.push({ name: s.name, result: await svc.lockfileFor(dir) })
}
// 不存在的目录
payload.detect.push({ name: 'missing', missing: true, result: mask(await svc.detect(join(root, 'd', 'no-such-dir'))) })

for (const s of faviconScenarios) {
  const dir = join(root, 'f', s.name)
  build(dir, s.files)
  payload.favicon.push({ name: s.name, files: s.files, result: await svc.readFavicon(dir) })
}

const profileScenarios = [
  { name: 'none', files: {} },
  { name: 'both-dirs', files: {
    'src/main/resources/application-dev.yml': '', 'src/main/resources/application-PROD.properties': '',
    'application-dev.yaml': '', 'application-test.yml': '', 'application.yml': '', 'application-a.b.yml': '',
    'application-x y.yml': '', 'application-ok_1-2.YML': '', 'Application-cap.yml': '', 'application-.yml': '',
    'application-z.json': '', 'application-dir.yml/x': '', 'application-中文.yml': '',
  } },
  { name: 'sort', files: { 'application-b.yml': '', 'application-B.yml.bak': '', 'application-a.properties': '', 'application-_.yml': '', 'application-Z.yml': '', 'application-1.yml': '' } },
]
for (const s of profileScenarios) {
  const dir = join(root, 'p', s.name)
  build(dir, s.files)
  payload.profiles.push({ name: s.name, files: s.files, result: await svc.detectSpringBootProfiles(dir) })
}

// scanChildren：排序、跳过、limit。每个子目录放 go.mod 才会被返回；none 子目录没有标记
const sortNames = ['中文', '阿', '啊', 'a', 'B', 'b', '_x', '-y', '10', '9', 'Zeta', 'émile', '项目', 'App', 'app2', '张三', '1a', 'z',
  '.git', 'node_modules', 'Dist', 'OUT', 'build', 'target2', 'Release', 'coverage', 'none']
const scanCases = [
  { name: 'sort', limit: 60, entries: Object.fromEntries(sortNames.map((n) => [n + '/' + (n === 'none' ? 'README.md' : 'go.mod'), ''])) },
  { name: 'limit', limit: 3, entries: { 'a/go.mod': '', 'b.txt': '', 'c/go.mod': '', 'd/README': '', 'e/go.mod': '', 'f/go.mod': '' } },
  { name: 'limit-files-only', limit: 2, entries: { 'x.txt': '', 'y.txt': '', 'z/go.mod': '' } },
  { name: 'mixed', limit: 60, entries: { 'web/package.json': '{"scripts":{"dev":"vite"}}', 'svc/pom.xml': 'spring-boot', 'docs/a.md': '', 'bad/package.json': '{' } },
  { name: 'empty', limit: 60, entries: {} },
]
for (const s of scanCases) {
  const dir = join(root, 's', s.name)
  build(dir, s.entries)
  payload.scan.push({ name: s.name, limit: s.limit, entries: s.entries, result: mask(await svc.scanChildren(dir, s.limit)) })
}
payload.scan.push({ name: 'missing-root', limit: 60, missing: true, result: mask(await svc.scanChildren(join(root, 's', 'nope'))) })

// 原项目夹具（只读）
for (const name of ['fixture', 'fixture-mono', 'fixture-task']) {
  const dir = join(ORIG_SCRIPTS, name)
  payload.fixtures.push({ name, result: mask(await svc.detect(dir)), lockfile: await svc.lockfileFor(dir), favicon: await svc.readFavicon(dir) })
}
payload.fixtures.push({ name: '<scan>', result: mask(await svc.scanChildren(ORIG_SCRIPTS)) })

// 纯函数：tryReadIcon 第一行的 clean 表达式（原版没拆成函数，这里逐字照抄 DetectService.ts 第 605 行），
// 以及 extname(clean).toLowerCase() 查 MIME 的结果
const { extname } = await import('node:path')
for (const rel of cleanInputs) {
  const clean = rel.trim().replace(/^\.?\//, '').replace(/[?#].*$/, '')
  payload.clean.push({ input: rel, clean, ext: extname(clean).toLowerCase() })
}
for (const html of hrefInputs) payload.hrefs.push({ html, result: mod.parseIconHrefs(html) })

rmSync(root, { recursive: true, force: true })
const json = JSON.stringify(payload, null, 1).replace(/[^\x00-\x7e]/g, (c) => B + 'u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, json + '\n', 'utf8')
console.log(`wrote ${out}: detect ${payload.detect.length}, favicon ${payload.favicon.length}, profiles ${payload.profiles.length}, scan ${payload.scan.length}, fixtures ${payload.fixtures.length}, clean ${payload.clean.length}, hrefs ${payload.hrefs.length}`)
