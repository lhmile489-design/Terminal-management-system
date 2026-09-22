import { useCallback, useEffect, useState } from 'react'
import { ArrowClockwise, FolderOpen, Warning } from '@phosphor-icons/react'
import type { EntryDiagnosis, PrecheckFixAction } from '@shared/types'
import { PrecheckPanel } from '../components/PrecheckPanel'
import { useEntries } from '../store/entries'
import { STATUS_META } from '../lib/entryMeta'
import { StatusPill } from '../components/StatusPill'
import { formatDuration } from '../lib/format'

/**
 * 诊断面板，PRD §4.4：预检复查、端口现状、会话回顾、环境快照、一键动作。
 * 只读收集，不改任何东西 —— 修复动作复用预检的 fix 入口。
 */
export function Diagnose({
  selectedId,
  onSelect,
  onFix,
  refreshKey
}: {
  selectedId: string | null
  onSelect: (id: string) => void
  onFix: (entryId: string, action: PrecheckFixAction, suggestedPort?: number) => Promise<void>
  /** 外部修复动作完成后自增，用于触发重新收集 */
  refreshKey: number
}): React.JSX.Element {
  const entries = useEntries((s) => s.entries)
  const runtimes = useEntries((s) => s.runtimes)
  const [report, setReport] = useState<EntryDiagnosis | null>(null)
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  // 未指定时诊断第一个条目，避免进来是空白页
  const active = selectedId ?? entries[0]?.id ?? null
  const entry = entries.find((e) => e.id === active) ?? null

  const collect = useCallback(async (id: string) => {
    setLoading(true)
    setFailure(null)
    try {
      setReport(await window.mile.entry.diagnose(id))
    } catch (err) {
      setReport(null)
      setFailure(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  // 选中条目变化或修复动作完成就重新收集；条目被移除时清空报告
  useEffect(() => {
    if (!active) {
      setReport(null)
      return
    }
    void collect(active)
  }, [active, collect, refreshKey])

  if (entries.length === 0) {
    return (
      <div className="surface-card px-6 py-14 text-center">
        <p className="text-[13px] text-ink-muted">启动台还没有条目</p>
        <p className="mt-1.5 text-[12px] text-ink-faint">先添加一个项目，再回来诊断</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="diagnose-picker-heading">
        <h2 id="diagnose-picker-heading" className="eyebrow mb-3">
          Target · 选择条目
        </h2>
        {/* 条目多时会换行，因此用可换行的 segmented 组，而不是单行滚动条 */}
        <div role="tablist" aria-label="诊断目标" className="segmented flex-wrap">
          {entries.map((e) => {
            const status = STATUS_META[runtimes[e.id]?.status ?? 'idle']
            const current = e.id === active
            return (
              <button
                key={e.id}
                type="button"
                role="tab"
                aria-selected={current}
                onClick={() => onSelect(e.id)}
                className="segmented-item"
              >
                <span className="max-w-[180px] truncate">{e.name}</span>
                <StatusPill tone={status.tone} label={status.label} dot={false} />
              </button>
            )
          })}
        </div>
      </section>

      {!entry ? (
        <div className="surface-card px-6 py-14 text-center">
          <p className="text-[13px] text-ink-muted">选择一个条目开始诊断</p>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 truncate text-[13px] text-ink-muted">
              诊断目标：<span className="text-ink-strong">{entry.name}</span>
            </p>
            <button
              type="button"
              onClick={() => void collect(entry.id)}
              disabled={loading}
              className="pressable flex shrink-0 items-center gap-1.5 rounded-[6px] border border-line-strong bg-card px-2.5 py-1.5 text-[12px] text-ink-muted hover:text-ink-strong disabled:cursor-not-allowed disabled:opacity-45"
            >
              <ArrowClockwise size={13} weight="bold" />
              {loading ? '收集中' : '重新收集'}
            </button>
          </div>

          {failure && (
            <div
              role="alert"
              className="flex items-start gap-3 rounded-[12px] border border-fault/40 bg-fault-soft px-4 py-3"
            >
              <Warning size={15} weight="bold" className="mt-0.5 shrink-0 text-fault" aria-hidden />
              <p className="min-w-0 flex-1 text-[13px] break-words text-fault">{failure}</p>
            </div>
          )}

          {/*
            报告必须属于当前条目才渲染：切换条目时 collect 是异步的，旧报告还在 state 里，
            会在新条目名下短暂显示上一个条目的端口、退出码和产物目录。用 entryId 对齐，
            比切换时清空 report 更好 —— 重新收集时不会闪空白。
          */}
          {report?.entryId === entry.id && (
            <>
              <section aria-labelledby="diagnose-precheck-heading">
                <h2 id="diagnose-precheck-heading" className="eyebrow mb-3">
                  1 · 预检复查
                </h2>
                <PrecheckPanel
                  result={report.precheck}
                  onFix={(action, suggestedPort) => void onFix(entry.id, action, suggestedPort).then(() => collect(entry.id))}
                />
              </section>

              <section aria-labelledby="diagnose-port-heading">
                <h2 id="diagnose-port-heading" className="eyebrow mb-3">
                  2 · 端口现状
                </h2>
                <Panel>
                  {report.port === null ? (
                    <Row label="预期端口" value="未设置" />
                  ) : report.portHolder === null ? (
                    <Row label={`:${report.port}`} value="当前空闲" />
                  ) : (
                    <>
                      <Row label={`:${report.port}`} value="被占用" />
                      <Row label="占用进程" value={report.portHolder.processName} mono />
                      <Row label="PID" value={String(report.portHolder.pid)} mono />
                      <Row
                        label="归属"
                        value={report.portHolder.ownership === 'owned' ? '受控（本应用启动）' : '外部进程'}
                        tone={report.portHolder.ownership === 'owned' ? 'live' : 'warn'}
                      />
                    </>
                  )}
                </Panel>
              </section>

              <section aria-labelledby="diagnose-session-heading">
                <h2 id="diagnose-session-heading" className="eyebrow mb-3">
                  3 · 会话回顾
                </h2>
                <Panel>
                  <Row
                    label="上次退出码"
                    value={report.lastExitCode === undefined ? '未运行过' : String(report.lastExitCode)}
                    mono
                    tone={
                      report.lastExitCode === undefined
                        ? undefined
                        : report.lastExitCode === 0
                          ? 'live'
                          : 'fault'
                    }
                  />
                  <Row
                    label="上次启动"
                    value={
                      report.lastStartedAt
                        ? new Date(report.lastStartedAt).toLocaleString('zh-CN', { hour12: false })
                        : '—'
                    }
                    mono
                  />
                  <Row
                    label="上次运行时长"
                    value={report.lastRunMs === undefined ? '—' : formatDuration(report.lastRunMs)}
                    mono
                  />
                  <Row
                    label="日志首个错误行"
                    value={report.firstErrorLine ?? '未捕获到错误关键字'}
                    mono
                    tone={report.firstErrorLine ? 'fault' : undefined}
                  />
                </Panel>
              </section>

              <section aria-labelledby="diagnose-env-heading">
                <h2 id="diagnose-env-heading" className="eyebrow mb-3">
                  4 · 环境快照
                </h2>
                <Panel>
                  <Row label="Node 版本" value={report.node} mono />
                  <Row label="包管理器" value={report.packageManager} mono />
                  <Row
                    label="包管理器路径"
                    value={report.packageManagerPath ?? 'PATH 中未找到'}
                    mono
                    tone={report.packageManagerPath ? undefined : 'fault'}
                  />
                  <Row
                    label="注入的环境变量"
                    value={
                      report.envKeys.length === 0
                        ? '无'
                        : `${report.envKeys.join(', ')}（共 ${report.envKeys.length} 项，仅键名）`
                    }
                    mono
                  />
                </Panel>
                {/* 变量值绝不下发到渲染层，PRD §4.4 —— 这里说明清楚，避免被当成缺陷 */}
                <p className="mt-2 text-[11px] text-ink-faint">
                  只显示键名。变量值不会离开主进程，避免 token 与密钥泄露到界面或日志。
                </p>
              </section>

              {entry.kind === 'task' && (
                <section aria-labelledby="diagnose-output-heading">
                  <h2 id="diagnose-output-heading" className="eyebrow mb-3">
                    5 · 产物目录
                  </h2>
                  <Panel>
                    <Row label="产物目录" value={report.outputDir ?? '尚无产物'} mono />
                  </Panel>
                  {report.outputDir && (
                    <button
                      type="button"
                      onClick={() => window.mile.shell.openPath(report.outputDir as string)}
                      className="pressable mt-2 flex items-center gap-1.5 rounded-[6px] border border-line-strong bg-card px-2.5 py-1.5 text-[12px] text-ink-muted hover:text-ink-strong"
                    >
                      <FolderOpen size={13} weight="bold" />
                      打开产物目录
                    </button>
                  )}
                </section>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

function Panel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <dl className="surface-card overflow-hidden">{children}</dl>
}

function Row({
  label,
  value,
  mono,
  tone
}: {
  label: string
  value: string
  mono?: boolean
  tone?: 'live' | 'warn' | 'fault'
}): React.JSX.Element {
  const color = tone === 'live' ? 'text-live' : tone === 'warn' ? 'text-warn' : tone === 'fault' ? 'text-fault' : 'text-ink-strong'
  return (
    <div className="flex items-baseline gap-4 border-b border-line px-4 py-2.5 last:border-b-0">
      <dt className="w-32 shrink-0 text-[12px] text-ink-faint">{label}</dt>
      <dd className={`min-w-0 flex-1 text-[12.5px] break-all ${mono ? 'font-mono' : ''} ${color}`}>
        {value}
      </dd>
    </div>
  )
}
