import { useScanner } from '../store/scanner'
import { useEntries } from '../store/entries'
import { formatClock } from '../lib/format'

/**
 * 端口占用历史（PRD-FEATURE-UPGRADE P1-4）。
 *
 * 只读：每行是「某个 PID 在某个端口开始 / 停止监听」。进程名是进程自己能写的，
 * 这里只展示，不给任何终止、提升之类的操作入口（红线 2）。只在内存，应用重启后清空。
 */
export function PortHistory(): React.JSX.Element {
  const events = useScanner((s) => s.portHistory)
  const entries = useEntries((s) => s.entries)

  if (events.length === 0) {
    return (
      <div className="surface-card px-6 py-10 text-center" data-port-history-empty>
        <p className="text-[13px] text-ink-muted">本次运行期间还没有端口开始或停止监听</p>
        <p className="mt-1 text-[12px] text-ink-faint">只记录应用启动之后的变化，最多 200 条，不落盘</p>
      </div>
    )
  }

  const nameOf = (id?: string): string | undefined => (id ? entries.find((e) => e.id === id)?.name : undefined)

  return (
    <div className="surface-card port-history" data-port-history>
      <ol className="port-history-list" aria-label="端口占用历史">
        {events.map((ev) => {
          const entryName = nameOf(ev.entryId)
          return (
            <li
              key={ev.seq}
              className="port-history-row"
              data-port-event={ev.kind}
              data-port={ev.port}
              data-pid={ev.pid}
            >
              <span className="port-history-time">{formatClock(ev.at)}</span>
              <span className="port-history-kind" data-kind={ev.kind}>
                {ev.kind === 'start' ? '开始监听' : '停止监听'}
              </span>
              <span className="port-history-port">:{ev.port}</span>
              <span className="port-history-pid">PID {ev.pid}</span>
              <span className="port-history-name" title={ev.processName}>
                {ev.processName}
                {entryName && <em className="port-history-entry">{entryName}</em>}
              </span>
            </li>
          )
        })}
      </ol>
      <p className="port-history-note">只记录应用启动之后的变化，最多 200 条，不落盘</p>
    </div>
  )
}
