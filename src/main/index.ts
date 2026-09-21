import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell, Tray } from 'electron'
import { Channels } from '@shared/channels'
import type {
  CreateSessionInput,
  EntryEdit,
  EntryStatus,
  LogQuery,
  MavenGoal,
  NewLaunchEntry,
  Settings,
  ThemePreference
} from '@shared/types'
import { SessionService } from './services/SessionService'
import { ConfigStore } from './services/ConfigStore'
import { ThemeService } from './services/ThemeService'
import { OwnershipService } from './services/OwnershipService'
import { ScannerService } from './services/ScannerService'
import { DetectService } from './services/DetectService'
import { EntryService } from './services/EntryService'
import { LogService } from './services/LogService'

// 打包后 resources/ 被 extraResources 平铺到 resourcesPath，开发期从工程根取
const iconPath = app.isPackaged
  ? join(process.resourcesPath, 'icon.png')
  : join(__dirname, '../../resources/icon.png')

const ownership = new OwnershipService()
const sessions = new SessionService(ownership)
const detect = new DetectService()
// 与 sessions 同时建起来：日志靠订阅 data 事件收集，晚一步挂钩就会漏掉那段输出
const logs = new LogService(sessions)
let config: ConfigStore
let theme: ThemeService
let scanner: ScannerService
let entries: EntryService
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
/** before-quit 已触发：close 事件不再拦成「收起到托盘」 */
let quitting = false

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    // 从任务栏隐藏（仅托盘）—— 构造时读一次，托盘 show() 重建窗口也走这条路
    skipTaskbar: config.get().settings.hideFromTaskbar,
    icon: iconPath,
    // 与令牌 --surface-canvas 对齐，避免启动瞬间闪白
    backgroundColor: theme.state().resolved === 'dark' ? '#0B0F14' : '#F6F7F9',
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow = win
  win.once('ready-to-show', () => win.show())

  const notifyMaximize = (): void =>
    win.webContents.send(Channels.windowMaximizeChanged, win.isMaximized())
  win.on('maximize', notifyMaximize)
  win.on('unmaximize', notifyMaximize)

  win.on('minimize', () => scanner.setVisible(false))
  win.on('restore', () => scanner.setVisible(true))
  win.on('hide', () => scanner.setVisible(false))
  win.on('show', () => scanner.setVisible(true))

  // closeToTray：关闭只收起窗口，受控进程继续跑。真正退出走托盘菜单或 before-quit，
  // 否则用户以为「关掉了」而 dev server 还在后台占端口。
  win.on('close', (e) => {
    if (quitting || !config.get().settings.closeToTray) return
    e.preventDefault()
    win.hide()
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    win.loadURL(devUrl)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * 托盘，PRD §9.3。closeToTray 打开后窗口会被收进这里，所以托盘必须始终存在 ——
 * 否则关窗即失联，只能去任务管理器结束进程。
 */
function createTray(): void {
  tray = new Tray(iconPath)
  tray.setToolTip('Mile Terminal')

  const show = (): void => {
    if (!mainWindow) {
      createWindow()
      return
    }
    mainWindow.show()
    mainWindow.focus()
  }

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: show },
      { type: 'separator' },
      // 这里必须走 app.quit()：直接 destroy 窗口会跳过 before-quit，
      // killOwnedOnQuit 的清理就不会执行
      { label: '退出', click: () => app.quit() }
    ])
  )
  tray.on('click', show)
  tray.on('double-click', show)
}

