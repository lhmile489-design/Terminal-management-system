export const GITHUB_URL = 'https://github.com/lhmile489-design/Terminal-management-system'
export const ISSUES_URL = `${GITHUB_URL}/issues`
export const DOCS_URL = `${GITHUB_URL}/blob/master/docs/PROJECT-INTRODUCTION.md`

export const NAV_ITEMS = [
  { label: '功能', href: '#features' },
  { label: '安全边界', href: '#security' },
  { label: '快速开始', href: '#quickstart' },
  { label: '技术架构', href: '#architecture' },
  { label: 'FAQ', href: '#faq' }
] as const

export const STATS = [
  { value: '02', unit: 's', label: '默认采集周期', note: '窗口隐藏时自动降频' },
  { value: '07', unit: '', label: '核心工作视图', note: '从端口到诊断完整收口' },
  { value: '5K', unit: '', label: '内存日志缓冲', note: '最近 5,000 行，不落盘' },
  { value: '03', unit: '', label: '进程归属凭据', note: '终止前再次校验' }
] as const

export type FeatureId =
  | 'dashboard'
  | 'launchpad'
  | 'backend'
  | 'workgroups'
  | 'terminal'
  | 'logs'
  | 'diagnose'

export interface Feature {
  id: FeatureId
  navLabel: string
  eyebrow: string
  title: string
  description: string
  bullets: string[]
  metric: string
  metricLabel: string
}

export const FEATURES: Feature[] = [
  {
    id: 'dashboard',
    navLabel: '工作台',
    eyebrow: 'DASHBOARD / LIVE',
    title: '本机状态，一眼扫清。',
    description: '当前用户的监听端口、进程负载与运行时长持续更新。「我的服务」和「应用后台」分组呈现，未纳管服务也能直接发现。',
    bullets: ['监听端口、PID、目录与运行时长同屏', 'CPU / 内存趋势与端口冲突概览', '新出现的本地服务可直接加入启动台'],
    metric: '2s',
    metricLabel: '默认实时采集周期'
  },
  {
    id: 'launchpad',
    navLabel: '前端启动台',
    eyebrow: 'LAUNCHPAD / PROJECTS',
    title: '常用项目，一键就位。',
    description: '把长驻服务与一次性任务存进启动台。启动、停止、重启、日志、诊断和目录入口都集中在同一张卡片上。',
    bullets: ['只执行 package.json 中已声明的脚本', '支持拖拽、置顶与 Ctrl + 方向键排序', '自定义图标与技术栈分类，配置即时持久化'],
    metric: '01',
    metricLabel: '统一项目操作入口'
  },
  {
    id: 'backend',
    navLabel: '后端控制台',
    eyebrow: 'BACKEND / SPRING BOOT',
    title: 'Spring Boot，也有专属席位。',
    description: '前端项目之外，后端服务同样能被清楚地管理。覆盖 Maven / Gradle 构建、profile 打包、jar 启动与产物定位。',
    bullets: ['Wrapper、系统构建工具与 jar 多种启动方式', '读取 application-*.yml / properties 中的 profile', '打包成功后一键定位产物或切换到新 jar 启动'],
    metric: '02',
    metricLabel: 'Maven 与 Gradle 构建链路'
  },
  {
    id: 'workgroups',
    navLabel: '工作组',
    eyebrow: 'WORKGROUPS / ENV',
    title: '按项目编组，不再翻找。',
    description: '把前端、后端与批处理任务归集到同一个项目上下文。只聚焦当前工作组，并用环境状态减少误操作。',
    bullets: ['一个条目可归属一个工作组，组内统一查看', '开发、沙箱、生产三种环境即时切换并保存', '沙箱与生产环境启动 Spring Boot 前给出警示'],
    metric: '03',
    metricLabel: '开发 / 沙箱 / 生产环境'
  },
  {
    id: 'terminal',
    navLabel: '终端',
    eyebrow: 'TERMINAL / CONPTY',
    title: '每个会话，都有完整上下文。',
    description: '基于 node-pty 与 ConPTY 的原生终端体验，保留交互输入和原始输出。从服务卡片一键跳到对应会话。',
    bullets: ['xterm.js + WebGL 渲染', '支持新建 PowerShell 会话', '字号、回滚行数与外部终端偏好可配置'],
    metric: 'PTY',
    metricLabel: '真实终端，不是日志文本框'
  },
  {
    id: 'logs',
    navLabel: '日志',
    eyebrow: 'LOGS / MEMORY ONLY',
    title: '跨会话输出，集中检索。',
    description: '把多个会话的输出汇总成可检索的行，按会话、级别与关键字快速缩小范围。筛选在主进程完成。',
    bullets: ['信息、警告、错误分级查看', '关键字与会话组合筛选', '仅保留最近 5,000 行，关闭后不写入磁盘'],
    metric: '5K',
    metricLabel: '内存环形日志缓冲'
  },
  {
    id: 'diagnose',
    navLabel: '诊断',
    eyebrow: 'DIAGNOSE / PRECHECK',
    title: '问题，在启动前说清楚。',
    description: '目录、脚本、运行时、依赖和预期端口先检查。发现失效项就直接给出修复入口，而不是让你先失败一次。',
    bullets: ['预检只读，不写文件、不装依赖、不执行项目', '端口占用者、最近退出码与首个错误行集中展示', '环境变量只显示键名，永不暴露值'],
    metric: '0',
    metricLabel: '预检阶段的项目代码执行'
  }
]

