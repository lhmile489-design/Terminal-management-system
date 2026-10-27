import { useEffect, useState } from 'react'
import type { EntryRuntime, LaunchEntry, PrecheckFixAction, PrecheckResult, ProjectGroup } from '@shared/types'
import { GROUP_ENV_LABEL } from '@shared/types'
import { Button, IconButton, Pill, Tabs, tabPanelProps, type TabItem } from '../ui'
import { EntryGlyph } from '../EntryGlyph'
import { PrecheckPanel } from '../PrecheckPanel'
import { TerminalView } from '../TerminalView'
import { ConsolePanel } from './BuildPanel'
import { EntryConfigForm } from '../EntryConfigForm'
import { useEntries } from '../../store/entries'
import { useEntryImage } from '../../store/favicons'
import { useScanner } from '../../store/scanner'
import { ICON } from '../../lib/icons'
import { FRAMEWORK_LABEL, STATUS_META, isLiveStatus } from '../../lib/entryMeta'
import { formatBytes, formatPercent, formatUptime } from '../../lib/format'
import { RowToggle } from './GroupTile'

export type DetailTab = 'overview' | 'output' | 'diagnose' | 'build' | 'config'

/** 「构建」标签只给 Java 项目（Q9） */
export function hasBuildTab(entry: LaunchEntry): boolean {
  return entry.framework === 'spring-boot'
}

/** 记住上次的标签（Q20）；新选中的条目没有那个标签时回到「概览」 */
export function effectiveTab(entry: LaunchEntry, tab: DetailTab): DetailTab {
  return tab === 'build' && !hasBuildTab(entry) ? 'overview' : tab
}

const ID_BASE = 'svc-detail'

/**
 * 服务详情面板，UI-REFACTOR §3.3。头部：图标、名称、状态胶囊、端口、所属组 + 启停 / 最大化 / 关闭。
 * 只做展示与转发：启停、修复、编辑都交回服务页，命令构造与校验仍在主进程。
 */
