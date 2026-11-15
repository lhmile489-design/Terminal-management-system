import {
  Cloud,
  Code,
  Cube,
  Database,
  GearSix,
  Globe,
  RocketLaunch,
  Terminal,
  type Icon
} from '@phosphor-icons/react'
import type {
  EntryStatus,
  Framework,
  LaunchMode,
  LaunchSource,
  PrecheckLevel,
  ServiceIcon,
  SpringBootLaunchMode
} from '@shared/types'

/** 服务卡片使用的受限 Phosphor 图标集。主进程只接受此列表中的标识。 */
export const SERVICE_ICON_META: Record<ServiceIcon, { label: string; icon: Icon }> = {
  rocket: { label: '火箭', icon: RocketLaunch },
  globe: { label: '地球', icon: Globe },
  database: { label: '数据库', icon: Database },
  terminal: { label: '终端', icon: Terminal },
  code: { label: '代码', icon: Code },
  cube: { label: '立方体', icon: Cube },
  cloud: { label: '云', icon: Cloud },
  gear: { label: '设置', icon: GearSix }
}

/** 状态同时给文字与颜色 —— 色盲用户不能只靠颜色区分，PRD §9.6 */
export const STATUS_META: Record<EntryStatus, { label: string; tone: Tone }> = {
  idle: { label: '未启动', tone: 'idle' },
  precheck: { label: '预检中', tone: 'warn' },
  blocked: { label: '预检未通过', tone: 'fault' },
  starting: { label: '启动中', tone: 'warn' },
  running: { label: '运行中', tone: 'live' },
  stopping: { label: '停止中', tone: 'warn' },
  stopped: { label: '已停止', tone: 'idle' },
  crashed: { label: '异常退出', tone: 'fault' },
  succeeded: { label: '已完成', tone: 'live' },
  failed: { label: '失败', tone: 'fault' },
  // 取消是中性事件，不是故障 —— 用 idle 而非 fault，否则卡片边框会染红
  canceled: { label: '已取消', tone: 'idle' }
}

export type Tone = 'idle' | 'live' | 'warn' | 'fault' | 'info' | 'accent'

export const TONE_CLASS: Record<Tone, string> = {
  idle: 'bg-raised text-ink-muted',
  live: 'bg-live-soft text-live',
  warn: 'bg-warn-soft text-warn',
  fault: 'bg-fault-soft text-fault',
  info: 'bg-info-soft text-info',
  accent: 'bg-accent-soft text-accent'
}

/**
 * 语义色的 CSS 变量，喂给卡片的 --glow。
 * 图标瓦片底色、边框着色、状态胶囊与圆点都从 --glow 派生，状态色只在这里给一次，
 * 组件里不再各自拼 bg-x-soft / text-x 的类名组合。
 */
export const TONE_VAR: Record<Tone, string> = {
  idle: 'var(--signal-idle)',
  live: 'var(--signal-live)',
  warn: 'var(--signal-warn)',
  fault: 'var(--signal-fault)',
  info: 'var(--signal-info)',
  accent: 'var(--signal-accent)'
}

/**
 * 卡片 data-tone 值。
 * busy（启动中/停止中）单独一档，做扫描动画；
 * live/warn/fault 染边框；其余保持中性。
 */
export function cardTone(
  tone: Tone,
  busy?: boolean
): 'live' | 'warn' | 'fault' | 'busy' | undefined {
  if (busy) return 'busy'
  return tone === 'live' || tone === 'warn' || tone === 'fault' ? tone : undefined
}

export const LEVEL_META: Record<PrecheckLevel, { label: string; tone: Tone }> = {
  pass: { label: '通过', tone: 'live' },
  warn: { label: '警告', tone: 'warn' },
  fail: { label: '阻止启动', tone: 'fault' }
}

export const FRAMEWORK_LABEL: Record<Framework, string> = {
  next: 'Next.js',
  nuxt: 'Nuxt',
  angular: 'Angular',
  'vue-vite': 'Vue + Vite',
  'vue-cli': 'Vue CLI',
  'react-vite': 'React + Vite',
  'react-cra': 'React (CRA)',
  svelte: 'Svelte',
  electron: 'Electron',
  hexo: 'Hexo',
  node: 'Node',
  'spring-boot': 'Spring Boot',
  uniapp: 'uniapp',
  hugo: 'Hugo',
  jekyll: 'Jekyll',
  django: 'Django',
  fastapi: 'FastAPI',
  flask: 'Flask',
  streamlit: 'Streamlit',
  python: 'Python',
  'docker-compose': 'Docker Compose',
  go: 'Go',
  rust: 'Rust',
  cpp: 'C++',
  static: '静态站点',
  unknown: '未知'
}

/** Spring Boot 启动方式的中文标签，用于新建/编辑面板的下拉选项 */
export const SPRING_BOOT_LAUNCH_MODE_LABEL: Record<SpringBootLaunchMode, string> = {
  'maven-wrapper': 'Maven Wrapper（mvnw）',
  'gradle-wrapper': 'Gradle Wrapper（gradlew）',
  jar: '运行已构建的 jar',
  'system-maven': '系统 Maven（mvn）',
  'system-gradle': '系统 Gradle（gradle）'
}

/** 全部启动方式的中文标签，用于新建/编辑面板的下拉选项（含 Spring Boot 与各语言） */
export const LAUNCH_MODE_LABEL: Record<LaunchMode, string> = {
  ...SPRING_BOOT_LAUNCH_MODE_LABEL,
  'python-file': 'Python 入口文件（python <文件>）',
  'python-module': 'Python 模块（python -m <模块>）',
  uvicorn: 'Uvicorn（python -m uvicorn <app>）',
  flask: 'Flask（flask run）',
  django: 'Django（manage.py runserver）',
  'go-run': 'go run',
  'cargo-run': 'cargo run',
  'cargo-run-release': 'cargo run --release',
  'cpp-exe': '运行已构建的 .exe'
}