export const CAPABILITIES = [
  {
    id: 'command',
    title: 'Ctrl + K，直达任何操作',
    description: '搜服务、搜端口、跑脚本、添加条目、切主题、跳视图。少一些层层点击，多一点肌肉记忆。',
    tag: 'COMMAND PALETTE',
    size: 'wide'
  },
  {
    id: 'tasks',
    title: '服务与任务，各有自己的状态',
    description: '长驻服务关注端口与存活；构建任务关注成功、失败、取消与产物目录。完成后可发送 Windows 通知。',
    tag: 'SERVICE + TASK',
    size: 'normal'
  },
  {
    id: 'ports',
    title: '端口冲突，给出可操作的答案',
    description: '先确认占用者，再提供精确停止或配置指引。已验证的 Next.js 可切换 PORT，未知框架绝不硬猜参数。',
    tag: 'PORT CONFLICT',
    size: 'normal'
  },
  {
    id: 'groups',
    title: '项目上下文，比卡片数量更重要',
    description: '工作组把前后端和任务放进同一个视图；分类与技术栈筛选仍然保留，两种组织方式互不冲突。',
    tag: 'WORKGROUPS',
    size: 'wide'
  },
  {
    id: 'settings',
    title: '偏好设置，即时保存',
    description: '采集周期、主题、终端字号、回滚行数、托盘与退出行为，都在设置中清晰可控。',
    tag: 'PREFERENCES',
    size: 'normal'
  },
  {
    id: 'recognition',
    title: '识别框架，但不替你猜命令',
    description: '读取 package.json、锁文件与项目标记。无法推出确定命令形状的生态，只登记，不硬造启动方式。',
    tag: 'READ-ONLY DETECTION',
    size: 'normal'
  }
] as const

export const PRINCIPLES = [
  {
    index: '01',
    title: '只读优先',
    summary: '不安装依赖，不执行项目代码。',
    description: '项目识别只读 package.json、锁文件和标记文件。连版本查询也不运行；缺少依赖时，由你显式创建安装会话。'
  },
  {
    index: '02',
    title: '归属可证',
    summary: '绝不因为端口相同就杀进程。',
    description: '只有运行 token、进程组和当前用户 UID 三重校验通过的受控进程才可终止。kill 前重新验证，避免 PID 复用误伤。'
  },
  {
    index: '03',
    title: '失败前置',
    summary: '能提前发现的问题，不让你先失败。',
    description: '启动前静态检查目录、脚本、运行时、依赖和端口冲突，并给出安全的修复入口。'
  },
  {
    index: '04',
    title: '内存日志',
    summary: '用于当下排障，不做持久审计。',
    description: '跨会话日志只保存在内存环形缓冲中，最多 5,000 行，不落盘；诊断也从不展示环境变量的值。'
  }
] as const

