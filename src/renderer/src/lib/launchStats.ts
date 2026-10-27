/**
 * 每个条目的启动次数，只用于总览「服务操作台」按常用程度排序。
 * 纯展示偏好，存 localStorage，不进主进程配置；条目被移除后残留的计数无害。
 */
const KEY = 'mile.launchCount'

export function launchCounts(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

export function bumpLaunch(id: string): void {
  const all = launchCounts()
  all[id] = (all[id] ?? 0) + 1
  try {
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    // localStorage 不可用时只是失去排序依据，不影响启动
  }
}
