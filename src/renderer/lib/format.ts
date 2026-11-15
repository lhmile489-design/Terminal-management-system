/** 刚刚 / 12m / 4h30m / 5d12h，见 PRD §3.3 */
export function formatUptime(startedAt?: number): string {
  if (!startedAt) return '—'
  const sec = Math.floor((Date.now() - startedAt) / 1000)
  if (sec < 60) return '刚刚'

  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`

  const hour = Math.floor(min / 60)
  if (hour < 24) {
    const rest = min % 60
    return rest ? `${hour}h${rest}m` : `${hour}h`
  }

  const day = Math.floor(hour / 24)
  const rest = hour % 24
  return rest ? `${day}d${rest}h` : `${day}d`
}

/** 已结束的时长（毫秒）：诊断里要能看出「跑了 3 秒就挂了」，所以保留秒 */
export function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) {
    const rest = sec % 60
    return rest ? `${min}m${rest}s` : `${min}m`
  }
  const hour = Math.floor(min / 60)
  const rest = min % 60
  return rest ? `${hour}h${rest}m` : `${hour}h`
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '—'
  const mb = bytes / 1024 / 1024
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

/** 2 秒采样下小数位没有意义，只占宽度 */
export function formatPercent(value: number | null): string {
  return value === null ? '—' : String(Math.round(value))
}

export function formatClock(at: number | null): string {
  if (!at) return '--:--:--'
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
}

/** 中间省略，保留盘符与末级目录 */
export function ellipsisPath(path: string, keep = 28): string {
  if (path.length <= keep) return path
  const head = path.slice(0, 10)
  const tail = path.slice(-(keep - 13))
  return `${head}…${tail}`
}
