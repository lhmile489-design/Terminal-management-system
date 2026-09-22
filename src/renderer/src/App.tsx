import { useCallback, useEffect, useState } from 'react'
import { ArrowsClockwise, Command, MagnifyingGlass, Plus } from '@phosphor-icons/react'
import { ViewHeader } from './components/ViewHeader'
import { TitleBar } from './components/TitleBar'
import { NavRail, type ViewId } from './components/NavRail'
import { ActivitySidebar, type ActivityEvent } from './components/ActivitySidebar'
import { Dashboard } from './views/Dashboard'
import { Launchpad } from './views/Launchpad'
import { BackendConsole } from './views/BackendConsole'
import { Diagnose } from './views/Diagnose'
import { TerminalWorkspace } from './views/TerminalWorkspace'
import { LogCenter } from './views/LogCenter'
import { Settings } from './views/Settings'
import { About } from './views/About'
import { CommandPalette, type PaletteAction } from './components/CommandPalette'
import { useEntryFix } from './lib/useEntryFix'
import { useSessions } from './store/sessions'
import type { EntryKind } from '@shared/types'
import { useScanner } from './store/scanner'
import { useEntries } from './store/entries'
import { useSettings } from './store/settings'
import { useGroups } from './store/groups'
import { STATUS_META } from './lib/entryMeta'

const TITLES: Record<
  ViewId,
  { eyebrow: string; title: string; romanized: string; caption: string }
> = {
  dashboard: {
    eyebrow: 'Dashboard',
    title: '工作台',
    romanized: 'DASHBOARD',
    caption: '实时掌握本机监听端口与进程负载'
  },
  launchpad: {
    eyebrow: 'Launchpad',
    title: '前端启动台',
    romanized: 'LAUNCHPAD',
    caption: '一键启动与管理你的本地前端服务和批处理任务'
  },
  backend: {
    eyebrow: 'Backend',
    title: '后端控制台',
    romanized: 'BACKEND',
    caption: 'Spring Boot 项目管理：启停服务、Maven/Gradle 构建操作'
  },
  terminal: {
    eyebrow: 'Terminal',
    title: '终端',
    romanized: 'TERMINAL',
    caption: '会话输出、输入与历史回看'
  },
  logs: {
    eyebrow: 'Logs',
    title: '日志',
    romanized: 'LOGS',
    caption: '跨会话汇总输出，按级别与关键字检索'
  },
  diagnose: {
    eyebrow: 'Diagnose',
    title: '诊断',
    romanized: 'DIAGNOSE',
    caption: '预检、端口占用与会话回顾'
  },
  settings: {
    eyebrow: 'Settings',
    title: '设置',
    romanized: 'SETTINGS',
    caption: '采集周期、主题与终端偏好'
  },
  about: {
    eyebrow: 'About',
    title: '关于',
    romanized: 'ABOUT',
    caption: '版本信息、使用教程与项目介绍'
  }
}

