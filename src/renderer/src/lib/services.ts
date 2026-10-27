import type { EntryRuntime, Framework, LaunchEntry, PrecheckResult, ProjectGroup } from '@shared/types'
import { GROUP_ENV_LABEL } from '@shared/types'
import { useEntries } from '../store/entries'
import { confirm, toast } from '../components/ui'
import { isLiveStatus } from './entryMeta'

/**
 * 服务页的纯逻辑，UI-REFACTOR §3.3。组件只负责展示，启停的确认与汇总通知都在这里，
 * 这样服务页、总览的服务操作台、命令面板走的是同一套规则。
 *
 * 安全说明：这里只调用 store 里已有的 start / stop，命令构造与归属校验仍全部在主进程。
 */

export type EntryClass = 'fe' | 'be' | 'task'

/** 后端生态。其余框架（含 electron、uniapp、静态站）都算前端 */
const BACKEND: readonly Framework[] = [
  'spring-boot', 'django', 'fastapi', 'flask', 'python', 'go', 'rust', 'cpp', 'docker-compose', 'node'
]

export function classOf(entry: LaunchEntry): EntryClass {
  if (entry.kind === 'task') return 'task'
  return BACKEND.includes(entry.framework) ? 'be' : 'fe'
}

export type ClassFilter = 'all' | EntryClass

export function matchesQuery(entry: LaunchEntry, runtime: EntryRuntime | undefined, q: string): boolean {
  const s = q.trim().toLowerCase()
  if (!s) return true
  const port = runtime?.port ?? entry.expectedPort
  return (
    entry.name.toLowerCase().includes(s) ||
    entry.path.toLowerCase().includes(s) ||
    (entry.category ?? '').toLowerCase().includes(s) ||
    (port != null && String(port).includes(s))
  )
}

/** 能被「全部启动」带上的成员：常驻服务、可启动、不由 HBuilderX 接管 */
export function isGroupStartable(entry: LaunchEntry): boolean {
  return entry.kind === 'service' && !entry.registerOnly && entry.framework !== 'uniapp'
}

/**
 * 启动前的环境确认。
 * - prod：任何条目都要确认（Q14）。
 * - sandbox：spring-boot 条目要确认（PRD-WORKGROUPS §5.2.1，比 Q14 更严，按 PRD 保留）。
 */
async function confirmEnv(entries: LaunchEntry[], group: ProjectGroup | undefined): Promise<boolean> {
  if (!group) return true
  const names = entries.map((e) => `「${e.name}」`).join('、')
  if (group.env === 'prod') {
    return confirm({
      title: `在生产环境启动${entries.length > 1 ? ` ${entries.length} 个服务` : ''}？`,
      body: `工作组「${group.name}」处于${GROUP_ENV_LABEL.prod}环境，启动 ${names} 会影响真实业务数据。`,
      okLabel: '确认启动',
      danger: true
    })
  }
  if (group.env === 'sandbox' && entries.some((e) => e.framework === 'spring-boot')) {
    return confirm({
      title: '在沙箱环境启动？',
      body: `工作组「${group.name}」处于${GROUP_ENV_LABEL.sandbox}环境，确认后启动 ${names}。`,
      okLabel: '确认启动'
    })
  }
  return true
}

export interface StartHooks {
  /** 预检拦下时调用，服务页借此打开详情的「诊断」标签 */
  onBlocked?: (entry: LaunchEntry, precheck: PrecheckResult) => void
}

/** 启动单个条目。返回 true 表示真的发出了启动（被预检拦下或取消都算 false） */
export async function startEntry(entry: LaunchEntry, group: ProjectGroup | undefined, hooks: StartHooks = {}): Promise<boolean> {
  if (!(await confirmEnv([entry], group))) return false
  const blocked = await useEntries.getState().start(entry.id)
  if (blocked) {
    hooks.onBlocked?.(entry, blocked)
    return false
  }
  return true
}

/** 整组启动：只确认一次，结束后发一条汇总通知（Q14） */
export async function startGroup(group: ProjectGroup, members: LaunchEntry[], hooks: StartHooks = {}): Promise<void> {
  const { runtimes, start } = useEntries.getState()
  const todo = members.filter((e) => isGroupStartable(e) && !isLiveStatus(runtimes[e.id]?.status ?? 'idle'))
  if (!todo.length) {
    toast({ tone: 'info', title: `${group.name}：全部已在运行` })
    return
  }
  if (!(await confirmEnv(todo, group))) return

  const results = await Promise.all(
    todo.map(async (e) => ({ e, blocked: await start(e.id).catch(() => null) }))
  )
  const failed = results.filter((r) => r.blocked)
  const ok = results.length - failed.length
  if (!failed.length) {
    toast({ tone: 'live', title: `${group.name}：${ok} 个已启动` })
    return
  }
  const first = failed[0]
  toast({
    tone: 'fault',
    title: `${group.name}：${ok} 个已启动，${failed.length} 个被预检拦下`,
    body: failed.map((r) => r.e.name).join('、'),
    action: hooks.onBlocked && first.blocked
      ? { label: '查看诊断', run: () => hooks.onBlocked?.(first.e, first.blocked as PrecheckResult) }
      : undefined
  })
}

export async function stopGroup(group: ProjectGroup, members: LaunchEntry[]): Promise<void> {
  const { runtimes, stop } = useEntries.getState()
  const live = members.filter((e) => isLiveStatus(runtimes[e.id]?.status ?? 'idle'))
  await Promise.all(live.map((e) => stop(e.id)))
  if (live.length) toast({ tone: 'info', title: `${group.name}：已停止 ${live.length} 个` })
}

/** 强制关闭：主进程走与停止相同的归属校验路径，这里只多一道确认（Q14） */
export async function forceStop(entry: LaunchEntry): Promise<void> {
  const ok = await confirm({
    title: `强制关闭「${entry.name}」？`,
    body: '只会结束本应用启动的进程树，可能丢失未保存的数据。',
    okLabel: '强制关闭',
    danger: true
  })
  if (ok) await useEntries.getState().stop(entry.id)
}

export async function removeEntry(entry: LaunchEntry): Promise<boolean> {
  const ok = await confirm({
    title: `移除「${entry.name}」？`,
    body: '只移除登记，不会删除项目目录里的任何文件。',
    okLabel: '移除',
    danger: true
  })
  if (ok) await useEntries.getState().remove(entry.id)
  return ok
}

/** 打开产物：任务成功后在资源管理器里定位产物，其余情况打开产物目录。路径都由主进程构造 */
export function openOutput(entry: LaunchEntry, runtime: EntryRuntime | undefined): void {
  if (entry.kind === 'task' && runtime?.status === 'succeeded') {
    void window.mile.entry.revealOutput(entry.id)
  } else {
    void window.mile.entry.outputDir(entry.id).then((dir) => dir && window.mile.shell.openPath(dir))
  }
}

/**
 * 运行状态筛选，补回旧启动台的「运行中 / 已停止 / 异常」。
 * 任务的成功、已取消算「已停止」，失败算「异常」；启动中、停止中算「运行中」。
 */
export type StatusFilter = 'all' | 'running' | 'stopped' | 'fault'

const FAULT_STATUSES = new Set(['crashed', 'failed', 'blocked'])

export function matchesStatus(runtime: EntryRuntime | undefined, f: StatusFilter): boolean {
  if (f === 'all') return true
  const s = runtime?.status ?? 'idle'
  if (f === 'running') return isLiveStatus(s)
  if (f === 'fault') return FAULT_STATUSES.has(s)
  return !isLiveStatus(s) && !FAULT_STATUSES.has(s)
}
