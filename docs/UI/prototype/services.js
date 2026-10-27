/* 服务页：工作组磁贴 + 详情分栏（概览 / 输出 / 诊断 / 构建 / 配置） */
'use strict'
const isLive = (id) => ['running', 'starting', 'stopping'].includes(RT[id].status)
const svc = (id) => SVC.find((s) => s.id === id)
const grp = (id) => GROUPS.find((g) => g.id === id)

function counts() {
  const c = { all: SVC.length, fe: 0, be: 0, task: 0 }
  SVC.forEach((s) => c[s.kind]++)
  return c
}
function matches(s) {
  if (S.kind !== 'all' && s.kind !== S.kind) return false
  const q = S.q.trim().toLowerCase()
  return !q || [s.name, s.id, s.path, s.port].some((v) => String(v ?? '').toLowerCase().includes(q))
}
function sections() {
  const filtering = S.kind !== 'all' || S.q.trim()
  const list = GROUPS.map((g) => ({ g, items: SVC.filter((s) => s.group === g.id && matches(s)) }))
  list.push({ g: { id: '_none', name: '未分组', env: null }, items: SVC.filter((s) => !s.group && matches(s)) })
  return list.filter((x) => x.items.length || (!filtering && x.g.id !== '_none'))
}

function pageServices() {
  const c = counts()
  const secs = sections()
  const open = !!S.sel
  const kinds = [['all', '全部'], ['fe', '前端'], ['be', '后端'], ['task', '任务']]
  return `<div class="page">
    <div class="view-head"><div><h1 class="display">服务</h1><p>按工作组启停你的前端、后端与任务</p></div>
      <div class="actions"><button class="btn secondary" data-act="newGroup">${ic('Folders')}新建工作组</button><button class="btn primary" data-act="addSvc">${ic('Plus')}添加服务</button></div></div>
    <div class="toolbar">
      <div class="seg" role="group" aria-label="类型">${kinds.map(([k, l]) => `<button aria-pressed="${S.kind === k}" data-act="kind" data-arg="${k}">${l}<span class="count num">${c[k]}</span></button>`).join('')}</div>
      <div class="search-box">${ic('MagnifyingGlass')}<input class="input" id="svc-q" data-fk="svc-q" placeholder="名称、端口或路径" value="${esc(S.q)}" aria-label="搜索服务"></div>
    </div>
    <div class="svc-split ${open ? 'open' : ''}">
      <div class="svc-list" id="svc-list" ${open ? `style="width:${S.listW}px"` : ''}>
        ${secs.length ? secs.map((x) => groupTile(x.g, x.items)).join('') : `<div class="tile empty" style="grid-column:1/-1"><span class="ico">${ic('MagnifyingGlass', false, 'lg')}</span><b>没有匹配的服务</b><span>换个关键字，或切回「全部」</span><button class="btn secondary" data-act="clearQ">清除搜索</button></div>`}
      </div>
      ${open ? `<div class="resizer" id="resizer" role="separator" aria-orientation="vertical" aria-label="调整列表宽度" aria-valuenow="${S.listW}" tabindex="0"></div>${detail()}` : ''}
    </div></div>`
}

