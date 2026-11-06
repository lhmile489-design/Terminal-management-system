import { execFile } from 'node:child_process'
import { runPowerShell } from './powershell'
import type { ListenRow, ProcessMeta, ProcessRow } from '../types'

/**
 * 快层：netstat 取监听端口，实测 ~55ms。
 *
 * 不用 Get-NetTCPConnection —— 那是 CIM 查询，单次 2.8s，放不进 2 秒采集周期。
 *
 * 不加 `-p TCP`：那只出 IPv4。Vite 8 等默认绑 `[::1]`，只查 IPv4 会整个漏掉
 * （实测 :5174 在 `-p TCP` 下不可见，在 `-p TCPv6` 下才有）。不带 -p 一次覆盖
 * 两个协议族，耗时相同，UDP 行没有 LISTENING 状态会被 parseNetstat 过掉。
 */
export function readListenPorts(timeoutMs = 4000): Promise<ListenRow[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'netstat.exe',
      ['-ano'],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => {
        if (err) return reject(err)
        resolve(parseNetstat(stdout))
      }
    )
  })
}

function parseNetstat(stdout: string): ListenRow[] {
  const rows: ListenRow[] = []
  const seen = new Map<string, ListenRow>()

  for (const line of stdout.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue
    const f = line.trim().split(/\s+/)
    if (f.length < 4) continue

    const local = f[1]
    const port = Number(local.slice(local.lastIndexOf(':') + 1))
    const pid = Number(f[f.length - 1])
    if (!Number.isInteger(port) || port < 1 || !Number.isInteger(pid) || pid <= 4) continue
    // netstat 的 IPv6 本地地址一律带方括号：[::]:3000、[::1]:5174
    const family: 4 | 6 = local.startsWith('[') ? 6 : 4

    // IPv4 与 IPv6 会各出一行同 (pid, port)：合并成一行，只记下两族都在
    const key = `${pid}:${port}`
    const existing = seen.get(key)
    if (existing) {
      if (!existing.families.includes(family)) existing.families.push(family)
      continue
    }
    const row: ListenRow = { port, pid, families: [family] }
    seen.set(key, row)
    rows.push(row)
  }
  return rows
}

/**
 * 慢层：进程元数据（命令行、启动时间、父子关系）与当前用户 PID 集合，实测 ~3.5s。
 *
 * 归属用 Win32_LogonSession → Win32_SessionProcess 批量关联，而不是对每个 PID 调
 * Invoke-CimMethod GetOwnerSid —— 后者每 PID 约 800ms，30 个监听进程就 26s，
 * 根本放不进采集周期。批量关联一次拿到当前用户登录会话下的全部 PID，效果等价。
 */
const META_SCRIPT = String.raw`
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value

$mineLogon = New-Object System.Collections.Generic.HashSet[string]
foreach ($s in @(Get-CimInstance Win32_LogonSession)) {
  try {
    foreach ($a in @(Get-CimAssociatedInstance -InputObject $s -ResultClassName Win32_Account)) {
      if ($a.SID -eq $me) { [void]$mineLogon.Add([string]$s.LogonId) }
    }
  } catch { }
}

$minePid = New-Object System.Collections.Generic.HashSet[int]
foreach ($sp in @(Get-CimInstance Win32_SessionProcess)) {
  if ($mineLogon.Contains([string]$sp.Antecedent.LogonId)) {
    [void]$minePid.Add([int]$sp.Dependent.Handle)
  }
}

$procs = @(Get-CimInstance -Query "SELECT ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate FROM Win32_Process" |
  ForEach-Object {
    [pscustomobject]@{
      pid  = [int]$_.ProcessId
      ppid = [int]$_.ParentProcessId
      name = $_.Name
      exe  = $_.ExecutablePath
      cmd  = $_.CommandLine
      at   = if ($_.CreationDate) { [long]([datetimeoffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { $null }
    }
  })

[pscustomobject]@{ procs = $procs; mine = @($minePid) } | ConvertTo-Json -Compress -Depth 4
`

interface RawRow {
  pid: number
  ppid: number
  name: string
  exe?: string | null
  cmd?: string | null
  at?: number | null
}

interface RawMeta {
  procs: RawRow[] | RawRow | null
  mine: number[] | number | null
}

function toArray<T>(v: T[] | T | null | undefined): T[] {
  if (v == null) return []
  return Array.isArray(v) ? v : [v]
}

export async function readProcessMeta(timeoutMs = 15_000): Promise<ProcessMeta> {
  const raw = (await runPowerShell(META_SCRIPT, timeoutMs)).trim()
  if (!raw) throw new Error('进程元数据采集无输出')

  const payload = JSON.parse(raw) as RawMeta
  const byPid = new Map<number, ProcessRow>()

  for (const r of toArray(payload.procs)) {
    byPid.set(r.pid, {
      pid: r.pid,
      ppid: r.ppid,
      name: r.name,
      execPath: r.exe ?? undefined,
      commandLine: r.cmd ?? undefined,
      startedAt: r.at ?? undefined
    })
  }

  return { byPid, mine: new Set(toArray(payload.mine)), at: Date.now() }
}
