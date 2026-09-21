export const Channels = {
  sessionList: 'session:list',
  sessionCreate: 'session:create',
  sessionWrite: 'session:write',
  sessionResize: 'session:resize',
  sessionStop: 'session:stop',
  sessionHistory: 'session:history',
  sessionData: 'session:data',
  sessionExit: 'session:exit',
  entryList: 'entry:list',
  entryAdd: 'entry:add',
  /** 渲染层唯一的条目写入口，逐字段校验并挡住运行中改身份，PRD §4.6 */
  entryEdit: 'entry:edit',
  entryRemove: 'entry:remove',
  entryReorder: 'entry:reorder',
  entryDetect: 'entry:detect',
  entryPrecheck: 'entry:precheck',
  entryStart: 'entry:start',
  entryStop: 'entry:stop',
  entryRestart: 'entry:restart',
  entryInstall: 'entry:install',
  entryRunScript: 'entry:runScript',
  entryDiagnose: 'entry:diagnose',
  entryOutputDir: 'entry:outputDir',
  /** 在资源管理器中定位并高亮产物文件（或打开产物目录），由主进程决定路径，见 EntryService.revealOutput */
  entryRevealOutput: 'entry:revealOutput',
  entryOpenPackageJson: 'entry:openPackageJson',
  /** uniapp 专属：调用本机 HBuilderX cli.exe 打开该项目，见 EntryService.openInHBuilderX */
  entryOpenInHBuilderX: 'entry:openInHBuilderX',
  /** 读取前端项目本地 favicon，返回 base64 data URL，只读不联网，见 DetectService.readFavicon */
  entryFavicon: 'entry:favicon',
  /** 设置条目自定义图片：渲染层传原始字节，主进程压缩落盘并回填哈希文件名，返回 imageId */
  entrySetImage: 'entry:setImage',
  /** 清除条目自定义图片，回退到 icon / favicon / 字标 */
  entryClearImage: 'entry:clearImage',
  /** 读取条目自定义图片为 data URL（显示用），无图返回 null */
  entryImage: 'entry:image',
  entryRuntimes: 'entry:runtimes',
  entryChanged: 'entry:changed',
  /** 日志中心，PRD §4.8。筛选在主进程做，渲染层只拿要显示的那一屏 */
  logQuery: 'log:query',
  logClear: 'log:clear',
  entryRuntimeChanged: 'entry:runtimeChanged',
  /** 主进程侧的非致命告警（如端口 5 秒未释放），只进实时动态，不弹窗 */
  entryWarning: 'entry:warning',
  dialogPickDirectory: 'dialog:pickDirectory',
  shellOpenLocalhost: 'shell:openLocalhost',
  shellOpenPath: 'shell:openPath',
  scannerSnapshot: 'scanner:snapshot',
  scannerDiff: 'scanner:diff',
  scannerRefresh: 'scanner:refresh',
  scannerVisibility: 'scanner:visibility',
  scannerIgnore: 'scanner:ignore',
  scannerHideOnce: 'scanner:hideOnce',
  /** 手动提升到「我的服务」或移回后台，PRD §5.2 */
  scannerSetGroup: 'scanner:setGroup',
  scannerWatchedGet: 'scanner:watchedGet',
  scannerWatchedSet: 'scanner:watchedSet',
  settingsGet: 'settings:get',
  settingsPatch: 'settings:patch',
  settingsChanged: 'settings:changed',
  themeGet: 'theme:get',
  themeSet: 'theme:set',
  themeChanged: 'theme:changed',
  windowIsMaximized: 'window:isMaximized',
  windowMaximizeChanged: 'window:maximizeChanged',
  /** 应用基础信息：版本号、名称，由主进程从 app.getVersion() 读取 */
  appInfo: 'app:info',
  /**
   * 后端控制台：执行 Maven/Gradle 构建任务（clean/compile/package/test/install/verify）。
   * goal 必须是 MavenGoal 枚举值，命令构造全在主进程，结果为 EntryRuntime（build 型会话）。
   */
  entryMavenRun: 'entry:mavenRun',
  /**
   * 带 profile 的打包：profile 为 null 时不带 -P 参数，命令构造全在主进程。
   * profile 经 SAFE_PROFILE 白名单校验（仅字母/数字/下划线/连字符）。
   */
  entryPackageWithProfile: 'entry:packageWithProfile',
  /**
   * 检测 Spring Boot 项目的 profile 配置文件列表（读目录，不读内容，不执行代码）。
   * 扫描 application-{profile}.properties/yml，返回 profile 名数组。
   */
  entryDetectProfiles: 'entry:detectProfiles',
  /**
   * 扫描 Spring Boot 项目 target/ 目录，返回可用 jar 文件的相对路径列表。
   * 过滤掉 -sources / -javadoc 包，只读目录结构，不执行代码。
   */
  entryListJars: 'entry:listJars'
} as const

export type Channel = (typeof Channels)[keyof typeof Channels]
