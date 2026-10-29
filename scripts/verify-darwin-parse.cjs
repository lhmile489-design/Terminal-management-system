/**
 * macOS 进程采集解析器（platform/darwin/process.ts）的纯逻辑校验。
 *
 * 不起 Electron、不调 lsof / ps：用 esbuild 单独打包解析函数，喂按 man 页格式写的
 * 合成输出。它只证明「解析器对这种格式的处理是对的」，证明不了真机上 lsof / ps 的
 * 输出就是这个格式 —— 那要在 Mac 上跑 verify-darwin-proctable 才算数。
 *
 *   node scripts/verify-darwin-parse.cjs
 */
const { join } = require('node:path')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { buildSync } = require('esbuild')

const ROOT = join(__dirname, '..')
const OUT_DIR = mkdtempSync(join(tmpdir(), 'mile-darwin-parse-'))
const OUT = join(OUT_DIR, 'darwin-process.cjs')
buildSync({
  entryPoints: [join(ROOT, 'src/main/platform/darwin/process.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: OUT,
  logLevel: 'silent'
})
const { parseLsof, parsePs } = require(OUT)

let pass = 0
let fail = 0
function check(name, ok, detail) {
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? ` — ${detail}` : ''}`)
}

console.log('\n=== 1. lsof -Fpn ===')
const lsof = [
  'p501', 'n*:5173', 'n[::1]:5173',      // 同一 PID 的 IPv4 / IPv6，只留一条
  'p502', 'n127.0.0.1:3000',
  'p503', 'n[::]:3000',                   // 另一个 PID 绑同端口：不能被合并
  'p1', 'n*:22',                          // launchd：排除
  'p504', 'nlocalhost:notaport',          // 端口不是数字：跳过
  ''
].join('\n')
const rows = parseLsof(lsof)
const key = (r) => `${r.pid}:${r.port}`
check('解析出 3 行', rows.length === 3, JSON.stringify(rows))
check('同 PID 的双栈只留一条', rows.filter((r) => r.pid === 501).length === 1)
check('同端口不同 PID 两行都在', rows.filter((r) => r.port === 3000).map(key).sort().join() === '502:3000,503:3000')
check('PID 1 被排除', !rows.some((r) => r.pid === 1))
check('空输出返回空数组', parseLsof('').length === 0)

console.log('\n=== 2. ps -o pid=,ppid=,uid=,lstart=,comm=,args= ===')
const ps = [
  '    1     0     0 Mon Oct 27 08:00:01 2026     /sbin/launchd /sbin/launchd',
  '  700     1   501 Thu Oct 30 09:15:02 2026     /Applications/Visual Studio Code.app/Contents/MacOS/Electron /Applications/Visual Studio Code.app/Contents/MacOS/Electron --type=renderer',
  '  800   700   501 Thu Oct  3 10:01:09 2026     /bin/zsh -zsh',
  '  801   800   501 Thu Oct 30 10:01:10 2026     /opt/homebrew/bin/node /opt/homebrew/bin/node /Users/me/app/node_modules/vite/bin/vite.js',
  '  900     1   502 Thu Oct 30 11:00:00 2026     /usr/sbin/sshd /usr/sbin/sshd -D',
  'garbage line that does not match',
  ''
].join('\n')
const meta = parsePs(ps, 501)
check('解析出 5 个进程', meta.byPid.size === 5, String(meta.byPid.size))
check('mine 只含 uid 501', [...meta.mine].sort((a, b) => a - b).join() === '700,800,801', [...meta.mine].join())
const code = meta.byPid.get(700)
check('带空格的可执行路径完整保留', code && code.execPath === '/Applications/Visual Studio Code.app/Contents/MacOS/Electron', code && code.execPath)
check('进程名取路径末段', code && code.name === 'Electron', code && code.name)
const zsh = meta.byPid.get(800)
check('args 被改写时退回按首个空白切', zsh && zsh.execPath === '/bin/zsh' && zsh.commandLine === '-zsh', zsh && JSON.stringify(zsh))
check('个位数日期（两个空格）也能解析', zsh && Number.isFinite(zsh.startedAt))
const node = meta.byPid.get(801)
check('父子关系', node && node.ppid === 800)
check('命令行保留参数', node && node.commandLine.endsWith('vite.js'), node && node.commandLine)
const t1 = node && node.startedAt
const t2 = node && Date.parse('2026-10-30T10:01:10')
check('启动时间按本地时区换算', t1 === t2, `${t1} vs ${t2}`)
check('两次读数一致（PID 复用判断的前提）', parsePs(ps, 501).byPid.get(801).startedAt === t1)

console.log(`\n结果：${pass} 通过，${fail} 失败`)
try { rmSync(OUT_DIR, { recursive: true, force: true }) } catch { /* 交给系统清理 */ }
process.exit(fail === 0 ? 0 : 1)
