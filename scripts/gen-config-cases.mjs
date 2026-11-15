// S09 对拍用例生成：跑原版 src/main/services/ConfigStore.ts，期望值全部来自原版，不手写。
//
// electron 换成桩（app.getPath('appData') 指向这里建的临时目录），platform 用原版 win32 实现
// （child_process 换成桩，不起进程）。ConfigStore 本身真读真写临时目录里的文件。
// 绝不碰真实 %APPDATA%：桩在没设 __appData 时直接抛错。
//
// 两类用例：
//   - migrate：每组输入写成 config.json，构造 ConfigStore，读 get() 与磁盘上的文件
//   - boot：主文件 / .bak 各种好坏组合，记录启动后的 get()、isReadOnly()、各文件内容；再 patch 一次看落盘
//
// 用法（在 mygo/console 下）：node scripts/gen-config-cases.mjs
// 输出里所有非 ASCII 字符都写成 \uXXXX（按 UTF-16 码元），文件是纯 ASCII。

import './platform-hooks.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '../internal/config/testdata/config_cases.json')
const ORIGINAL = resolve(here, '../../../mile-terminal-management/src/main/services/ConfigStore.ts')
const { ConfigStore, MAX_IGNORED_LISTENERS } = await import(pathToFileURL(ORIGINAL).href)
const cp = (n) => String.fromCodePoint(n)

const root = mkdtempSync(join(tmpdir(), 'mile-s09-'))
let n = 0
function sandbox() {
  const appData = join(root, String(n++))
  mkdirSync(join(appData, 'mile-terminal'), { recursive: true })
  globalThis.__appData = appData
  return join(appData, 'mile-terminal')
}
const readOrNull = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null)

// ---- 迁移输入 ----
const entry = (extra = {}) => ({
  id: 'e1', kind: 'service', name: 'web', path: 'E:\\p', framework: 'vite', packageManager: 'npm', script: 'dev',
  scripts: { dev: 'vite' }, env: { PORT: '3000' }, registerOnly: false, pinned: false, order: 0, createdAt: 1, ...extra,
})
const v14Keys = { healthCheck: { path: '/h', enabled: true }, autoRestart: true, alertKeywords: ['x'], alertOnErrors: true }
const fullSettings = {
  scanIntervalMs: 5000, theme: 'dark', externalTerminal: 'cmd', terminalFontSize: 15, scrollback: 9000, killOwnedOnQuit: false,
  closeToTray: true, notifyOnTaskDone: false, hideFromTaskbar: true, notifyOnCrash: false, notifyOnlyWhenBackground: false,
  globalHotkey: false, loginShellPath: true, plannerNotify: false, plannerSound: false,
}
const ignored = [
  { processName: 'a.exe', port: 80 }, { processName: '', port: 81 }, { processName: 'b', port: 0 }, { processName: 'c', port: 65536 },
  { processName: 'd', port: 80.5 }, { processName: 'e', port: '80' }, { processName: 5, port: 80 }, null, 7, [],
  { processName: 'x'.repeat(260), port: 1 }, { processName: 'x'.repeat(261), port: 1 }, { processName: cp(0x1f600).repeat(130), port: 2 },
  { processName: cp(0x1f600).repeat(131), port: 3 }, { processName: 'f', port: 65535 }, { processName: 'g', port: 80.0 },
  { processName: 'h' }, { port: 9 }, { processName: 'i', port: 1e2 },
]
const categories = [
  'Web', '  Web  ', '', '   ', 'x'.repeat(40), 'x'.repeat(41), cp(0x1f600).repeat(20), cp(0x1f600).repeat(21), 'a' + cp(0x1f) + 'b',
  'a' + cp(0x7f) + 'b', 'a' + cp(0x80) + 'b', cp(0xfeff) + 'Web' + cp(0xfeff), cp(0x85) + 'Web', cp(0x3000) + cp(0x4e2d) + cp(0x3000),
  5, null, true, ['x'], { a: 1 },
]
const pinnedValues = [true, false, null, 'yes', 1, 0, [], {}]

