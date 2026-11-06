import { useMemo, useRef, useState } from 'react'
import type { EntryRuntime, LaunchEntry, ProjectGroup } from '@shared/types'
import { STATUS_META, type Tone } from '../../lib/entryMeta'
import { ICON } from '../../lib/icons'

/** 节点尺寸与间距，全部是 SVG 坐标 */
const NODE_W = 148
const NODE_H = 32
const COL_GAP = 56
const ROW_GAP = 12
const PAD = 8
/** 节点数超过这个值默认折叠，避免一进服务页就被一张大图挤掉列表 */
const COLLAPSE_OVER = 30
const NAME_MAX = 14

const TONE_STROKE: Record<Tone, string> = {
  idle: 'var(--stroke-strong)',
  live: 'var(--signal-live)',
  warn: 'var(--signal-warn)',
  fault: 'var(--signal-fault)',
  info: 'var(--signal-info)',
  accent: 'var(--signal-accent)'
}

interface Node {
  entry: LaunchEntry
  col: number
  row: number
}

interface Layout {
  group: ProjectGroup | null
  nodes: Node[]
  edges: { from: string; to: string }[]
  cols: number
  rows: number
}

/**
 * 启动顺序视图（PRD-FEATURE-UPGRADE P1-5）。
 *
 * 只画 `startAfter`：从左到右按 `EntryService.startOrdered` 同样的分层排列，连线从前置指向
 * 依赖它的条目。这是启动顺序，不是运行期的调用依赖（那是 PRD-workspace-environment §3.3，
 * 另行排期）。只展示，节点上 Enter / 点击只打开详情，不启停。
 */
export function StartOrderView({
  entries,
  groups,
  runtimes,
  onOpen
}: {
  entries: LaunchEntry[]
  groups: ProjectGroup[]
  runtimes: Record<string, EntryRuntime>
  onOpen: (entry: LaunchEntry) => void
}): React.JSX.Element | null {
  const layouts = useMemo(() => buildLayouts(entries, groups), [entries, groups])
  const total = layouts.reduce((n, l) => n + l.nodes.length, 0)
  const [open, setOpen] = useState(() => total <= COLLAPSE_OVER)
  const refs = useRef(new Map<string, SVGGElement>())

  if (layouts.length === 0) return null

  // 焦点顺序：先按组，再按列、行。方向键在这个序列里前后移动
  const order = layouts.flatMap((l) => l.nodes.map((n) => n.entry.id))
  const move = (id: string, delta: number): void => {
    const i = order.indexOf(id)
    const next = order[Math.min(order.length - 1, Math.max(0, i + delta))]
    refs.current.get(next)?.focus()
  }

  return (
    <section className="ui-tile start-order" data-start-order aria-labelledby="start-order-heading">
      <button
        type="button"
        className="start-order-toggle"
        aria-expanded={open}
        aria-controls="start-order-body"
        onClick={() => setOpen((v) => !v)}
      >
        <ICON.moveDown size={16} aria-hidden className="start-order-caret" data-open={open || undefined} />
        <span id="start-order-heading">启动顺序</span>
        <span className="start-order-count">{total} 个服务</span>
      </button>
      {open && (
        <div id="start-order-body" className="start-order-body">
          <p className="start-order-note">整组启动时从左到右分批，同一列同时启动。只显示设置了「先等待」的工作组</p>
          {layouts.map((l) => (
            <figure key={l.group?.id ?? '_none'} className="start-order-group" data-start-order-group={l.group?.id ?? ''}>
              <figcaption>{l.group?.name ?? '未分组'}</figcaption>
              <svg
                width={width(l)}
                height={height(l)}
                viewBox={`0 0 ${width(l)} ${height(l)}`}
                role="group"
                aria-label={`${l.group?.name ?? '未分组'} 的启动顺序，${l.cols} 批`}
                data-cols={l.cols}
              >
                <defs>
                  <marker id={`arrow-${l.group?.id ?? 'none'}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto">
                    <path d="M0 0 L8 4 L0 8 z" fill="var(--text-faint)" />
                  </marker>
                </defs>
                {l.edges.map((e) => {
                  const a = l.nodes.find((n) => n.entry.id === e.from)!
                  const b = l.nodes.find((n) => n.entry.id === e.to)!
                  const x1 = nx(a) + NODE_W
                  const y1 = ny(a) + NODE_H / 2
                  const x2 = nx(b) - 2
                  const y2 = ny(b) + NODE_H / 2
                  const mid = (x1 + x2) / 2
                  return (
                    <path
                      key={`${e.from}->${e.to}`}
                      data-start-edge={`${e.from}->${e.to}`}
                      d={`M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`}
                      fill="none"
                      stroke="var(--text-faint)"
                      strokeWidth="1.25"
                      markerEnd={`url(#arrow-${l.group?.id ?? 'none'})`}
                    />
                  )
                })}
                {l.nodes.map((n) => {
                  const rt = runtimes[n.entry.id]
                  const meta = STATUS_META[rt?.status ?? 'idle']
                  const name = n.entry.name.length > NAME_MAX ? `${n.entry.name.slice(0, NAME_MAX)}…` : n.entry.name
                  return (
                    <g
                      key={n.entry.id}
                      ref={(el) => {
                        if (el) refs.current.set(n.entry.id, el)
                        else refs.current.delete(n.entry.id)
                      }}
                      className="start-order-node"
                      data-start-node={n.entry.id}
                      data-col={n.col}
                      tabIndex={0}
                      role="button"
                      aria-label={`${n.entry.name}，第 ${n.col + 1} 批，${meta.label}，打开详情`}
                      transform={`translate(${nx(n)} ${ny(n)})`}
                      onClick={() => onOpen(n.entry)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          onOpen(n.entry)
                        } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                          e.preventDefault()
                          move(n.entry.id, 1)
                        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                          e.preventDefault()
                          move(n.entry.id, -1)
                        }
                      }}
                    >
                      <title>{`${n.entry.name} · ${meta.label}`}</title>
                      {/* 状态色只染描边，不染底 */}
                      <rect
                        width={NODE_W}
                        height={NODE_H}
                        rx="10"
                        fill="var(--surface-card)"
                        stroke={TONE_STROKE[meta.tone]}
                        strokeWidth="1.5"
                      />
                      <text x="12" y={NODE_H / 2} dominantBaseline="central" fontSize="12" fill="var(--text-strong)">
                        {name}
                      </text>
                    </g>
                  )
                })}
              </svg>
            </figure>
          ))}
        </div>
      )}
    </section>
  )
}