function groupTile(g, items) {
  const real = g.id !== '_none'
  const all = real ? SVC.filter((s) => s.group === g.id) : items
  const startable = all.filter((s) => s.kind !== 'task' && !s.registerOnly)
  const live = startable.filter((s) => RT[s.id].status === 'running').length
  const fault = all.some((s) => RT[s.id].status === 'failed')
  const tone = fault ? 'tone-fault' : startable.length && live === startable.length ? 'tone-live' : ''
  const compact = !!S.sel
  const allOn = startable.length && live === startable.length
  const gBtn = !real || !startable.length ? '' : allOn
    ? `<button class="btn secondary sm" data-act="groupStop" data-arg="${g.id}" ${compact ? 'aria-label="全部停止" title="全部停止"' : ''}>${ic('Stop')}${compact ? '' : '全部停止'}</button>`
    : `<button class="btn ${compact ? 'secondary' : 'primary'} sm" data-act="groupStart" data-arg="${g.id}" ${compact ? 'aria-label="全部启动" title="全部启动"' : ''}>${ic('Play')}${compact ? '' : '全部启动'}</button>`
  return `<section class="tile group-tile ${tone}" aria-label="${esc(g.name)}">
    <div class="tile-head ${S.cursor === 'g:' + g.id ? 'cursor' : ''}" data-gid="${g.id}">
      ${ic(real ? 'Folders' : 'Stack', false, 'lg')}<h2 style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(g.name)}</h2>
      ${real ? envBadge(g.env) : ''}
      ${startable.length ? `<span class="count num">${live}/${startable.length} 运行中</span>` : ''}
      <div class="right">${gBtn}${real ? `<button class="iconbtn" data-act="menu" data-arg="grp:${g.id}" aria-label="${esc(g.name)} 更多操作" title="更多">${ic('DotsThree')}</button>` : ''}</div>
    </div>
    <div class="rows" role="listbox" data-gid="${g.id}" aria-label="${esc(g.name)} 成员">
      ${items.some((s) => s.id === S.sel) ? '<span class="row-indicator" style="top:0"></span>' : ''}
      ${items.length ? items.map(row).join('') : `<p style="padding:8px 12px;color:var(--ink-faint)">这个组还没有成员，在「⋯」菜单里添加服务</p>`}
    </div></section>`
}
function envBadge(env) {
  if (!env) return ''
  return `<span class="env ${env}">${env === 'prod' ? ic('Warning') : ''}${env}</span>`
}
function row(s) {
  const st = ST[RT[s.id].status]
  const sub = s.kind === 'task' ? `任务 · ${s.script}` : FW[s.fw].n
  return `<div class="row ${S.cursor === s.id ? 'cursor' : ''}" role="option" aria-selected="${S.sel === s.id}" data-act="select" data-arg="${s.id}" data-sid="${s.id}">
    <span class="dot ${st.d} ${S.flash === s.id ? 'flash' : ''}" title="${st.l}"></span>${glyph(s)}
    <span class="name">${esc(s.name)}<small>${esc(sub)}</small></span>
    <span class="port mono num">${s.port ? ':' + s.port : ''}</span>
    ${toggle(s)}
    <button class="iconbtn" data-act="menu" data-arg="svc:${s.id}" aria-label="${esc(s.name)} 更多操作" title="更多">${ic('DotsThree')}</button></div>`
}
function toggle(s, primary = false) {
  const st = RT[s.id].status
  if (s.registerOnly) return primary ? '' : '<span class="pill idle">仅登记</span>'
  const cls = primary ? 'primary' : 'secondary'
  const fail = S.flash === s.id ? 'failed' : ''
  if (s.kind === 'task') {
    return st === 'starting' ? `<button class="btn ${cls} sm" disabled>${ic('Clock')}运行中</button>`
      : `<button class="btn ${cls} sm ${fail}" data-act="start" data-arg="${s.id}">${ic('Play')}运行</button>`
  }
  if (st === 'running') return `<button class="btn secondary sm" data-act="stop" data-arg="${s.id}">${ic('Stop')}停止</button>`
  if (st === 'starting' || st === 'stopping') return `<button class="btn secondary sm" disabled>${ic('Clock')}${ST[st].l}</button>`
  return `<button class="btn ${cls} sm ${fail}" data-act="start" data-arg="${s.id}">${ic('Play')}${fail ? '启动失败' : st === 'failed' ? '重试' : '启动'}</button>`
}
function glyph(s, big = false) {
  const f = FW[s.fw]
  return `<span class="glyph" style="background:${f.c};${big ? 'width:40px;height:40px;border-radius:12px;font-size:15px' : ''}" aria-hidden="true">${f.t}</span>`
}

