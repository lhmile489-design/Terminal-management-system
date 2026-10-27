import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowsClockwise, Command } from '@phosphor-icons/react'
import { ViewHeader } from './components/ViewHeader'
import { TitleBar } from './components/TitleBar'
import { NavRail, NAV_HOTKEYS, type ViewId } from './components/NavRail'
import { ActivityDrawer, type ActivityEvent } from './components/ActivityDrawer'
import { ShortcutOverlay } from './components/ShortcutOverlay'
import { Button, ConfirmHost, ToastHost, toast } from './components/ui'
import { hasOpenOverlay } from './lib/overlay'
import { ICON } from './lib/icons'
import { Dashboard } from './views/Dashboard'
import { Launchpad } from './views/Launchpad'
import { Services } from './views/Services'
import { BackendConsole } from './views/BackendConsole'
import { Workgroups } from './views/Workgroups'
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
  { title: string; caption: string }
> = {
  services: {
    title: '服务',
    caption: '按工作组启停前端、后端与任务，点一个服务看详情'
  },
  dashboard: {
    title: '总览',
    caption: '实时掌握本机监听端口与进程负载'
  },
  launchpad: {
    title: '前端启动台',
    caption: '一键启动与管理你的本地前端服务和批处理任务'
  },
  backend: {
    title: '后端控制台',
    caption: 'Spring Boot 项目管理：启停服务、Maven/Gradle 构建操作'
  },
  workgroups: {
    title: '工作组',
    caption: '按项目组合管理前端与后端服务，统一环境控制'
  },
  terminal: {
    title: '终端',
    caption: '会话输出、输入与历史回看'
  },
  logs: {
    title: '日志',
    caption: '跨会话汇总输出，按级别与关键字检索'
  },
  diagnose: {
    title: '诊断',
    caption: '预检、端口占用与会话回顾'
  },
  settings: {
    title: '设置',
    caption: '采集周期、主题与终端偏好'
  },
  about: {
    title: '关于',
    caption: '版本信息、使用教程与项目介绍'
  }
}

export function App(): React.JSX.Element {
  const [view, setView] = useState<ViewId>('dashboard')
  const [events, setEvents] = useState<ActivityEvent[]>([])
  // 实时动态改为抽屉（UI-REFACTOR Q1）：关着时新事件计入未读，失败类让角标变红
  const [drawerOpen, setDrawerOpen] = useState(false)
  const drawerOpenRef = useRef(false)
  drawerOpenRef.current = drawerOpen
  const [unread, setUnread] = useState(0)
  const [unreadFault, setUnreadFault] = useState(false)
  const [keysOpen, setKeysOpen] = useState(false)
  /** 每个条目上一次的状态，只在「进入」失败态时弹通知，同一状态重复推送不再弹 */
  const lastStatus = useRef(new Map<string, string>())
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
    if (!drawerOpenRef.current) {
      setUnread((n) => n + 1)
      if (level === 'fault') setUnreadFault(true)
    }
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

        // 失败通知条常驻到手动关闭（Q14）。阶段 4 有详情面板后，「查看输出」改为打开详情的输出标签
        const prev = lastStatus.current.get(runtime.entryId)
        lastStatus.current.set(runtime.entryId, runtime.status)
        if (meta.tone === 'fault' && prev !== runtime.status) {
          const name = useEntries.getState().entries.find((e) => e.id === runtime.entryId)?.name ?? '条目'
          const sid = runtime.sessionId
          const blocked = runtime.status === 'blocked'
          toast({
            tone: 'fault',
            title: `${name}：${meta.label}`,
            body: blocked ? '启动前检查没通过，诊断里有原因和修复入口' : '输出里能看到退出前的最后几行',
            action: blocked
              ? { label: '查看诊断', run: () => { setDiagnoseId(runtime.entryId); setView('diagnose') } }
              : sid
                ? { label: '查看输出', run: () => { void focusSession(sid); setView('terminal') } }
                : undefined
          })
        }
      }),
    [setRuntime, pushEvent, focusSession]
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
  // ⚠️ 扩展注意：向此 handler 添加新快捷键时，应避免与 xterm 默认快捷键冲突
  // （Ctrl+C/D/Z/L/R 等）。若必须覆盖，需先检查焦点是否在终端内并决定是否 preventDefault。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setPaletteOpen((v) => !v)
        return
      }
      // Ctrl+1..5 切换导航（UI-REFACTOR §5.2）。xterm 不占用这组键，终端里也能切
      if (e.ctrlKey && !e.altKey && !e.shiftKey && /^[1-5]$/.test(e.key)) {
        const target = NAV_HOTKEYS[Number(e.key)]
        if (target) {
          e.preventDefault()
          setView(target)
        }
        return
      }
      // 单键快捷键：焦点在输入框或终端里时不生效，避免打字误触发
      const el = e.target as HTMLElement | null
      const typing = !!el?.closest?.('input, textarea, select, [contenteditable="true"], .xterm')
      if (e.key === '?' && !e.ctrlKey && !e.altKey && !typing && !hasOpenOverlay()) {
        e.preventDefault()
        setKeysOpen(true)
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
  const openDrawer = useCallback(() => {
    setDrawerOpen((v) => !v)
    setUnread(0)
    setUnreadFault(false)
  }, [])
  const meta = TITLES[view]

  return (
    <div className="flex h-full flex-col bg-canvas">
      <TitleBar
        onSearch={() => setPaletteOpen(true)}
        onActivity={openDrawer}
        unread={unread}
        unreadFault={unreadFault}
      />

      <div className="flex min-h-0 flex-1">
        <NavRail active={view} onChange={setView} />

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* 视图头随内容滚动，只有标题栏吸顶（UI-REFACTOR §3.2）。key=view 切换时重播 view-enter */}
          <div key={view} className="view-enter flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
            <ViewHeader
              title={meta.title}
              caption={meta.caption}
              actions={<QuickActions view={view} onAdd={setPaletteAdd} />}
            />
            {view === 'dashboard' && (
              <Dashboard
                onRequestAdd={requestAdd}
                highlightPort={highlightPort}
                onHighlightConsumed={() => setHighlightPort(null)}
                onOpenLogs={openLogs}
              />
            )}
            {view === 'services' && <Services onOpenLogs={openLogs} />}
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
            {view === 'workgroups' && (
              <Workgroups onOpenLogs={openLogs} />
            )}
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

      {drawerOpen && (
        <ActivityDrawer events={events} onClear={clearEvents} onClose={() => setDrawerOpen(false)} />
      )}
      {keysOpen && <ShortcutOverlay onClose={() => setKeysOpen(false)} />}
      <ConfirmHost />
      <ToastHost />
    </div>
  )
}


/** 视图头右侧的常用动作。只在与当前视图相关时出现，避免每页都摆一排无关按钮 */
function QuickActions({
  view,
  onAdd
}: {
  view: ViewId
  onAdd: (kind: EntryKind) => void
}): React.JSX.Element | null {
  if (view !== 'launchpad' && view !== 'dashboard') return null
  return (
    <>
      <Button variant="ghost" icon={ArrowsClockwise} onClick={() => window.mile.scanner.refresh()}>
        刷新状态
      </Button>
      <Button variant="secondary" icon={Command} onClick={() => onAdd('task')}>
        添加任务
      </Button>
      <Button variant="primary" icon={ICON.add} onClick={() => onAdd('service')}>
        添加服务
      </Button>
    </>
  )
}