const nx = (n: Node): number => PAD + n.col * (NODE_W + COL_GAP)
const ny = (n: Node): number => PAD + n.row * (NODE_H + ROW_GAP)
const width = (l: Layout): number => PAD * 2 + l.cols * NODE_W + (l.cols - 1) * COL_GAP
const height = (l: Layout): number => PAD * 2 + l.rows * NODE_H + (l.rows - 1) * ROW_GAP

/**
 * 每个工作组一张图，只画组里至少有一条 startAfter 的组。分层规则与 startOrdered 一致：
 * 只认本组内的前置，没有前置的在第 0 列，其余在「最深前置 + 1」列。旧配置里万一成环，
 * 访问标记兜住，环上的节点落在第 0 列，不会死循环。
 */
function buildLayouts(entries: LaunchEntry[], groups: ProjectGroup[]): Layout[] {
  const services = entries.filter((e) => e.kind === 'service')
  const byGroup = new Map<string, LaunchEntry[]>()
  for (const e of services) {
    const key = e.groupId ?? ''
    byGroup.set(key, [...(byGroup.get(key) ?? []), e])
  }

  const ordered = [...groups].sort((a, b) => a.order - b.order)
  const keys = [...ordered.map((g) => g.id), '']
  const out: Layout[] = []
  for (const key of keys) {
    const members = (byGroup.get(key) ?? []).sort((a, b) => a.order - b.order)
    const ids = new Set(members.map((m) => m.id))
    const deps = new Map(members.map((m) => [m.id, (m.startAfter ?? []).filter((d) => ids.has(d) && d !== m.id)]))
    const edges = members.flatMap((m) => deps.get(m.id)!.map((d) => ({ from: d, to: m.id })))
    if (edges.length === 0) continue

    const depth = new Map<string, number>()
    const visiting = new Set<string>()
    const level = (id: string): number => {
      const known = depth.get(id)
      if (known !== undefined) return known
      if (visiting.has(id)) return 0
      visiting.add(id)
      const ds = deps.get(id) ?? []
      const d = ds.length ? Math.max(...ds.map(level)) + 1 : 0
      visiting.delete(id)
      depth.set(id, d)
      return d
    }
    const rowsPerCol = new Map<number, number>()
    const nodes: Node[] = members.map((entry) => {
      const col = level(entry.id)
      const row = rowsPerCol.get(col) ?? 0
      rowsPerCol.set(col, row + 1)
      return { entry, col, row }
    })
    out.push({
      group: key ? (ordered.find((g) => g.id === key) ?? null) : null,
      nodes,
      edges,
      cols: Math.max(...nodes.map((n) => n.col)) + 1,
      rows: Math.max(...rowsPerCol.values())
    })
  }
  return out
}