function registerIpc(): void {
  ipcMain.handle(Channels.sessionList, () => sessions.list())
  ipcMain.handle(Channels.sessionCreate, (_e, input: CreateSessionInput) => sessions.create(input))
  ipcMain.handle(Channels.sessionHistory, (_e, id: string) => sessions.history(id))
  ipcMain.handle(Channels.sessionStop, (_e, id: string) => sessions.stop(id))
  ipcMain.on(Channels.sessionWrite, (_e, id: string, data: string) => sessions.write(id, data))
  ipcMain.on(Channels.sessionResize, (_e, id: string, cols: number, rows: number) =>
    sessions.resize(id, cols, rows)
  )

  // 仅允许 localhost 的 http，端口取整校验 —— 不接受渲染层传任意 URL，PRD §11
  ipcMain.on(Channels.shellOpenLocalhost, (_e, port: unknown) => {
    if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) return
    void shell.openExternal(`http://localhost:${port as number}`)
  })

  ipcMain.on(Channels.shellOpenPath, (_e, target: unknown) => {
    if (typeof target !== 'string') return
    // 白名单二选一：采集到的现存目录，或启动台已登记条目的目录/产物目录。
    // 两者都不匹配就拒绝 —— 不接受渲染层构造任意路径触发关联程序，PRD §11。
    if (!scanner.knownPath(target) && !entries.knownPath(target)) return
    void shell.openPath(target)
  })

  ipcMain.handle(Channels.entryList, () => entries.list())
  ipcMain.handle(Channels.entryAdd, (_e, input: NewLaunchEntry) => entries.add(input))
  // 渲染层没有不受校验的写入口：edit 只认白名单字段，运行中改身份字段直接抛错，PRD §4.6
  ipcMain.handle(Channels.entryEdit, (_e, id: string, patch: EntryEdit) => entries.edit(id, patch))
  ipcMain.handle(Channels.entryRemove, (_e, id: string) => entries.remove(id))
  ipcMain.handle(Channels.entryReorder, (_e, ids: string[]) => entries.reorder(ids))
  ipcMain.handle(Channels.entryDetect, (_e, path: string) => detect.detect(path))
  ipcMain.handle(Channels.entryPrecheck, (_e, id: string) => entries.runPrecheck(id))
  ipcMain.handle(Channels.entryStart, (_e, id: string) => entries.start(id))
  ipcMain.handle(Channels.entryStop, (_e, id: string) => entries.stop(id))
  ipcMain.handle(Channels.entryRestart, (_e, id: string) => entries.restart(id))
  ipcMain.handle(Channels.entryInstall, (_e, id: string) => entries.install(id))
  // 后端控制台：Maven/Gradle 构建任务。goal 在主进程白名单校验，不接受自由字符串。
  ipcMain.handle(Channels.entryMavenRun, (_e, id: string, goal: unknown) => {
    const VALID_GOALS: MavenGoal[] = ['clean', 'compile', 'package', 'test', 'install', 'verify']
    if (typeof goal !== 'string' || !VALID_GOALS.includes(goal as MavenGoal)) {
      throw new Error(`非法构建目标：${String(goal)}`)
    }
    return entries.mavenRun(id, goal as MavenGoal)
  })
  // 带 profile 的打包：profile 为 null 不带 -P；命令构造全在主进程，profile 经 SAFE_PROFILE 白名单
  ipcMain.handle(Channels.entryPackageWithProfile, (_e, id: unknown, profile: unknown) => {
    if (typeof id !== 'string') throw new Error('条目 id 非法')
    if (profile !== null && typeof profile !== 'string') {
      throw new Error('profile 必须是字符串或 null')
    }
    return entries.packageWithProfile(id, profile as string | null)
  })
  // 检测 Spring Boot profile 配置文件列表（只读目录，不执行代码）
  ipcMain.handle(Channels.entryDetectProfiles, (_e, id: unknown) => {
    if (typeof id !== 'string') return []
    const entry = entries.get(id)
    if (!entry || entry.framework !== 'spring-boot') return []
    return detect.detectSpringBootProfiles(entry.path)
  })
  // 扫描 target/ 目录下的 jar 文件列表（只读目录），供后端控制台 jar 模式一键选择
  ipcMain.handle(Channels.entryListJars, (_e, id: unknown) => {
    if (typeof id !== 'string') return []
    return entries.listJars(id)
  })
  // 只收 id + 脚本名，命令构造与脚本校验全在主进程，PRD §9.5 / §11
  ipcMain.handle(Channels.entryRunScript, (_e, id: string, script: string) => {
    if (typeof script !== 'string') throw new Error('脚本名必须是字符串')
    return entries.runScript(id, script)
  })
  ipcMain.handle(Channels.entryDiagnose, (_e, id: string) => entries.diagnose(id))
  ipcMain.handle(Channels.entryOutputDir, (_e, id: string) => entries.outputDir(id))
  // 路径全在主进程构造（entries.revealOutput → outputDir → readdir），渲染层只给 id，PRD §11
  ipcMain.handle(Channels.entryRevealOutput, async (_e, id: string) => {
    const result = await entries.revealOutput(id)
    if (!result.path) return false
    if (result.kind === 'file') {
      shell.showItemInFolder(result.path)
    } else {
      const err = await shell.openPath(result.path)
      if (err) return false
    }
    return true
  })

  // 路径由主进程按条目 id 自己拼，渲染层只给 id —— 不接受传入任意文件路径，PRD §11
  ipcMain.handle(Channels.entryOpenPackageJson, async (_e, id: string) => {
    const target = entries.packageJsonPath(id)
    if (!target) return false
    const err = await shell.openPath(target)
    if (err) throw new Error(err)
    return true
  })
  // uniapp 专属：只收 id，cli.exe 探测与命令构造全在主进程，PRD §11
  ipcMain.handle(Channels.entryOpenInHBuilderX, (_e, id: string) => entries.openInHBuilderX(id))
  ipcMain.handle(Channels.entryRuntimes, () => entries.runtimeList())
  // 只收 id，路径由主进程按条目自己拼，返回 base64 data URL 或 null，只读不联网，PRD §11
  ipcMain.handle(Channels.entryFavicon, (_e, id: unknown) =>
    typeof id === 'string' ? entries.favicon(id) : null
  )
  // 自定义图片：渲染层传 id + 原始字节，主进程压缩落盘并回填哈希文件名。字节做上限
  // 校验（8MB），超限拒绝避免大文件占内存；解码/非图片由 ImageService 兜底抛错。
  ipcMain.handle(Channels.entrySetImage, (_e, id: unknown, bytes: unknown) => {
    if (typeof id !== 'string') throw new Error('条目 id 非法')
    const view =
      bytes instanceof Uint8Array
        ? bytes
        : bytes instanceof ArrayBuffer
          ? new Uint8Array(bytes)
          : null
    if (!view) throw new Error('图片数据非法')
    if (view.byteLength === 0) throw new Error('图片为空')
    if (view.byteLength > 8 * 1024 * 1024) throw new Error('图片过大（上限 8MB）')
    return entries.setImage(id, view)
  })
  ipcMain.handle(Channels.entryClearImage, (_e, id: unknown) => {
    if (typeof id !== 'string') throw new Error('条目 id 非法')
    return entries.clearImage(id)
  })
  ipcMain.handle(Channels.entryImage, (_e, id: unknown) =>
    typeof id === 'string' ? entries.imageDataUrl(id) : null
  )
  entries.on('changed', (list) => mainWindow?.webContents.send(Channels.entryChanged, list))
  entries.on('runtime', (runtime) =>
    mainWindow?.webContents.send(Channels.entryRuntimeChanged, runtime)
  )
  entries.on('taskDone', notifyTaskDone)
  // 这条以前没人订阅：「端口 5 秒未释放」只在主进程 emit 一下就没了，
  // 而重启后端口还被占着恰恰是用户最需要知道的那一刻
  entries.on('warning', (text: string) =>
    mainWindow?.webContents.send(Channels.entryWarning, text)
  )

  // 查询条件逐字段校形：坏值会让筛选静默失效，用户以为「没有这样的日志」
  ipcMain.handle(Channels.logQuery, (_e, query: unknown) => logs.query(sanitizeLogQuery(query)))
  ipcMain.on(Channels.logClear, () => logs.clear())

  ipcMain.handle(Channels.settingsGet, () => config.get().settings)

  // 设置直接驱动采集周期、退出行为等，逐字段校验后再落盘 —— 不接受渲染层
  // 塞进任意键值，坏值会让采集器排出无意义的定时或让配置结构走形。
  ipcMain.handle(Channels.settingsPatch, (_e, patch: unknown) => {
    const next = sanitizeSettings(patch)
    const updated = config.patchSettings(next).settings
    // 采集周期改了要立刻生效，否则要等下一轮才换节奏
    if (next.scanIntervalMs !== undefined) scanner.reschedule()
    // 主题走 ThemeService，它还要同步 nativeTheme.themeSource 并广播
    if (next.theme !== undefined) theme.set(next.theme)
    // 任务栏可见性即时生效：托盘常驻，隐藏后窗口仍能从托盘唤出
    if (next.hideFromTaskbar !== undefined) mainWindow?.setSkipTaskbar(next.hideFromTaskbar)
    mainWindow?.webContents.send(Channels.settingsChanged, updated)
    return updated
  })

  ipcMain.handle(Channels.dialogPickDirectory, async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择项目目录',
      properties: ['openDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(Channels.scannerSnapshot, () => scanner.snapshot())
  ipcMain.on(Channels.scannerRefresh, () => scanner.refresh())
  ipcMain.on(Channels.scannerVisibility, (_e, visible: boolean) => scanner.setVisible(visible))
  ipcMain.on(Channels.scannerIgnore, (_e, processName: string, port: number) =>
    scanner.ignore(processName, port)
  )
  ipcMain.on(Channels.scannerHideOnce, (_e, pid: number, port: number) =>
    scanner.hideOnce(pid, port)
  )

  // 分组只影响列表怎么排，不影响能不能停 —— 权限判定始终在 OwnershipService，PRD §5.2
  ipcMain.handle(Channels.scannerSetGroup, (_e, processName: unknown, group: unknown) => {
    if (typeof processName !== 'string') throw new Error('进程名必须是字符串')
    if (group !== 'mine' && group !== 'background' && group !== null) {
      throw new Error('分组只接受 mine / background / null')
    }
    scanner.setGroup(processName, group)
  })

  ipcMain.handle(Channels.scannerWatchedGet, () => config.get().watchedKeywords)
  ipcMain.handle(Channels.scannerWatchedSet, (_e, keywords: unknown) =>
    scanner.setWatchedKeywords(keywords)
  )
  scanner.on('diff', (diff) => mainWindow?.webContents.send(Channels.scannerDiff, diff))

  ipcMain.handle(Channels.themeGet, () => theme.state())
  ipcMain.handle(Channels.themeSet, (_e, preference: ThemePreference) => theme.set(preference))
  theme.on('changed', (state) => mainWindow?.webContents.send(Channels.themeChanged, state))

  ipcMain.handle(Channels.windowIsMaximized, () => mainWindow?.isMaximized() ?? false)
  ipcMain.handle(Channels.appInfo, () => ({ version: app.getVersion(), name: app.getName() }))
  ipcMain.on('window:minimize', () => mainWindow?.minimize())
  ipcMain.on('window:toggleMaximize', () => {
    if (!mainWindow) return
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
  })
  ipcMain.on('window:close', () => mainWindow?.close())

  sessions.on('data', (payload) => mainWindow?.webContents.send(Channels.sessionData, payload))
  sessions.on('exit', (payload) => mainWindow?.webContents.send(Channels.sessionExit, payload))
}

app.whenReady().then(() => {
  config = new ConfigStore()
  theme = new ThemeService(config)
  scanner = new ScannerService(ownership, config)
  entries = new EntryService(config, detect, sessions, scanner, ownership)
  // 回注而非构造注入：Scanner 需要条目预期端口，Entry 需要 Scanner 快照，互为依赖
  scanner.setExpectationSource(() => entries.expectations())
  registerIpc()
  createWindow()
  createTray()
  scanner.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// closeToTray 打开时窗口是被 hide 而非销毁，走不到这里；关掉时按常规退出。
// 不能无条件 quit，否则托盘驻留形同虚设。
app.on('window-all-closed', () => {
  if (!config.get().settings.closeToTray) app.quit()
})
app.on('before-quit', () => {
  quitting = true
  scanner?.stop()
  if (config.get().settings.killOwnedOnQuit) sessions.disposeAll()
})

const SCAN_INTERVALS = [1000, 2000, 5000, 10_000]
const TERMINALS = ['wt', 'pwsh', 'powershell', 'cmd', 'gitbash']
const THEMES = ['light', 'dark', 'system']

/**
 * 逐字段校验设置补丁，只放行认识的键与合法值域。
 *
 * 这些值直接驱动采集定时与退出时的杀进程行为，坏值不是显示问题而是行为问题：
 * scanIntervalMs 给个 0 会让采集空转，killOwnedOnQuit 给个字符串会让退出逻辑
 * 按真值处理。未提供的键一律不动，避免整段覆盖丢掉其他设置。
 */
const LOG_LEVELS = ['info', 'warn', 'error']

/** 只放行认识的键与类型；limit 的上下限由 LogService 自己再收一次 */
function sanitizeLogQuery(input: unknown): LogQuery {
  if (input === undefined || input === null) return {}
  if (typeof input !== 'object') throw new Error('日志查询条件必须是对象')
  const raw = input as Record<string, unknown>
  const out: LogQuery = {}

  if (typeof raw.sessionId === 'string') out.sessionId = raw.sessionId
  if (typeof raw.entryId === 'string') out.entryId = raw.entryId
  if (typeof raw.level === 'string') {
    if (!LOG_LEVELS.includes(raw.level)) throw new Error('日志级别只接受 info / warn / error')
    out.level = raw.level as LogQuery['level']
  }
  // 关键字只做纯文本包含匹配，不构造正则 —— 用户输入 `(` 不该让查询抛异常
  if (typeof raw.text === 'string') out.text = raw.text.slice(0, 200)
  if (raw.limit !== undefined) out.limit = Number(raw.limit)
  return out
}

const TASK_DONE_TITLE: Partial<Record<EntryStatus, string>> = {
  succeeded: '任务完成',
  failed: '任务失败',
  canceled: '任务已取消'
}

/**
 * 任务完成通知，PRD §4.7。
 *
 * 开关每次都现读配置 —— 不在启动时缓存，否则用户刚关掉还会再收到一条。
 * 点击通知只把窗口带到前台，不做任何写操作：通知是从系统层来的输入，
 * 不该成为触发启动、停止之类动作的入口。
 */
function notifyTaskDone(e: { name: string; status: EntryStatus; exitCode: number }): void {
  if (!config.get().settings.notifyOnTaskDone) return
  // Windows 上通知未必可用（策略关闭、专注助手），不可用时静默跳过而不是抛
  if (!Notification.isSupported()) return

  const title = TASK_DONE_TITLE[e.status]
  if (!title) return

  const n = new Notification({
    title: `${title} · ${e.name}`,
    body: e.status === 'succeeded' ? '退出码 0' : `退出码 ${e.exitCode}`,
    icon: iconPath,
    silent: false
  })
  n.on('click', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
  n.show()
}

function sanitizeSettings(input: unknown): Partial<Settings> {
  if (typeof input !== 'object' || input === null) throw new Error('设置补丁必须是对象')
  const raw = input as Record<string, unknown>
  const out: Partial<Settings> = {}

  if (raw.scanIntervalMs !== undefined) {
    if (!SCAN_INTERVALS.includes(raw.scanIntervalMs as number)) {
      throw new Error(`采集周期只接受 ${SCAN_INTERVALS.join(' / ')} 毫秒`)
    }
    out.scanIntervalMs = raw.scanIntervalMs as Settings['scanIntervalMs']
  }
  if (raw.theme !== undefined) {
    if (!THEMES.includes(raw.theme as string)) throw new Error('主题只接受 light / dark / system')
    out.theme = raw.theme as ThemePreference
  }
  if (raw.externalTerminal !== undefined) {
    if (!TERMINALS.includes(raw.externalTerminal as string)) {
      throw new Error(`外部终端只接受 ${TERMINALS.join(' / ')}`)
    }
    out.externalTerminal = raw.externalTerminal as Settings['externalTerminal']
  }
  if (raw.terminalFontSize !== undefined) {
    const size = Number(raw.terminalFontSize)
    if (!Number.isInteger(size) || size < 10 || size > 22) {
      throw new Error('终端字号只接受 10–22 的整数')
    }
    out.terminalFontSize = size
  }
  if (raw.scrollback !== undefined) {
    const lines = Number(raw.scrollback)
    if (!Number.isInteger(lines) || lines < 1000 || lines > 50_000) {
      throw new Error('回滚行数只接受 1000–50000 的整数')
    }
    out.scrollback = lines
  }
  if (raw.killOwnedOnQuit !== undefined) {
    if (typeof raw.killOwnedOnQuit !== 'boolean') throw new Error('killOwnedOnQuit 必须是布尔值')
    out.killOwnedOnQuit = raw.killOwnedOnQuit
  }
  if (raw.closeToTray !== undefined) {
    if (typeof raw.closeToTray !== 'boolean') throw new Error('closeToTray 必须是布尔值')
    out.closeToTray = raw.closeToTray
  }
  if (raw.notifyOnTaskDone !== undefined) {
    if (typeof raw.notifyOnTaskDone !== 'boolean') throw new Error('notifyOnTaskDone 必须是布尔值')
    out.notifyOnTaskDone = raw.notifyOnTaskDone
  }
  if (raw.hideFromTaskbar !== undefined) {
    if (typeof raw.hideFromTaskbar !== 'boolean') throw new Error('hideFromTaskbar 必须是布尔值')
    out.hideFromTaskbar = raw.hideFromTaskbar
  }
  return out
}