/* ── 详情面板 ───────────────────────────────────────── */
function tabsOf(s) {
  const t = [['overview', '概览', 'Gauge'], ['output', '输出', 'TerminalWindow'], ['diagnose', '诊断', 'Stethoscope']]
  if (s.java) t.push(['build', '构建', 'Hammer'])
  t.push(['config', '配置', 'SlidersHorizontal'])
  return t
}
const effTab = (s) => (S.tab === 'build' && !s.java ? 'overview' : S.tab)

function detail() {
  const s = svc(S.sel)
  if (!s) return ''
  const rt = RT[s.id]
  const st = ST[rt.status]
  const g = grp(s.group)
  const tab = effTab(s)
  const bad = diagnose(s).filter((c) => c.tone === 'fail').length
  const maxStyle = S.max ? `style="left:${(S.navCollapsed ? 56 : 184) + 16}px"` : ''
  return `<section class="tile detail ${S.fresh ? 'enter' : ''} ${S.max ? 'max' : ''}" ${maxStyle} aria-label="${esc(s.name)} 详情">
    <div class="detail-head">${glyph(s, true)}
      <div style="min-width:0"><h2 style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.name)}</h2>
        <div class="meta"><span class="pill ${st.p}"><span class="dot ${st.d}"></span>${st.l}</span>${s.registerOnly ? '<span class="pill idle">仅登记</span>' : ''}
          ${s.port ? `<span class="mono num">:${s.port}</span>` : ''}${g ? `<span>${esc(g.name)}</span>${envBadge(g.env)}` : ''}</div></div>
      <div class="right">${toggle(s, true)}
        <button class="iconbtn" data-act="max" aria-label="${S.max ? '还原分栏' : '最大化'}" title="${S.max ? '还原（Esc）' : '最大化'}">${ic(S.max ? 'ArrowsIn' : 'ArrowsOut')}</button>
        <button class="iconbtn" data-act="closeDetail" aria-label="关闭详情" title="关闭（Esc）">${ic('X')}</button></div></div>
    <div class="tabs" role="tablist"><span class="tab-ink" style="left:0"></span>
      ${tabsOf(s).map(([id, l, i]) => `<button class="tab" role="tab" aria-selected="${tab === id}" data-act="tab" data-arg="${id}">${ic(i, tab === id)}${l}${id === 'diagnose' && bad ? `<span class="pill fault" style="height:18px;padding:0 6px">${bad}</span>` : ''}</button>`).join('')}</div>
    <div class="detail-body" id="detail-body">${TABS[tab](s)}</div>
    ${tab === 'config' && dirty(s) ? savebar() : ''}
  </section>`
}

function tabOverview(s) {
  const rt = RT[s.id]
  let mini
  if (s.kind === 'task') {
    const runs = rt.runs
    const last = runs[0]
    const ok = runs.filter((r) => r.ok).length
    mini = [['上次运行', last ? (last.ok ? '成功' : '失败') : '—'], ['平均耗时', runs.length ? Math.round(runs.reduce((a, r) => a + r.ms, 0) / runs.length / 1000) + ' 秒' : '—'], ['成功率', runs.length ? `${ok}/${runs.length}` : '—']]
      .map(([k, v]) => `<div class="mini"><div class="k">${k}</div><div class="v display num">${v}</div></div>`).join('')
  } else {
    const up = rt.status === 'running' ? fmtDur(now() - rt.since) : '—'
    const cpu = rt.status === 'running' ? rt.cpu[rt.cpu.length - 1] : null
    mini = `<div class="mini"><div class="k">运行时长</div><div class="v display num" data-up="${s.id}">${up}</div></div>
      <div class="mini"><div class="k">CPU</div><div class="v display num" data-cpu="${s.id}">${cpu == null ? '—' : cpu.toFixed(1) + '%'}</div>${cpu == null ? '' : `<div data-spark="${s.id}">${spark(rt.cpu)}</div>`}</div>
      <div class="mini"><div class="k">内存</div><div class="v display num">${rt.status === 'running' ? rt.mem + ' MB' : '—'}</div></div>`
  }
  const cmd = s.java ? `mvn spring-boot:run -P ${S.profile[s.id] || 'dev'}` : s.script ? `npm run ${s.script}` : '未识别启动方式'
  return `<div class="mini-grid">${mini}</div>
    <dl class="kv">
      <dt>状态</dt><dd><span class="pill ${ST[rt.status].p}">${ST[rt.status].l}</span></dd>
      <dt>PID</dt><dd class="mono num">${rt.pid ?? '—'}</dd>
      <dt>工作组</dt><dd>${s.group ? esc(grp(s.group).name) : '未分组'}</dd>
      <dt>项目路径</dt><dd><span class="mono" title="${esc(s.path)}">${esc(s.path)}</span><button class="iconbtn" data-act="copy" data-arg="${esc(s.path)}" aria-label="复制路径" title="复制">${ic('Copy')}</button></dd>
      <dt>启动命令</dt><dd><span class="mono">${esc(cmd)}</span></dd>
      <dt>上次退出</dt><dd>${esc(rt.exit || '—')}</dd>
    </dl>
    <div style="display:flex;gap:8px;margin-top:16px">
      <button class="btn secondary sm" data-act="toast" data-arg="已在资源管理器打开 ${esc(s.path)}">${ic('FolderOpen')}打开目录</button>
      <button class="btn secondary sm" data-act="tab" data-arg="output">${ic('TerminalWindow')}查看输出</button></div>`
}

