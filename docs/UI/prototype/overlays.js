/* 原型浮层：实时动态抽屉、命令面板、快捷键一览、确认弹窗、更多菜单、通知条 */
'use strict'

/* ── 实时动态抽屉 ───────────────────────────────────── */
const EV_ICO = { live: 'CheckCircle', fault: 'WarningCircle', idle: 'Info' }
function eventList() {
  if (!S.events.length) return `<div class="empty" style="padding:32px 16px"><span class="ico">${ic('Bell', false, 'lg')}</span><b>暂无事件</b><span>启动或停止服务后会记录在这里</span></div>`
  return S.events.map((e) => `<div class="event"><span class="ico ${e.tone}">${ic(EV_ICO[e.tone] || 'Info')}</span>
    <div style="min-width:0"><b>${esc(e.title)}</b><span>${esc(e.body || '')}</span><span class="mono num">${fmtClock(e.at)}</span></div></div>`).join('')
}
function renderDrawer() {
  const box = $('#ov-drawer')
  if (!S.drawer) { box.innerHTML = ''; return }
  // 抽屉已开时只换列表，不重放滑入动画
  const list = $('#ev-list', box)
  if (list) { list.innerHTML = eventList(); return }
  box.innerHTML = `<div class="scrim" data-act="closeDrawer"></div>
    <aside class="drawer" role="dialog" aria-modal="true" aria-label="实时动态">
      <div class="drawer-head"><h2>实时动态</h2>
        <button class="btn ghost sm" data-act="clearEvents">${ic('Trash')}清空</button>
        <button class="iconbtn" id="drawer-x" data-act="closeDrawer" aria-label="关闭实时动态" title="关闭（Esc）">${ic('X')}</button></div>
      <div id="ev-list" style="flex:1;overflow-y:auto;padding:6px 0">${eventList()}</div>
    </aside>`
}
function openDrawer() {
  S.drawer = true; S.unread = 0; S.unreadFault = false
  renderTitle(); renderDrawer()
  $('#drawer-x').focus()
}
function closeDrawer() {
  S.drawer = false
  renderDrawer()
  $('#bell') && $('#bell').focus()
}
function addEvent(tone, title, body) {
  S.events.unshift({ tone, title, body, at: now() })
  S.events.length = Math.min(S.events.length, 50)
  if (!S.drawer) { S.unread++; if (tone === 'fault') S.unreadFault = true }
  const focusBell = document.activeElement && document.activeElement.id === 'bell'
  renderTitle()
  if (focusBell) $('#bell').focus()
  renderDrawer()
}

/* ── 命令面板 ───────────────────────────────────────── */
function palItems() {
  const items = []
  PAGES.forEach((p) => items.push({ g: '页面', i: p.i, l: '前往' + p.l, h: 'Alt ' + p.k, run: () => go(p.id) }))
  GROUPS.forEach((g) => items.push({ g: '工作组', i: 'Folders', l: '启动整组：' + g.name, h: g.env, run: () => groupStart(g.id) }))
  SVC.forEach((s) => {
    items.push({ g: '服务', i: 'Stack', l: '打开 ' + s.name, h: s.port ? ':' + s.port : '任务', run: () => openSvc(s.id) })
    if (!s.registerOnly && !isLive(s.id)) items.push({ g: '服务', i: 'Play', l: (s.kind === 'task' ? '运行 ' : '启动 ') + s.name, h: '', run: () => start(s.id) })
    if (RT[s.id].status === 'running') items.push({ g: '服务', i: 'Stop', l: '停止 ' + s.name, h: '', run: () => stop(s.id) })
  })
  items.push({ g: '命令', i: 'Plus', l: '新建 PowerShell 终端', h: '', run: newShell })
  items.push({ g: '命令', i: 'Sun', l: '切换主题', h: THEME_L[S.theme], run: cycleTheme })
  items.push({ g: '命令', i: 'Keyboard', l: '快捷键一览', h: '?', run: openKeys })
  const q = S.palQ.trim().toLowerCase()
  return q ? items.filter((x) => (x.l + x.h).toLowerCase().includes(q)) : items
}
function openPal() {
  S.pal = true; S.palQ = ''; S.palI = 0
  S._palFrom = document.activeElement
  $('#ov-pal').innerHTML = `<div class="scrim full" data-act="closePal"></div>
    <div class="palette" role="dialog" aria-modal="true" aria-label="命令面板">
      <span class="s">${ic('MagnifyingGlass')}</span>
      <input id="pal-q" placeholder="搜索服务、工作组、页面或命令" aria-label="搜索命令" autocomplete="off">
      <ul id="pal-list" role="listbox"></ul></div>`
  renderPalList()
  $('#pal-q').focus()
}
function renderPalList() {
  const items = palItems()
  S._palItems = items
  S.palI = Math.max(0, Math.min(S.palI, items.length - 1))
  let last = ''
  $('#pal-list').innerHTML = items.length ? items.map((x, i) => {
    const head = x.g !== last ? `<li class="grp" role="presentation">${x.g}</li>` : ''
    last = x.g
    return `${head}<li role="option" data-pi="${i}" aria-selected="${i === S.palI}">${ic(x.i)}<span>${esc(x.l)}</span><span class="hint">${esc(x.h)}</span></li>`
  }).join('') : '<li class="grp">没有匹配的命令</li>'
  const cur = $('#pal-list [aria-selected="true"]')
  cur && cur.scrollIntoView({ block: 'nearest' })
}
function closePal() {
  S.pal = false
  $('#ov-pal').innerHTML = ''
  S._palFrom && S._palFrom.focus && S._palFrom.focus()
}
function runPal(i) {
  const x = S._palItems[i]
  if (!x) return
  closePal()
  x.run()
}