export function EntryDetail({
  entry,
  runtime,
  group,
  tab,
  onTab,
  maximized,
  onToggleMax,
  onClose,
  onToggle,
  failed,
  categories,
  onDirtyChange,
  onOpenLogs,
  onFix,
  refreshKey
}: {
  entry: LaunchEntry
  runtime: EntryRuntime
  group?: ProjectGroup
  tab: DetailTab
  onTab: (t: DetailTab) => void
  maximized: boolean
  onToggleMax: () => void
  onClose: () => void
  onToggle: () => void
  failed?: boolean
  categories: string[]
  onDirtyChange: (dirty: boolean) => void
  onOpenLogs: (sessionId: string) => void
  onFix: (action: PrecheckFixAction, suggestedPort?: number) => void
  refreshKey: number
}): React.JSX.Element {
  const imageUrl = useEntryImage(entry)
  const status = STATUS_META[runtime.status]
  const current = effectiveTab(entry, tab)

  const [precheck, setPrecheck] = useState<PrecheckResult | null>(runtime.precheck ?? null)
  useEffect(() => {
    if (current !== 'diagnose') return
    let alive = true
    void window.mile.entry
      .precheck(entry.id)
      .then((r) => alive && setPrecheck(r))
      .catch(() => alive && setPrecheck(null))
    return () => {
      alive = false
    }
  }, [current, entry.id, refreshKey])
  // 换条目时丢掉上一个的预检结果
  useEffect(() => setPrecheck(runtime.precheck ?? null), [entry.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const fails = (precheck ?? runtime.precheck)?.items.filter((i) => i.level === 'fail').length ?? 0
  const items: TabItem<DetailTab>[] = [
    { id: 'overview', label: '概览', icon: ICON.overview },
    { id: 'output', label: '输出', icon: ICON.output },
    { id: 'diagnose', label: '诊断', icon: ICON.diagnose, badge: fails || undefined },
    ...(hasBuildTab(entry) ? [{ id: 'build' as const, label: '构建', icon: ICON.build }] : []),
    { id: 'config', label: '配置', icon: ICON.config }
  ]

  const port = runtime.port ?? entry.expectedPort
  const flush = current === 'output'

  return (
    <section className="ui-tile svc-detail" aria-label={`${entry.name} 详情`} data-detail-id={entry.id}>
      <div className="svc-detail-head">
        <EntryGlyph entry={entry} imageUrl={imageUrl} size={22} glyphClass="text-[13px]" />
        <div className="min-w-0">
          <h2 className="svc-detail-title">{entry.name}</h2>
          <div className="svc-detail-meta">
            <Pill tone={status.tone} dot>{status.label}</Pill>
            {port != null && <span className="font-mono tabular-nums">:{port}</span>}
            {group && (
              <>
                <span>{group.name}</span>
                <span className="svc-env" data-env={group.env}>{GROUP_ENV_LABEL[group.env]}</span>
              </>
            )}
          </div>
        </div>
        <div className="svc-detail-actions">
          <RowToggle entry={entry} runtime={runtime} failed={failed} onToggle={onToggle} primary />
          <IconButton
            icon={maximized ? ICON.restore : ICON.maximize}
            label={maximized ? '还原分栏' : '最大化'}
            onClick={onToggleMax}
          />
          <IconButton icon={ICON.close} label="关闭详情" onClick={onClose} />
        </div>
      </div>

      <div className="svc-detail-tabs">
        <Tabs items={items} value={current} onChange={onTab} idBase={ID_BASE} label="详情标签" />
      </div>

      <div className="svc-detail-body" data-flush={flush || undefined} {...tabPanelProps(ID_BASE, current)}>
        {current === 'overview' && <Overview entry={entry} runtime={runtime} group={group} />}
        {current === 'output' && <Output runtime={runtime} onOpenLogs={onOpenLogs} />}
        {current === 'diagnose' &&
          (precheck ? (
            <>
              <p className="svc-note">{precheck.ok ? '启动前检查全部通过' : `有 ${fails} 项需要处理，处理前启动会被拦下`}</p>
              <PrecheckPanel result={precheck} onFix={onFix} />
            </>
          ) : (
            <p className="svc-note">正在检查…</p>
          ))}
        {current === 'build' && <ConsolePanel entry={entry} />}
        {current === 'config' && (
          <ConfigTab entry={entry} runtime={runtime} categories={categories} onDirtyChange={onDirtyChange} />
        )}
      </div>
    </section>
  )
}

function Overview({
  entry,
  runtime,
  group
}: {
  entry: LaunchEntry
  runtime: EntryRuntime
  group?: ProjectGroup
}): React.JSX.Element {
  const listener = useScanner((s) => (runtime.pid ? s.listeners.find((l) => l.pid === runtime.pid) : undefined))
  const live = isLiveStatus(runtime.status)
  const task = entry.kind === 'task'
  return (
    <>
      <div className="svc-mini">
        <Mini k={task ? '上次退出码' : '运行时长'} v={task ? (entry.lastExitCode ?? '—') : live ? formatUptime(runtime.startedAt) : '—'} />
        <Mini k="CPU" v={listener ? formatPercent(listener.cpu) : '—'} />
        <Mini k="内存" v={listener ? formatBytes(listener.memory) : '—'} />
      </div>
      <dl className="svc-kv">
        <dt>状态</dt>
        <dd>{STATUS_META[runtime.status].label}{runtime.exitCode != null && !live ? `（退出码 ${runtime.exitCode}）` : ''}</dd>
        <dt>PID</dt>
        <dd className="font-mono tabular-nums">{runtime.pid ?? '—'}</dd>
        <dt>类型</dt>
        <dd>{FRAMEWORK_LABEL[entry.framework]} · {task ? '任务' : '服务'}</dd>
        <dt>工作组</dt>
        <dd>{group ? `${group.name}（${GROUP_ENV_LABEL[group.env]}）` : '未分组'}</dd>
        <dt>项目路径</dt>
        <dd>
          <span className="mono" title={entry.path}>{entry.path}</span>
          <CopyButton text={entry.path} label="复制路径" />
        </dd>
        <dt>启动脚本</dt>
        <dd><span className="mono">{entry.registerOnly ? '仅登记，不可启动' : (entry.script ?? '—')}</span></dd>
      </dl>
      <div className="mt-4 flex gap-2">
        <Button size="sm" icon={ICON.openFolder} onClick={() => window.mile.shell.openPath(entry.path)}>
          打开目录
        </Button>
      </div>
    </>
  )
}

function Mini({ k, v }: { k: string; v: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <div className="k">{k}</div>
      <div className="ui-stat" data-size="md">{v}</div>
    </div>
  )
}

function Output({
  runtime,
  onOpenLogs
}: {
  runtime: EntryRuntime
  onOpenLogs: (sessionId: string) => void
}): React.JSX.Element {
  const sid = runtime.sessionId
  return (
    <>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[12px] text-ink-muted">停止后保留上一次运行的输出</span>
        <Button size="sm" variant="ghost" icon={ICON.openExternal} disabled={!sid} onClick={() => sid && onOpenLogs(sid)} className="ml-auto">
          在终端页查看
        </Button>
      </div>
      {sid ? (
        <div className="svc-term">
          <TerminalView sessionId={sid} />
        </div>
      ) : (
        <p className="svc-note">还没有运行过，启动后输出会显示在这里。</p>
      )}
    </>
  )
}

/**
 * 配置标签：在详情里直接改（Q13）。放弃改动 = 换 key 重挂载表单回到已保存的值；
 * 卸载（切标签 / 换服务）时把未保存状态清掉，父组件的提醒只针对还挂着的表单。
 */
function ConfigTab({
  entry,
  runtime,
  categories,
  onDirtyChange
}: {
  entry: LaunchEntry
  runtime: EntryRuntime
  categories: string[]
  onDirtyChange: (dirty: boolean) => void
}): React.JSX.Element {
  const edit = useEntries((s) => s.edit)
  const stop = useEntries((s) => s.stop)
  const error = useEntries((s) => s.error)
  const clearError = useEntries((s) => s.clearError)
  const [nonce, setNonce] = useState(0)
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])
  return (
    <EntryConfigForm
      key={`${entry.id}:${nonce}`}
      entry={entry}
      runtime={runtime}
      categories={categories}
      error={error}
      onSubmit={(patch) => edit(entry.id, patch)}
      onStop={() => void stop(entry.id)}
      onDiscard={() => {
        clearError()
        setNonce((n) => n + 1)
        onDirtyChange(false)
      }}
      onDirtyChange={onDirtyChange}
    />
  )
}

function CopyButton({ text, label }: { text: string; label: string }): React.JSX.Element {
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const t = setTimeout(() => setDone(false), 1200)
    return () => clearTimeout(t)
  }, [done])
  return (
    <IconButton
      icon={done ? ICON.copied : ICON.copy}
      label={done ? '已复制' : label}
      onClick={() => void navigator.clipboard.writeText(text).then(() => setDone(true), () => setDone(true))}
    />
  )
}