export function App(): React.JSX.Element {
  const [view, setView] = useState<ViewId>('dashboard')
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [pendingAdd, setPendingAdd] = useState<{ path: string; name: string } | null>(null)
  const [diagnoseId, setDiagnoseId] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  /** 命令面板发起的「添加服务/任务」，交给启动台弹出既有的识别对话框 */
  const [paletteAdd, setPaletteAdd] = useState<EntryKind | null>(null)
  /** 命令面板定位端口后，工作台高亮对应表格行 */
  const [highlightPort, setHighlightPort] = useState<number | null>(null)
  const refresh = useSessions((s) => s.refresh)
  const focusSession = useSessions((s) => s.focus)
  const markExited = useSessions((s) => s.markExited)
  const initScanner = useScanner((s) => s.init)
  const applyDiff = useScanner((s) => s.applyDiff)
  const listeners = useScanner((s) => s.listeners)
  const initEntries = useEntries((s) => s.init)
  const setEntries = useEntries((s) => s.setEntries)
  const setRuntime = useEntries((s) => s.setRuntime)
  const entries = useEntries((s) => s.entries)
  const runtimes = useEntries((s) => s.runtimes)
  const startEntry = useEntries((s) => s.start)
  const stopEntry = useEntries((s) => s.stop)
  const runScript = useEntries((s) => s.runScript)
  const initSettings = useSettings((s) => s.init)
  const setSettings = useSettings((s) => s.set)
  const initGroups = useGroups((s) => s.init)
  const setGroups = useGroups((s) => s.setGroups)

  useEffect(() => {
    void refresh()
    void initScanner()
    void initEntries()
    void initSettings()
    void initGroups()
  }, [refresh, initScanner, initEntries, initSettings, initGroups])

  useEffect(() => window.mile.scanner.onDiff(applyDiff), [applyDiff])
  useEffect(() => window.mile.entry.onChange(setEntries), [setEntries])
  useEffect(() => window.mile.settings.onChange(setSettings), [setSettings])
  useEffect(() => window.mile.group.onChange(setGroups), [setGroups])

  const pushEvent = useCallback((level: ActivityEvent['level'], text: string) => {
    setEvents((prev) =>
      [{ id: `${Date.now()}-${Math.random()}`, at: Date.now(), level, text }, ...prev].slice(0, 100)
    )
  }, [])

  useEffect(
    () =>
      window.mile.entry.onRuntime((runtime) => {
        setRuntime(runtime)
        const meta = STATUS_META[runtime.status]
        pushEvent(
          meta.tone === 'fault' ? 'fault' : meta.tone === 'warn' ? 'warn' : 'info',
          `条目状态：${meta.label}${runtime.port ? ` · :${runtime.port}` : ''}`
        )
      }),
    [setRuntime, pushEvent]
  )

  useEffect(() => window.mile.entry.onWarning((text) => pushEvent('warn', text)), [pushEvent])

  // 修复动作可能经过对话框异步完成，用计数器通知诊断面板重新收集
  const [fixNonce, setFixNonce] = useState(0)
  const { runFix, dialogs } = useEntryFix(useCallback(() => setFixNonce((n) => n + 1), []))

  const openLogs = useCallback(
    (sessionId: string) => {
      void focusSession(sessionId)
      setView('terminal')
    },
    [focusSession]
  )

  const requestAdd = useCallback((path: string, name: string) => {
    setPendingAdd({ path, name })
    setView('launchpad')
  }, [])

  // 主进程的 minimize/restore 覆盖不了「窗口被其他窗口完全遮挡」，这里补一层
  useEffect(() => {
    const sync = (): void => window.mile.scanner.setVisible(!document.hidden)
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [])

  useEffect(
    () =>
      window.mile.session.onExit((e) => {
        markExited(e.id, e.exitCode)
        pushEvent(
          e.exitCode === 0 ? 'info' : 'fault',
          e.exitCode === 0 ? '会话结束，退出码 0' : `会话异常退出，退出码 ${e.exitCode}`
        )
      }),
    [markExited, pushEvent]
  )

  // Ctrl+K 全局唤起命令面板，PRD §9.5。用 capture 抢在终端 xterm 之前，
  // 否则焦点在终端里时按键会被当成输入吞掉。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])

  const runPalette = useCallback(
    async (action: PaletteAction): Promise<void> => {
      switch (action.type) {
        case 'startEntry': {
          setView('launchpad')
          const blocked = await startEntry(action.entry.id)
          // 预检拦下时跳到启动台，修复入口在那里
          if (blocked) pushEvent('warn', `${action.entry.name} 预检未通过，请在启动台修复`)
          return
        }
        case 'stopEntry':
          await stopEntry(action.entry.id)
          return
        case 'locatePort':
          setView('dashboard')
          setHighlightPort(action.port)
          return
        case 'runScript': {
          // 只把 id + 脚本名交给主进程，命令构造与脚本校验都在那边，PRD §11
          const runtime = await runScript(action.entry.id, action.script)
          if (runtime?.sessionId) openLogs(runtime.sessionId)
          return
        }
        case 'addEntry':
          setPaletteAdd(action.kind)
          setView('launchpad')
          return
        case 'refresh':
          window.mile.scanner.refresh()
          return
        case 'setTheme':
          await window.mile.theme.set(action.preference)
          return
        case 'goto':
          setView(action.view)
          return
      }
    },
    [startEntry, stopEntry, runScript, openLogs, pushEvent]
  )

  const clearEvents = useCallback(() => setEvents([]), [])
  const meta = TITLES[view]

  return (
    <div className="flex h-full flex-col bg-canvas">
      <TitleBar />

      <div className="flex min-h-0 flex-1">
        <NavRail active={view} onChange={setView} />

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* ─── 固定顶栏 ─── */}
          <div className="shrink-0 border-b border-line bg-panel px-6 py-3">
            {/* key=view 让标题在切视图时触发 header-enter 重播 */}
            <div key={view} className="header-enter">
              <ViewHeader
                eyebrow={meta.eyebrow}
                title={meta.title}
                romanized={meta.romanized}
                caption={meta.caption}
                actions={
                  <>
                    <PaletteHint onOpen={() => setPaletteOpen(true)} />
                    <QuickActions view={view} onAdd={setPaletteAdd} />
                  </>
                }
              />
            </div>
          </div>

          {/* ─── 滚动内容区：key=view 切换时触发 view-enter 重播 ─── */}
          <div key={view} className="view-enter flex-1 overflow-y-auto px-6 py-5">
            {view === 'dashboard' && (
              <Dashboard
                onRequestAdd={requestAdd}
                highlightPort={highlightPort}
                onHighlightConsumed={() => setHighlightPort(null)}
              />
            )}
            {view === 'launchpad' && (
              <Launchpad
                onOpenLogs={openLogs}
                pendingAdd={pendingAdd}
                onPendingConsumed={() => setPendingAdd(null)}
                pendingKind={paletteAdd}
                onPendingKindConsumed={() => setPaletteAdd(null)}
              />
            )}
            {view === 'backend' && <BackendConsole />}
            {view === 'terminal' && <TerminalWorkspace />}
            {view === 'logs' && <LogCenter />}
            {view === 'diagnose' && (
              <Diagnose
                selectedId={diagnoseId}
                onSelect={setDiagnoseId}
                onFix={runFix}
                refreshKey={fixNonce}
              />
            )}
            {view === 'settings' && <Settings />}
            {view === 'about' && <About />}
          </div>
        </main>

        <ActivitySidebar events={events} onClear={clearEvents} />
      </div>

      <CommandPalette
        open={paletteOpen}
        entries={entries}
        listeners={listeners}
        runtimeStatus={(id) => runtimes[id]?.status ?? 'idle'}
        onClose={() => setPaletteOpen(false)}
        onRun={(action) => void runPalette(action)}
      />

      {dialogs}
    </div>
  )
}