/* ── 快捷键一览 ─────────────────────────────────────── */
const KEYS = [
  ['打开命令面板', 'Ctrl K'], ['切换页面', 'Ctrl 1–5（原型里用 Alt 1–5）'], ['列表上下移动', '↑ ↓'],
  ['打开详情', 'Enter'], ['启动 / 停止（选中工作组标题时整组）', 'Space'],
  ['切换详情标签', 'Ctrl Tab（原型里用 [ ]）'], ['关闭详情 / 退出最大化 / 关闭浮层', 'Esc'], ['打开本面板', '?']
]
function openKeys() {
  S.keys = true
  S._keysFrom = document.activeElement
  $('#ov-keys').innerHTML = `<div class="scrim full" data-act="closeKeys"></div>
    <div class="keys" role="dialog" aria-modal="true" aria-labelledby="keys-h">
      <div style="display:flex;align-items:center;margin-bottom:12px"><h2 id="keys-h" style="margin:0">快捷键</h2>
        <button class="iconbtn" id="keys-x" data-act="closeKeys" aria-label="关闭" style="margin-left:auto">${ic('X')}</button></div>
      <dl>${KEYS.map(([a, k]) => `<dt>${a}</dt><dd><span class="kbd">${k}</span></dd>`).join('')}</dl>
      <p style="margin-top:14px;color:var(--ink-muted);font-size:12px">光标在输入框或终端里时，单键快捷键不生效。浏览器占用了 Ctrl 1–5 和 Ctrl Tab，真实应用里用原键位。</p>
    </div>`
  $('#keys-x').focus()
}
function closeKeys() {
  S.keys = false
  $('#ov-keys').innerHTML = ''
  S._keysFrom && S._keysFrom.focus && S._keysFrom.focus()
}

/* ── 确认弹窗：默认焦点在「取消」，Tab 只在两个按钮间循环 ── */
function confirmDlg(o) {
  return new Promise((resolve) => {
    S.confirm = { ...o, resolve, from: document.activeElement }
    $('#ov-confirm').innerHTML = `<div class="scrim full"></div>
      <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="cf-h" aria-describedby="cf-p">
        <h2 id="cf-h">${o.danger ? `<span class="ico">${ic('Warning')}</span>` : ''}${esc(o.title)}</h2>
        <p id="cf-p">${esc(o.body)}</p>
        <div class="btns"><button class="btn secondary" id="cf-no" data-act="cfNo">取消</button>
          <button class="btn ${o.danger ? 'danger' : 'primary'}" id="cf-ok" data-act="cfOk">${esc(o.ok || '确定')}</button></div></div>`
    $('#cf-no').focus()
  })
}
function closeConfirm(ok) {
  const c = S.confirm
  if (!c) return
  S.confirm = null
  $('#ov-confirm').innerHTML = ''
  c.from && c.from.isConnected && c.from.focus()
  c.resolve(ok)
}

