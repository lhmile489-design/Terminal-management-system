import { useMemo, useState } from 'react'
import type { DetectResult, NewLaunchEntry } from '@shared/types'
import { Button, DialogShell } from './ui'
import { ICON } from '../lib/icons'
import { FRAMEWORK_LABEL, FRAMEWORK_LAUNCH_MODES } from '../lib/entryMeta'
import { normDir, MODES_NEEDING_PATH } from './AddEntryDialog'
import { useEntries } from '../store/entries'
import { useGroups } from '../store/groups'

/**
 * 批量导入（2.3.0）：主进程扫描父目录下一层子目录后，这里列成勾选表一次添加。
 *
 * 默认勾选「能直接启动」的项目：npm 生态有 dev 脚本、非 npm 生态识别出了不需要额外路径的启动方式。
 * 其余默认不勾，勾了就以「仅登记」加入。已登记过的目录置灰不可勾，免得重复。
 * 入库逐条走现有 entry.add（主进程 sanitizeEdit 校验），建组走 group.add，不另开写入口。
 */
interface Row {
  item: DetectResult
  key: string
  name: string
  /** 能直接启动时的启动方式；npm 生态是脚本名，非 npm 生态是 launchMode */
  script: string | null
  launchMode?: NonNullable<DetectResult['detectedLaunchMode']>
  startable: boolean
  existing?: string
}

function toRow(item: DetectResult, existingName: string | undefined): Row {
  const modes = FRAMEWORK_LAUNCH_MODES[item.framework]
  const mode = item.detectedLaunchMode
  const launchable = !!modes && !!mode && !MODES_NEEDING_PATH.has(mode)
  const script = modes ? null : item.devScript
  return {
    item,
    key: normDir(item.path),
    name: item.name || item.path.split(/[\\/]/).pop() || item.path,
    script,
    launchMode: launchable ? mode : undefined,
    startable: !item.registerOnly && (launchable || !!script),
    existing: existingName
  }
}

export function ImportDialog({
  root,
  items,
  onClose,
  onDone
}: {
  root: string
  items: DetectResult[]
  onClose: () => void
  onDone: (count: number, groupName: string | null) => void
}): React.JSX.Element {
  const entries = useEntries((s) => s.entries)
  const add = useEntries((s) => s.add)
  const edit = useEntries((s) => s.edit)
  const addGroup = useGroups((s) => s.add)

  const rows = useMemo(() => {
    const known = new Map(entries.map((e) => [normDir(e.path), e.name]))
    return items.map((it) => toRow(it, known.get(normDir(it.path))))
  }, [items, entries])

  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(rows.filter((r) => r.startable && !r.existing).map((r) => r.key))
  )
  const parentName = root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '导入'
  const [makeGroup, setMakeGroup] = useState(false)
  const [groupName, setGroupName] = useState(parentName.slice(0, 40))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const chosen = rows.filter((r) => picked.has(r.key) && !r.existing)
  const toggle = (key: string): void =>
    setPicked((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })

  const submit = async (): Promise<void> => {
    if (busy || chosen.length === 0) return
    setBusy(true)
    setError(null)
    const failed: string[] = []
    let ok = 0
    try {
      const group = makeGroup && groupName.trim() ? await addGroup({ name: groupName.trim() }) : null
      for (const r of chosen) {
        const it = r.item
        const input: NewLaunchEntry = {
          kind: 'service',
          name: r.name.slice(0, 60),
          path: it.path,
          framework: it.framework,
          packageManager: it.packageManager,
          script: r.startable ? r.script : null,
          scripts: FRAMEWORK_LAUNCH_MODES[it.framework] ? {} : it.scripts,
          env: {},
          ...(r.startable && r.launchMode ? { launchMode: r.launchMode } : {}),
          ...(it.detectedPort ? { expectedPort: it.detectedPort } : {}),
          registerOnly: !r.startable,
          pinned: false
        }
        try {
          const entry = await add(input)
          if (group && entry?.id) await edit(entry.id, { groupId: group.id })
          ok++
        } catch (err) {
          failed.push(`${r.name}：${(err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`)
        }
      }
      if (failed.length) {
        setError(`${failed.length} 个没能导入：${failed.join('；')}`)
        if (ok) onDone(ok, group?.name ?? null)
        return
      }
      onDone(ok, group?.name ?? null)
      onClose()
    } catch (err) {
      setError((err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogShell
      title="从文件夹导入"
      icon={<ICON.openFolder size={20} />}
      onClose={onClose}
      width={620}
      dataset={{ 'import-dialog': '' }}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" icon={ICON.add} disabled={busy || chosen.length === 0} onClick={() => void submit()}>
            {busy ? '导入中…' : `导入 ${chosen.length} 个`}
          </Button>
        </>
      }
    >
      <p className="imp-root" title={root}>{root}</p>
      {rows.length === 0 ? (
        <p className="imp-empty">这个目录下没有找到能识别的项目（只看下一层子目录）</p>
      ) : (
        <ul className="imp-list">
          {rows.map((r) => (
            <li key={r.key} className="imp-row" data-import-row={r.item.path.split(/[\\/]/).pop()} data-disabled={!!r.existing || undefined}>
              <label>
                <input
                  type="checkbox"
                  checked={!r.existing && picked.has(r.key)}
                  disabled={!!r.existing || busy}
                  onChange={() => toggle(r.key)}
                  aria-label={`导入 ${r.name}`}
                />
                <span className="imp-name">
                  <b>{r.name}</b>
                  <span>
                    <em className="ui-pill" data-tone="accent">{FRAMEWORK_LABEL[r.item.framework]}</em>
                    {r.existing ? (
                      <em className="ui-pill" data-tone="idle">已登记为「{r.existing}」</em>
                    ) : r.startable ? (
                      <em className="ui-pill" data-tone="live">{r.script ? `启动脚本 ${r.script}` : '可启动'}</em>
                    ) : (
                      <em className="ui-pill" data-tone="idle">仅登记</em>
                    )}
                    {r.item.detectedPort ? <em className="ui-pill" data-tone="idle" data-mono="true">:{r.item.detectedPort}</em> : null}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="imp-group">
        <label>
          <input type="checkbox" data-import-group checked={makeGroup} disabled={busy} onChange={(e) => setMakeGroup(e.target.checked)} />
          同时建工作组，把导入的服务都放进去
        </label>
        <input
          className="ui-input"
          data-import-group-name
          value={groupName}
          maxLength={40}
          disabled={!makeGroup || busy}
          aria-label="新工作组名称"
          onChange={(e) => setGroupName(e.target.value)}
        />
      </div>
      {error && <p className="add-error" role="alert">{error}</p>}
    </DialogShell>
  )
}
