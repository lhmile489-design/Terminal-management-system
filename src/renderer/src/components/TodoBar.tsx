import { useMemo } from 'react'
import type { EntryRuntime, LaunchEntry, ListenerSnapshot } from '@shared/types'
import { Button } from './ui'
import { ICON } from '../lib/icons'
import { STATUS_META } from '../lib/entryMeta'
import { formatClock } from '../lib/format'

interface TodoItem {
  key: string
  kind: 'conflict' | 'fault' | 'scan'
  text: string
  action: { label: string; run: () => void }
}

/**
 * 总览顶部的待办条（2.2.0）：把「需要处理的事」合成可点的行动行。
 *
 * 全部由渲染层已有的状态算出，不新增 IPC。按钮只导航或重试采集，不触发启停 ——
 * 启停仍要用户在服务页或操作台上明确点。
 *   - 端口冲突：与主进程 countConflicts 同一口径 —— 条目的端口（运行中取实听端口，
 *     否则取预期端口）上有不属于该条目的监听。
 *   - 失败：状态色调为 fault 的条目（预检未通过、异常退出、任务失败）。
 *   - 采集失败：端口表停在旧数据上，给「重试」。
 */
export function TodoBar({
  entries,
  runtimes,
  listeners,
  scanFailed,
  lastSuccessAt,
  onFocusService
}: {
  entries: LaunchEntry[]
  runtimes: Record<string, EntryRuntime>
  listeners: ListenerSnapshot[]
  scanFailed: boolean
  lastSuccessAt: number | null
  onFocusService: (id: string, tab: 'diagnose' | 'output') => void
}): React.JSX.Element {
  const items = useMemo(() => {
    const out: TodoItem[] = []
    if (scanFailed) {
      out.push({
        key: 'scan',
        kind: 'scan',
        text: `端口采集失败，下面的数据停在 ${lastSuccessAt ? formatClock(lastSuccessAt) : '启动时'}`,
        action: { label: '重试', run: () => window.mile.scanner.refresh() }
      })
    }
    for (const e of entries) {
      const rt = runtimes[e.id]
      const status = rt?.status ?? 'idle'
      if (STATUS_META[status].tone === 'fault') {
        out.push({
          key: `fault-${e.id}`,
          kind: 'fault',
          text: `${e.name}：${STATUS_META[status].label}`,
          // 预检未通过看诊断；退出类看输出里最后几行
          action: status === 'blocked'
            ? { label: '查看诊断', run: () => onFocusService(e.id, 'diagnose') }
            : { label: '查看输出', run: () => onFocusService(e.id, 'output') }
        })
      }
      const port = rt?.port ?? e.expectedPort
      if (!port) continue
      // 同一端口可能被两个进程分别占住（IPv4 / IPv6），用 filter 排掉自己，不取第一行
      const others = listeners.filter((l) => l.ports.includes(port) && l.entryId !== e.id)
      if (others.length) {
        out.push({
          key: `conflict-${e.id}`,
          kind: 'conflict',
          text: `${e.name} 的端口 :${port} 被 ${others.map((l) => `${l.processName}（PID ${l.pid}）`).join('、')} 占用`,
          action: { label: '查看诊断', run: () => onFocusService(e.id, 'diagnose') }
        })
      }
    }
    return out
  }, [entries, runtimes, listeners, scanFailed, lastSuccessAt, onFocusService])

  return (
    <section className="dash-todo" data-todo aria-labelledby="todo-heading" aria-live="polite">
      <h2 id="todo-heading" className="sr-only">待处理</h2>
      {items.length === 0 ? (
        <p className="dash-todo-ok">
          <ICON.success size={16} aria-hidden />
          一切正常：没有端口冲突、失败的服务或采集错误
        </p>
      ) : (
        <ul className="dash-todo-list">
          {items.map((it) => (
            <li key={it.key} className="dash-todo-item" data-todo-item={it.kind} data-tone={it.kind === 'scan' ? 'warn' : 'fault'}>
              <ICON.failed size={16} aria-hidden />
              <span className="dash-todo-text">{it.text}</span>
              <Button size="sm" onClick={it.action.run}>{it.action.label}</Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
