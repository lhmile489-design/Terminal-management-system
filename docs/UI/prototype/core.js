/* 原型核心：工具、假数据、状态、主题、标题栏与导航。对应 docs/UI/UI-REFACTOR.md，一次性演示用 */
'use strict'
const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const now = () => Date.now()

/** Phosphor 图标：regular 默认，fill 只用于选中态 */
function ic(name, fill = false, cls = '') {
  const d = window.PH[name]
  if (!d) return ''
  const paths = (fill && d.fill ? d.fill : d.regular) || []
  return `<svg class="ph ${cls}" viewBox="0 0 256 256" aria-hidden="true">${paths.map((p) => `<path d="${p}"/>`).join('')}</svg>`
}

function fmtDur(ms) {
  const s = Math.floor(ms / 1000)
  if (s < 60) return s + ' 秒'
  const m = Math.floor(s / 60)
  if (m < 60) return m + ' 分 ' + (s % 60) + ' 秒'
  return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分'
}
function fmtClock(ts) {
  const d = new Date(ts)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
}

/* ── 假数据：4 个工作组，前后端成对 ───────────────────── */
const FW = {
  vue: { t: 'V', c: '#2F855A', n: 'Vue' },
  react: { t: 'R', c: '#0E7490', n: 'React' },
  next: { t: 'N', c: '#374151', n: 'Next.js' },
  spring: { t: 'S', c: '#3F7D20', n: 'Spring Boot' },
  uni: { t: 'U', c: '#2B7A4B', n: 'uni-app' },
  hugo: { t: 'H', c: '#C2410C', n: 'Hugo' },
  node: { t: 'JS', c: '#4D5B12', n: 'Node' }
}

const SVC = [
  { id: 'mall-web', name: '商城前台', fw: 'vue', kind: 'fe', port: 5173, path: 'E:/Work/mall/mall-web', script: 'dev', scripts: ['dev', 'build', 'preview'], group: 'mall', env: ['VITE_API_BASE'] },
  { id: 'mall-admin', name: '商城后台管理', fw: 'react', kind: 'fe', port: 5174, path: 'E:/Work/mall/mall-admin', script: 'dev', scripts: ['dev', 'build'], group: 'mall', env: [] },
  { id: 'mall-server', name: '商城服务端', fw: 'spring', kind: 'be', port: 8080, path: 'E:/Work/mall/mall-server', script: 'spring-boot:run', scripts: [], group: 'mall', env: ['SPRING_PROFILES_ACTIVE', 'DB_PASSWORD'], java: true },
  { id: 'docs-site', name: '公司文档站', fw: 'next', kind: 'fe', port: 3000, path: 'E:/Work/docs/docs-site', script: 'dev', scripts: ['dev', 'build', 'start'], group: 'docs', env: [] },
  { id: 'docs-api', name: '文档检索服务', fw: 'spring', kind: 'be', port: 8090, path: 'E:/Work/docs/docs-api', script: 'spring-boot:run', scripts: [], group: 'docs', env: ['ES_URL'], java: true },
  { id: 'off-web', name: '官网', fw: 'next', kind: 'fe', port: 3100, path: 'E:/Work/site/off-web', script: 'dev', scripts: ['dev', 'build'], group: 'site', env: [] },
  { id: 'off-api', name: '官网接口', fw: 'spring', kind: 'be', port: 8180, path: 'E:/Work/site/off-api', script: 'spring-boot:run', scripts: [], group: 'site', env: ['SPRING_PROFILES_ACTIVE'], java: true },
  { id: 'site-build', name: '官网静态构建', fw: 'node', kind: 'task', port: null, path: 'E:/Work/site/off-web', script: 'build', scripts: ['dev', 'build'], group: 'site', env: [] },
  { id: 'play-ui', name: '组件实验室', fw: 'react', kind: 'fe', port: 6006, path: 'E:/Lab/play-ui', script: 'dev', scripts: ['dev', 'storybook'], group: 'lab', env: [], missingDeps: true },
  { id: 'play-mini', name: '小程序实验', fw: 'uni', kind: 'fe', port: 5180, path: 'E:/Lab/play-mini', script: 'dev:h5', scripts: ['dev:h5', 'build:mp-weixin'], group: 'lab', env: [] },
  { id: 'blog', name: '个人博客', fw: 'hugo', kind: 'fe', port: 1313, path: 'E:/Personal/blog', script: '', scripts: [], group: null, env: [], registerOnly: true },
  { id: 'clean', name: '清理构建缓存', fw: 'node', kind: 'task', port: null, path: 'E:/Work/tools', script: 'clean', scripts: ['clean'], group: null, env: [] }
]

const GROUPS = [
  { id: 'mall', name: '商城项目', env: 'dev' },
  { id: 'docs', name: '文档平台', env: 'dev' },
  { id: 'site', name: '官网生产', env: 'prod' },
  { id: 'lab', name: '实验室', env: 'sandbox' }
]

const ST = {
  idle: { l: '未启动', p: 'idle', d: '' },
  starting: { l: '启动中', p: 'warn', d: 'warn' },
  running: { l: '运行中', p: 'live', d: 'live' },
  stopping: { l: '停止中', p: 'warn', d: 'warn' },
  failed: { l: '启动失败', p: 'fault', d: 'fault' }
}