export const QUICK_START_STEPS = [
  {
    index: '01',
    title: '登记一个项目',
    description: '打开前端启动台或按 Ctrl + K，选择项目目录。应用会只读识别框架、包管理器与可用脚本。'
  },
  {
    index: '02',
    title: '选择已声明脚本',
    description: '为服务选择 dev，为任务选择 build 等 scripts 中真实存在的命令。没有合适脚本时可仅登记观察。'
  },
  {
    index: '03',
    title: '预检后启动',
    description: '确认目录、脚本、运行时、依赖与端口状态。预检失败时按入口修复，通过后再启动。'
  },
  {
    index: '04',
    title: '看日志，也看清归属',
    description: '从卡片进入终端或日志中心；需要停止时，只有归属可证的受控进程才会被执行终止。'
  }
] as const

export const INSTALL_COMMANDS = [
  { label: '安装依赖', command: 'npm install' },
  { label: '开发运行', command: 'npm run dev' },
  { label: '构建 Windows 安装包', command: 'npm run build:win' }
] as const

export const TECH_STACK = [
  { name: 'Electron 43', role: '桌面运行时' },
  { name: 'React 19', role: '界面层' },
  { name: 'TypeScript 5.9', role: '类型安全' },
  { name: 'Vite 7', role: '构建工具' },
  { name: 'Tailwind 4', role: '应用样式' },
  { name: 'Zustand', role: '状态管理' },
  { name: 'node-pty 1.1', role: 'ConPTY 会话' },
  { name: 'xterm.js 6', role: '终端渲染' }
] as const

export const ARCHITECTURE_LAYERS = [
  {
    index: '01',
    name: 'Renderer',
    subtitle: 'React + Zustand',
    description: '只做展示与交互。没有特权，拿不到运行 token，也不能构造命令。'
  },
  {
    index: '02',
    name: 'Preload',
    subtitle: 'contextBridge',
    description: '只暴露白名单内的 window.mile.* API，把渲染层与系统能力隔开。'
  },
  {
    index: '03',
    name: 'Main',
    subtitle: 'Services + IPC',
    description: '所有参数校形、命令构造、进程操作与 Windows 平台细节都在这里完成。'
  }
] as const

export const FAQS = [
  {
    question: 'Mile Terminal 会自动执行 npm install 吗？',
    answer: '不会。依赖安装可能触发 postinstall 等任意项目代码。识别与预检只读文件；缺少 node_modules 时会明确报错，只有你主动点击“创建安装会话”后才会运行安装命令。'
  },
  {
    question: '发现端口被占用，可以直接结束外部进程吗？',
    answer: '不能仅依据端口终止。Mile Terminal 只停止通过运行 token、进程组和当前用户 UID 三重校验的受控进程，并在终止前重新校验归属。外部进程可以观察和诊断，但不会被误杀。'
  },
  {
    question: '日志会保存到磁盘吗？',
    answer: '不会。日志中心使用内存环形缓冲，只保留最近 5,000 行，用于当前这轮开发与排障，不做持久审计。配置与条目则保存在本机 %APPDATA%\\mile-terminal\\config.json。'
  },
  {
    question: '服务正在运行，但没有显示端口，是失败了吗？',
    answer: '不一定。应用会从启动输出中捕获常见本地地址；若服务在 60 秒后仍存活但没有可识别端口，会显示“端口未知”，而不是误判失败。你可以查看终端输出或填写预期端口用于冲突检测。'
  },
  {
    question: '支持哪些项目与平台？',
    answer: '当前面向 Windows 11 / x64，本机离线使用。前端服务、批处理任务与 Spring Boot 项目都有对应工作流，并支持 Maven / Gradle 构建。它不是远程运维平台，不提供账号、云同步、SSH 或 Docker 管理。'
  },
  {
    question: '如何从源码运行或构建安装包？',
    answer: '准备 Windows 与 Node.js 20+，在项目目录执行 npm install 和 npm run dev。发布构建推荐 Node 22 LTS，执行 npm run build:win 后会生成 NSIS 安装器。'
  }
] as const
