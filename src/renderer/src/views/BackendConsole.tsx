import { useState, useCallback, useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  Play,
  Stop,
  ArrowClockwise,
  Terminal as TerminalIcon,
  Package,
  Wrench,
  TestTube,
  Archive,
  Eraser,
  CheckCircle,
  TreeStructure,
  Warning,
  Circle,
  Cube,
  ArrowRight,
  Copy,
  FileJpg,
  CaretDown,
  LightbulbFilament,
  FolderOpen,
  Rocket,
  ProhibitInset
} from '@phosphor-icons/react'
import type { LaunchEntry, MavenGoal, PrecheckResult, SpringBootLaunchMode } from '@shared/types'
import { GROUP_ENV_LABEL } from '@shared/types'
import {
  FRAMEWORK_LABEL,
  STATUS_META,
  isLiveStatus,
  SPRING_BOOT_LAUNCH_MODE_LABEL,
  FRAMEWORK_LAUNCH_MODES
} from '../lib/entryMeta'
import { StatusPill } from '../components/StatusPill'
import { TerminalView } from '../components/TerminalView'
import { PrecheckPanel } from '../components/PrecheckPanel'
import { useEntries } from '../store/entries'
import { useGroups } from '../store/groups'
import { useEntryFix } from '../lib/useEntryFix'

// ─── 构建目标定义 ─────────────────────────────────────────────────────────────

interface GoalDef {
  goal: MavenGoal
  label: string
  mavenCmd: string
  gradleCmd: string
  icon: React.ComponentType<{ size?: number; weight?: 'bold' | 'regular' | 'light' }>
  description: string
}

const GOALS: GoalDef[] = [
  { goal: 'clean',   label: 'Clean',   mavenCmd: 'mvn clean',   gradleCmd: 'gradle clean',              icon: Eraser,      description: '清除构建产物目录' },
  { goal: 'compile', label: 'Compile', mavenCmd: 'mvn compile', gradleCmd: 'gradle compileJava',         icon: Wrench,      description: '编译主源码' },
  { goal: 'test',    label: 'Test',    mavenCmd: 'mvn test',    gradleCmd: 'gradle test',                icon: TestTube,    description: '运行单元测试' },
  { goal: 'package', label: 'Package', mavenCmd: 'mvn package', gradleCmd: 'gradle build',               icon: Package,     description: '打包为 jar / war' },
  { goal: 'install', label: 'Install', mavenCmd: 'mvn install', gradleCmd: 'gradle publishToMavenLocal', icon: Archive,     description: '安装到本地仓库' },
  { goal: 'verify',  label: 'Verify',  mavenCmd: 'mvn verify',  gradleCmd: 'gradle check',               icon: CheckCircle, description: '运行集成测试并验证' },
]

// ─── 错误诊断 ─────────────────────────────────────────────────────────────────

interface Suggestion {
  label: string
  hint: string
  action: 'switch-mode' | 'copy-text' | 'copy-pom'
  switchMode?: SpringBootLaunchMode
  copyText?: string
}

const POM_PLUGIN_SNIPPET = `<build>
    <plugins>
        <plugin>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-maven-plugin</artifactId>
        </plugin>
    </plugins>
</build>`

