import { useCallback, useMemo, useState } from 'react'
import type { LaunchEntry } from '@shared/types'
import type { EntryCardActions } from '../components/EntryCard'
import { GroupsPanel } from '../components/GroupsPanel'
import { EditEntryDialog } from '../components/EditEntryDialog'
import { useEntries } from '../store/entries'
import { useEntryFix } from '../lib/useEntryFix'

interface WorkgroupsProps {
  onOpenLogs: (sessionId: string) => void
}

const IDLE_RUNTIME = (id: string) => ({
  entryId: id,
  status: 'idle' as const,
  portUnknown: false
})

export function Workgroups({ onOpenLogs }: WorkgroupsProps): React.JSX.Element {
  const entries = useEntries((s) => s.entries)
  const runtimes = useEntries((s) => s.runtimes)
  const edit = useEntries((s) => s.edit)
  const remove = useEntries((s) => s.remove)
  const start = useEntries((s) => s.start)
  const stop = useEntries((s) => s.stop)
  const restart = useEntries((s) => s.restart)
  const runScript = useEntries((s) => s.runScript)
  const clearError = useEntries((s) => s.clearError)
  const error = useEntries((s) => s.error)

  const [editing, setEditing] = useState<string | null>(null)

  // useEntryFix 修复完成后不需要在本视图展示 precheck 结果；
  // 若将来需要展示，在此处补 useState<PrecheckResult> 并绑定 UI。
  const afterFix = useCallback((_entryId: string) => { /* 修复完成，无额外操作 */ }, [])

  const { dialogs } = useEntryFix((id) => void afterFix(id))

  // 从所有条目中提取已有 category 名称（供编辑对话框使用）
  const categoryNames = useMemo(
    () =>
      [...new Set(entries.map((e) => e.category?.trim()).filter(Boolean) as string[])],
    [entries]
  )

  const actionsFor = useCallback((entry: LaunchEntry): EntryCardActions => ({
    onStart: () => void start(entry.id),
    onStop: () => void stop(entry.id),
    onRestart: () => void restart(entry.id),
    onLogs: () => {
      const sessionId = runtimes[entry.id]?.sessionId
      if (sessionId) onOpenLogs(sessionId)
    },
    onPin: () => {
      // 工作组视图内 pin 操作：选中该条目作为终端预览目标（GroupsPanel 内部处理）
    },
    onDiagnose: () => {
      // 工作组视图暂不展示 precheck 详情弹窗，诊断请前往「诊断」视图
      void window.mile.entry.precheck(entry.id)
    },
    onEdit: () => {
      clearError()
      setEditing(entry.id)
    },
    onOpenFolder: () => window.mile.shell.openPath(entry.path),
    onOpenOutput: () => {
      if (entry.kind === 'task' && runtimes[entry.id]?.status === 'succeeded') {
        void window.mile.entry.revealOutput(entry.id)
      } else {
        void window.mile.entry
          .outputDir(entry.id)
          .then((dir) => dir && window.mile.shell.openPath(dir))
      }
    },
    onTogglePin: () => void edit(entry.id, { pinned: !entry.pinned }),
    onRemove: () => void remove(entry.id),
    onRunScript:
      entry.kind === 'task'
        ? (script) => void runScript(entry.id, script)
        : undefined
  }), [runtimes, onOpenLogs, clearError, edit, remove, stop, start, restart, runScript])

  const editEntry = editing ? entries.find((e) => e.id === editing) : undefined

  return (
    <div className="flex min-h-full flex-1 flex-col">
      {error && (
        <div
          role="alert"
          className="mb-3 flex items-center gap-2 rounded-[7px] border border-fault/30 bg-fault/8 px-3 py-2 text-[12px] text-fault"
        >
          <span className="min-w-0 flex-1">{error}</span>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={clearError}
            className="shrink-0 text-fault/70 hover:text-fault"
          >
            ✕
          </button>
        </div>
      )}

      <GroupsPanel
        actionsFor={actionsFor}
        onOpenLogs={onOpenLogs}
      />

      {editEntry && (
        <EditEntryDialog
          entry={editEntry}
          runtime={runtimes[editEntry.id] ?? IDLE_RUNTIME(editEntry.id)}
          categories={categoryNames}
          error={error}
          onSubmit={(patch) => edit(editEntry.id, patch)}
          onStop={() => void stop(editEntry.id)}
          onClose={() => {
            setEditing(null)
            clearError()
          }}
        />
      )}

      {dialogs}
    </div>
  )
}
