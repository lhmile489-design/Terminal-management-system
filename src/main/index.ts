import { join } from 'node:path'
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, Notification, shell, Tray } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { Channels } from '@shared/channels'
import type {
  EntryEdit,
  EntryStatus,
  GroupPatch,
  LaunchEntry,
  LogQuery,
  MavenGoal,
  NewLaunchEntry,
  NewProjectGroup,
  Settings,
  ThemePreference,
  ProjectLink,
  FocusEntryRequest
} from '@shared/types'
import { GROUP_ENV_LABEL, PROJECT_LINKS } from '@shared/types'
import { SessionService } from './services/SessionService'
import { ConfigStore } from './services/ConfigStore'
import { ThemeService } from './services/ThemeService'
import { OwnershipService } from './services/OwnershipService'
import { ScannerService } from './services/ScannerService'
import { DetectService } from './services/DetectService'
import { EntryService } from './services/EntryService'
import { LogService } from './services/LogService'
import { GroupService } from './services/GroupService'
import { loadWindowState, trackWindowState, MIN_WIDTH, MIN_HEIGHT } from './lib/windowState'

// 打包后 resources/ 被 extraResources 平铺到 resourcesPath，开发期从工程根取
const resourceDir = app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources')
/**
 * 窗口与托盘用多尺寸 .ico：Windows 按当前 DPI 直接取预先缩好的那一档（16/20/24/32/40/48…）。
 * 以前给的是 1024px PNG，任务栏和托盘要系统现场缩到 16–32px，缩放质量差，图标发糊。
 * 通知仍用 PNG（Toast 会按自己的尺寸取图，PNG 兼容性更好）。
 */
const iconPath = join(resourceDir, 'icon.ico')
const notifyIconPath = join(resourceDir, 'icon.png')

const ownership = new OwnershipService()
const sessions = new SessionService(ownership)
const detect = new DetectService()
// 与 sessions 同时建起来：日志靠订阅 data 事件收集，晚一步挂钩就会漏掉那段输出
const logs = new LogService(sessions)
let config: ConfigStore
let theme: ThemeService
let scanner: ScannerService
let entries: EntryService
let groups: GroupService
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
/** before-quit 已触发：close 事件不再拦成「收起到托盘」 */
let quitting = false