function diagnoseError(error: string): Suggestion[] {
  const e = error.toLowerCase()
  const suggestions: Suggestion[] = []

  if (e.includes('mvnw') || e.includes('maven wrapper')) {
    suggestions.push({ label: '切换为系统 Maven', hint: '项目没有 mvnw.cmd，改用 PATH 里的 mvn 命令', action: 'switch-mode', switchMode: 'system-maven' })
    suggestions.push({ label: '复制生成 Wrapper 的命令', hint: '在项目根目录运行此命令可生成 mvnw.cmd', action: 'copy-text', copyText: 'mvn wrapper:wrapper' })
  }
  if (e.includes('no plugin found') && e.includes('spring-boot')) {
    suggestions.push({ label: '复制 pom.xml 插件配置', hint: '将此配置粘贴到 pom.xml 的 <build><plugins> 节点内', action: 'copy-pom' })
    suggestions.push({ label: '切换为 jar 模式', hint: '先 Package 打包，再改为 jar 模式直接运行 jar 文件', action: 'switch-mode', switchMode: 'jar' })
  }
  if ((e.includes('找不到 mvn') || (e.includes('path') && e.includes('mvn'))) && !e.includes('mvnw')) {
    suggestions.push({ label: '切换为 Maven Wrapper', hint: '如果项目有 mvnw.cmd，可改用 Wrapper 模式', action: 'switch-mode', switchMode: 'maven-wrapper' })
  }
  if (e.includes('gradlew') || e.includes('gradle wrapper')) {
    suggestions.push({ label: '切换为系统 Gradle', hint: '项目没有 gradlew.bat，改用 PATH 里的 gradle 命令', action: 'switch-mode', switchMode: 'system-gradle' })
  }
  if (e.includes('找不到 java') || (e.includes('path') && e.includes('java'))) {
    suggestions.push({ label: '复制检查命令', hint: '确认 JDK 是否正确安装并加入 PATH', action: 'copy-text', copyText: 'java -version' })
  }
  return suggestions
}

function buildToolOf(mode?: string): 'maven' | 'gradle' | 'unknown' {
  if (mode === 'maven-wrapper' || mode === 'system-maven') return 'maven'
  if (mode === 'gradle-wrapper' || mode === 'system-gradle') return 'gradle'
  return 'unknown'
}

function classifyProfile(name: string): 'prod' | 'sandbox' | 'dev' | 'custom' {
  const l = name.toLowerCase()
  if (l === 'prod' || l === 'production') return 'prod'
  if (l === 'dev' || l === 'sandbox' || l === 'staging' || l === 'uat') return 'sandbox'
  if (l === 'local' || l === 'development' || l === 'test') return 'dev'
  return 'custom'
}

const PROFILE_TONE: Record<ReturnType<typeof classifyProfile>, string> = {
  prod:    'border-fault/30 bg-fault/8 text-fault hover:bg-fault/14',
  sandbox: 'border-warn/30 bg-warn/8 text-warn hover:bg-warn/14',
  dev:     'border-live/30 bg-live/8 text-live hover:bg-live/14',
  custom:  'border-line bg-card text-ink-muted hover:bg-raised hover:text-ink-strong'
}

const PROFILE_LABEL: Record<ReturnType<typeof classifyProfile>, string> = {
  prod: '生产', sandbox: '沙箱', dev: '本地', custom: ''
}

// ─── 左侧：单个项目条目 ──────────────────────────────────────────────────────

function ProjectItem({
  entry,
  active,
  onClick
}: {
  entry: LaunchEntry
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  const runtimeOf = useEntries((s) => s.runtimeOf)
  const runtime = runtimeOf(entry.id)
  const live = isLiveStatus(runtime.status)
  const statusMeta = STATUS_META[runtime.status]

  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={[
        'pressable-flat group flex w-full min-w-0 items-center gap-2 rounded-[5px] px-2.5 py-2 text-left transition-colors duration-150',
        active
          ? 'bg-accent/10 text-ink-strong'
          : 'text-ink-muted hover:bg-raised/60 hover:text-ink-strong'
      ].join(' ')}
    >
      {/* 运行状态点 */}
      <span
        className={[
          'flex h-1.5 w-1.5 shrink-0 rounded-full transition-all duration-300',
          live
            ? 'bg-live shadow-[0_0_0_2.5px_color-mix(in_srgb,var(--signal-live)_22%,transparent)]'
            : active ? 'bg-accent/50' : 'bg-stroke-strong/60'
        ].join(' ')}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate text-[12px] font-medium leading-none">
        {entry.name}
      </span>
      {active && (
        <span
          className="shrink-0 rounded-[3px] bg-accent/15 px-1 font-mono text-[9px] font-bold text-accent"
          aria-hidden
        >
          {statusMeta.label}
        </span>
      )}
    </button>
  )
}

// ─── 构建目标按钮 ─────────────────────────────────────────────────────────────

