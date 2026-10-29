import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import type { ListenRow, ProcessMeta, ProcessRow } from '../types'

/**
 * macOS 进程采集（docs/MACOS-PORTING.md §3.1）。
 *
 * 两条命令都是固定参数的系统工具，不经 shell，不带任何外部输入。
 * LC_ALL=C 固定 `ps -o lstart` 的英文日期格式，否则中文系统下解析不了。
 *
 * 尚未在真机上验证：解析器按 lsof / ps 的文档格式写成，阶段 4 的
 * verify-darwin-proctable 要先在 Mac 上跑过才能算数。
 */

const ENV = { ...process.env, LC_ALL: 'C', LANG: 'C' }

function run(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', env: ENV },
      (err, stdout) => {
        // lsof 在没有任何匹配时退出码为 1 且 stdout 为空，不算失败
        if (err && !(file.endsWith('lsof') && stdout === '')) return reject(err)
        resolve(stdout)
      }
    )
  })
}

/**
 * 快层：`lsof -nP -iTCP -sTCP:LISTEN -Fpn`，字段输出：
 *   p<pid>       一个进程开始
 *   n<地址:端口>  该进程的一个监听地址，如 `*:5173`、`127.0.0.1:3000`、`[::1]:5174`
 *
 * 非 root 时只看得到当前用户的进程。别的账户、系统守护进程的监听不在这里，
 * 端口冲突要靠预检的绑定探测兜底（§3.1）。
 */
export async function readListenPorts(timeoutMs = 4000): Promise<ListenRow[]> {
  const stdout = await run('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], timeoutMs)
  return parseLsof(stdout)
}

export function parseLsof(stdout: string): ListenRow[] {
  const rows: ListenRow[] = []
  const seen = new Set<string>()
  let pid = 0
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1))
      continue
    }
    if (!line.startsWith('n') || !Number.isInteger(pid) || pid <= 1) continue
    const addr = line.slice(1)
    const port = Number(addr.slice(addr.lastIndexOf(':') + 1))
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue
    // 与 Windows 一致：同一 (pid, port) 的 IPv4 / IPv6 两行只留一条，不同 PID 不合并
    const key = `${pid}:${port}`
    if (seen.has(key)) continue
    seen.add(key)
    rows.push({ port, pid })
  }
  return rows
}

/**
 * 慢层：`ps -axww -o pid=,ppid=,uid=,lstart=,comm=,args=`。
 * lstart 固定占 24 个字符（`Thu Oct 30 09:15:02 2026`），秒精度。PID 复用判断只比较
 * 同一来源的两次读数（OwnershipService 的 SAME_PROCESS_MS = 1000），秒精度够用。
 *
 * comm 在 macOS 上是可执行文件的完整路径，可能含空格（`/Applications/Visual Studio Code.app/...`），
 * 所以不按空白切 comm，而是拿 args 的前缀去对齐：args 以可执行文件路径开头。
 */
export async function readProcessMeta(timeoutMs = 15_000): Promise<ProcessMeta> {
  const stdout = await run('/bin/ps', ['-axww', '-o', 'pid=,ppid=,uid=,lstart=,comm=,args='], timeoutMs)
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1
  return parsePs(stdout, uid)
}

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/

export function parsePs(stdout: string, myUid: number): ProcessMeta {
  const byPid = new Map<number, ProcessRow>()
  const mine = new Set<number>()
  for (const line of stdout.split('\n')) {
    const m = PS_LINE.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    const ppid = Number(m[2])
    const uid = Number(m[3])
    const startedAt = Date.parse(m[4])
    const rest = m[5]
    const { exec, args } = splitCommAndArgs(rest)
    byPid.set(pid, {
      pid,
      ppid,
      name: basename(exec),
      execPath: exec.startsWith('/') ? exec : undefined,
      commandLine: args || undefined,
      startedAt: Number.isFinite(startedAt) ? startedAt : undefined
    })
    if (uid === myUid) mine.add(pid)
  }
  return { byPid, mine, at: Date.now() }
}

/**
 * `comm args` 拼在一起，comm 本身可能带空格。args 通常以 comm 原样开头再接参数，
 * 于是找 rest 里 comm 第二次出现的位置作为分界；找不到时（args 被进程自己改写过）
 * 退回按第一个空白切。
 */
function splitCommAndArgs(rest: string): { exec: string; args: string } {
  for (let i = rest.indexOf(' '); i > 0; i = rest.indexOf(' ', i + 1)) {
    const comm = rest.slice(0, i)
    const tail = rest.slice(i + 1)
    if (tail === comm || tail.startsWith(`${comm} `)) return { exec: comm, args: tail }
  }
  const sp = rest.indexOf(' ')
  return sp < 0 ? { exec: rest, args: '' } : { exec: rest.slice(0, sp), args: rest.slice(sp + 1) }
}
