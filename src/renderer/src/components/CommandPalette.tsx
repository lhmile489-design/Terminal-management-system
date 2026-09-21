import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, MagnifyingGlass } from '@phosphor-icons/react'
import type { LaunchEntry, ListenerSnapshot, ThemePreference } from '@shared/types'
import { STATUS_META } from '../lib/entryMeta'

/**
 * 全局命令面板，PRD §9.5。Ctrl+K 唤起，单输入框实时匹配并分组。
 *
 * 「直接添加服务或任务」是硬需求：不必先去启动台页面，面板内就能走完
 * 选目录 → 识别 → 入库。这里只负责发起，识别与确认交给既有的 AddEntryDialog，
 * 避免两套识别逻辑产生分歧。
 */
export type PaletteAction =
  | { type: 'startEntry'; entry: LaunchEntry }
  | { type: 'stopEntry'; entry: LaunchEntry }
  | { type: 'locatePort'; port: number }
  | { type: 'runScript'; entry: LaunchEntry; script: string }
  | { type: 'addEntry'; kind: 'service' | 'task' }
  | { type: 'refresh' }
  | { type: 'setTheme'; preference: ThemePreference }
  | { type: 'goto'; view: 'dashboard' | 'launchpad' | 'backend' | 'terminal' | 'diagnose' | 'settings' }

interface Candidate {
  id: string
  group: string
  label: string
  hint?: string
  action: PaletteAction
}

const VIEW_LABEL: Record<string, string> = {
  dashboard: '工作台',
  launchpad: '前端启动台',
  backend: '后端控制台',
  terminal: '终端',
  diagnose: '诊断',
  settings: '设置'
}