/** 每个可启动框架允许的 launchMode 列表，新建/编辑面板据此渲染下拉选项 */
export const FRAMEWORK_LAUNCH_MODES: Partial<Record<Framework, LaunchMode[]>> = {
  'spring-boot': ['maven-wrapper', 'gradle-wrapper', 'jar', 'system-maven', 'system-gradle'],
  python: ['python-file', 'python-module', 'uvicorn', 'flask'],
  django: ['django', 'python-file', 'python-module'],
  fastapi: ['uvicorn', 'python-module', 'python-file'],
  flask: ['flask', 'python-module', 'python-file'],
  streamlit: ['python-module', 'python-file'],
  go: ['go-run'],
  rust: ['cargo-run', 'cargo-run-release'],
  cpp: ['cpp-exe']
}

/**
 * 技术栈大类：把细分框架归并成用户口中的「React / Java / Vue」这类粗粒度标签，
 * 用于任务台顶部的技术栈 tab。react-vite 与 react-cra 都归 React，spring-boot 归 Java。
 *
 * 值是稳定的英文键（做 tab 的标识与筛选比较），标签走 STACK_LABEL。
 */
export type TechStack =
  | 'react'
  | 'vue'
  | 'next'
  | 'nuxt'
  | 'angular'
  | 'svelte'
  | 'node'
  | 'java'
  | 'python'
  | 'go'
  | 'rust'
  | 'cpp'
  | 'docker'
  | 'uniapp'
  | 'static'
  | 'other'

const FRAMEWORK_STACK: Record<Framework, TechStack> = {
  next: 'next',
  nuxt: 'nuxt',
  angular: 'angular',
  'vue-vite': 'vue',
  'vue-cli': 'vue',
  'react-vite': 'react',
  'react-cra': 'react',
  svelte: 'svelte',
  electron: 'node',
  hexo: 'node',
  node: 'node',
  'spring-boot': 'java',
  uniapp: 'uniapp',
  hugo: 'go', // Hugo 是 Go 写的静态站生成器，归 Go 一类而非另立
  jekyll: 'other',
  django: 'python',
  fastapi: 'python',
  flask: 'python',
  streamlit: 'python',
  python: 'python',
  'docker-compose': 'docker',
  go: 'go',
  rust: 'rust',
  cpp: 'cpp',
  static: 'static',
  unknown: 'other'
}

/** 技术栈大类的展示标签，tab 上显示这个 */
export const STACK_LABEL: Record<TechStack, string> = {
  react: 'React',
  vue: 'Vue',
  next: 'Next.js',
  nuxt: 'Nuxt',
  angular: 'Angular',
  svelte: 'Svelte',
  node: 'Node',
  java: 'Java',
  python: 'Python',
  go: 'Go',
  rust: 'Rust',
  cpp: 'C++',
  docker: 'Docker',
  uniapp: 'uniapp',
  static: '静态站点',
  other: '其他'
}

export function stackOf(framework: Framework): TechStack {
  return FRAMEWORK_STACK[framework] ?? 'other'
}

/**
 * 启动来源徽标文案，PRD §5.3。
 *
 * 徽标一律中性色（idle）。给它上语义色会让人以为「来源是 X」意味着某种状态，
 * 而它只是「谁拉起了这个进程」，与能否停止无关 —— 那由归属徽标单独表示。
 */
export const LAUNCH_SOURCE_LABEL: Record<LaunchSource, string> = {
  mile: '本应用',
  vscode: 'VS Code',
  cursor: 'Cursor',
  jetbrains: 'JetBrains',
  claude: 'Claude',
  codex: 'Codex',
  terminal: '终端',
  explorer: '资源管理器',
  service: '系统服务',
  unknown: '未知来源'
}

export function isBusyStatus(status: EntryStatus): boolean {
  return status === 'precheck' || status === 'starting' || status === 'stopping'
}

export function isLiveStatus(status: EntryStatus): boolean {
  return status === 'running' || isBusyStatus(status)
}

/** 卡片筛选口径，PRD §4.6。服务与任务各一套，因为二者的「结束」含义不同 */
export type ServiceFilter = 'all' | 'running' | 'stopped' | 'fault'
export type TaskFilter = 'all' | 'running' | 'succeeded' | 'failed' | 'canceled'

export const SERVICE_FILTERS: { value: ServiceFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'running', label: '运行中' },
  { value: 'stopped', label: '已停止' },
  { value: 'fault', label: '异常' }
]

export const TASK_FILTERS: { value: TaskFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'running', label: '运行中' },
  { value: 'succeeded', label: '成功' },
  { value: 'failed', label: '失败' },
  { value: 'canceled', label: '已取消' }
]

export function matchesServiceFilter(status: EntryStatus, filter: ServiceFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'running':
      return isLiveStatus(status)
    // 「异常」把预检未通过也算进来：从使用者角度它同样是「这张卡现在起不来」
    case 'fault':
      return status === 'crashed' || status === 'blocked'
    case 'stopped':
      return status === 'idle' || status === 'stopped'
  }
}

export function matchesTaskFilter(status: EntryStatus, filter: TaskFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'running':
      return isLiveStatus(status)
    case 'succeeded':
      return status === 'succeeded'
    case 'failed':
      return status === 'failed' || status === 'crashed' || status === 'blocked'
    case 'canceled':
      return status === 'canceled' || status === 'stopped'
  }
}
