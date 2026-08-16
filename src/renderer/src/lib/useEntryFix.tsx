import { useCallback, useState } from 'react'
import { Warning, X } from '@phosphor-icons/react'
import type { LaunchEntry, PrecheckFixAction, PrecheckResult } from '@shared/types'
import { ScriptPickerDialog } from '../components/ScriptPickerDialog'
import { PortDialog } from '../components/PortDialog'
import { useEntries } from '../store/entries'

/**
 * 预检修复入口的统一派发，PRD §5.3。
 *
 * 启动台与诊断面板都要能点这些按钮，逻辑必须共用一份 —— 各写一遍会让两处
 * 对「外部进程能不能停」这类安全判断产生分歧。
 *
 * 返回 dialogs 元素，调用方直接渲染。
 */
export function useEntryFix(onAfterFix: (entryId: string) => void): {
  runFix: (entryId: string, action: PrecheckFixAction) => Promise<void>
  dialogs: React.JSX.Element | null
} {
  const entries = useEntries((s) => s.entries)
  const edit = useEntries((s) => s.edit)
  const remove = useEntries((s) => s.remove)
  const install = useEntries((s) => s.install)
  const stop = useEntries((s) => s.stop)

  const [scriptPicker, setScriptPicker] = useState<LaunchEntry | null>(null)
  const [portDialog, setPortDialog] = useState<{ entry: LaunchEntry; holderName?: string } | null>(
    null
  )
  const [nodeNotice, setNodeNotice] = useState<string | null>(null)

  const runFix = useCallback(
    async (entryId: string, action: PrecheckFixAction): Promise<void> => {
      const entry = entries.find((e) => e.id === entryId)
      if (!entry) return

      switch (action) {
        case 'pickDirectory': {
          const target = await window.mile.dialog.pickDirectory()
          if (!target) return
          const detected = await window.mile.entry.detect(target)
          await edit(entry.id, {
            path: detected.path,
            framework: detected.framework,
            packageManager: detected.packageManager,
            scripts: detected.scripts,
            registerOnly: detected.registerOnly
          })
          break
        }

        case 'removeEntry':
          await remove(entry.id)
          return

        case 'useNpm':
          await edit(entry.id, { packageManager: 'npm' })
          break

        case 'createInstallSession':
          await install(entry.id)
          return

        case 'openInEditor':
          // 只传 id，路径由主进程按条目拼，渲染层不构造任意文件路径
          await window.mile.entry.openPackageJson(entry.id)
          return

        case 'pickScript':
          setScriptPicker(entry)
          return

        case 'showNodeRequirement': {
          const result = await window.mile.entry.precheck(entry.id)
          setNodeNotice(nodeRequirementOf(result))
          return
        }

        case 'resolvePort': {
          const report = await window.mile.entry.diagnose(entry.id)
          const holder = report.portHolder
          // 只有主进程按会话归属精确回传了条目 id，才允许停受控占用者。端口相同
          // 不是归属凭据：IPv4/IPv6 双绑时按端口找会停掉当前条目。
          if (holder?.ownership === 'owned' && holder.entryId && holder.entryId !== entry.id) {
            await stop(holder.entryId)
            break
          }
          setPortDialog({ entry, holderName: holder?.processName })
          return
        }
      }

      onAfterFix(entry.id)
    },
    [entries, edit, remove, install, stop, onAfterFix]
  )

  const dialogs =
    scriptPicker || portDialog || nodeNotice ? (
      <>
        {scriptPicker && (
          <ScriptPickerDialog
            entry={scriptPicker}
            onClose={() => setScriptPicker(null)}
            onPick={(script) => {
              const target = scriptPicker.id
              setScriptPicker(null)
              void edit(target, { script, registerOnly: false }).then(() => onAfterFix(target))
            }}
          />
        )}

        {portDialog && (
          <PortDialog
            currentPort={portDialog.entry.expectedPort}
            holderName={portDialog.holderName}
            framework={portDialog.entry.framework}
            onClose={() => setPortDialog(null)}
            onSubmit={portDialog.entry.framework === 'next' ? (port) => {
              const target = portDialog.entry.id
              setPortDialog(null)
              void edit(target, {
                env: { ...portDialog.entry.env, PORT: String(port) },
                expectedPort: port
              }).then((saved) => {
                if (saved) onAfterFix(target)
              })
            } : undefined}
          />
        )}

        {nodeNotice && (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-[12px] border border-warn/40 bg-warn-soft px-4 py-3"
          >
            <Warning size={15} weight="bold" className="mt-0.5 shrink-0 text-warn" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] break-words text-warn">{nodeNotice}</p>
              <p className="mt-1 text-[11px] text-ink-faint">
                不代为安装或切换 Node 版本，请自行用 nvm / fnm 等工具切换后重试。
              </p>
            </div>
            <button
              type="button"
              aria-label="关闭提示"
              title="关闭提示"
              onClick={() => setNodeNotice(null)}
              className="pressable shrink-0 text-warn hover:opacity-80"
            >
              <X size={14} weight="bold" />
            </button>
          </div>
        )}
      </>
    ) : null

  return { runFix, dialogs }
}

function nodeRequirementOf(precheck: PrecheckResult): string {
  return precheck.items.find((i) => i.id === 'node')?.detail ?? '未获取到 engines.node 要求'
}
