import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

const PS_CANDIDATES = [
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
]

let psPath: string | null = null

function powershell(): string {
  if (psPath) return psPath
  psPath = PS_CANDIDATES.find((p) => existsSync(p)) ?? 'powershell.exe'
  return psPath
}

/**
 * -EncodedCommand 收 UTF-16LE base64，脚本里的引号与换行不再经过命令行解析，
 * 因此不存在拼接注入面。脚本必须是代码内常量，调用方不得插入外部字符串。
 */
export function runPowerShell(script: string, timeoutMs = 8000): Promise<string> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    execFile(
      powershell(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr?.trim() || err.message))
        resolve(stdout)
      }
    )
  })
}

/** ConvertTo-Json 单元素时返回对象而非数组，统一成数组 */
export async function runPowerShellJson<T>(script: string, timeoutMs?: number): Promise<T[]> {
  const raw = (await runPowerShell(script, timeoutMs)).trim()
  if (!raw) return []
  const parsed = JSON.parse(raw) as T | T[]
  return Array.isArray(parsed) ? parsed : [parsed]
}