function GoalButton({
  def, onClick, disabled, tool
}: {
  def: GoalDef
  onClick: () => void
  disabled: boolean
  tool: 'maven' | 'gradle' | 'unknown'
}): React.JSX.Element {
  const IconCmp = def.icon
  const cmdHint = tool === 'gradle' ? def.gradleCmd : def.mavenCmd
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={`${def.description}\n${cmdHint}`}
      className="pressable group flex items-center gap-1.5 rounded-[5px] border border-line bg-raised/40 px-2.5 py-1.5 text-[11px] text-ink-muted transition-all duration-150 hover:border-line-strong hover:bg-raised hover:text-ink-strong disabled:cursor-not-allowed disabled:opacity-30"
    >
      <span className="shrink-0 transition-colors duration-150 group-hover:text-accent"><IconCmp size={12} weight="regular" aria-hidden /></span>
      {def.label}
    </button>
  )
}

// ─── 带 profile 打包按钮 ──────────────────────────────────────────────────────

function PackageButton({
  profile, cmdHint, onClick, disabled
}: {
  profile: string | null
  cmdHint: string
  onClick: () => void
  disabled: boolean
}): React.JSX.Element {
  const cls = profile !== null
    ? PROFILE_TONE[classifyProfile(profile)]
    : 'border-line bg-raised/40 text-ink-muted hover:bg-raised hover:border-line-strong hover:text-ink-strong'
  const typeLabel = profile !== null ? PROFILE_LABEL[classifyProfile(profile)] : ''
  const displayLabel = profile !== null
    ? `${profile}${typeLabel ? ` · ${typeLabel}` : ''}`
    : '默认包'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={cmdHint}
      className={`pressable flex items-center gap-1.5 rounded-[5px] border px-2.5 py-1.5 text-[11px] font-medium transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-30 ${cls}`}
    >
      <Package size={11} weight="bold" className="shrink-0" aria-hidden />
      {displayLabel}
    </button>
  )
}

// ─── 空状态 ──────────────────────────────────────────────────────────────────

function ConsolePanelEmpty(): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-[10px] border border-line bg-raised">
        <TreeStructure size={18} weight="regular" className="text-ink-faint/50" aria-hidden />
      </div>
      <p className="text-[12px] text-ink-faint/70 leading-snug">
        从左侧选择一个<br />Spring Boot 项目
      </p>
    </div>
  )
}

// ─── 控制按钮 ────────────────────────────────────────────────────────────────

function CtrlButton({
  icon, label, onClick, disabled, primary, danger
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  primary?: boolean
  danger?: boolean
}): React.JSX.Element {
  const style = primary
    ? 'btn-primary'
    : danger
      ? 'border border-fault/25 bg-fault/8 text-fault hover:bg-fault/14'
      : 'border border-line bg-raised/40 text-ink-muted hover:bg-raised hover:text-ink-strong hover:border-line-strong'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`pressable flex h-6 items-center gap-1 rounded-[5px] px-2.5 text-[11px] font-medium transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${style}`}
    >
      {icon}
      {label}
    </button>
  )
}

// ─── 区块标题 ────────────────────────────────────────────────────────────────

function SectionLabel({
  children, badge
}: {
  children: React.ReactNode
  badge?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="mb-1.5 flex items-center gap-1.5">
      <span className="font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-ink-faint/60">
        {children}
      </span>
      {badge}
    </div>
  )
}

// ─── 主控制台面板 ─────────────────────────────────────────────────────────────

