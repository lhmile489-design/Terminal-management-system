import type { ProjectGroup } from '@shared/types'
import { GROUP_ENV_LABEL } from '@shared/types'
import { boardProgress, boardStatus, nextFireAt, timeOfDay, WEEKDAY_LABEL, type PlannerBoard } from '@shared/planner'
import { Pill, Tile } from '../ui'
import { ICON } from '../../lib/icons'
import type { Tone } from '../../lib/entryMeta'

/** 看板状态 → 胶囊色调。状态只染描边与胶囊，不染底（UI 约定） */
export const BOARD_PILL: Record<'overdue' | 'complete' | 'soon' | 'normal', Tone> = {
  overdue: 'fault',
  complete: 'live',
  soon: 'warn',
  normal: 'idle'
}

/**
 * 进度条：6px 胶囊。宽度变化走 transform: scaleX + spring，不动画 width。
 * 读屏读「已完成 12 项，共 20 项」。
 */
export function ProgressBar({ board }: { board: Pick<PlannerBoard, 'tasks'> }): React.JSX.Element {
  const p = boardProgress(board)
  const ratio = p.total === 0 ? 0 : p.done / p.total
  return (
    <div className="pl-progress">
      <div
        className="pl-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={p.total}
        aria-valuenow={p.done}
        aria-valuetext={p.total === 0 ? '还没有任务' : `已完成 ${p.done} 项，共 ${p.total} 项`}
        data-complete={p.total > 0 && p.done === p.total ? true : undefined}
      >
        <span className="pl-bar-fill" style={{ transform: `scaleX(${ratio})` }} />
      </div>
      <span className="pl-progress-num" data-board-progress>
        {p.total === 0 ? (
          '还没有任务'
        ) : (
          <>
            {p.done} / {p.total}
            <b>{p.percent}%</b>
          </>
        )}
      </span>
    </div>
  )
}

/** 'YYYY-MM-DD' → 'MM-DD'，同一年内不重复写年份 */
export function shortDate(d?: string): string {
  return d ? d.slice(5) : ''
}

/** 「今天 15:00」「明天 09:15」「11-10 周一 09:15」 */
function nextLabel(at: number): string {
  const t = timeOfDay(at)
  const a = new Date(at)
  const n = new Date()
  const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diff = Math.round((startOfDay(a) - startOfDay(n)) / 86_400_000)
  if (diff === 0) return `下次提醒 今天 ${t}`
  if (diff === 1) return `下次提醒 明天 ${t}`
  return `下次提醒 ${String(a.getMonth() + 1).padStart(2, '0')}-${String(a.getDate()).padStart(2, '0')} 周${WEEKDAY_LABEL[a.getDay()]} ${t}`
}

/** 看板磁贴：整块可点，打开详情。键盘 Enter / Space 同样打开 */
export function BoardTile({
  board,
  group,
  selected,
  today,
  onOpen
}: {
  board: PlannerBoard
  group?: ProjectGroup
  selected: boolean
  today: string
  onOpen: () => void
}): React.JSX.Element {
  const status = boardStatus(board, today)
  const tone = status.tone === 'overdue' ? 'fault' : status.tone === 'complete' ? 'live' : undefined
  const name = group?.name ?? '工作组已删除'
  const hasRange = !!(board.startDate || board.endDate)
  // 「下次提醒」取所有未暂停日程里最近的一条（PRD §4.6 第三行）
  const next = board.schedules.reduce<number | null>(
    (acc, s) => {
      const at = nextFireAt(s, Date.now())
      return at === null ? acc : acc === null || at < acc ? at : acc
    },
    null
  )

  return (
    <Tile
      as="article"
      interactive
      tone={tone}
      className="pl-board"
      data-board-id={board.id}
      data-board-tone={status.tone}
      data-selected={selected || undefined}
      aria-current={selected || undefined}
      aria-label={`${name} 看板`}
      tabIndex={0}
      role="button"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
    >
      <div className="pl-board-head">
        <ICON.planner size={20} aria-hidden className="pl-board-icon" />
        <h3 className="ui-tile-title">{name}</h3>
        {group?.pinned && (
          <span className="svc-pinned" title="已置顶">
            <ICON.pin size={12} aria-hidden />
            置顶
          </span>
        )}
        {group ? (
          <span className="svc-env" data-env={group.env}>{GROUP_ENV_LABEL[group.env]}</span>
        ) : (
          <Pill tone="fault">工作组已删除</Pill>
        )}
      </div>
      <ProgressBar board={board} />
      <div className="pl-board-foot">
        <span className="pl-range" data-empty={!hasRange || undefined}>
          {hasRange ? `${shortDate(board.startDate) || '未定'} → ${shortDate(board.endDate) || '未定'}` : '未设置日期'}
        </span>
        {status.label && (
          <Pill tone={BOARD_PILL[status.tone]}>
            <span data-board-status>{status.label}</span>
          </Pill>
        )}
      </div>
      {next && (
        <div className="pl-board-next" data-next-reminder>
          <ICON.reminder size={16} aria-hidden />
          <span>{nextLabel(next)}</span>
        </div>
      )}
    </Tile>
  )
}