const S = {
  page: 'services',
  navCollapsed: localStorage.getItem('proto.nav') === '1',
  theme: localStorage.getItem('proto.theme') || 'light',
  kind: 'all', q: '', sel: null, tab: 'overview', max: false, fresh: false, cursor: null,
  listW: +localStorage.getItem('proto.listW') || 360,
  drafts: {}, advOpen: false,
  drawer: false, unread: 0, unreadFault: false, events: [],
  pal: false, palQ: '', palI: 0, keys: false, confirm: null, menu: null, flash: null,
  termTab: 'term', term: 'sh1', logLevel: 'all', logSess: 'all', logQ: '',
  showBg: false, hiPort: null, profile: {}, build: {}, artifact: {},
  set: { scan: 2000, home: 'services', font: 13, scroll: 5000, ext: 'wt', killOnQuit: true, tray: false, notifyFail: true, notifyDone: true }
}
const RT = {}
const POS = {}

/* ── 主题 ───────────────────────────────────────────── */
const THEME_L = { light: '浅色', dark: '深色', system: '跟随系统' }
const mq = matchMedia('(prefers-color-scheme: dark)')
function applyTheme() {
  const dark = S.theme === 'dark' || (S.theme === 'system' && mq.matches)
  const r = document.documentElement
  r.classList.add('theme-switching')
  r.dataset.theme = dark ? 'dark' : 'light'
  requestAnimationFrame(() => requestAnimationFrame(() => r.classList.remove('theme-switching')))
  localStorage.setItem('proto.theme', S.theme)
}

/** 指示条滑动：DOM 每次重建，所以先瞬移到上次位置，再过渡到新位置 */
function slide(el, key, to) {
  const from = POS[key]
  const css = (p) => `translate(${p.x || 0}px, ${p.y || 0}px)`
  if (from) {
    el.style.transition = 'none'
    el.style.transform = css(from)
    if (to.w != null && from.w != null) el.style.width = from.w + 'px'
    void el.offsetWidth
    el.style.transition = ''
  }
  el.style.transform = css(to)
  if (to.w != null) el.style.width = to.w + 'px'
  POS[key] = to
}

/* ── 标题栏 ─────────────────────────────────────────── */
function renderTitle() {
  $('#tb').innerHTML = `
    <div class="brand"><span class="brand-mark">M</span>Mile Terminal</div>
    <button class="search-trigger" data-act="pal">${ic('MagnifyingGlass')}<span>搜索服务、工作组、端口或命令</span><span class="kbd">Ctrl K</span></button>
    <div class="tb-right">
      <button class="bell" id="bell" data-act="drawer" title="实时动态" aria-label="实时动态${S.unread ? `，${S.unread} 条未读` : ''}">${ic('Bell')}${S.unread ? `<span class="badge ${S.unreadFault ? 'fault' : ''}">${S.unread}</span>` : ''}</button>
      <button class="chrome" data-act="chrome" aria-label="最小化">${ic('Minus')}</button>
      <button class="chrome" data-act="chrome" aria-label="最大化">${ic('Square')}</button>
      <button class="chrome close" data-act="chrome" aria-label="关闭">${ic('X')}</button>
    </div>`
}

/* ── 导航轨：5 项 ───────────────────────────────────── */
const PAGES = [
  { id: 'services', l: '服务', i: 'Stack', k: 1 },
  { id: 'overview', l: '总览', i: 'Gauge', k: 2 },
  { id: 'terminal', l: '终端', i: 'TerminalWindow', k: 3 },
  { id: 'settings', l: '设置', i: 'Gear', k: 4, bottom: true },
  { id: 'about', l: '关于', i: 'Info', k: 5, bottom: true }
]
function navItem(p) {
  const on = S.page === p.id
  return `<button class="nav-item" data-act="go" data-arg="${p.id}" data-tip="${p.l}" aria-label="${p.l}" ${on ? 'aria-current="page"' : ''}>${ic(p.i, on)}<span class="label">${p.l}</span><span class="kbd">Alt ${p.k}</span></button>`
}
function renderNav() {
  const nav = $('#nav')
  nav.classList.toggle('collapsed', S.navCollapsed)
  const colLbl = S.navCollapsed ? '展开导航' : '折叠导航'
  nav.innerHTML = `<span class="nav-indicator" style="top:0"></span>
    ${PAGES.filter((p) => !p.bottom).map(navItem).join('')}
    <div class="nav-sep"></div>
    ${PAGES.filter((p) => p.bottom).map(navItem).join('')}
    <button class="nav-item" data-act="theme" data-tip="主题：${THEME_L[S.theme]}" aria-label="切换主题，当前${THEME_L[S.theme]}">${ic(S.theme === 'dark' ? 'Moon' : 'Sun')}<span class="label">主题 · ${THEME_L[S.theme]}</span></button>
    <button class="nav-item" data-act="collapse" data-tip="${colLbl}" aria-label="${colLbl}" aria-expanded="${!S.navCollapsed}">${ic('SidebarSimple')}<span class="label">折叠导航</span></button>`
  const a = $('.nav-item[aria-current]', nav)
  if (a) slide($('.nav-indicator', nav), 'nav', { y: a.offsetTop + (a.offsetHeight - 20) / 2 })
  $('#note').style.left = (S.navCollapsed ? 68 : 196) + 'px'
}
