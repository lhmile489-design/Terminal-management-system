/* 原型页面：总览、终端（含全部输出）、设置、关于，以及主区域渲染 */
'use strict'
const TABS = { overview: tabOverview, output: tabOutput, diagnose: tabDiagnose, build: tabBuild, config: tabConfig }

/* ── 总览：保留原工作台全部区块，按便当网格重排 ───────── */
const NEWL = [
  { port: 5199, proc: 'node.exe', pid: 14420, path: 'E:/Lab/vite-demo', hint: 'Vite 开发服务器' },
  { port: 4321, proc: 'node.exe', pid: 15012, path: 'E:/Lab/astro-notes', hint: 'Astro 开发服务器' }
]
const BG = [
  { port: 5037, proc: 'adb.exe', pid: 2210, mem: 24 },
  { port: 6463, proc: 'Discord.exe', pid: 7781, mem: 210 },
  { port: 27036, proc: 'steam.exe', pid: 6620, mem: 96 }
]
const WATCH = [
  { name: 'nginx.exe', port: 80, on: true },
  { name: 'mongod.exe', port: 27017, on: false }
]

function spark(vals) {
  if (!vals || vals.length < 2) return ''
  const w = 120, h = 28, max = Math.max(10, ...vals)
  const pts = vals.map((v, i) => [(i / (vals.length - 1)) * w, h - (v / max) * (h - 4) - 2])
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('')
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path class="area" d="${line}L${w},${h}L0,${h}Z"/><path d="${line}" vector-effect="non-scaling-stroke"/></svg>`
}

function kpi(icon, k, v, unit, hint, act, tone = '') {
  const tag = act ? 'button' : 'div'
  return `<${tag} class="tile kpi ${act ? 'hoverable' : ''} ${tone}" ${act ? `data-act="${act[0]}" data-arg="${act[1]}" style="text-align:left;cursor:pointer"` : ''}>
    <div class="k"><span class="ico">${ic(icon)}</span>${k}</div>
    <div class="v display num">${v}${unit ? `<small>${unit}</small>` : ''}</div>
    <div class="hint">${hint}</div></${tag}>`
}

function pageOverview() {
  const live = SVC.filter((s) => RT[s.id].status === 'running' && s.port)
  const startable = SVC.filter((s) => s.kind !== 'task' && !s.registerOnly)
  const running = startable.filter((s) => RT[s.id].status === 'running').length
  const ports = live.length + EXT.length + NEWL.length + BG.length
  const cpu = SVC.reduce((a, s) => a + (RT[s.id].status === 'running' ? RT[s.id].cpu.at(-1) || 0 : 0), 0)
  const failed = SVC.filter((s) => RT[s.id].status === 'failed').length
  return `<div class="page">
    <header class="view-head"><div><h1 class="display">总览</h1><p>本机现在跑着什么：监听端口、负载与外部进程</p></div>
      <div class="actions"><button class="btn secondary" data-act="toast" data-arg="已刷新端口快照">${ic('ArrowClockwise')}立即刷新</button></div></header>
    <div class="bento">
      ${kpi('Plug', '监听端口', ports, '', `本应用 ${live.length} · 外部 ${ports - live.length}`, ['seePort', 'table'])}
      ${kpi('Stack', '运行中服务', running, ` / ${startable.length}`, failed ? `${failed} 个启动失败` : '没有失败的服务', ['go', 'services'], failed ? 'warn' : '')}
      ${kpi('Cpu', '受控进程 CPU', `<span data-cpu-total>${cpu.toFixed(1)}</span>`, '%', '只统计本应用启动的进程')}
      ${kpi('Clock', '采集状态', `<span data-clock>${fmtClock(now())}</span>`, '', `每 ${S.set.scan / 1000} 秒采集一次，正常`)}

      <section class="tile span-2 row-2" aria-labelledby="ops-h">
        <div class="tile-head">${ic('Stack', false, 'lg')}<h2 id="ops-h">服务操作台</h2><span class="sub">点名称打开详情</span></div>
        <div class="tile-body">${GROUPS.map((g) => {
          const items = SVC.filter((s) => s.group === g.id && s.kind !== 'task')
          return `<div class="sec-label" style="display:flex;align-items:center;gap:6px">${esc(g.name)} ${envBadge(g.env)}</div>${items.map(opRow).join('')}`
        }).join('')}</div>
      </section>

      <section class="tile span-2" aria-labelledby="new-h">
        <div class="tile-head">${ic('Plus', false, 'lg')}<h2 id="new-h">新发现的端口</h2><span class="sub">不属于任何已登记服务</span></div>
        <div class="tile-body">${NEWL.length ? NEWL.map((n) => `<div class="disc"><span class="p num">:${n.port}</span>
          <div style="min-width:0;flex:1"><div style="font-weight:600;color:var(--ink-strong)">${esc(n.hint)}</div><div class="d mono" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(n.proc)} · ${esc(n.path)}</div></div>
          <button class="btn ghost sm" data-act="ignore" data-arg="${n.port}">忽略</button>
          <button class="btn secondary sm" data-act="promote" data-arg="${n.port}">${ic('Plus')}加为我的服务</button></div>`).join('') : '<p style="color:var(--ink-muted)">暂时没有新端口</p>'}</div>
      </section>

      <section class="tile span-2" aria-labelledby="watch-h">
        <div class="tile-head">${ic('Eye', false, 'lg')}<h2 id="watch-h">受关注进程</h2></div>
        <div class="tile-body">${WATCH.map((w) => `<div class="op-row"><span class="dot ${w.on ? 'live' : ''}"></span><span class="mono" style="color:var(--ink-strong)">${esc(w.name)}</span>
          <span class="pill ${w.on ? 'live' : 'idle'}">${w.on ? `运行中 :${w.port}` : '未运行'}</span><span></span></div>`).join('')}</div>
      </section>

      <section class="tile span-4" id="port-table" aria-labelledby="pt-h">
        <div class="tile-head">${ic('Plug', false, 'lg')}<h2 id="pt-h">我的服务端口</h2><span class="sub">外部进程只展示，不在这里结束</span></div>
        <div class="tile-body" style="padding:0 4px 8px">${portTable()}</div>
      </section>

      <section class="tile span-4" aria-labelledby="bg-h">
        <div class="tile-head">${ic('Folders', false, 'lg')}<h2 id="bg-h">应用后台</h2>
          <button class="collapser" data-act="bg" aria-expanded="${S.showBg}">${ic('CaretRight')}${BG.length} 个</button>
          <span class="sub">GUI 应用与系统路径进程</span></div>
        ${S.showBg ? `<div class="tile-body" style="padding:0 4px 8px"><table class="table"><thead><tr><th>端口</th><th>进程</th><th>PID</th><th>内存</th><th></th></tr></thead><tbody>
          ${BG.map((b) => `<tr><td class="mono num">:${b.port}</td><td class="mono">${esc(b.proc)}</td><td class="mono num">${b.pid}</td><td class="num">${b.mem} MB</td>
            <td style="text-align:right"><button class="btn ghost sm" data-act="moveToMine" data-arg="${b.port}">提升为我的服务</button></td></tr>`).join('')}</tbody></table></div>` : ''}
      </section>
    </div></div>`
}

function opRow(s) {
  const live = RT[s.id].status === 'running'
  return `<div class="op-row"><span class="dot ${ST[RT[s.id].status].d}"></span>
    <span class="n" role="link" tabindex="0" data-act="openSvc" data-arg="${s.id}">${esc(s.name)}<span class="mono num" style="color:var(--ink-faint);font-weight:400;margin-left:8px">${s.port ? ':' + s.port : ''}</span></span>
    ${toggle(s)}
    ${live ? `<button class="iconbtn" data-act="kill" data-arg="${s.id}" aria-label="强制关闭 ${esc(s.name)}" title="强制关闭">${ic('Prohibit')}</button>` : '<span style="width:28px"></span>'}</div>`
}

function portTable() {
  const mine = SVC.filter((s) => RT[s.id].status === 'running' && s.port).map((s) => ({ port: s.port, proc: s.java ? 'java.exe' : 'node.exe', pid: RT[s.id].pid, mem: RT[s.id].mem, s }))
  const rows = [...mine, ...EXT].sort((a, b) => a.port - b.port)
  return `<table class="table"><thead><tr><th>端口</th><th>进程</th><th>PID</th><th>内存</th><th>来源</th><th></th></tr></thead><tbody>
    ${rows.map((r) => `<tr data-port="${r.port}" class="${S.hiPort === r.port ? 'hi' : ''}"><td class="mono num">:${r.port}</td><td class="mono">${esc(r.proc)}</td><td class="mono num">${r.pid}</td><td class="num">${r.mem} MB</td>
      <td>${r.s ? `<span class="pill info">${esc(r.s.name)}</span>` : `<span class="pill idle" title="${esc(r.note || '不是本应用启动的进程')}">外部</span>`}</td>
      <td style="text-align:right">${r.s ? `<button class="btn ghost sm" data-act="openSvc" data-arg="${r.s.id}">打开服务</button>` : `<button class="iconbtn" data-act="copy" data-arg="${r.port}" aria-label="复制端口" title="复制端口">${ic('Copy')}</button>`}</td></tr>`).join('')}
    </tbody></table>`
}

/* ── 终端：会话列表 + 终端；「全部输出」标签即原日志页 ─── */
let SHELLS = [{ id: 'sh1', name: 'PowerShell 1', cwd: 'E:/Work', lines: [{ c: 'dim', t: 'Windows PowerShell' }, { t: 'PS E:/Work> git status' }, { t: 'On branch main, nothing to commit' }] }]
let shellSeq = 1

function pageTerminal() {
  return `<div class="page">
    <header class="view-head"><div><h1 class="display">终端</h1><p>独立 PowerShell 会话，以及所有服务的输出</p></div>
      <div class="actions"><div class="seg" role="group" aria-label="视图">
        <button aria-pressed="${S.termTab === 'term'}" data-act="termTab" data-arg="term">终端</button>
        <button aria-pressed="${S.termTab === 'logs'}" data-act="termTab" data-arg="logs">全部输出</button></div>
        <button class="btn primary" data-act="newShell">${ic('Plus')}新建终端</button></div></header>
    ${S.termTab === 'term' ? termLayout() : logsLayout()}</div>`
}

function termLayout() {
  const svcs = SVC.filter((s) => RT[s.id].lines.length)
  const byG = {}
  svcs.forEach((s) => { const k = grp(s.group)?.name || '未分组'; (byG[k] = byG[k] || []).push(s) })
  return `<div class="term-layout">
    <nav class="tile sessions" aria-label="会话">
      <div class="sess-h">我的终端</div>
      ${SHELLS.map((h) => `<button class="sess" aria-selected="${S.term === h.id}" data-act="term" data-arg="${h.id}">${ic('TerminalWindow')}<span>${esc(h.name)}</span></button>`).join('') || '<p style="color:var(--ink-faint);padding:4px 10px">还没有终端</p>'}
      <div class="sess-h" style="margin-top:12px">服务会话</div>
      ${Object.entries(byG).map(([g, list]) => `<div class="sess-group">${esc(g)}</div>${list.map((s) => `<button class="sess" aria-selected="${S.term === 'svc:' + s.id}" data-act="term" data-arg="svc:${s.id}"><span class="dot ${ST[RT[s.id].status].d}"></span><span>${esc(s.name)}</span></button>`).join('')}`).join('')}
    </nav>
    <section class="tile term-main" aria-label="终端输出">${termMain()}</section></div>`
}

function termMain() {
  const font = `style="font-size:${S.set.font}px"`
  if (S.term && S.term.startsWith('svc:')) {
    const s = svc(S.term.slice(4))
    if (s) return `<div class="tile-head"><span class="dot ${ST[RT[s.id].status].d}"></span><h2>${esc(s.name)}</h2><span class="pill ${ST[RT[s.id].status].p}">${ST[RT[s.id].status].l}</span>
        <div class="right"><button class="btn ghost sm" data-act="openSvc" data-arg="${s.id}:output">${ic('ArrowSquareOut')}打开服务详情</button></div></div>
      <div class="term term-fill" ${font}>${termHTML(RT[s.id].lines)}</div>`
  }
  const h = SHELLS.find((x) => x.id === S.term)
  if (!h) return `<div class="empty"><span class="ico">${ic('TerminalWindow', false, 'lg')}</span><b>没有选中的会话</b><span>新建一个 PowerShell，或从左侧选择服务会话</span><button class="btn primary" data-act="newShell">${ic('Plus')}新建终端</button></div>`
  return `<div class="tile-head">${ic('TerminalWindow', false, 'lg')}<h2>${esc(h.name)}</h2><span class="sub mono">${esc(h.cwd)}</span>
      <div class="right"><button class="iconbtn" data-act="closeShell" data-arg="${h.id}" aria-label="关闭这个终端" title="关闭终端">${ic('X')}</button></div></div>
    <div class="term term-fill" ${font}>${termHTML(h.lines)}</div>
    <label class="term-input mono"><span>PS ${esc(h.cwd)}&gt;</span><input id="sh-in" data-fk="sh-in" data-shell="${h.id}" aria-label="输入命令" autocomplete="off" spellcheck="false"></label>`
}

function collectLogs() {
  const out = []
  SVC.forEach((s) => RT[s.id].lines.forEach((l) => {
    if (l.c === 'sep') return
    out.push({ sid: s.id, name: s.name, ts: l.ts || 0, t: l.t, lv: l.c === 'err' ? 'error' : l.c === 'warnl' ? 'warn' : 'info' })
  }))
  return out.sort((a, b) => a.ts - b.ts)
}
function logsLayout() {
  const all = collectLogs()
  const q = S.logQ.trim().toLowerCase()
  const n = { all: all.length, error: all.filter((l) => l.lv === 'error').length, warn: all.filter((l) => l.lv === 'warn').length }
  const list = all.filter((l) => (S.logLevel === 'all' || l.lv === S.logLevel) && (S.logSess === 'all' || l.sid === S.logSess) && (!q || l.t.toLowerCase().includes(q)))
  const lvP = { error: 'fault', warn: 'warn', info: 'idle' }
  const lvL = { error: '错误', warn: '警告', info: '信息' }
  return `<section class="tile" style="flex:1;min-height:0;display:flex;flex-direction:column">
    <div class="tile-head" style="flex-wrap:wrap">
      <div class="seg" role="group" aria-label="级别">${[['all', '全部'], ['error', '错误'], ['warn', '警告']].map(([k, l]) => `<button aria-pressed="${S.logLevel === k}" data-act="logLevel" data-arg="${k}">${l}<span class="count num">${n[k]}</span></button>`).join('')}</div>
      <select class="input" id="log-sess" data-fk="log-sess" aria-label="会话" style="width:180px">${[['all', '全部会话'], ...SVC.filter((s) => RT[s.id].lines.length).map((s) => [s.id, s.name])].map(([v, l]) => `<option value="${v}" ${S.logSess === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <div class="search-box" style="margin-left:auto">${ic('MagnifyingGlass')}<input class="input" id="log-q" data-fk="log-q" placeholder="关键字" value="${esc(S.logQ)}" aria-label="搜索输出"></div></div>
    <div class="tile-body" style="flex:1;min-height:0;overflow-y:auto">
      ${list.length ? list.map((l) => `<button class="logline" data-act="term" data-arg="svc:${l.sid}" data-to="term"><span class="time mono num">${l.ts ? fmtClock(l.ts) : '--:--:--'}</span>
        <span class="pill ${lvP[l.lv]}" style="height:20px">${lvL[l.lv]}</span><span class="src">${esc(l.name)}</span><span class="msg mono">${esc(l.t)}</span></button>`).join('')
      : `<div class="empty"><span class="ico">${ic('Funnel', false, 'lg')}</span><b>没有符合条件的输出</b><span>放宽级别或换个关键字</span></div>`}
    </div></section>`
}

/* ── 设置：分组磁贴 2 列 ─────────────────────────────── */
function setSeg(key, opts) {
  return `<div class="seg" role="group">${opts.map(([v, l]) => `<button aria-pressed="${String(S.set[key] ?? S[key]) === String(v)}" data-act="setSeg" data-arg="${key}=${v}">${l}</button>`).join('')}</div>`
}
function setSw(key, label) {
  const on = key === 'nav' ? S.navCollapsed : S.set[key]
  return `<button class="switch" role="switch" aria-checked="${on}" aria-label="${label}" data-act="setSw" data-arg="${key}"></button>`
}
function setStep(key, unit) {
  return `<div class="stepper"><button data-act="step" data-arg="${key}:-1" aria-label="减少">${ic('Minus')}</button><span class="num mono">${S.set[key]}${unit}</span><button data-act="step" data-arg="${key}:1" aria-label="增加">${ic('Plus')}</button></div>`
}
const setRow = (b, d, ctl) => `<div class="set-row"><div class="l"><b>${b}</b>${d ? `<span>${d}</span>` : ''}</div>${ctl}</div>`
const setTile = (icon, h, body) => `<section class="tile"><div class="tile-head">${ic(icon, false, 'lg')}<h2>${h}</h2></div><div class="tile-body">${body}</div></section>`

function pageSettings() {
  return `<div class="page">
    <header class="view-head"><div><h1 class="display">设置</h1><p>采集周期、外观、终端与退出行为</p></div></header>
    <div class="set-grid">
      ${setTile('Pulse', '采集', setRow('采集周期', '越短越及时，CPU 占用越高', setSeg('scan', [[1000, '1 秒'], [2000, '2 秒'], [5000, '5 秒']])))}
      ${setTile('Sun', '外观', setRow('主题', '先打磨浅色，深色可用', `<div class="seg" role="group">${['light', 'dark', 'system'].map((t) => `<button aria-pressed="${S.theme === t}" data-act="setTheme" data-arg="${t}">${THEME_L[t]}</button>`).join('')}</div>`)
        + setRow('默认首页', '打开应用先进哪一页', setSeg('home', [['services', '服务'], ['overview', '总览']]))
        + setRow('折叠导航', '只显示图标，悬停看名称', setSw('nav', '折叠导航')))}
      ${setTile('TerminalWindow', '终端', setRow('字号', '', setStep('font', 'px')) + setRow('回滚行数', '每个会话保留在内存里的行数', setStep('scroll', ''))
        + setRow('外部终端', '「在外部终端打开」用哪个', setSeg('ext', [['wt', 'Windows Terminal'], ['ps', 'PowerShell']])))}
      ${setTile('Power' in PH ? 'Power' : 'X', '退出', setRow('退出时停止受控进程', '只停本应用启动的进程', setSw('killOnQuit', '退出时停止受控进程'))
        + setRow('关闭窗口时收起到托盘', '', setSw('tray', '关闭窗口时收起到托盘')))}
      ${setTile('Bell', '通知', setRow('启动失败时提醒', '失败通知条常驻，直到你关掉', setSw('notifyFail', '启动失败时提醒'))
        + setRow('任务完成时提醒', '', setSw('notifyDone', '任务完成时提醒')))}
    </div></div>`
}

/* ── 关于 ───────────────────────────────────────────── */
function pageAbout() {
  return `<div class="page">
    <header class="view-head"><div><h1 class="display">关于</h1><p>版本信息与使用教程</p></div></header>
    <div class="bento">
      <section class="tile span-2 row-2 about-brand"><span class="brand-mark">M</span><h2 class="display">Mile Terminal</h2>
        <p style="color:var(--ink-muted)">把「本机现在跑着什么」和「我常跑的那几个项目」收进一个界面。</p></section>
      <section class="tile span-2"><div class="tile-head">${ic('Info', false, 'lg')}<h2>版本</h2></div>
        <div class="tile-body"><dl class="kv"><dt>应用</dt><dd class="mono">1.8.0（原型）</dd><dt>Electron</dt><dd class="mono">43.4.0</dd><dt>配置文件</dt><dd class="mono">%APPDATA%/mile-terminal/config.json</dd></dl></div></section>
      <section class="tile span-2"><div class="tile-head">${ic('Keyboard', false, 'lg')}<h2>快捷键</h2></div>
        <div class="tile-body"><p style="color:var(--ink-muted);margin-bottom:10px">列表、详情、页面都能用键盘操作</p><button class="btn secondary" data-act="keys">${ic('Keyboard')}查看快捷键（?）</button></div></section>
      <section class="tile span-4"><div class="tile-head">${ic('Lightning', false, 'lg')}<h2>三步上手</h2></div>
        <div class="tile-body"><ol style="padding-left:20px;display:grid;gap:6px;color:var(--ink)">
          <li>在「服务」页点「添加服务」，选项目目录，识别后确认。</li>
          <li>把同一个项目的前端和后端放进一个工作组。</li>
          <li>以后打开应用，点工作组的「全部启动」。出问题看通知条，或去「总览」查端口。</li></ol></div></section>
    </div></div>`
}

/* ── 主区域渲染：保留滚动、焦点与光标 ──────────────── */
const PAGE_FN = { services: pageServices, overview: pageOverview, terminal: pageTerminal, settings: pageSettings, about: pageAbout }
function renderMain() {
  const main = $('#main')
  const keep = {}
  ;['#svc-list', '#detail-body'].forEach((k) => { const el = $(k); if (el) keep[k] = el.scrollTop })
  const detailKey = S.sel + ':' + S.tab
  const mainTop = main.scrollTop
  const a = document.activeElement
  const fk = a && a.dataset && a.dataset.fk
  let caret = null
  try { caret = fk ? [a.selectionStart, a.selectionEnd] : null } catch { caret = null }
  const shellVal = $('#sh-in') ? $('#sh-in').value : ''

  const flush = S.page === 'terminal' || (S.page === 'services' && S.sel)
  main.classList.toggle('flush', !!flush)
  main.innerHTML = PAGE_FN[S.page]()

  if (!flush) main.scrollTop = S._lastPage === S.page ? mainTop : 0
  S._lastPage = S.page
  if (keep['#svc-list'] != null && $('#svc-list')) $('#svc-list').scrollTop = keep['#svc-list']
  if (keep['#detail-body'] != null && $('#detail-body') && S._detailKey === detailKey) $('#detail-body').scrollTop = keep['#detail-body']
  S._detailKey = detailKey
  if ($('#sh-in')) $('#sh-in').value = shellVal
  if (fk) {
    const el = $(`[data-fk="${fk}"]`)
    if (el && !el.disabled) { el.focus(); if (caret && caret[0] != null) try { el.setSelectionRange(caret[0], caret[1]) } catch { /* number / select */ } }
  }
  S.fresh = false
  afterMain()
}

function afterMain() {
  $$('.rows').forEach((rows) => {
    const ind = $('.row-indicator', rows)
    const r = $('.row[aria-selected="true"]', rows)
    if (!ind || !r) return
    slide(ind, 'row:' + rows.dataset.gid, { y: r.offsetTop + (r.offsetHeight - 24) / 2 })
  })
  const tabs = $('.tabs')
  if (tabs) {
    const t = $('.tab[aria-selected="true"]', tabs)
    const key = 'tab:' + S.sel
    if (t) slide($('.tab-ink', tabs), key, { x: t.offsetLeft, w: t.offsetWidth })
  }
  $$('.term').forEach((t) => { t.scrollTop = t.scrollHeight })
}