function termHTML(lines) {
  return lines.map((l) => l.c === 'sep' ? `<span class="sep">${esc(l.t)}</span>` : `<div class="${l.c || ''}">${esc(l.t)}</div>`).join('')
}
function tabOutput(s) {
  const lines = RT[s.id].lines
  return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <span style="color:var(--ink-muted)">停止后保留上一次运行的输出，新一次运行用分隔线隔开</span>
      <div style="margin-left:auto;display:flex;gap:6px">
        <button class="btn ghost sm" data-act="termOf" data-arg="${s.id}">${ic('ArrowSquareOut')}在终端页查看</button>
        <button class="btn ghost sm" data-act="clearOut" data-arg="${s.id}">${ic('Broom')}清空</button></div></div>
    <div class="term" style="${S.max ? 'min-height:calc(100vh - 290px)' : ''};font-size:${S.set.font - 0.5}px">${lines.length ? termHTML(lines) : '<div class="dim">还没有输出。启动后这里显示实时日志。</div>'}</div>`
}

/* 端口外部占用：只展示，不提供结束外部进程 —— 安全红线 2 */
const EXT = [
  { port: 3306, proc: 'mysqld.exe', pid: 4120, mem: 412 },
  { port: 6379, proc: 'redis-server.exe', pid: 5532, mem: 38 },
  { port: 8090, proc: 'java.exe', pid: 9917, mem: 640, note: '另一个 IDEA 里跑着的服务' }
]
function diagnose(s) {
  const out = [{ tone: 'ok', t: '项目目录存在', d: s.path }]
  if (s.registerOnly) {
    out.push({ tone: 'info', t: '仅登记，不可启动', d: `识别为 ${FW[s.fw].n}，推不出「包管理器 run 脚本」形状的启动命令，所以只登记、可监控。` })
    return out
  }
  out.push(s.java ? { tone: 'ok', t: '识别到 Maven 项目', d: 'pom.xml 含 spring-boot-maven-plugin' } : { tone: 'ok', t: `脚本「${s.script}」存在`, d: 'package.json 的 scripts 里有这个键' })
  if (s.missingDeps) out.push({ tone: 'fail', t: '缺少 node_modules', d: '不会自动安装依赖。可以创建一个安装会话，命令由你在终端里确认执行。', fix: ['install', '创建安装会话'] })
  if (s.port) {
    const occ = RT[s.id].status !== 'running' && EXT.find((e) => e.port === s.port)
    if (occ) out.push({ tone: 'fail', t: `端口 ${s.port} 被外部进程占用`, d: `${occ.proc}（PID ${occ.pid}）不是本应用启动的，不会替你结束它。改端口或先关掉那个进程。`, fix: ['cfgPort', '改端口'], fix2: ['seePort', '在总览查看', s.port] })
    else out.push({ tone: 'ok', t: `端口 ${s.port} ${RT[s.id].status === 'running' ? '由本服务监听' : '空闲'}`, d: '启动前会再检查一次' })
  }
  if (s.env.length) out.push({ tone: 'info', t: `环境变量 ${s.env.length} 个`, d: '只显示键名：' + s.env.join('、') })
  return out
}
function tabDiagnose(s) {
  const list = diagnose(s)
  const bad = list.filter((c) => c.tone === 'fail').length
  const ico = { ok: 'CheckCircle', fail: 'WarningCircle', info: 'Info' }
  return `<p style="margin-bottom:12px;color:var(--ink-muted)">${bad ? `有 ${bad} 项需要处理，处理前启动会被拦下` : '启动前检查全部通过'}</p>
    ${list.map((c) => `<div class="check ${c.tone}"><span class="ico">${ic(ico[c.tone])}</span>
      <div style="min-width:0"><div class="t">${esc(c.t)}</div><div class="d">${esc(c.d)}</div></div>
      ${c.fix ? `<div class="act" style="display:flex;gap:6px">${c.fix2 ? `<button class="btn ghost sm" data-act="${c.fix2[0]}" data-arg="${c.fix2[2]}">${c.fix2[1]}</button>` : ''}<button class="btn secondary sm" data-act="${c.fix[0]}" data-arg="${s.id}">${c.fix[1]}</button></div>` : ''}</div>`).join('')}`
}

const GOALS = [['clean', '清理产物'], ['compile', '编译'], ['test', '运行测试'], ['package', '打包 jar'], ['verify', '集成校验'], ['install', '装到本地仓库']]
function tabBuild(s) {
  const busy = S.build[s.id]
  const prof = S.profile[s.id] || 'dev'
  const art = S.artifact[s.id]
  return `<div class="sec-label" style="margin-top:0">Profile</div>
    <div class="seg" role="group" aria-label="Profile">${['dev', 'test', 'prod'].map((p) => `<button aria-pressed="${prof === p}" data-act="profile" data-arg="${s.id}:${p}">${p}</button>`).join('')}</div>
    <div class="sec-label">Maven 目标</div>
    <div class="goals">${GOALS.map(([g, d]) => `<button class="goal" data-act="goal" data-arg="${s.id}:${g}" ${busy ? 'disabled' : ''}><b>${busy === g ? '执行中…' : g}</b><span>${d}</span></button>`).join('')}</div>
    <div class="sec-label">产物</div>
    <dl class="kv"><dt>jar</dt><dd>${art ? `<span class="mono">${esc(art)}</span><button class="iconbtn" data-act="toast" data-arg="已打开产物目录" aria-label="打开产物目录" title="打开产物目录">${ic('FolderOpen')}</button>` : '<span style="color:var(--ink-faint)">还没打过包，运行 package 后出现</span>'}</dd></dl>`
}

/* ── 配置：直接编辑，常用 / 高级 ────────────────────── */
const LOCKED = ['kind', 'path', 'script', 'port', 'subdir', 'env']
const base = (s, k) => ({ name: s.name, kind: s.kind, port: s.port ?? '', script: s.script, subdir: s.subdir || '', outDir: s.outDir || (s.java ? 'target' : 'dist'), icon: s.icon || 'auto' }[k])
const val = (s, k) => (S.drafts[s.id] && k in S.drafts[s.id] ? S.drafts[s.id][k] : base(s, k))
const dirty = (s) => !!S.drafts[s.id] && Object.keys(S.drafts[s.id]).some((k) => String(S.drafts[s.id][k]) !== String(base(s, k)))

function field(s, k, label, input, full = false) {
  const lock = LOCKED.includes(k) && isLive(s.id)
  return `<div class="field ${full ? 'full' : ''}"><label for="f-${k}">${label}${lock ? `<span class="lock">${ic('Lock')}停止后可改</span>` : ''}</label>${input(lock)}</div>`
}
const inp = (s, k, type = 'text') => (lock) => `<input class="input ${type === 'number' ? 'mono' : ''}" id="f-${k}" data-fk="f-${k}" data-cfg="${k}" type="${type}" value="${esc(val(s, k))}" ${lock ? 'disabled' : ''}>`
function tabConfig(s) {
  const kindSel = (lock) => `<select class="input" id="f-kind" data-fk="f-kind" data-cfg="kind" ${lock ? 'disabled' : ''}>${[['fe', '前端'], ['be', '后端'], ['task', '任务']].map(([v, l]) => `<option value="${v}" ${val(s, 'kind') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`
  const scriptSel = (lock) => s.java ? `<input class="input mono" id="f-script" value="mvn spring-boot:run" disabled>`
    : `<select class="input mono" id="f-script" data-fk="f-script" data-cfg="script" ${lock ? 'disabled' : ''}><option value="">仅登记（不启动）</option>${s.scripts.map((x) => `<option ${val(s, 'script') === x ? 'selected' : ''}>${x}</option>`).join('')}</select>`
  const envRows = (lock) => (s.env.length ? s.env : ['']).map((k) => `<div style="display:flex;gap:6px;margin-top:6px"><input class="input mono" value="${esc(k)}" placeholder="键名" aria-label="键名" ${lock ? 'disabled' : ''}><input class="input mono" type="password" placeholder="${k ? '已设置，不显示' : '值'}" aria-label="值" ${lock ? 'disabled' : ''}></div>`).join('')
  return `<div class="form-sec"><div class="sec-t">常用</div>
      <div class="fields">${field(s, 'name', '名称', inp(s, 'name'))}${field(s, 'kind', '分类', kindSel)}${field(s, 'port', '预期端口', inp(s, 'port', 'number'))}${field(s, 'script', '启动方式', scriptSel)}</div></div>
    <details class="form-sec" id="adv" ${S.advOpen ? 'open' : ''}><summary>${ic('CaretRight')}高级</summary>
      <div class="fields">${field(s, 'subdir', '子目录（monorepo 子包）', inp(s, 'subdir'))}${field(s, 'outDir', '产物目录', inp(s, 'outDir'))}
        ${field(s, 'env', '环境变量（值不回显）', envRows, true)}
        ${field(s, 'icon', '卡片图标', () => `<div class="seg" role="group" aria-label="卡片图标">${[['auto', '框架图标'], ['custom', '自定义图片']].map(([v, l]) => `<button aria-pressed="${val(s, 'icon') === v}" data-act="cfgIcon" data-arg="${v}">${l}</button>`).join('')}</div>`, true)}</div></details>`
}
function savebar() {
  return `<div class="savebar"><span class="msg">有未保存的改动</span><div style="margin-left:auto;display:flex;gap:8px">
    <button class="btn ghost sm" data-act="discard">放弃</button><button class="btn primary sm" data-act="save">保存</button></div></div>`
}
function saveCfg() {
  const s = svc(S.sel)
  const d = S.drafts[s.id] || {}
  const port = d.port === undefined ? s.port : d.port === '' ? null : Number(d.port)
  if (port !== null && !(Number.isInteger(port) && port >= 1 && port <= 65535)) return toast('fault', '端口不合法', '请填 1 到 65535 之间的整数')
  if ('name' in d && !String(d.name).trim()) return toast('fault', '名称不能为空', '')
  Object.assign(s, { name: String(d.name ?? s.name).trim(), kind: d.kind ?? s.kind, script: d.script ?? s.script, subdir: d.subdir ?? s.subdir, outDir: d.outDir ?? s.outDir, icon: d.icon ?? s.icon, port })
  delete S.drafts[s.id]
  toast('live', '配置已保存', s.name)
  renderMain()
}
async function guard() {
  const s = S.sel && svc(S.sel)
  if (!s || !dirty(s)) return true
  const ok = await confirmDlg({ title: '放弃未保存的改动？', body: `「${s.name}」的配置改了还没保存。离开后这些改动会丢失。`, ok: '放弃改动', danger: true })
  if (ok) delete S.drafts[s.id]
  return ok
}
