import { useState, useCallback, useMemo } from 'react'
import { useOverlay } from '../../lib/overlay'
import { Users, Warning, CheckCircle } from '@phosphor-icons/react'
import type { GroupEnvironment, LaunchEntry, ProjectGroup } from '@shared/types'
import { GROUP_ENV_LABEL } from '@shared/types'
import { useEntries } from '../../store/entries'

/**
 * 工作组的创建 / 编辑对话框与成员分配对话框。原在 GroupsPanel，工作组页并入服务页（Q10）后
 * 只剩这两个对话框还在用，搬到这里。
 */

const ENV_BADGE: Record<GroupEnvironment, string> = {
  dev:     'bg-live/10 text-live border border-live/20',
  sandbox: 'bg-warn/10 text-warn border border-warn/20',
  prod:    'bg-fault/10 text-fault border border-fault/20'
}

// ─── 工作组对话框（创建 / 编辑）────────────────────────────────────────────────

interface GroupDialogProps {
  initial?: ProjectGroup
  onSubmit: (name: string, description: string, env: GroupEnvironment) => Promise<void>
  onClose: () => void
}

export function GroupDialog({ initial, onSubmit, onClose }: GroupDialogProps): React.JSX.Element {
  const [name, setName] = useState(initial?.name ?? '')
  const [desc, setDesc] = useState(initial?.description ?? '')
  const [env, setEnv] = useState<GroupEnvironment>(initial?.env ?? 'dev')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!name.trim()) { setErr('名称不能为空'); return }
    if (name.trim().length > 40) { setErr('名称不超过 40 字'); return }
    setLoading(true)
    setErr(null)
    try {
      await onSubmit(name.trim(), desc.trim(), env)
      onClose()
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : '操作失败')
    } finally {
      setLoading(false)
    }
  }

  const panelRef = useOverlay<HTMLDivElement>(onClose)
  return (
    <div
      className="dlg-scrim fixed inset-0 z-50 flex items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={initial ? '编辑工作组' : '新建工作组'} className="dlg-panel w-full max-w-[400px] p-5">
        <h2 className="mb-4 dlg-title">
          {initial ? '编辑工作组' : '新建工作组'}
        </h2>

        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
          {/* 名称 */}
          <div>
            <label htmlFor="group-name" className="mb-1 block font-mono text-[12px] font-bold uppercase tracking-[0.15em] text-ink-faint">
              名称 <span className="text-fault">*</span>
            </label>
            <input
              id="group-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              placeholder="例：商城系统"
              autoFocus
              className="w-full rounded-control border border-line bg-raised/50 px-2.5 py-1.5 text-[12.5px] text-ink-strong placeholder-ink-faint/40 outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20"
            />
          </div>

          {/* 描述 */}
          <div>
            <label htmlFor="group-desc" className="mb-1 block font-mono text-[12px] font-bold uppercase tracking-[0.15em] text-ink-faint">
              描述（可选）
            </label>
            <input
              id="group-desc"
              type="text"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              maxLength={120}
              placeholder="简短说明这个工作组的用途"
              className="w-full rounded-control border border-line bg-raised/50 px-2.5 py-1.5 text-[12.5px] text-ink-strong placeholder-ink-faint/40 outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20"
            />
          </div>

          {/* 环境 */}
          <div>
            <span className="mb-1.5 block font-mono text-[12px] font-bold uppercase tracking-[0.15em] text-ink-faint">
              初始环境
            </span>
            <div className="flex gap-2">
              {(['dev', 'sandbox', 'prod'] as GroupEnvironment[]).map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => setEnv(e)}
                  className={[
                    'pressable flex-1 rounded-control border py-1.5 text-[12px] font-medium transition-all duration-150',
                    env === e
                      ? ENV_BADGE[e]
                      : 'border-line bg-raised/40 text-ink-faint hover:bg-raised hover:text-ink-muted'
                  ].join(' ')}
                >
                  {GROUP_ENV_LABEL[e]}
                </button>
              ))}
            </div>
          </div>

          {/* 错误 */}
          {err && (
            <div className="flex items-center gap-1.5 rounded-control border border-fault/25 bg-fault/8 px-2.5 py-1.5">
              <Warning size={11} weight="bold" className="shrink-0 text-fault" />
              <p className="text-[12px] text-fault">{err}</p>
            </div>
          )}

          {/* 按钮 */}
          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="pressable rounded-control border border-line bg-raised/40 px-3.5 py-1.5 text-[12px] text-ink-muted hover:border-line-strong hover:text-ink-strong"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={loading}
              className="btn-primary pressable rounded-control px-4 py-1.5 text-[12px] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? '保存中…' : initial ? '保存' : '创建'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── 条目分配对话框 ────────────────────────────────────────────────────────────