/**
 * 页头的搜索入口。点开即命令面板 —— 不做第二套搜索实现，
 * 否则「页头搜到的」和「Ctrl+K 搜到的」会是两套结果。
 */
function PaletteHint({ onOpen }: { onOpen: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="pressable-flat flex w-[260px] max-w-full items-center gap-2 rounded-[6px] border border-line bg-raised/50 px-2.5 py-1.5 text-left text-ink-faint hover:border-line-strong hover:text-ink-muted"
    >
      <MagnifyingGlass size={12} weight="bold" className="shrink-0 text-ink-faint/60" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-[11.5px]">
        搜索服务、端口、命令…
      </span>
      <kbd className="shrink-0 rounded-[3px] border border-line px-1 font-mono text-[9.5px] text-ink-faint/60">
        ^K
      </kbd>
    </button>
  )
}

/** 页头右下的常用动作。只在与当前视图相关时出现，避免每页都摆一排无关按钮 */
function QuickActions({
  view,
  onAdd
}: {
  view: ViewId
  onAdd: (kind: EntryKind) => void
}): React.JSX.Element | null {
  if (view !== 'launchpad' && view !== 'dashboard') return null
  return (
    <div className="flex items-center gap-1.5">
      <HeaderAction icon={Plus} label="添加服务" onClick={() => onAdd('service')} />
      <HeaderAction icon={Command} label="添加任务" onClick={() => onAdd('task')} />
      <HeaderAction
        icon={ArrowsClockwise}
        label="刷新状态"
        onClick={() => window.mile.scanner.refresh()}
      />
    </div>
  )
}

function HeaderAction({
  icon: IconCmp,
  label,
  onClick
}: {
  icon: React.ComponentType<{ size?: number; weight?: 'bold' }>
  label: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="pressable flex items-center gap-1.5 rounded-[6px] border border-line bg-raised/50 px-2.5 py-1.5 text-[11.5px] text-ink-muted hover:border-line-strong hover:bg-raised hover:text-ink-strong"
    >
      <IconCmp size={12} weight="bold" />
      {label}
    </button>
  )
}