export function CommandPalette({
  open,
  entries,
  listeners,
  runtimeStatus,
  onClose,
  onRun
}: {
  open: boolean
  entries: LaunchEntry[]
  listeners: ListenerSnapshot[]
  runtimeStatus: (id: string) => string
  onClose: () => void
  onRun: (action: PaletteAction) => void
}): React.JSX.Element | null {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // 每次打开都从空查询开始：上次搜的东西留着会让回车误触
  useEffect(() => {
    if (open) {
      setQuery('')
      setCursor(0)
      inputRef.current?.focus()
    }
  }, [open])

  const candidates = useMemo(
    () => buildCandidates(query, entries, listeners, runtimeStatus),
    [query, entries, listeners, runtimeStatus]
  )

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(candidates.length - 1, 0)))
  }, [candidates.length])

  // 键盘移动时把选中项滚进视野，否则长列表下按方向键像是没反应
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [cursor, candidates.length])

  const run = useCallback(
    (candidate: Candidate | undefined) => {
      if (!candidate) return
      onClose()
      onRun(candidate.action)
    },
    [onClose, onRun]
  )

  if (!open) return null

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => (candidates.length === 0 ? 0 : (c + 1) % candidates.length))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => (candidates.length === 0 ? 0 : (c - 1 + candidates.length) % candidates.length))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      run(candidates[cursor])
    }
  }

  let lastGroup = ''

  return (
    <div
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 pt-[12vh]"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onKeyDown={onKeyDown}
        className="flex max-h-[64vh] w-[560px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-[12px] border border-line-strong bg-panel"
      >
        <div className="flex shrink-0 items-center gap-2.5 border-b border-line px-3.5 py-3">
          <MagnifyingGlass size={15} weight="bold" className="shrink-0 text-ink-faint" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setCursor(0)
            }}
            placeholder="搜索条目、端口、脚本，或输入 > 执行动作"
            aria-label="命令面板输入"
            aria-controls="palette-results"
            className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink-strong placeholder:text-ink-faint focus:outline-none"
          />
          <kbd className="shrink-0 rounded-[4px] border border-line-strong px-1.5 py-0.5 font-mono text-[10px] text-ink-faint">
            Esc
          </kbd>
        </div>

        <div id="palette-results" ref={listRef} role="listbox" className="min-h-0 flex-1 overflow-y-auto py-1.5">
          {candidates.length === 0 ? (
            <p className="px-3.5 py-6 text-center text-[12.5px] text-ink-faint">没有匹配项</p>
          ) : (
            candidates.map((c, i) => {
              const header = c.group !== lastGroup ? c.group : null
              lastGroup = c.group
              return (
                <div key={c.id}>
                  {header && (
                    <p className="px-3.5 pt-2 pb-1 font-mono text-[10px] font-semibold tracking-[0.12em] text-ink-faint uppercase">
                      {header}
                    </p>
                  )}
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === cursor}
                    data-active={i === cursor}
                    // 只有鼠标真的移动过才跟随，否则光标恰好停在列表上时，
                    // 键盘选中会被静默改掉，回车执行到另一项
                    onMouseMove={() => setCursor(i)}
                    onClick={() => run(c)}
                    className={`pressable-flat flex w-full items-center gap-2.5 px-3.5 py-2 text-left ${
                      i === cursor ? 'bg-raised' : ''
                    }`}
                  >
                    <ArrowRight
                      size={12}
                      weight="bold"
                      className={`shrink-0 ${i === cursor ? 'text-info' : 'text-ink-faint opacity-0'}`}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-ink-strong">{c.label}</span>
                    {c.hint && (
                      <span className="shrink-0 font-mono text-[11px] text-ink-faint">{c.hint}</span>
                    )}
                  </button>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

/** 子序列匹配：输入 "lnw" 能命中 "late-night-website" */
function fuzzy(text: string, query: string): boolean {
  if (!query) return true
  const t = text.toLowerCase()
  const q = query.toLowerCase()
  let i = 0
  for (const ch of t) {
    if (ch === q[i]) i++
    if (i === q.length) return true
  }
  return false
}

function buildCandidates(
  raw: string,
  entries: LaunchEntry[],
  listeners: ListenerSnapshot[],
  runtimeStatus: (id: string) => string
): Candidate[] {
  const query = raw.trim()

  // "> " 前缀进入内置动作模式，PRD §9.5
  if (query.startsWith('>')) {
    const rest = query.slice(1).trim()
    return BUILTINS.filter((b) => fuzzy(b.label, rest)).map((b) => ({ ...b, group: '动作' }))
  }

  const out: Candidate[] = []

  // 纯数字优先当端口理解
  const asPort = /^\d{1,5}$/.test(query) ? Number(query) : null
  if (asPort !== null && asPort > 0 && asPort <= 65535) {
    const hit = listeners.filter((l) => l.ports.some((p) => String(p).startsWith(query)))
    for (const l of hit.slice(0, 6)) {
      for (const port of l.ports.filter((p) => String(p).startsWith(query)).slice(0, 2)) {
        out.push({
          id: `port-${l.pid}-${port}`,
          group: '监听端口',
          label: `:${port} · ${l.processName}`,
          hint: `PID ${l.pid}`,
          action: { type: 'locatePort', port }
        })
      }
    }
  }

  for (const entry of entries) {
    if (!fuzzy(entry.name, query) && !fuzzy(entry.path, query)) continue
    const status = runtimeStatus(entry.id)
    const running = status === 'running' || status === 'starting'
    out.push({
      id: `entry-${entry.id}`,
      group: entry.kind === 'service' ? '服务' : '任务',
      label: `${running ? '停止' : '启动'} ${entry.name}`,
      hint: STATUS_META[status as keyof typeof STATUS_META]?.label ?? status,
      action: running ? { type: 'stopEntry', entry } : { type: 'startEntry', entry }
    })
  }

  // 脚本名匹配：选中后在该项目目录创建会话执行
  if (query.length >= 2) {
    for (const entry of entries) {
      for (const script of Object.keys(entry.scripts ?? {})) {
        if (!fuzzy(script, query)) continue
        out.push({
          id: `script-${entry.id}-${script}`,
          group: '脚本',
          label: `${script} · ${entry.name}`,
          hint: 'run',
          action: { type: 'runScript', entry, script }
        })
      }
    }
  }

  // 空查询时给出内置动作，面板一打开就是可用的
  if (!query) out.push(...BUILTINS.map((b) => ({ ...b, group: '动作' })))

  return out.slice(0, 40)
}

const BUILTINS: Omit<Candidate, 'group'>[] = [
  { id: 'add-service', label: '添加服务', hint: '选目录', action: { type: 'addEntry', kind: 'service' } },
  { id: 'add-task', label: '添加任务', hint: '选目录', action: { type: 'addEntry', kind: 'task' } },
  { id: 'refresh', label: '刷新采集', action: { type: 'refresh' } },
  { id: 'theme-light', label: '主题：浅色', action: { type: 'setTheme', preference: 'light' } },
  { id: 'theme-dark', label: '主题：深色', action: { type: 'setTheme', preference: 'dark' } },
  { id: 'theme-system', label: '主题：跟随系统', action: { type: 'setTheme', preference: 'system' } },
  ...(['dashboard', 'launchpad', 'backend', 'terminal', 'diagnose', 'settings'] as const).map((view) => ({
    id: `goto-${view}`,
    label: `前往${VIEW_LABEL[view]}`,
    action: { type: 'goto' as const, view }
  }))
]