function createWindow(): void {
  // 上次的位置与大小；坐标跑到屏幕外或文件损坏时 x/y 为空，交给系统居中
  const winState = loadWindowState()
  const win = new BrowserWindow({
    width: winState.width,
    height: winState.height,
    ...(winState.x !== undefined && winState.y !== undefined ? { x: winState.x, y: winState.y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
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
      // preload 只使用 contextBridge + ipcRenderer，不依赖 Node.js 内置模块，
      // 可以安全开启沙箱。沙箱收窄了渲染进程依赖漏洞的逃逸面，PRD §11
      sandbox: true
    }
  })

  mainWindow = win
  if (winState.maximized) win.maximize()
  trackWindowState(win)
  win.once('ready-to-show', () => win.show())
  // 窗口销毁后必须放掉引用：采集、会话输出仍在推送，往已销毁的 webContents 发会抛错
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

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

  // 与 shellOpenLocalhost 保持相同口径：只允许 localhost/127.0.0.1，不接受任意外部 URL，PRD §11
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(url)) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  // 顶层页面只能是应用自己：渲染层改 location 离开当前 URL 一律拦下。
  // 页内 hash 跳转不触发 will-navigate；主进程 loadURL 也不经过这里。
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault()
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

  /** 与渲染层 isGroupStartable 同口径：常驻服务、可启动、不由 HBuilderX 接管 */
  const startable = (e: LaunchEntry): boolean =>
    e.kind === 'service' && !e.registerOnly && e.framework !== 'uniapp'
  const isLive = (status: string | undefined): boolean =>
    status === 'precheck' || status === 'starting' || status === 'running' || status === 'stopping'

  /**
   * 启动前的环境确认，规则同渲染层 confirmEnv：prod 任何条目都确认，
   * sandbox 只有 spring-boot 确认。托盘入口不能因为换了入口就绕过这道确认。
   */
  const confirmEnv = async (list: LaunchEntry[], groupId: string | undefined): Promise<boolean> => {
    const group = groupId ? groups.list().find((g) => g.id === groupId) : undefined
    if (!group) return true
    const names = list.map((e) => `「${e.name}」`).join('、')
    let message: string | null = null
    if (group.env === 'prod') {
      message = `工作组「${group.name}」处于${GROUP_ENV_LABEL.prod}环境，启动 ${names} 会影响真实业务数据。`
    } else if (group.env === 'sandbox' && list.some((e) => e.framework === 'spring-boot')) {
      message = `工作组「${group.name}」处于${GROUP_ENV_LABEL.sandbox}环境，确认后启动 ${names}。`
    }
    if (!message) return true
    const options = {
      type: 'warning' as const,
      title: '确认启动',
      message: `在${GROUP_ENV_LABEL[group.env]}环境启动？`,
      detail: message,
      buttons: ['确认启动', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    }
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options)
    return result.response === 0
  }

  const startList = async (list: LaunchEntry[], groupId: string | undefined): Promise<void> => {
    const live = new Set(entries.runtimeList().filter((r) => isLive(r.status)).map((r) => r.entryId))
    const todo = list.filter((e) => startable(e) && !live.has(e.id))
    if (!todo.length || !(await confirmEnv(todo, groupId))) return
    // 预检被拦下只会让该条目进入 blocked（并触发系统通知），不抛；spawn 抛错同理吞掉
    await Promise.all(todo.map((e) => entries.start(e.id).catch(() => undefined)))
  }

  const stopList = async (list: LaunchEntry[]): Promise<void> => {
    const live = new Set(entries.runtimeList().filter((r) => isLive(r.status)).map((r) => r.entryId))
    // stop 内部走 OwnershipService.assertKillable，拒绝时抛错，这里逐个吞掉不影响其余条目
    await Promise.all(list.filter((e) => live.has(e.id)).map((e) => entries.stop(e.id).catch(() => undefined)))
  }

  const rebuild = (): void => {
    if (!tray || tray.isDestroyed()) return
    const all = entries.list()
    const live = new Set(entries.runtimeList().filter((r) => isLive(r.status)).map((r) => r.entryId))
    const liveCount = all.filter((e) => live.has(e.id)).length

    const groupItems: Electron.MenuItemConstructorOptions[] = groups.list().map((g) => {
      const members = all.filter((e) => e.groupId === g.id)
      const anyStartable = members.some((e) => startable(e) && !live.has(e.id))
      const anyLive = members.some((e) => live.has(e.id))
      return {
        label: `${g.name}（${GROUP_ENV_LABEL[g.env]}）`,
        submenu: [
          { label: '启动全部', enabled: anyStartable, click: () => void startList(members, g.id) },
          { label: '停止全部', enabled: anyLive, click: () => void stopList(members) }
        ]
      }
    })

    const recent = all
      .filter((e) => startable(e) && e.lastStartedAt)
      .sort((a, b) => (b.lastStartedAt ?? 0) - (a.lastStartedAt ?? 0))
      .slice(0, 5)
    const recentItems: Electron.MenuItemConstructorOptions[] = recent.map((e) => ({
      label: e.name,
      type: 'checkbox',
      checked: live.has(e.id),
      click: () => void (live.has(e.id) ? stopList([e]) : startList([e], e.groupId))
    }))

    tray.setToolTip(liveCount > 0 ? `Mile Terminal · ${liveCount} 个运行中` : 'Mile Terminal')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `${liveCount} 个运行中`, enabled: false },
        { type: 'separator' },
        { label: '显示主窗口', click: show },
        { type: 'separator' },
        { label: '工作组', enabled: groupItems.length > 0, submenu: groupItems },
        { label: '最近使用', enabled: recentItems.length > 0, submenu: recentItems },
        { label: '全部停止', enabled: liveCount > 0, click: () => void stopList(all) },
        { type: 'separator' },
        // 这里必须走 app.quit()：直接 destroy 窗口会跳过 before-quit，
        // killOwnedOnQuit 的清理就不会执行
        { label: '退出', click: () => app.quit() }
      ])
    )
  }

  // 运行态在端口捕获、状态切换时会连发多次，合并成一次重建
  let rebuildTimer: NodeJS.Timeout | null = null
  const scheduleRebuild = (): void => {
    if (rebuildTimer) return
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null
      rebuild()
    }, 50)
  }
  entries.on('runtime', scheduleRebuild)
  entries.on('changed', scheduleRebuild)
  groups.on('changed', scheduleRebuild)

  rebuild()
  tray.on('click', show)
  tray.on('double-click', show)
}