const migrateInputs = []
for (const v of [undefined, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 0, -1, 2.5, 13.5, '16', null, true]) {
  const cfg = {
    entries: [entry({ icon: 'custom', category: '  Web  ', ...v14Keys })],
    groups: [{ id: 'g1', name: 'G', env: 'dev', createdAt: 1, order: 0, pinned: true }],
    ignoredListeners: [{ processName: 'a.exe', port: 80 }],
    groupOverrides: [{ processName: 'n.exe', group: 'mine' }],
    watchedKeywords: ['k'],
    settings: fullSettings,
  }
  if (v !== undefined) cfg.version = v
  migrateInputs.push(cfg)
}
migrateInputs.push(
  {},
  { version: 16 },
  { version: 1, settings: {} },
  { version: 16, settings: { theme: 'neon' } },
  { version: 16, settings: { theme: 'system' } },
  { version: 16, settings: { externalTerminal: 'iterm' } },
  { version: 16, settings: { externalTerminal: 'gitbash' } },
  { version: 16, settings: { externalTerminal: 7 } },
  { version: 16, settings: null },
  { version: 16, settings: [1, 2] },
  { version: 16, settings: 'x' },
  { version: 16, settings: { ...fullSettings, scanIntervalMs: 'fast', terminalFontSize: 14.0, closeToTray: 'yes' } },
  { version: 16, entries: {}, groups: 'x', ignoredListeners: null, groupOverrides: 5, watchedKeywords: {} },
  { version: 16, entries: [null, 5, 'x', entry(), [], entry({ id: 'e2' })] },
  { version: 16, ignoredListeners: ignored },
  { version: 16, ignoredListeners: Array.from({ length: 520 }, (_, i) => ({ processName: 'p' + i, port: 1000 + i })) },
  ...categories.map((category) => ({ version: 4, entries: [entry({ category })] })),
  ...categories.slice(0, 4).map((category) => ({ version: 5, entries: [entry({ category })] })),
  ...pinnedValues.map((pinned) => ({ version: 14, groups: [{ id: 'g', name: 'G', env: 'dev', createdAt: 1, order: 0, pinned }] })),
  ...pinnedValues.slice(0, 3).map((pinned) => ({ version: 15, groups: [{ id: 'g', name: 'G', env: 'dev', createdAt: 1, order: 0, pinned }] })),
  { version: 13, entries: [entry({ ...v14Keys }), entry({ id: 'e2' })] },
  { version: 14, entries: [entry({ ...v14Keys })] },
  { version: 3, entries: [entry({ icon: 'x' })] },
  { version: 4, entries: [entry({ icon: 'x' })] },
  { version: 16, entries: [entry({ startAfter: ['e2'], groupId: 'g1', launchMode: 'jar', jarPath: 'a.jar', imageId: 'i.png', lastExitCode: 1, lastStartedAt: 5, expectedPort: 3000, cwd: 'pkg', outputDir: 'dist' })] },
  { version: 16, entries: [entry({ script: null, env: {} })] },
  { version: 16, watchedKeywords: ['a', 'b'], groupOverrides: [{ processName: 'x', group: 'background' }] },
  { version: 1, groupOverrides: [{ processName: 'x', group: 'mine' }], watchedKeywords: ['a'] },
  { version: 16, unknownTop: 1, settings: { ...fullSettings, unknownSetting: true } },
  { version: 16, settings: { ...fullSettings, notifyOnTaskDone: false, hideFromTaskbar: true } },
)

const migrate = []
for (const input of migrateInputs) {
  const dir = sandbox()
  writeFileSync(join(dir, 'config.json'), JSON.stringify(input), 'utf8')
  const store = new ConfigStore()
  migrate.push({ input, output: store.get(), readOnly: store.isReadOnly(), wroteFile: readOrNull(join(dir, 'config.json')) !== JSON.stringify(input) })
}

