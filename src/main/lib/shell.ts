import { existsSync } from 'node:fs'

const CANDIDATES = [
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
]

let cached: string | null = null

export function defaultShell(): string {
  if (cached) return cached
  cached = CANDIDATES.find((p) => existsSync(p)) ?? process.env.ComSpec ?? 'cmd.exe'
  return cached
}

export function shellLaunchArgs(file: string): string[] {
  return /powershell\.exe$|pwsh\.exe$/i.test(file) ? ['-NoLogo', '-NoExit'] : []
}
