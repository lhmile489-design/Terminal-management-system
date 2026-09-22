import { useEffect, useMemo, useState } from 'react'
import {
  Stack,
  Broadcast,
  CaretRight,
  Cpu,
  Memory,
  Warning,
  ClockCounterClockwise
} from '@phosphor-icons/react'
import { KpiCard, type KpiCardProps } from '../components/KpiCard'
import { ListenerTable } from '../components/ListenerTable'
import { DiscoveredListeners } from '../components/DiscoveredListeners'
import { WatchedProcesses } from '../components/WatchedProcesses'
import { useScanner } from '../store/scanner'
import { useEntries } from '../store/entries'
import { isLiveStatus } from '../lib/entryMeta'
import { formatClock, formatPercent } from '../lib/format'

export function Dashboard({
  onRequestAdd,
  highlightPort,
  onHighlightConsumed
}: {
  onRequestAdd: (path: string, name: string) => void
  /** 命令面板定位过来的端口，滚动到对应行并短暂高亮 */
  highlightPort?: number | null
  onHighlightConsumed?: () => void
}): React.JSX.Element {
  const listeners = useScanner((s) => s.listeners)
  const system = useScanner((s) => s.system)
  const cpuHistory = useScanner((s) => s.cpuHistory)
  const memHistory = useScanner((s) => s.memHistory)
  const portConflicts = useScanner((s) => s.portConflicts)
  const at = useScanner((s) => s.at)
  const lastSuccessAt = useScanner((s) => s.lastSuccessAt)
  const failed = useScanner((s) => s.failed)
  const setGroup = useScanner((s) => s.setGroup)
  const entries = useEntries((s) => s.entries)
  const runtimeOf = useEntries((s) => s.runtimeOf)

  // 只数「我的服务」里的外部监听：后台组是 GUI 与系统进程，把它们算进这个数字
  // 会让 KPI 常年是两位数，而用户关心的是「有几个我该纳管的服务没纳管」
  const external = listeners.filter((l) => l.ownership === 'external' && l.group === 'mine')

  // 分组展示，PRD §5.2。后台组默认折叠：它多是 GUI 应用与系统进程，
  // 摊开会把真正在开发的服务挤到屏幕外
  const mine = useMemo(() => listeners.filter((l) => l.group === 'mine'), [listeners])
  const background = useMemo(() => listeners.filter((l) => l.group !== 'mine'), [listeners])
  const [showBackground, setShowBackground] = useState(false)

  // 命令面板定位到的端口可能属于后台组，而后台组默认是折叠的。
  // 不展开的话那一行根本不在 DOM 里，用户点了搜索结果却什么都没发生。
  const hidesHighlight = highlightPort
    ? background.some((l) => l.ports.includes(highlightPort))
    : false
  useEffect(() => {
    if (hidesHighlight) setShowBackground(true)
  }, [hidesHighlight])

  // 「我的服务」按启动台条目算，PRD §3.4 —— 不是按监听进程数
  const runningEntries = entries.filter((e) => isLiveStatus(runtimeOf(e.id).status)).length
  const stoppedEntries = Math.max(entries.length - runningEntries, 0)
  const runningRatio = entries.length ? Math.round((runningEntries / entries.length) * 100) : 0

  const cards: KpiCardProps[] = [
    {
      icon: Stack,
      label: '我的服务',
      value: String(runningEntries),
      unit: `/ ${entries.length}`,
      hint: entries.length ? `运行占比 ${runningRatio}%` : '启动台暂无条目',
      detail: entries.length ? `${stoppedEntries} 项待启动 · ${entries.length} 项已纳管` : '从启动台添加常用项目',
      tone: 'live',
      live: runningEntries > 0
    },
    {
      icon: Broadcast,
      label: '外部监听',
      value: String(external.length),
      hint: external.length ? '当前用户下未纳管' : '无外部监听',
      detail: listeners.length ? `监听列表共 ${listeners.length} 个进程` : '等待本机监听进程出现',
      tone: external.length ? 'info' : 'neutral'
    },
    {
      icon: Cpu,
      label: 'CPU',
      value: formatPercent(system.cpu),
      unit: '%',
      hint: '全机使用率 · 负载趋势',
      detail: `采样窗口 ${cpuHistory.length} 点 · 实时刷新`,
      tone: 'info',
      trend: cpuHistory.length > 1 ? cpuHistory : undefined
    },
    {
      icon: Memory,
      label: '内存',
      value: formatPercent(system.memory),
      unit: '%',
      hint: '全机使用率 · 负载趋势',
      detail: `采样窗口 ${memHistory.length} 点 · 实时刷新`,
      tone: 'info',
      trend: memHistory.length > 1 ? memHistory : undefined
    },
    {
      icon: Warning,
      label: '端口冲突',
      value: String(portConflicts),
      hint: portConflicts ? '预期端口被占用' : '无冲突',
      detail: portConflicts ? '打开诊断可定位占用进程' : '登记服务的预期端口均可用',
      tone: portConflicts ? 'fault' : 'neutral'
    },
    {
      icon: ClockCounterClockwise,
      label: '最后更新',
      value: formatClock(failed ? lastSuccessAt : at),
      hint: failed ? '采集失败，显示上次成功时间' : '采集正常',
      detail: failed ? '保留最近成功快照供排障' : '监听与负载数据已同步',
      tone: failed ? 'warn' : 'neutral'
    }
  ]

  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="kpi-heading">
        <h2 id="kpi-heading" className="eyebrow mb-2.5">
          Overview
        </h2>
        <div className="kpi-grid">
          {cards.map((card, i) => (
            <KpiCard key={card.label} {...card} index={i} />
          ))}
        </div>
      </section>

      <DiscoveredListeners onRequestAdd={onRequestAdd} />

      <section aria-labelledby="listeners-heading">
        <h2 id="listeners-heading" className="eyebrow mb-2.5">
          My Services · 我的服务
        </h2>
        {/* 定位端口只交给真正持有那一行的表：两张表都拿到的话，没命中的那张
            会先跑完 2 秒计时把高亮消掉，命中的那张还没滚过去 */}
        <ListenerTable
          listeners={mine}
          group="mine"
          onSetGroup={(name, g) => void setGroup(name, g)}
          highlightPort={hidesHighlight ? null : highlightPort}
          onHighlightConsumed={onHighlightConsumed}
        />
      </section>

      <section aria-labelledby="background-heading">
        <div className="mb-2.5 flex items-center gap-2">
          <h2 id="background-heading" className="eyebrow">
            Background · 应用后台
          </h2>
          <button
            type="button"
            aria-expanded={showBackground}
            onClick={() => setShowBackground((v) => !v)}
            className="pressable flex items-center gap-1 rounded-[5px] border border-line bg-raised/50 px-1.5 py-0.5 font-mono text-[10px] text-ink-muted hover:border-line-strong hover:text-ink-strong"
          >
            <CaretRight
              size={9}
              weight="bold"
              className="transition-transform duration-300 [transition-timing-function:cubic-bezier(0.34,1.56,0.64,1)]"
              style={{ transform: showBackground ? 'rotate(90deg)' : 'rotate(0deg)' }}
            />
            {background.length}
          </button>
        </div>
        {showBackground ? (
          <ListenerTable
            listeners={background}
            group="background"
            onSetGroup={(name, g) => void setGroup(name, g)}
            highlightPort={hidesHighlight ? highlightPort : null}
            onHighlightConsumed={onHighlightConsumed}
          />
        ) : (
          <p className="text-[12px] text-ink-faint">
            GUI 应用与系统路径进程归在这里，展开后可提升为我的服务
          </p>
        )}
      </section>

      <WatchedProcesses />
    </div>
  )
}