interface AssignDialogProps {
  group: ProjectGroup
  entries: LaunchEntry[]
  onClose: () => void
}

export function AssignGroupDialog({ group, entries, onClose }: AssignDialogProps): React.JSX.Element {
  const patchEntry = useEntries((s) => s.edit)
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')

  const filtered = useMemo(
    () => entries.filter((e) =>
      !search || e.name.toLowerCase().includes(search.toLowerCase())
    ),
    [entries, search]
  )

  const toggle = useCallback(async (entry: LaunchEntry) => {
    setLoading(true)
    try {
      if (entry.groupId === group.id) {
        await patchEntry(entry.id, { groupId: null })
      } else {
        await patchEntry(entry.id, { groupId: group.id })
      }
    } finally {
      setLoading(false)
    }
  }, [group.id, patchEntry])

  const panelRef = useOverlay<HTMLDivElement>(onClose)
  return (
    <div
      className="dlg-scrim fixed inset-0 z-50 flex items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={`分配条目到「${group.name}」`} className="dlg-panel w-full max-w-[440px] p-5">
        <div className="mb-3 flex items-center gap-2">
          <Users size={14} weight="regular" className="shrink-0 text-accent" aria-hidden />
          <h2 className="dlg-title">分配条目到「{group.name}」</h2>
        </div>

        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索条目名称…"
          className="mb-3 w-full rounded-control border border-line bg-raised/50 px-2.5 py-1.5 text-[12px] text-ink-strong placeholder-ink-faint/40 outline-none focus:border-accent/50"
        />

        <div className="flex max-h-[280px] flex-col gap-1 overflow-y-auto">
          {filtered.length === 0 && (
            <p className="py-4 text-center text-[12px] text-ink-faint">没有匹配的条目</p>
          )}
          {filtered.map((entry) => {
            const inGroup = entry.groupId === group.id
            const inOther = entry.groupId && entry.groupId !== group.id
            return (
              <button
                key={entry.id}
                type="button"
                disabled={loading}
                onClick={() => void toggle(entry)}
                className={[
                  'pressable-flat flex min-w-0 items-center gap-2.5 rounded-control border px-3 py-2 text-left transition-colors',
                  inGroup
                    ? 'border-accent/25 bg-accent/8'
                    : inOther
                      ? 'border-line bg-raised/20 opacity-50'
                      : 'border-line bg-card hover:border-line-strong hover:bg-raised'
                ].join(' ')}
              >
                {inGroup ? (
                  <CheckCircle size={13} weight="fill" className="shrink-0 text-accent" aria-hidden />
                ) : (
                  <div className="h-3.5 w-3.5 shrink-0 rounded-full border border-line" aria-hidden />
                )}
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink-strong">{entry.name}</span>
                {inOther && (
                  <span className="shrink-0 text-[12px] text-ink-faint">已在其他工作组</span>
                )}
              </button>
            )
          })}
        </div>

        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="pressable rounded-control border border-line bg-raised/40 px-4 py-1.5 text-[12px] text-ink-muted hover:border-line-strong hover:text-ink-strong"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  )
}