/**
 * 条目出主进程前抹掉环境变量的值，只留键名（值恒为空串）。
 * 渲染层拿不到密钥：编辑时用合并补丁（字符串覆盖、null 删除、没提的键保持原值）。
 */
function redactEntry(e: LaunchEntry): LaunchEntry {
  return { ...e, env: Object.fromEntries(Object.keys(e.env ?? {}).map((k) => [k, ''])) }
}
const redactList = (list: LaunchEntry[]): LaunchEntry[] => list.map(redactEntry)

/** 主进程 → 渲染层推送。窗口没了或正在销毁时静默丢弃，推送方不必各自判断 */
function sendToRenderer(channel: string, ...args: unknown[]): void {
  const wc = mainWindow?.webContents
  if (!mainWindow || mainWindow.isDestroyed() || !wc || wc.isDestroyed()) return
  wc.send(channel, ...args)
}

/**
 * IPC 只认主窗口的主框架。preload 只挂在主窗口上，正常不会有别的来源；
 * 这一层是兜底 —— 万一以后多开窗口或嵌了 iframe，它们拿不到特权通道。
 */
function isTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return (
    !!mainWindow &&
    event.sender === mainWindow.webContents &&
    event.senderFrame === mainWindow.webContents.mainFrame
  )
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const ipc = {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void {
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrustedSender(event)) throw new Error('拒绝非主窗口或非主框架的 IPC 请求')
      return listener(event, ...args)
    })
  },
  on(channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void): void {
    ipcMain.on(channel, (event, ...args) => {
      if (!isTrustedSender(event)) return
      listener(event, ...args)
    })
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function registerIpc(): void {
  ipc.handle(Channels.sessionList, () => sessions.list())
  // 只走固定 shell 入口：渲染层给的 file/args/cwd/env 在这里被丢弃，PRD §11 红线 3、4
  // 带 entryId 时开在该条目目录：目录由 EntryService 按登记信息解析并校验（红线 4），
  // 渲染层只给 id。entryId 不是字符串、条目不存在、目录越界或不存在都直接抛错，不回退
  ipc.handle(Channels.sessionCreate, async (_e, input: unknown) => {
    const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
    if (raw.entryId === undefined) return sessions.createShell(input)
    if (typeof raw.entryId !== 'string') throw new Error('entryId 必须是字符串')
    const at = await entries.terminalCwd(raw.entryId)
    return sessions.createShell(input, { cwd: at.cwd, title: `终端 · ${at.name}`.slice(0, 80) })
  })
  ipc.handle(Channels.sessionHistory, (_e, id: string) => sessions.history(id))
  ipc.handle(Channels.sessionStop, (_e, id: string) => sessions.stop(id))
  ipc.on(Channels.sessionWrite, (_e, id: string, data: string) => sessions.write(id, data))
  ipc.on(Channels.sessionResize, (_e, id: string, cols: number, rows: number) =>
    sessions.resize(id, cols, rows)
  )

  // 仅允许 localhost 的 http，端口取整校验 —— 不接受渲染层传任意 URL，PRD §11
  ipc.on(Channels.shellOpenLocalhost, (_e, port: unknown) => {
    if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) return
    void shell.openExternal(`http://localhost:${port as number}`)
  })

  // 关于页的两个外链：渲染层只给键名，地址写死在主进程。不放行任意外部 URL，PRD §11
  ipc.on(Channels.shellOpenProjectLink, (_e, key: unknown) => {
    if (typeof key !== 'string' || !Object.hasOwn(PROJECT_LINKS, key)) return
    void shell.openExternal(PROJECT_LINKS[key as ProjectLink])
  })

  ipc.on(Channels.shellOpenPath, (_e, target: unknown) => {
    if (typeof target !== 'string') return
    // 白名单二选一：采集到的现存目录，或启动台已登记条目的目录/产物目录。
    // 两者都不匹配就拒绝 —— 不接受渲染层构造任意路径触发关联程序，PRD §11。
    if (!scanner.knownPath(target) && !entries.knownPath(target)) return
    void shell.openPath(target)
  })

  ipc.handle(Channels.entryList, () => redactList(entries.list()))
  ipc.handle(Channels.entryAdd, async (_e, input: NewLaunchEntry) => redactEntry(await entries.add(input)))
  // 渲染层没有不受校验的写入口：edit 只认白名单字段，运行中改身份字段直接抛错，PRD §4.6
  ipc.handle(Channels.entryEdit, async (_e, id: string, patch: EntryEdit) =>
    redactEntry(await entries.edit(id, patch))
  )
  ipc.handle(Channels.entryRemove, (_e, id: string) => entries.remove(id))
  ipc.handle(Channels.entryReorder, (_e, ids: string[]) => redactList(entries.reorder(ids)))
  ipc.handle(Channels.entryDetect, (_e, path: string) => detect.detect(path))
  ipc.handle(Channels.entryPrecheck, (_e, id: string) => entries.runPrecheck(id))
  ipc.handle(Channels.entryStart, (_e, id: string) => entries.start(id))
  ipc.handle(Channels.entryStop, (_e, id: string) => entries.stop(id))
  ipc.handle(Channels.entryRestart, (_e, id: string) => entries.restart(id))
  ipc.handle(Channels.entryInstall, (_e, id: string) => entries.install(id))
  // 后端控制台：Maven/Gradle 构建任务。goal 在主进程白名单校验，不接受自由字符串。
  ipc.handle(Channels.entryMavenRun, (_e, id: string, goal: unknown) => {
    const VALID_GOALS: MavenGoal[] = ['clean', 'compile', 'package', 'test', 'install', 'verify']
    if (typeof goal !== 'string' || !VALID_GOALS.includes(goal as MavenGoal)) {
      throw new Error(`非法构建目标：${String(goal)}`)
    }
    return entries.mavenRun(id, goal as MavenGoal)
  })
  // 带 profile 的打包：profile 为 null 不带 -P；命令构造全在主进程，profile 经 SAFE_PROFILE 白名单
  ipc.handle(Channels.entryPackageWithProfile, (_e, id: unknown, profile: unknown) => {
    if (typeof id !== 'string') throw new Error('条目 id 非法')
    if (profile !== null && typeof profile !== 'string') {
      throw new Error('profile 必须是字符串或 null')
    }
    return entries.packageWithProfile(id, profile as string | null)
  })
  // 检测 Spring Boot profile 配置文件列表（只读目录，不执行代码）
  ipc.handle(Channels.entryDetectProfiles, (_e, id: unknown) => {
    if (typeof id !== 'string') return []
    const entry = entries.get(id)
    if (!entry || entry.framework !== 'spring-boot') return []
    return detect.detectSpringBootProfiles(entry.path)
  })
  // 扫描 target/ 目录下的 jar 文件列表（只读目录），供后端控制台 jar 模式一键选择
  ipc.handle(Channels.entryListJars, (_e, id: unknown) => {
    if (typeof id !== 'string') return []
    return entries.listJars(id)
  })
  // 将条目的 expectedPort 切换到指定端口并持久化。port 必须是 1024-65535 的整数。
  ipc.handle(Channels.entrySwitchPort, (_e, id: unknown, port: unknown) => {
    if (typeof id !== 'string') throw new Error('条目 id 非法')
    const p = Number(port)
    if (!Number.isInteger(p) || p < 1024 || p > 65535) {
      throw new Error(`端口非法：${String(port)}，必须是 1024-65535 的整数`)
    }
    return entries.switchPort(id, p)
  })
  // 只收 id + 脚本名，命令构造与脚本校验全在主进程，PRD §9.5 / §11
  ipc.handle(Channels.entryRunScript, (_e, id: string, script: string) => {
    if (typeof script !== 'string') throw new Error('脚本名必须是字符串')
    return entries.runScript(id, script)
  })
  ipc.handle(Channels.entryDiagnose, (_e, id: string) => entries.diagnose(id))
  ipc.handle(Channels.entryOutputDir, (_e, id: string) => entries.outputDir(id))
  // 路径全在主进程构造（entries.revealOutput → outputDir → readdir），渲染层只给 id，PRD §11
  ipc.handle(Channels.entryRevealOutput, async (_e, id: string) => {
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
  ipc.handle(Channels.entryOpenPackageJson, async (_e, id: string) => {
    const target = entries.packageJsonPath(id)
    if (!target) return false
    const err = await shell.openPath(target)
    if (err) throw new Error(err)
    return true
  })
  // uniapp 专属：只收 id，cli.exe 探测与命令构造全在主进程，PRD §11
  ipc.handle(Channels.entryOpenInHBuilderX, (_e, id: string) => entries.openInHBuilderX(id))
  ipc.handle(Channels.entryRuntimes, () => entries.runtimeList())
  // 只收 id，路径由主进程按条目自己拼，返回 base64 data URL 或 null，只读不联网，PRD §11
  ipc.handle(Channels.entryFavicon, (_e, id: unknown) =>
    typeof id === 'string' ? entries.favicon(id) : null
  )
  // 自定义图片：渲染层传 id + 原始字节，主进程压缩落盘并回填哈希文件名。字节做上限
  // 校验（8MB），超限拒绝避免大文件占内存；解码/非图片由 ImageService 兜底抛错。
  ipc.handle(Channels.entrySetImage, (_e, id: unknown, bytes: unknown) => {
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
  ipc.handle(Channels.entryClearImage, (_e, id: unknown) => {
    if (typeof id !== 'string') throw new Error('条目 id 非法')
    return redactEntry(entries.clearImage(id))
  })
  ipc.handle(Channels.entryImage, (_e, id: unknown) =>
    typeof id === 'string' ? entries.imageDataUrl(id) : null
  )
  entries.on('changed', (list) => sendToRenderer(Channels.entryChanged, redactList(list)))
  entries.on('runtime', (runtime) =>
    sendToRenderer(Channels.entryRuntimeChanged, runtime)
  )
  entries.on('taskDone', notifyTaskDone)
  entries.on('crashed', (e: { entryId: string; name: string; exitCode: number }) =>
    notifyEntryProblem({
      entryId: e.entryId,
      title: `服务已崩溃 · ${e.name}`,
      body: `退出码 ${e.exitCode}，点击查看输出`,
      tab: 'output'
    })
  )
  entries.on('blocked', (e: { entryId: string; name: string }) =>
    notifyEntryProblem({
      entryId: e.entryId,
      title: `启动被拦下 · ${e.name}`,
      body: '启动前检查没通过，点击查看原因和修复入口',
      tab: 'diagnose'
    })
  )
  entries.on('portUnreleased', (e: { entryId: string; port: number }) =>
    notifyEntryProblem({
      entryId: e.entryId,
      title: `端口未释放 · ${entryName(e.entryId)}`,
      body: `:${e.port} 在 5 秒内没有放手，重启后可能仍被占用`,
      tab: 'diagnose'
    })
  )
  // 这条以前没人订阅：「端口 5 秒未释放」只在主进程 emit 一下就没了，
  // 而重启后端口还被占着恰恰是用户最需要知道的那一刻
  entries.on('warning', (text: string) =>
    sendToRenderer(Channels.entryWarning, text)
  )

  // ── 工作组 IPC，PRD-WORKGROUPS §4 ──────────────────────────────────────────
  ipc.handle(Channels.groupList, () => groups.list())

  ipc.handle(Channels.groupAdd, (_e, input: unknown) => {
    if (typeof input !== 'object' || input === null) throw new Error('工作组输入必须是对象')
    return groups.add(input as NewProjectGroup)
  })

  ipc.handle(Channels.groupPatch, (_e, id: unknown, patch: unknown) => {
    if (typeof id !== 'string') throw new Error('工作组 id 必须是字符串')
    if (typeof patch !== 'object' || patch === null) throw new Error('工作组补丁必须是对象')
    return groups.patch(id, patch as GroupPatch)
  })

  ipc.handle(Channels.groupRemove, (_e, id: unknown) => {
    if (typeof id !== 'string') throw new Error('工作组 id 必须是字符串')
    groups.remove(id)
  })

  ipc.handle(Channels.groupReorder, (_e, ids: unknown) => {
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
      throw new Error('ids 必须是字符串数组')
    }
    groups.reorder(ids as string[])
  })

  groups.on('changed', (list) => sendToRenderer(Channels.groupChanged, list))

  // entry:revealLastJar：路径由主进程从 EntryRuntime.lastBuiltJar 构造，渲染层只给 id，PRD §11
  ipc.handle(Channels.entryRevealLastJar, async (_e, id: unknown) => {
    if (typeof id !== 'string') throw new Error('条目 id 非法')
    const entry = entries.get(id)
    if (!entry) throw new Error('条目不存在')
    const runtime = entries.runtimeOf(id)
    if (!runtime?.lastBuiltJar) throw new Error('没有可定位的 jar 文件，请先执行 Package')
    // lastBuiltJar 来自 listJars()，已经过 target/ 目录扫描，是相对路径
    // 安全校验：不含 ..，不含绝对路径前缀，必须在项目目录内
    const rel = runtime.lastBuiltJar
    if (rel.includes('..') || /^[/\\]/.test(rel)) throw new Error('jar 路径越界')
    const absPath = join(entry.path, rel)
    // 二次确认：拼接后的绝对路径必须在项目目录内
    if (!absPath.startsWith(entry.path)) throw new Error('jar 路径越界')
    shell.showItemInFolder(absPath)
    return true
  })

  // 查询条件逐字段校形：坏值会让筛选静默失效，用户以为「没有这样的日志」
  ipc.handle(Channels.logQuery, (_e, query: unknown) => logs.query(sanitizeLogQuery(query)))
  ipc.on(Channels.logClear, () => logs.clear())

  ipc.handle(Channels.settingsGet, () => config.get().settings)

  // 设置直接驱动采集周期、退出行为等，逐字段校验后再落盘 —— 不接受渲染层
  // 塞进任意键值，坏值会让采集器排出无意义的定时或让配置结构走形。
  ipc.handle(Channels.settingsPatch, (_e, patch: unknown) => {
    const next = sanitizeSettings(patch)
    const updated = config.patchSettings(next).settings
    // 采集周期改了要立刻生效，否则要等下一轮才换节奏
    if (next.scanIntervalMs !== undefined) scanner.reschedule()
    // 主题走 ThemeService，它还要同步 nativeTheme.themeSource 并广播
    if (next.theme !== undefined) theme.set(next.theme)
    // 任务栏可见性即时生效：托盘常驻，隐藏后窗口仍能从托盘唤出
    if (next.hideFromTaskbar !== undefined) mainWindow?.setSkipTaskbar(next.hideFromTaskbar)
    if (next.globalHotkey !== undefined) applyGlobalHotkey()
    sendToRenderer(Channels.settingsChanged, updated)
    return updated
  })

  ipc.handle(Channels.dialogPickDirectory, async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择项目目录',
      properties: ['openDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipc.handle(Channels.scannerSnapshot, () => scanner.snapshot())
  ipc.on(Channels.scannerRefresh, () => scanner.refresh())
  ipc.on(Channels.scannerVisibility, (_e, visible: boolean) => scanner.setVisible(visible))
  ipc.on(Channels.scannerIgnore, (_e, processName: string, port: number) =>
    scanner.ignore(processName, port)
  )
  ipc.on(Channels.scannerHideOnce, (_e, pid: number, port: number) =>
    scanner.hideOnce(pid, port)
  )

  // 分组只影响列表怎么排，不影响能不能停 —— 权限判定始终在 OwnershipService，PRD §5.2
  ipc.handle(Channels.scannerSetGroup, (_e, processName: unknown, group: unknown) => {
    if (typeof processName !== 'string') throw new Error('进程名必须是字符串')
    if (group !== 'mine' && group !== 'background' && group !== null) {
      throw new Error('分组只接受 mine / background / null')
    }
    scanner.setGroup(processName, group)
  })

  ipc.handle(Channels.scannerWatchedGet, () => config.get().watchedKeywords)
  ipc.handle(Channels.scannerWatchedSet, (_e, keywords: unknown) =>
    scanner.setWatchedKeywords(keywords)
  )
  scanner.on('diff', (diff) => sendToRenderer(Channels.scannerDiff, diff))
  // 采集失败已由 failed 增量告知界面，这里只留一行日志供排查
  scanner.on('error', (err) => console.error('[scanner] 采集失败：', err))

  ipc.handle(Channels.themeGet, () => theme.state())
  ipc.handle(Channels.themeSet, (_e, preference: ThemePreference) => theme.set(preference))
  theme.on('changed', (state) => sendToRenderer(Channels.themeChanged, state))

  ipc.handle(Channels.windowIsMaximized, () => mainWindow?.isMaximized() ?? false)
  ipc.handle(Channels.appInfo, () => ({ version: app.getVersion(), name: app.getName() }))
  ipc.on('window:minimize', () => mainWindow?.minimize())
  ipc.on('window:toggleMaximize', () => {
    if (!mainWindow) return
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
  })
  ipc.on('window:close', () => mainWindow?.close())

  sessions.on('data', (payload) => sendToRenderer(Channels.sessionData, payload))
  sessions.on('exit', (payload) => sendToRenderer(Channels.sessionExit, payload))
}

/**
 * 全局快捷键 Ctrl+Alt+M：唤起窗口并打开命令面板。窗口收起到托盘或失焦时 Ctrl+K 无效，这是唯一入口。
 * 注册后在所有应用里都会被占用，所以设置里能关；组合键被别的程序占了时只在实时动态里提示，不抛错、
 * 不挡设置保存。回调只导航，不触发启停这类写操作。
 */
const GLOBAL_HOTKEY = 'Ctrl+Alt+M'

function applyGlobalHotkey(): void {
  if (globalShortcut.isRegistered(GLOBAL_HOTKEY)) globalShortcut.unregister(GLOBAL_HOTKEY)
  if (!config.get().settings.globalHotkey) return
  const ok = globalShortcut.register(GLOBAL_HOTKEY, () => {
    if (!mainWindow) {
      createWindow()
      // 新窗口加载完才有渲染层可接收。createWindow 会赋值 mainWindow，TS 的收窄看不到这一点
      const created = mainWindow as BrowserWindow | null
      created?.webContents.once('did-finish-load', () => sendToRenderer(Channels.appOpenPalette))
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    sendToRenderer(Channels.appOpenPalette)
  })
  if (!ok) {
    sendToRenderer(Channels.entryWarning, `全局快捷键 ${GLOBAL_HOTKEY} 已被其他程序占用，未能注册`)
  }
}

/**
 * 单实例锁：再双击快捷方式不起第二个实例（两个实例会抢同一份 config.json 和同一批端口扫描），
 * 第二个实例自己退出，并让第一个实例把窗口带到前台。
 *
 * 锁的作用域是 userData。开发期默认 userData 与本机其他 Electron 项目共用，会互相挤掉，
 * 所以只在打包后启用；harness 用 MILE_FORCE_SINGLE_INSTANCE=1 强开（并自己把 userData 指到沙箱）。
 * 这里用 app.exit 而不是 app.quit：第二个实例还没建任何服务，没有清理要做。
 */
const singleInstance = app.isPackaged || process.env.MILE_FORCE_SINGLE_INSTANCE === '1'
const gotLock = !singleInstance || app.requestSingleInstanceLock()
if (!gotLock) app.exit(0)

app.on('second-instance', () => {
  if (!mainWindow) {
    if (app.isReady()) createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

app.whenReady().then(() => {
  if (!gotLock) return
  config = new ConfigStore()
  theme = new ThemeService(config)
  scanner = new ScannerService(ownership, config)
  entries = new EntryService(config, detect, sessions, scanner, ownership)
  groups = new GroupService(config)
  // 回注而非构造注入：Scanner 需要条目预期端口，Entry 需要 Scanner 快照，互为依赖
  scanner.setExpectationSource(() => entries.expectations())
  // scanner 晚于 sessions 构建，后注入供 kill 前重校验归属用，PRD §6.3 步骤 4
  sessions.setScanner(scanner)
  registerIpc()
  createWindow()
  createTray()
  applyGlobalHotkey()
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
/** 退出时等进程树终止的上限：taskkill 卡住也不能让应用关不掉 */
const QUIT_CLEANUP_TIMEOUT_MS = 6000
let cleanupDone = false

app.on('will-quit', () => globalShortcut.unregisterAll())

app.on('before-quit', (e) => {
  quitting = true
  scanner?.stop()
  if (cleanupDone || !config.get().settings.killOwnedOnQuit || sessions.liveCount() === 0) return
  // 不等的话进程退出时 taskkill 还没跑完，dev server 会留在后台占端口
  e.preventDefault()
  cleanupDone = true
  const timeout = new Promise<void>((r) => setTimeout(r, QUIT_CLEANUP_TIMEOUT_MS))
  void Promise.race([sessions.disposeAll().catch(() => undefined), timeout]).finally(() => app.quit())
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
    icon: notifyIconPath,
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

/** 窗口当前看不到：隐藏到托盘、最小化或失焦。前台时应用内已有提示，不再弹系统通知 */
function windowInBackground(): boolean {
  const w = mainWindow
  if (!w || w.isDestroyed()) return true
  return !w.isVisible() || w.isMinimized() || !w.isFocused()
}

/**
 * 服务崩溃、启动被预检拦下、端口未释放的系统通知。
 *
 * 点击只把窗口带回前台并让渲染层定位到该服务的输出或诊断标签，不做任何写操作。
 * 退出清理期间不弹：killOwnedOnQuit 杀进程会让每个服务走一遍 crashed 路径。
 */
function notifyEntryProblem(opts: {
  entryId: string
  title: string
  body: string
  tab: FocusEntryRequest['tab']
}): void {
  const s = config.get().settings
  if (!s.notifyOnCrash || quitting) return
  if (s.notifyOnlyWhenBackground && !windowInBackground()) return
  if (!Notification.isSupported()) return

  const n = new Notification({
    title: opts.title,
    body: opts.body,
    icon: notifyIconPath,
    silent: false
  })
  n.on('click', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    sendToRenderer(Channels.appFocusEntry, { id: opts.entryId, tab: opts.tab } satisfies FocusEntryRequest)
  })
  n.show()
}

function entryName(id: string): string {
  return entries.get(id)?.name ?? '服务'
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
  if (raw.notifyOnCrash !== undefined) {
    if (typeof raw.notifyOnCrash !== 'boolean') throw new Error('notifyOnCrash 必须是布尔值')
    out.notifyOnCrash = raw.notifyOnCrash
  }
  if (raw.globalHotkey !== undefined) {
    if (typeof raw.globalHotkey !== 'boolean') throw new Error('globalHotkey 必须是布尔值')
    out.globalHotkey = raw.globalHotkey
  }
  if (raw.notifyOnlyWhenBackground !== undefined) {
    if (typeof raw.notifyOnlyWhenBackground !== 'boolean') {
      throw new Error('notifyOnlyWhenBackground 必须是布尔值')
    }
    out.notifyOnlyWhenBackground = raw.notifyOnlyWhenBackground
  }
  return out
}