function ConsolePanel({ entry }: { entry: LaunchEntry }): React.JSX.Element {
  const { runtimeOf, start, stop, restart, mavenRun, packageWithProfile, edit, error, clearError } = useEntries(
    useShallow((s) => ({
      runtimeOf: s.runtimeOf,
      start: s.start,
      stop: s.stop,
      restart: s.restart,
      mavenRun: s.mavenRun,
      packageWithProfile: s.packageWithProfile,
      edit: s.edit,
      error: s.error,
      clearError: s.clearError
    }))
  )
  const busy = useEntries((s) => !!s.busy[entry.id])
  const groupOf = useGroups((s) => s.groupOf)

  const runtime = runtimeOf(entry.id)
  const statusMeta = STATUS_META[runtime.status]
  const live = isLiveStatus(runtime.status)
  const sessionId = runtime.sessionId ?? null

  const tool = buildToolOf(entry.launchMode)
  const mode = entry.launchMode as SpringBootLaunchMode | undefined
  const isJarMode = mode === 'jar'

  // 环境警示：所属工作组的 env 为 sandbox 或 prod 时，启动前弹内联确认横幅
  const entryGroup = entry.groupId ? groupOf(entry.groupId) : undefined
  const envLevel = entryGroup?.env
  const [showEnvWarning, setShowEnvWarning] = useState(false)

  const [precheck, setPrecheck] = useState<PrecheckResult | null>(null)
  const { runFix, dialogs: fixDialogs } = useEntryFix(useCallback(() => setPrecheck(null), []))

  // profiles：运行时扫描 application-*.yml/properties
  const [profiles, setProfiles] = useState<string[]>([])
  useEffect(() => {
    let cancelled = false
    void window.mile.entry.detectProfiles(entry.id).then((list) => {
      if (!cancelled) setProfiles(list)
    })
    return () => { cancelled = true }
  }, [entry.id])

  // jars：jar 模式时扫描 target/*.jar
  const [jars, setJars] = useState<string[]>([])
  useEffect(() => {
    if (!isJarMode) { setJars([]); return }
    let cancelled = false
    void window.mile.entry.listJars(entry.id).then((list) => {
      if (!cancelled) setJars(list)
    })
    return () => { cancelled = true }
  }, [isJarMode, entry.id, runtime.startedAt])   // startedAt 变化意味着有新构建/启动

  // 复制反馈
  const [copiedHint, setCopiedHint] = useState<string | null>(null)
  const showCopied = useCallback((hint: string) => {
    setCopiedHint(hint)
    setTimeout(() => setCopiedHint(null), 2000)
  }, [])

  // 切换启动方式
  const handleModeChange = useCallback(async (newMode: SpringBootLaunchMode) => {
    if (live) return
    clearError()
    await edit(entry.id, { launchMode: newMode })
  }, [live, edit, entry.id, clearError])

  // 建议动作执行
  const handleSuggestion = useCallback(async (s: Suggestion) => {
    if (s.action === 'switch-mode' && s.switchMode) {
      await handleModeChange(s.switchMode)
    } else if (s.action === 'copy-text' && s.copyText) {
      await navigator.clipboard.writeText(s.copyText)
      showCopied(s.copyText)
    } else if (s.action === 'copy-pom') {
      await navigator.clipboard.writeText(POM_PLUGIN_SNIPPET)
      showCopied('pom.xml 插件配置已复制')
    }
  }, [handleModeChange, showCopied])

  const handleStart = useCallback(async () => {
    // 环境警示：沙箱 / 生产环境先弹确认横幅
    if ((envLevel === 'sandbox' || envLevel === 'prod') && !showEnvWarning) {
      setShowEnvWarning(true)
      return
    }
    setShowEnvWarning(false)
    clearError(); setPrecheck(null)
    const result = await start(entry.id)
    if (result) setPrecheck(result)
  }, [start, entry.id, clearError, envLevel, showEnvWarning])

  const handleStop = useCallback(() => {
    clearError(); void stop(entry.id)
  }, [stop, entry.id, clearError])

  const handleRestart = useCallback(async () => {
    clearError(); setPrecheck(null)
    const result = await restart(entry.id)
    if (result) setPrecheck(result)
  }, [restart, entry.id, clearError])

  const handleGoal = useCallback(
    (goal: MavenGoal) => { clearError(); void mavenRun(entry.id, goal) },
    [mavenRun, entry.id, clearError]
  )

  const handlePackage = useCallback(
    (profile: string | null) => { clearError(); void packageWithProfile(entry.id, profile) },
    [packageWithProfile, entry.id, clearError]
  )

  const suggestions = error ? diagnoseError(error) : []
  const springBootModes = FRAMEWORK_LAUNCH_MODES['spring-boot'] as SpringBootLaunchMode[]

  return (
    <div className="flex h-full flex-col overflow-hidden">

      {/* ── 顶部信息栏 ── */}
      <div className="shrink-0 border-b border-line px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          {/* 图标 */}
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[7px] border"
            style={{
              background: `color-mix(in srgb, var(--signal-${live ? 'live' : 'accent'}) 12%, var(--surface-raised))`,
              borderColor: `color-mix(in srgb, var(--signal-${live ? 'live' : 'accent'}) 30%, var(--stroke-base))`
            }}
          >
            <span style={{ color: `var(--signal-${live ? 'live' : 'accent'})` }}>
              <Cube size={15} weight="regular" aria-hidden />
            </span>
          </div>

          {/* 名称 + 框架 */}
          <div className="min-w-0 flex-1 pt-0.5">
            <h2 className="truncate text-[13px] font-semibold text-ink-strong leading-tight">
              {entry.name}
            </h2>
            <p className="mt-0.5 font-mono text-[10px] text-ink-faint/70">
              {FRAMEWORK_LABEL[entry.framework]}
            </p>
          </div>

          {/* 状态胶囊 */}
          <StatusPill tone={statusMeta.tone} label={statusMeta.label} halo={live} />
        </div>

        {/* 启动方式选择器 */}
        <div className="mt-2.5 flex items-center gap-2">
          <span className="shrink-0 font-mono text-[9px] text-ink-faint/50 uppercase tracking-[0.12em]">
            启动方式
          </span>
          <div className="relative flex-1">
            <select
              value={mode ?? ''}
              onChange={(e) => { void handleModeChange(e.target.value as SpringBootLaunchMode) }}
              disabled={live || busy}
              title={live ? '请先停止服务再切换启动方式' : '切换启动方式无需重启应用'}
              className="w-full appearance-none rounded-[5px] border border-line bg-raised/40 py-1 pl-2.5 pr-6 font-mono text-[11px] text-ink-muted transition-colors hover:border-line-strong hover:text-ink-strong disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="" disabled>未设置（仅登记）</option>
              {springBootModes.map((m) => (
                <option key={m} value={m}>{SPRING_BOOT_LAUNCH_MODE_LABEL[m]}</option>
              ))}
            </select>
            <CaretDown size={9} weight="bold" className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ink-faint/50" aria-hidden />
          </div>
          {live && (
            <span className="shrink-0 font-mono text-[9px] text-warn/70">运行中·停止后可切换</span>
          )}
        </div>

        {/* 控制按钮行 */}
        <div className="mt-2 flex items-center gap-1.5">
          {live ? (
            <CtrlButton icon={<Stop size={10} weight="bold" />} label="停止" onClick={handleStop} disabled={busy} danger />
          ) : (
            <CtrlButton icon={<Play size={10} weight="bold" />} label="启动" onClick={() => void handleStart()} disabled={busy || entry.registerOnly} primary />
          )}
          <CtrlButton
            icon={<ArrowClockwise size={10} weight="bold" />}
            label="重启"
            onClick={() => void handleRestart()}
            disabled={busy || entry.registerOnly || !live}
          />
          {sessionId && (
            <span className="ml-auto font-mono text-[9.5px] text-ink-faint/40 select-none">
              #{sessionId.slice(0, 6)}
            </span>
          )}
        </div>
      </div>

      {/* ── 环境警示横幅 ── */}
      {showEnvWarning && entryGroup && (envLevel === 'sandbox' || envLevel === 'prod') && (
        <div
          className={[
            'mx-4 mt-2 shrink-0 rounded-[5px] border px-3 py-2.5',
            envLevel === 'prod'
              ? 'border-fault/30 bg-fault/8'
              : 'border-warn/30 bg-warn/8'
          ].join(' ')}
        >
          <div className="flex items-start gap-2">
            {envLevel === 'prod' ? (
              <ProhibitInset size={13} weight="fill" className="mt-px shrink-0 text-fault" aria-hidden />
            ) : (
              <Warning size={13} weight="bold" className="mt-px shrink-0 text-warn" aria-hidden />
            )}
            <div className="flex-1">
              <p className={`text-[12px] font-semibold ${envLevel === 'prod' ? 'text-fault' : 'text-warn'}`}>
                {envLevel === 'prod'
                  ? `警告：当前工作组「${entryGroup.name}」处于生产环境！`
                  : `当前工作组「${entryGroup.name}」处于沙箱（${GROUP_ENV_LABEL[envLevel]}）环境`
                }
              </p>
              {envLevel === 'prod' && (
                <p className="mt-0.5 text-[11px] text-fault/80">生产环境启动将影响真实业务数据，请确认操作。</p>
              )}
            </div>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleStart()}
              className={[
                'pressable flex items-center gap-1 rounded-[4px] border px-3 py-1 text-[11.5px] font-medium transition-colors',
                envLevel === 'prod'
                  ? 'border-fault/30 bg-fault/10 text-fault hover:bg-fault/18'
                  : 'border-warn/30 bg-warn/10 text-warn hover:bg-warn/18'
              ].join(' ')}
            >
              <Play size={9} weight="bold" aria-hidden />
              确认启动
            </button>
            <button
              type="button"
              onClick={() => setShowEnvWarning(false)}
              className="pressable flex items-center gap-1 rounded-[4px] border border-line bg-raised/40 px-3 py-1 text-[11.5px] text-ink-muted transition-colors hover:bg-raised hover:text-ink-strong"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* ── 错误横幅 + 智能修复建议 ── */}
      {error && (
        <div className="mx-4 mt-2 shrink-0">
          {/* 错误文本 */}
          <div className="flex items-start gap-2 rounded-t-[5px] border border-b-0 border-fault/25 bg-fault/7 px-2.5 py-2">
            <Warning size={11} weight="bold" className="mt-px shrink-0 text-fault" aria-hidden />
            <p className="flex-1 text-[11px] leading-relaxed text-fault">{error}</p>
            <button
              type="button"
              onClick={clearError}
              className="shrink-0 text-[10px] text-fault/50 hover:text-fault transition-colors"
              aria-label="关闭错误"
            >
              ✕
            </button>
          </div>
          {/* 建议区 */}
          {suggestions.length > 0 && (
            <div className="rounded-b-[5px] border border-t border-fault/15 bg-raised/60 px-2.5 py-2">
              <div className="mb-1.5 flex items-center gap-1">
                <LightbulbFilament size={10} weight="bold" className="text-accent/70" aria-hidden />
                <span className="font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-ink-faint/60">修复建议</span>
              </div>
              <div className="flex flex-col gap-1">
                {suggestions.map((s, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => void handleSuggestion(s)}
                    className="pressable-flat flex min-w-0 items-center gap-2 rounded-[4px] px-2 py-1.5 text-left transition-colors hover:bg-raised"
                  >
                    <span className="shrink-0 text-accent/70">
                      {s.action === 'switch-mode' ? <ArrowRight size={10} weight="bold" aria-hidden /> : <Copy size={10} weight="bold" aria-hidden />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[11px] font-medium text-ink-strong">{s.label}</span>
                      <span className="block text-[10px] text-ink-faint/70 leading-tight mt-0.5">{s.hint}</span>
                    </span>
                  </button>
                ))}
              </div>
              {copiedHint && (
                <p className="mt-1.5 text-[10px] text-live/80">✓ 已复制：{copiedHint}</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── 预检结果 ── */}
      {precheck && (
        <div className="mx-4 mt-2 shrink-0">
          <PrecheckPanel result={precheck} onFix={(action, suggestedPort) => void runFix(entry.id, action, suggestedPort)} />
        </div>
      )}
      {fixDialogs}

      {/* ── 构建操作区（非 jar 模式）── */}
      {!isJarMode && (
        <div className="shrink-0 border-b border-line px-4 py-3">
          <SectionLabel
            badge={
              tool !== 'unknown' && (
                <span className="rounded-[3px] bg-raised px-1.5 font-mono text-[8.5px] text-ink-faint/70">
                  {tool === 'maven' ? 'Maven' : 'Gradle'}
                </span>
              )
            }
          >
            构建
          </SectionLabel>
          <div className="flex flex-wrap gap-1.5">
            {GOALS.map((def) => (
              <GoalButton key={def.goal} def={def} onClick={() => handleGoal(def.goal)} disabled={busy} tool={tool} />
            ))}
          </div>

          <div className="mt-3">
            <SectionLabel
              badge={
                profiles.length > 0 && (
                  <span className="rounded-[3px] bg-raised px-1.5 font-mono text-[8.5px] text-ink-faint/70">
                    {profiles.length} 个 profile
                  </span>
                )
              }
            >
              打包
            </SectionLabel>
            <div className="flex flex-wrap gap-1.5">
              <PackageButton
                profile={null}
                cmdHint={tool === 'gradle'
                  ? (mode === 'gradle-wrapper' ? 'gradlew build' : 'gradle build')
                  : (mode === 'maven-wrapper' ? 'mvnw package' : 'mvn package')}
                onClick={() => handlePackage(null)}
                disabled={busy}
              />
              {profiles.map((p) => (
                <PackageButton
                  key={p}
                  profile={p}
                  cmdHint={tool === 'gradle'
                    ? (mode === 'gradle-wrapper' ? `gradlew build -P${p}` : `gradle build -P${p}`)
                    : (mode === 'maven-wrapper' ? `mvnw package -P ${p}` : `mvn package -P ${p}`)}
                  onClick={() => handlePackage(p)}
                  disabled={busy}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── 打包完成操作横幅（当 runtime.lastBuiltJar 非空时出现）── */}
      {runtime.lastBuiltJar && (
        <div className="mx-4 mt-2 shrink-0 rounded-[5px] border border-live/25 bg-live/7 px-3 py-2">
          <div className="flex items-center gap-2">
            <CheckCircle size={11} weight="bold" className="shrink-0 text-live" aria-hidden />
            <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-live/90">
              打包完成：{runtime.lastBuiltJar.replace('target/', '')}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => void window.mile.entry.revealLastJar(entry.id)}
              className="pressable flex items-center gap-1 rounded-[4px] border border-live/25 bg-live/8 px-2 py-1 text-[10.5px] text-live/90 transition-colors hover:bg-live/15"
            >
              <FolderOpen size={10} weight="bold" aria-hidden />
              在资源管理器中打开
            </button>
            <button
              type="button"
              disabled={live || busy}
              onClick={() => void (async () => {
                await edit(entry.id, { jarPath: runtime.lastBuiltJar ?? null, launchMode: 'jar' })
                clearError()
                void handleStart()
              })()}
              title={live ? '请先停止服务再切换' : '切换到此 jar 并立即启动'}
              className="pressable flex items-center gap-1 rounded-[4px] border border-live/25 bg-live/8 px-2 py-1 text-[10.5px] text-live/90 transition-colors hover:bg-live/15 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Rocket size={10} weight="bold" aria-hidden />
              切换到此 jar 并启动
            </button>
          </div>
        </div>
      )}

      {/* ── Jar 模式：jar 文件选择区 ── */}
      {isJarMode && (
        <div className="shrink-0 border-b border-line px-4 py-3">
          <SectionLabel
            badge={
              jars.length > 0 && (
                <span className="rounded-[3px] bg-raised px-1.5 font-mono text-[8.5px] text-ink-faint/70">
                  {jars.length} 个 jar
                </span>
              )
            }
          >
            Jar 文件
          </SectionLabel>

          {/* 当前已选 */}
          {entry.jarPath ? (
            <div className="mb-2 flex items-center gap-1.5 rounded-[4px] bg-raised/50 px-2 py-1.5">
              <FileJpg size={11} weight="regular" className="shrink-0 text-accent/70" aria-hidden />
              <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-muted">{entry.jarPath}</span>
              <span className="shrink-0 rounded-[3px] bg-accent/12 px-1 font-mono text-[8.5px] text-accent">当前</span>
            </div>
          ) : (
            <p className="mb-2 text-[11px] text-ink-faint/60">未配置 jar 路径，请先 Package 打包后从下方选择</p>
          )}

          {/* 扫描到的 jar 列表 */}
          {jars.length > 0 ? (
            <div className="flex flex-col gap-1">
              {jars.map((j) => (
                <button
                  key={j}
                  type="button"
                  disabled={live || busy}
                  onClick={() => void edit(entry.id, { jarPath: j, launchMode: 'jar' })}
                  title={live ? '请先停止再切换 jar 文件' : `使用 ${j}`}
                  className={[
                    'pressable-flat flex items-center gap-2 rounded-[4px] border px-2 py-1.5 text-left text-[11px] transition-colors',
                    entry.jarPath === j
                      ? 'border-accent/25 bg-accent/8 text-accent'
                      : 'border-line bg-raised/30 text-ink-muted hover:border-line-strong hover:bg-raised hover:text-ink-strong',
                    (live || busy) ? 'cursor-not-allowed opacity-50' : ''
                  ].join(' ')}
                >
                  <FileJpg size={11} weight="regular" className="shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px]">
                    {j.replace('target/', '')}
                  </span>
                  {entry.jarPath !== j && (
                    <span className="shrink-0 text-[9px] text-ink-faint/50">使用</span>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-[10.5px] text-ink-faint/50">
              target/ 目录为空，先执行 Package 打包生成 jar
            </p>
          )}
        </div>
      )}

      {/* ── 终端输出 ── */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-1.5">
          <TerminalIcon size={10} weight="bold" className="text-ink-faint/50" aria-hidden />
          <span className="font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-ink-faint/60">
            输出
          </span>
          {sessionId && (
            <span className="ml-auto font-mono text-[9px] text-ink-faint/40">
              {live ? (
                <span className="inline-flex items-center gap-1">
                  <Circle size={6} weight="fill" className="text-live" aria-hidden />
                  运行中
                </span>
              ) : '已停止'}
            </span>
          )}
        </div>
        <div className="flex-1 overflow-hidden">
          {sessionId ? (
            <TerminalView sessionId={sessionId} />
          ) : (
            <div className="flex h-full items-center justify-center">
              <p className="font-mono text-[10.5px] text-ink-faint/40">等待会话启动…</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── 主视图 ──────────────────────────────────────────────────────────────────

export function BackendConsole(): React.JSX.Element {
  const entries = useEntries((s) => s.entries)
  const springBootEntries = entries.filter((e) => e.framework === 'spring-boot')

  const [selectedId, setSelectedId] = useState<string | null>(
    () => springBootEntries[0]?.id ?? null
  )
  const selectedEntry = springBootEntries.find((e) => e.id === selectedId) ?? null

  return (
    <div className="-mx-6 -my-5 flex min-h-0 flex-1 overflow-hidden">

      {/* ── 左侧导航栏 ── */}
      <div className="flex w-48 shrink-0 flex-col border-r border-line bg-panel">
        {/* 侧栏头部 */}
        <div className="shrink-0 border-b border-line px-3 py-2.5">
          <div className="flex items-center gap-1.5">
            <Cube size={11} weight="regular" className="shrink-0 text-ink-faint/60" aria-hidden />
            <span className="font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-ink-faint/70">
              Java 项目
            </span>
            {springBootEntries.length > 0 && (
              <span className="ml-auto rounded-[3px] bg-raised px-1.5 font-mono text-[8.5px] text-ink-faint/60">
                {springBootEntries.length}
              </span>
            )}
          </div>
        </div>

        {/* 项目列表 */}
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {springBootEntries.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <TreeStructure size={18} weight="regular" className="text-ink-faint/30" aria-hidden />
              <p className="text-[10.5px] text-ink-faint/50 leading-snug">
                在启动台添加<br />Spring Boot 项目
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {springBootEntries.map((entry) => (
                <ProjectItem
                  key={entry.id}
                  entry={entry}
                  active={entry.id === selectedId}
                  onClick={() => setSelectedId(entry.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── 右侧控制台 ── */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-canvas">
        {selectedEntry ? (
          <ConsolePanel key={selectedEntry.id} entry={selectedEntry} />
        ) : (
          <ConsolePanelEmpty />
        )}
      </div>
    </div>
  )
}