// ---- 启动场景：主文件 / .bak 的好坏组合 ----
const good = (name) => JSON.stringify({ version: 16, entries: [entry({ name })], settings: fullSettings })
const oldGood = (name) => JSON.stringify({ version: 9, entries: [entry({ name, icon: 'x' })] })
const fileKinds = {
  missing: null,
  good: good('primary'),
  goodOld: oldGood('primary-old'),
  bakGood: good('backup'),
  bakOld: oldGood('backup-old'),
  broken: '{"version": 16, "entries": [',
  array: '[1,2]',
  nul: 'null',
  number: '5',
  empty: '',
  bom: cp(0xfeff) + good('bom'),
  whitespace: '  \n' + good('ws') + '\n  ',
}
const bootPairs = [
  ['missing', 'missing'], ['good', 'missing'], ['good', 'bakGood'], ['goodOld', 'missing'], ['broken', 'bakGood'],
  ['broken', 'bakOld'], ['missing', 'bakGood'], ['broken', 'missing'], ['missing', 'broken'], ['broken', 'broken'],
  ['array', 'bakGood'], ['nul', 'missing'], ['number', 'number'], ['empty', 'bakGood'], ['empty', 'missing'],
  ['bom', 'missing'], ['bom', 'bakGood'], ['whitespace', 'missing'], ['array', 'array'],
]
const boot = []
for (const [primary, backup] of bootPairs) {
  const dir = sandbox()
  const files = { 'config.json': fileKinds[primary], 'config.json.bak': fileKinds[backup] }
  for (const [name, body] of Object.entries(files)) if (body !== null) writeFileSync(join(dir, name), body, 'utf8')
  const store = new ConfigStore()
  const afterBoot = snapshot(dir)
  const cfg = store.get()
  const readOnly = store.isReadOnly()
  store.patchSettings({ scrollback: 1234 })
  const afterPatch = snapshot(dir)
  boot.push({ primary, backup, files, config: cfg, readOnly, afterBoot, afterPatch })
}
function snapshot(dir) {
  const o = {}
  for (const name of readdirSync(dir).sort()) o[name] = readFileSync(join(dir, name), 'utf8')
  return o
}

// ---- patch 序列：.bak 总是上一份 ----
const sequence = []
{
  const dir = sandbox()
  const store = new ConfigStore()
  sequence.push(snapshot(dir))
  store.patch({ watchedKeywords: ['one'] })
  sequence.push(snapshot(dir))
  store.patch({ watchedKeywords: ['two'] })
  sequence.push(snapshot(dir))
  store.patchSettings({ theme: 'dark' })
  sequence.push(snapshot(dir))
}

// ---- backupBeforeImport：时钟固定在本地时间 2026-11-14 09:05:07 ----
const RealDate = globalThis.Date
class FixedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(2026, 10, 14, 9, 5, 7)
    else super(...args)
  }
}
const importBackup = []
for (const withFile of [true, false]) {
  const dir = sandbox()
  if (withFile) writeFileSync(join(dir, 'config.json'), good('import'), 'utf8')
  const store = new ConfigStore()
  globalThis.Date = FixedDate
  const names = []
  for (let i = 0; i < 3; i++) names.push(store.backupBeforeImport().slice(dir.length + 1))
  globalThis.Date = RealDate
  importBackup.push({ withFile, names, files: snapshot(dir) })
}

rmSync(root, { recursive: true, force: true })

const json = JSON.stringify({ generatedFrom: 'mile-terminal-management/src/main/services/ConfigStore.ts + node ' + process.version, maxIgnored: MAX_IGNORED_LISTENERS, migrate, boot, sequence, importBackup })
  .replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, json + '\n', 'utf8')
console.log(`wrote ${out}: migrate ${migrate.length}，boot ${boot.length}，sequence ${sequence.length}`)