/* ── 更多菜单 ───────────────────────────────────────── */
function svcMenu(s) {
  const live = isLive(s.id)
  const running = RT[s.id].status === 'running'
  const m = []
  if (s.kind !== 'task' && !s.registerOnly) m.push({ i: 'ArrowClockwise', l: '重启', dis: !running, run: () => restart(s.id) })
  if (s.kind !== 'task') m.push({ i: 'Prohibit', l: '强制关闭', dis: !running, danger: true, run: () => kill(s.id) })
  m.push('-')
  m.push({ i: 'TerminalWindow', l: '查看输出', run: () => openSvc(s.id + ':output') })
  m.push({ i: 'Stethoscope', l: '诊断', run: () => openSvc(s.id + ':diagnose') })
  m.push({ i: 'SlidersHorizontal', l: '配置', run: () => openSvc(s.id + ':config') })
  m.push('-')
  m.push({ i: 'FolderOpen', l: '打开目录', run: () => toast('info', '已在资源管理器中打开', s.path) })
  if (s.kind !== 'task') m.push({ i: 'Package', l: '查看产物', run: () => toast('info', '已打开产物目录', s.path + '/' + (s.java ? 'target' : 'dist')) })
  if (s.fw === 'uni') m.push({ i: 'ArrowSquareOut', l: '用 HBuilderX 打开', run: () => toast('info', '已交给 HBuilderX', s.path) })
  m.push({ i: 'Copy', l: '复制路径', run: () => copyText(s.path) })
  m.push('-')
  m.push({ i: 'Trash', l: live ? '移除（先停止）' : '移除', dis: live, danger: true, run: () => removeSvc(s.id) })
  return m
}
function grpMenu(g) {
  const anyLive = SVC.some((s) => s.group === g.id && RT[s.id].status === 'running')
  return [
    { i: 'Plus', l: '添加服务到本组', run: () => addSvc(g.id) },
    { i: 'Stop', l: '全部停止', dis: !anyLive, run: () => groupStop(g.id) },
    '-',
    ...['dev', 'sandbox', 'prod'].map((e) => ({ i: g.env === e ? 'Check' : '', l: '环境：' + e, run: () => setEnv(g.id, e) })),
    '-',
    { i: 'Trash', l: '删除工作组', danger: true, run: () => removeGroup(g.id) }
  ]
}
function openMenu(btn, arg) {
  if (S.menu && S.menu.arg === arg) { closeMenu(); return }
  const [type, id] = arg.split(':')
  const items = type === 'svc' ? svcMenu(svc(id)) : grpMenu(grp(id))
  S.menu = { arg, items, from: btn }
  const r = btn.getBoundingClientRect()
  const box = $('#ov-menu')
  box.innerHTML = `<div class="menu" role="menu" aria-label="更多操作">${items.map((x, i) => x === '-' ? '<hr>'
    : `<button role="menuitem" data-mi="${i}" class="${x.danger ? 'danger' : ''}" ${x.dis ? 'disabled' : ''}>${x.i ? ic(x.i) : '<span style="width:16px"></span>'}${esc(x.l)}</button>`).join('')}</div>`
  const m = $('.menu', box)
  const h = m.offsetHeight
  const w = m.offsetWidth
  m.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + 'px'
  m.style.top = (r.bottom + 4 + h > innerHeight - 8 ? r.top - h - 4 : r.bottom + 4) + 'px'
  const first = $('button:not(:disabled)', m)
  first && first.focus()
}
function closeMenu(refocus = false) {
  if (!S.menu) return
  const from = S.menu.from
  S.menu = null
  $('#ov-menu').innerHTML = ''
  if (refocus && from && from.isConnected) from.focus()
}

/* ── 通知条：成功 4 秒消失，失败常驻 ─────────────────── */
function toast(tone, title, body = '', action = null) {
  const box = $('#toasts')
  const el = document.createElement('div')
  el.className = 'toast ' + tone
  el.setAttribute('role', tone === 'fault' ? 'alert' : 'status')
  el.innerHTML = `<span class="ico">${ic(tone === 'fault' ? 'WarningCircle' : tone === 'live' ? 'CheckCircle' : 'Info')}</span>
    <div style="min-width:0"><b>${esc(title)}</b>${body ? `<span>${esc(body)}</span>` : ''}
      ${action ? `<div class="acts"><button class="btn secondary sm" data-ta>${esc(action.l)}</button></div>` : ''}</div>
    <button class="iconbtn" data-tx aria-label="关闭通知">${ic('X')}</button>`
  const close = () => el.remove()
  $('[data-tx]', el).onclick = (e) => { e.stopPropagation(); close() }
  if (action) $('[data-ta]', el).onclick = (e) => { e.stopPropagation(); close(); action.run() }
  box.appendChild(el)
  while (box.children.length > 4) box.firstChild.remove()
  if (tone !== 'fault') setTimeout(close, 4000)
}
