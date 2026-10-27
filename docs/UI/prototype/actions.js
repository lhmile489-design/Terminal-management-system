/* 原型行为：启停模拟、导航、键盘、点击分发、计时器、种子数据与启动 */
'use strict'

function pushLine(id, c, t) { RT[id].lines.push({ c, t, ts: now() }); if (RT[id].lines.length > 300) RT[id].lines.shift() }
function refresh() { renderMain() }
function flashFail(id) {
  S.flash = id; refresh()
  setTimeout(() => { if (S.flash === id) { S.flash = null; refresh() } }, 700)
}

/* ── 启停模拟 ───────────────────────────────────────── */
async function start(id, opts = {}) {
  const s = svc(id)
  if (!s || s.registerOnly || isLive(id)) return false
  const g = grp(s.group)
  if (!opts.bulk && g && g.env === 'prod') {
    const ok = await confirmDlg({ title: `在 prod 环境启动「${s.name}」？`, body: '这个工作组标记为生产环境，启动后可能影响真实业务数据。', ok: '仍然启动', danger: true })
    if (!ok) return false
  }
  return run(s, opts)
}
function run(s, opts) {
  const rt = RT[s.id]
  if (rt.lines.length) rt.lines.push({ c: 'sep', t: `── 新一次运行 · ${fmtClock(now())} ──`, ts: now() })
  pushLine(s.id, 'dim', s.java ? `> mvn spring-boot:run -P ${S.profile[s.id] || 'dev'}` : `> npm run ${s.script}`)
  rt.status = 'starting'; rt.exit = null; refresh()
  return new Promise((done) => setTimeout(() => {
    const bad = diagnose(s).find((c) => c.tone === 'fail')
    if (bad) {
      pushLine(s.id, 'err', `启动前检查未通过：${bad.t}`)
      pushLine(s.id, 'err', '进程没有启动')
      rt.status = 'failed'; rt.exit = bad.t
      flashFail(s.id)
      addEvent('fault', `${s.name} 启动失败`, bad.t)
      if (!opts.bulk) toast('fault', `${s.name} 启动失败`, bad.t, { l: '查看输出', run: () => openSvc(s.id + ':output') })
      return done(false)
    }
    if (s.kind === 'task') {
      taskLines(s).forEach((l) => pushLine(s.id, l[0], l[1]))
      const ms = 2000 + Math.round(Math.random() * 6000)
      rt.status = 'idle'; rt.exit = '退出码 0'
      rt.runs.unshift({ ok: true, ms, at: now() }); rt.runs.length = Math.min(rt.runs.length, 10)
      addEvent('live', `${s.name} 运行完成`, '退出码 0')
      if (!opts.bulk && S.set.notifyDone) toast('live', `${s.name} 运行完成`, `耗时 ${Math.round(ms / 1000)} 秒`)
    } else {
      bootLines(s).forEach((l) => pushLine(s.id, l[0], l[1]))
      rt.status = 'running'; rt.pid = 10000 + Math.floor(Math.random() * 50000); rt.since = now()
      rt.cpu = Array.from({ length: 12 }, () => 2 + Math.random() * 6); rt.mem = 120 + Math.round(Math.random() * 300)
      addEvent('live', `${s.name} 已启动`, s.port ? `监听 :${s.port}` : '')
      if (!opts.bulk) toast('live', `${s.name} 已启动`, s.port ? `http://localhost:${s.port}` : '')
    }
    refresh(); done(true)
  }, 700 + Math.random() * 600))
}
function bootLines(s) {
  if (s.java) return [['dim', '[INFO] Scanning for projects...'], ['', '  .   ____          _'], ['', ':: Spring Boot ::                (v3.3.4)'], ['ok', `Tomcat started on port ${s.port} (http)`], ['ok', `Started Application in ${(3 + Math.random() * 4).toFixed(2)} seconds`]]
  if (s.fw === 'next') return [['', '▲ Next.js 15.0.3'], ['', `- Local: http://localhost:${s.port}`], ['ok', `✓ Ready in ${(1 + Math.random() * 2).toFixed(1)}s`]]
  return [['', 'VITE v7.3.6  ready in ' + (300 + Math.round(Math.random() * 600)) + ' ms'], ['ok', `➜  Local:   http://localhost:${s.port}/`], ['dim', '➜  Network: use --host to expose']]
}
function taskLines(s) {
  return s.script === 'clean' ? [['', '删除 dist/、.cache/'], ['ok', '已清理 214 MB']] : [['', 'Creating an optimized production build...'], ['ok', '✓ Compiled successfully'], ['ok', '产物写入 out/']]
}
function stop(id, forced = false) {
  const s = svc(id), rt = RT[id]
  if (!s || rt.status !== 'running') return Promise.resolve()
  rt.status = 'stopping'; refresh()
  return new Promise((done) => setTimeout(() => {
    rt.status = 'idle'; rt.pid = null; rt.since = null; rt.cpu = []
    rt.exit = forced ? '强制结束（退出码 1）' : '手动停止'
    pushLine(id, 'dim', forced ? `进程树已强制结束 · ${fmtClock(now())}` : `已停止 · ${fmtClock(now())}`)
    addEvent('idle', `${s.name} 已停止`, rt.exit)
    refresh(); done()
  }, 500))
}
async function kill(id) {
  const s = svc(id)
  const ok = await confirmDlg({ title: `强制关闭「${s.name}」？`, body: '会直接结束它的整个进程树，未保存的数据可能丢失。只对本应用启动的进程生效。', ok: '强制关闭', danger: true })
  if (ok) stop(id, true)
}
async function restart(id) { await stop(id); return start(id) }

async function groupStart(gid) {
  const g = grp(gid)
  const todo = SVC.filter((s) => s.group === gid && s.kind !== 'task' && !s.registerOnly && !isLive(s.id))
  if (!todo.length) { toast('info', `${g.name} 已全部运行`); return }
  if (g.env === 'prod') {
    const ok = await confirmDlg({ title: `在 prod 环境启动「${g.name}」？`, body: `将启动 ${todo.map((s) => s.name).join('、')}。这个工作组标记为生产环境，可能影响真实业务数据。`, ok: '全部启动', danger: true })
    if (!ok) return
  }
  const res = await Promise.all(todo.map((s) => run(s, { bulk: true })))
  const okN = res.filter(Boolean).length, bad = todo.filter((_, i) => !res[i])
  if (bad.length) toast('fault', `${g.name}：${okN} 个已启动，${bad.length} 个失败`, bad.map((s) => s.name).join('、'), { l: '查看输出', run: () => openSvc(bad[0].id + ':output') })
  else toast('live', `${g.name}：${okN} 个已启动`)
}
async function groupStop(gid) {
  const g = grp(gid)
  const live = SVC.filter((s) => s.group === gid && RT[s.id].status === 'running')
  await Promise.all(live.map((s) => stop(s.id)))
  if (live.length) toast('idle', `${g.name}：${live.length} 个已停止`)
}
async function removeSvc(id) {
  const s = svc(id)
  if (isLive(id)) { toast('fault', '运行中不能移除', '先停止再移除'); return }
  const ok = await confirmDlg({ title: `移除「${s.name}」？`, body: '只移除登记，不会删除项目目录里的任何文件。', ok: '移除', danger: true })
  if (!ok) return
  SVC.splice(SVC.indexOf(s), 1)
  if (S.sel === id) { S.sel = null; S.max = false }
  toast('info', `已移除「${s.name}」`); refresh()
}
async function removeGroup(gid) {
  const g = grp(gid)
  const ok = await confirmDlg({ title: `删除工作组「${g.name}」？`, body: '组内的服务不会被删除，会移到「未分组」。', ok: '删除工作组', danger: true })
  if (!ok) return
  GROUPS.splice(GROUPS.indexOf(g), 1)
  SVC.forEach((s) => { if (s.group === gid) s.group = null })
  toast('info', `已删除工作组「${g.name}」`); refresh()
}
function setEnv(gid, env) { grp(gid).env = env; toast('info', `${grp(gid).name} 切到 ${env}`, env === 'prod' ? '之后启动前都会先确认' : ''); refresh() }
function addSvc(gid) { toast('info', '添加服务', `真实应用里是分步对话框：选目录 → 识别 → 确认${gid ? '，并自动归入这个组' : ''}。原型省略。`) }
function newGroup() { toast('info', '新建工作组', '真实应用里是一个小对话框：名称、描述、环境。原型省略。') }

/* ── 导航与选中 ─────────────────────────────────────── */
async function go(p) {
  if (S.page === p) return
  if (S.page === 'services' && !(await guard())) return
  closeMenu(); S.page = p; S.cursor = null
  renderNav(); renderMain()
}
async function selectSvc(id) {
  if (S.sel === id) return
  if (!(await guard())) return
  S.fresh = !S.sel; S.sel = id; S.cursor = id
  renderMain()
}
async function openSvc(arg) {
  const [id, tab] = arg.split(':')
  if (!svc(id)) return
  if (S.page !== 'services') { await go('services'); if (S.page !== 'services') return }
  if (S.sel !== id && !(await guard())) return
  if (!matches(svc(id))) { S.q = ''; S.kind = 'all' }
  if (!S.sel) S.fresh = true
  S.sel = id; S.cursor = id
  if (tab) S.tab = tab
  renderMain()
}
async function closeDetail() {
  if (!(await guard())) return
  S.sel = null; S.max = false; renderMain()
}

/* ── 其余动作 ───────────────────────────────────────── */
function copyText(t, btn) {
  try { navigator.clipboard.writeText(t) } catch { /* file:// 下可能不可用 */ }
  if (btn) {
    const old = btn.innerHTML
    btn.innerHTML = ic('Check'); btn.style.color = 'var(--live)'
    setTimeout(() => { btn.innerHTML = old; btn.style.color = '' }, 1200)
  } else toast('live', '已复制', t)
}
let shellN = 1
function newShell(cwd = 'E:/Work', name) {
  shellN++
  const h = { id: 'sh' + shellN, name: name || 'PowerShell ' + shellN, cwd, lines: [{ c: 'dim', t: 'Windows PowerShell' }] }
  SHELLS.push(h)
  S.term = h.id; S.termTab = 'term'
  return h
}
async function install(id) {
  const s = svc(id)
  const h = newShell(s.path, '安装 · ' + s.name)
  h.lines.push({ c: 'dim', t: '命令已填好，按 Enter 确认执行。应用不会替你自动安装。' })
  h.pending = { id, cmd: 'npm install' }
  if (S.page !== 'terminal') await go('terminal'); else renderMain()
  const el = $('#sh-in'); if (el) { el.value = 'npm install'; el.focus() }
}
function shellExec(h, cmd) {
  h.lines.push({ t: `PS ${h.cwd}> ${cmd}` })
  if (/^(clear|cls)$/i.test(cmd)) h.lines = []
  else if (/^npm (i|install)$/i.test(cmd) && h.pending) {
    const s = svc(h.pending.id)
    h.lines.push({ t: 'added 412 packages in 18s' }, { c: 'ok', t: '依赖安装完成' })
    s.missingDeps = false; h.pending = null
    addEvent('live', `${s.name} 依赖已安装`, '诊断已通过')
    toast('live', `${s.name} 依赖已安装`, '现在可以启动了', { l: '回到服务', run: () => openSvc(s.id + ':diagnose') })
  } else if (cmd) h.lines.push({ c: 'dim', t: '（原型不会真正执行命令）' })
  renderMain()
  const el = $('#sh-in'); if (el) { el.value = ''; el.focus() }
}
function closeShell(id) {
  SHELLS = SHELLS.filter((h) => h.id !== id)
  S.term = SHELLS[0] ? SHELLS[0].id : (SVC.find((s) => RT[s.id].lines.length) ? 'svc:' + SVC.find((s) => RT[s.id].lines.length).id : null)
  renderMain()
}
async function seePort(port) {
  await go('overview')
  S.hiPort = +port; renderMain()
  const r = $(`#port-table tr[data-port="${port}"]`) || $('#port-table')
  if (r) r.scrollIntoView({ behavior: 'smooth', block: 'center' })
  setTimeout(() => { S.hiPort = null; if (S.page === 'overview') renderMain() }, 2200)
}
async function cfgPort(id) {
  S.tab = 'config'; renderMain()
  setTimeout(() => { const el = $('#f-port'); if (el) { el.focus(); el.select() } })
}
function promote(port) {
  const n = NEWL.find((x) => x.port === +port)
  if (!n) return
  NEWL.splice(NEWL.indexOf(n), 1)
  const id = 'new-' + port
  SVC.push({ id, name: n.name || n.proc, fw: n.fw || 'react', kind: 'fe', port: +port, path: n.path, script: 'dev', scripts: ['dev', 'build'], group: null, env: [] })
  RT[id] = mkRT()
  toast('info', '已提升为我的服务', '真实应用会先走「识别 → 确认」。这个进程不是本应用启动的，停止它要先在原处关掉。')
  openSvc(id + ':overview')
}
function ignore(port) { NEWL.splice(NEWL.findIndex((x) => x.port === +port), 1); toast('info', `已忽略 :${port}`); renderMain() }
function moveToMine(port) {
  const b = BG.find((x) => x.port === +port)
  if (!b) return
  BG.splice(BG.indexOf(b), 1); EXT.push({ port: b.port, proc: b.proc, pid: b.pid, mem: b.mem })
  toast('info', `${b.proc} 已移到我的服务端口`); renderMain()
}
function runGoal(arg) {
  const [id, g] = arg.split(':')
  S.build[id] = g; S.tab = 'output'
  pushLine(id, 'dim', `> mvn ${g} -P ${S.profile[id] || 'dev'}`)
  pushLine(id, '', '[INFO] Scanning for projects...')
  renderMain()
  setTimeout(() => {
    pushLine(id, 'ok', '[INFO] BUILD SUCCESS')
    if (g === 'package' || g === 'install') S.artifact[id] = `target/${id}-1.0.0.jar`
    delete S.build[id]
    toast('live', `mvn ${g} 完成`, svc(id).name)
    renderMain()
  }, 1400)
}
function cycleTheme() {
  const order = ['light', 'dark', 'system']
  S.theme = order[(order.indexOf(S.theme) + 1) % 3]
  applyTheme(); renderNav(); renderMain()
}
function setSegAct(arg) {
  const [k, v] = arg.split('=')
  if (k === 'theme') { S.theme = v; applyTheme(); renderNav() } else S.set[k] = isNaN(+v) ? v : +v
  renderMain()
}
function setSwAct(k) {
  if (k === 'nav') { S.navCollapsed = !S.navCollapsed; localStorage.setItem('proto.nav', S.navCollapsed ? '1' : '0'); renderNav() } else S.set[k] = !S.set[k]
  renderMain()
}
const STEP = { font: [12, 20, 1], scroll: [1000, 20000, 1000] }
function stepAct(arg) {
  const [k, d] = arg.split(':')
  const [lo, hi, st] = STEP[k]
  S.set[k] = Math.max(lo, Math.min(hi, S.set[k] + st * +d))
  renderMain()
}

/* ── 点击分发 ───────────────────────────────────────── */
const ACT = {
  go: (a) => go(a), theme: cycleTheme, setTheme: (a) => setSegAct('theme=' + a),
  collapse: () => setSwAct('nav'),
  pal: openPal, closePal, keys: openKeys, closeKeys,
  drawer: () => (S.drawer ? closeDrawer() : openDrawer()), closeDrawer,
  clearEvents: () => { S.events = []; renderDrawer() },
  cfOk: () => closeConfirm(true), cfNo: () => closeConfirm(false),
  chrome: () => toast('info', '窗口控件', '原型里不做任何事'),
  kind: (a) => { S.kind = a; S.cursor = null; renderMain() },
  clearQ: () => { S.q = ''; S.kind = 'all'; renderMain() },
  select: (a) => selectSvc(a), openSvc: (a) => openSvc(a), closeDetail,
  max: () => { S.max = !S.max; renderMain() },
  tab: (a) => { S.tab = a; renderMain() },
  start: (a) => start(a), stop: (a) => stop(a), kill: (a) => kill(a),
  groupStart: (a) => groupStart(a), groupStop: (a) => groupStop(a),
  menu: (a, el) => openMenu(el, a),
  addSvc: (a) => addSvc(a), newGroup,
  copy: (a, el) => copyText(a, el),
  clearOut: (a) => { RT[a].lines = []; renderMain() },
  termOf: async (a) => { S.term = 'svc:' + a; S.termTab = 'term'; await go('terminal'); renderMain() },
  install: (a) => install(a), cfgPort: (a) => cfgPort(a), seePort: (a) => seePort(a),
  profile: (a) => { const [id, p] = a.split(':'); S.profile[id] = p; renderMain() },
  goal: (a) => runGoal(a),
  cfgIcon: (a) => { const s = svc(S.sel); (S.drafts[s.id] ||= {}).icon = a; renderMain() },
  save: saveCfg,
  discard: async () => {
    const ok = await confirmDlg({ title: '放弃改动？', body: '未保存的配置会恢复成上次保存的值。', ok: '放弃改动', danger: true })
    if (ok) { delete S.drafts[S.sel]; renderMain() }
  },
  bg: () => { S.showBg = !S.showBg; renderMain() },
  promote: (a) => promote(a), ignore: (a) => ignore(a), moveToMine: (a) => moveToMine(a),
  term: (a, el) => { S.term = a; if (el.dataset.to) S.termTab = el.dataset.to; renderMain() },
  termTab: (a) => { S.termTab = a; renderMain() },
  newShell: () => { newShell(); renderMain(); setTimeout(() => $('#sh-in') && $('#sh-in').focus()) },
  closeShell: (a) => closeShell(a),
  logLevel: (a) => { S.logLevel = a; renderMain() },
  setSeg: (a) => setSegAct(a), setSw: (a) => setSwAct(a), step: (a) => stepAct(a),
  toast: (a) => toast('info', a)
}

document.addEventListener('click', (e) => {
  const mi = e.target.closest('[data-mi]')
  if (mi && S.menu) { const x = S.menu.items[+mi.dataset.mi]; closeMenu(); if (x && x.run) x.run(); return }
  const pi = e.target.closest('[data-pi]')
  if (pi) { runPal(+pi.dataset.pi); return }
  if (S.menu && !e.target.closest('.menu') && !e.target.closest('[data-act="menu"]')) closeMenu()
  if (e.target.classList.contains('scrim')) {
    if (S.drawer) closeDrawer(); else if (S.pal) closePal(); else if (S.keys) closeKeys()
    return
  }
  const el = e.target.closest('[data-act]')
  if (!el || el.disabled) return
  const fn = ACT[el.dataset.act]
  if (fn) { e.preventDefault(); fn(el.dataset.arg, el) }
})

/* ── 输入 ───────────────────────────────────────────── */
document.addEventListener('input', (e) => {
  const t = e.target
  if (t.id === 'svc-q') { S.q = t.value; S.cursor = null; renderMain() }
  else if (t.id === 'log-q') { S.logQ = t.value; renderMain() }
  else if (t.id === 'pal-q') { S.palQ = t.value; S.palI = 0; renderPalList() }
  else if (t.dataset.cfg) {
    const s = svc(S.sel)
    const was = dirty(s)
    ;(S.drafts[s.id] ||= {})[t.dataset.cfg] = t.value
    if (was !== dirty(s)) renderMain()
  }
})
document.addEventListener('change', (e) => {
  const t = e.target
  if (t.id === 'log-sess') { S.logSess = t.value; renderMain() }
  else if (t.tagName === 'SELECT' && t.dataset.cfg) {
    const s = svc(S.sel)
    ;(S.drafts[s.id] ||= {})[t.dataset.cfg] = t.value
    renderMain()
  }
})
document.addEventListener('toggle', (e) => { if (e.target.id === 'adv') S.advOpen = e.target.open }, true)

/* ── 键盘 ───────────────────────────────────────────── */
const typing = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
function navList() {
  const out = []
  sections().forEach((x) => { if (x.g.id !== '_none') out.push('g:' + x.g.id); x.items.forEach((s) => out.push(s.id)) })
  return out
}
function moveCursor(d) {
  const list = navList()
  if (!list.length) return
  const i = list.indexOf(S.cursor)
  const next = list[i < 0 ? (d > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, i + d))]
  if (S.sel && !next.startsWith('g:')) { selectSvc(next); return }
  S.cursor = next; renderMain()
  const el = next.startsWith('g:') ? $(`.tile-head[data-gid="${next.slice(2)}"]`) : $(`.row[data-sid="${next}"]`)
  if (el) el.scrollIntoView({ block: 'nearest' })
}
function cycleTab(d) {
  const s = svc(S.sel)
  const ids = tabsOf(s).map((t) => t[0])
  S.tab = ids[(ids.indexOf(effTab(s)) + d + ids.length) % ids.length]
  renderMain()
}

document.addEventListener('keydown', (e) => {
  const t = e.target
  if (S.confirm) {
    if (e.key === 'Escape') { e.preventDefault(); closeConfirm(false) }
    else if (e.key === 'Tab') {
      const b = $$('#ov-confirm button'); const i = b.indexOf(document.activeElement)
      e.preventDefault(); b[(i + (e.shiftKey ? -1 : 1) + b.length) % b.length].focus()
    }
    return
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); S.pal ? closePal() : openPal(); return }
  if (e.altKey && /^[1-5]$/.test(e.key)) { e.preventDefault(); go(PAGES[+e.key - 1].id); return }
  if (S.pal) {
    const n = palItems().length
    if (e.key === 'ArrowDown') { e.preventDefault(); S.palI = Math.min(n - 1, S.palI + 1); renderPalList() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); S.palI = Math.max(0, S.palI - 1); renderPalList() }
    else if (e.key === 'Enter') { e.preventDefault(); runPal(S.palI) }
    else if (e.key === 'Escape') { e.preventDefault(); closePal() }
    return
  }
  if (S.menu) {
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); return }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const b = $$('#ov-menu button:not(:disabled)'); const i = b.indexOf(document.activeElement)
      e.preventDefault(); b[(i + (e.key === 'ArrowDown' ? 1 : -1) + b.length) % b.length].focus()
      return
    }
  }
  if (t.id === 'sh-in' && e.key === 'Enter') { e.preventDefault(); shellExec(SHELLS.find((h) => h.id === t.dataset.shell), t.value.trim()); return }
  if (t.id === 'resizer' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault(); S.listW = Math.max(300, Math.min(520, S.listW + (e.key === 'ArrowRight' ? 24 : -24)))
    localStorage.setItem('proto.listW', S.listW); renderMain(); $('#resizer').focus(); return
  }
  if (e.key === 'Escape') {
    if (typing(t)) { t.blur(); return }
    if (S.keys) closeKeys()
    else if (S.drawer) closeDrawer()
    else if (S.max) { S.max = false; renderMain() }
    else if (S.sel) closeDetail()
    return
  }
  if (typing(t)) return
  if (e.key === 'Enter' && t.getAttribute && t.getAttribute('role') === 'link') { e.preventDefault(); t.click(); return }
  if (e.key === '?') { e.preventDefault(); S.keys ? closeKeys() : openKeys(); return }
  if (S.drawer || S.keys || S.page !== 'services') return
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveCursor(e.key === 'ArrowDown' ? 1 : -1); return }
  if ((e.key === '[' || e.key === ']') && S.sel) { e.preventDefault(); cycleTab(e.key === ']' ? 1 : -1); return }
  if (t.closest && t.closest('button')) return
  if (e.key === 'Enter' && S.cursor && !S.cursor.startsWith('g:')) { e.preventDefault(); selectSvc(S.cursor); return }
  if (e.key === ' ' && S.cursor) {
    e.preventDefault()
    if (S.cursor.startsWith('g:')) {
      const gid = S.cursor.slice(2)
      const live = SVC.some((s) => s.group === gid && RT[s.id].status === 'running')
      const all = SVC.filter((s) => s.group === gid && s.kind !== 'task' && !s.registerOnly).every((s) => RT[s.id].status === 'running')
      all && live ? groupStop(gid) : groupStart(gid)
    } else isLive(S.cursor) ? stop(S.cursor) : start(S.cursor)
  }
})

/* ── 分栏拖宽 ───────────────────────────────────────── */
document.addEventListener('mousedown', (e) => {
  if (e.target.id !== 'resizer') return
  e.preventDefault()
  const x0 = e.clientX, w0 = S.listW, r = e.target
  r.classList.add('drag')
  const move = (ev) => { S.listW = Math.max(300, Math.min(520, w0 + ev.clientX - x0)); const l = $('#svc-list'); if (l) l.style.width = S.listW + 'px' }
  const up = () => { r.classList.remove('drag'); localStorage.setItem('proto.listW', S.listW); removeEventListener('mousemove', move); removeEventListener('mouseup', up); afterMain() }
  addEventListener('mousemove', move); addEventListener('mouseup', up)
})

/* ── 折叠导航的提示 ─────────────────────────────────── */
function showTip(e) {
  const tip = $('#tip')
  const el = e.target.closest && e.target.closest('.nav-item')
  if (!el || !S.navCollapsed) { tip.classList.remove('show'); return }
  const r = el.getBoundingClientRect()
  tip.textContent = el.dataset.tip
  tip.style.left = r.right + 10 + 'px'; tip.style.top = r.top + r.height / 2 - 13 + 'px'
  tip.classList.add('show')
}
document.addEventListener('mouseover', showTip)
document.addEventListener('focusin', showTip)

/* ── 计时器：只补丁数字，不整页重绘 ───────────────────── */
setInterval(() => {
  let total = 0
  SVC.forEach((s) => {
    const rt = RT[s.id]
    if (rt.status !== 'running') return
    const v = Math.max(0.3, Math.min(40, (rt.cpu.at(-1) || 3) + (Math.random() - 0.5) * 3))
    rt.cpu.push(v); if (rt.cpu.length > 24) rt.cpu.shift()
    total += v
    $$(`[data-cpu="${s.id}"]`).forEach((el) => { el.textContent = v.toFixed(1) + '%' })
    $$(`[data-up="${s.id}"]`).forEach((el) => { el.textContent = fmtDur(now() - rt.since) })
    $$(`[data-spark="${s.id}"]`).forEach((el) => { el.innerHTML = spark(rt.cpu) })
  })
  $$('[data-cpu-total]').forEach((el) => { el.textContent = total.toFixed(1) })
  $$('[data-clock]').forEach((el) => { el.textContent = fmtClock(now()) })
}, 2000)

/* ── 种子数据 ───────────────────────────────────────── */
function mkRT() { return { status: 'idle', pid: null, since: null, lines: [], cpu: [], mem: null, exit: null, runs: [] } }
SVC.forEach((s) => { RT[s.id] = mkRT() })
function seedRun(id, agoMin) {
  const s = svc(id), rt = RT[id]
  rt.status = 'running'; rt.pid = 10000 + Math.floor(Math.random() * 50000); rt.since = now() - agoMin * 60000
  rt.cpu = Array.from({ length: 16 }, () => 2 + Math.random() * 8); rt.mem = 180 + Math.round(Math.random() * 400)
  pushLine(id, 'dim', s.java ? '> mvn spring-boot:run -P dev' : `> npm run ${s.script}`)
  bootLines(s).forEach((l) => pushLine(id, l[0], l[1]))
}
seedRun('mall-web', 42); seedRun('mall-server', 41); seedRun('docs-site', 95)
;(() => {
  const rt = RT['docs-api']
  pushLine('docs-api', 'dim', '> mvn spring-boot:run -P dev')
  pushLine('docs-api', 'err', 'Web server failed to start. Port 8090 was already in use.')
  pushLine('docs-api', 'err', 'APPLICATION FAILED TO START')
  rt.status = 'failed'; rt.exit = '端口 8090 被占用'
  RT['site-build'].runs = [{ ok: true, ms: 41000, at: now() - 3600e3 }, { ok: false, ms: 12000, at: now() - 86400e3 }, { ok: true, ms: 39000, at: now() - 2 * 86400e3 }]
  S.events = [
    { tone: 'fault', title: '文档检索服务 启动失败', body: '端口 8090 被外部进程占用', at: now() - 5 * 60e3 },
    { tone: 'live', title: '商城服务端 已启动', body: '监听 :8080', at: now() - 41 * 60e3 },
    { tone: 'live', title: '商城前台 已启动', body: '监听 :5173', at: now() - 42 * 60e3 }
  ]
  S.unread = 1; S.unreadFault = true
})()

/* ── 启动 ───────────────────────────────────────────── */
$('#app').innerHTML = `<div class="app"><header class="titlebar" id="tb"></header><div class="body"><nav class="nav" id="nav" aria-label="主导航"></nav><main class="main" id="main"></main></div></div>`
applyTheme()
renderTitle(); renderNav(); renderMain(); renderDrawer()
mq.addEventListener('change', () => { if (S.theme === 'system') { applyTheme(); renderMain() } })
addEventListener('resize', () => { renderNav(); afterMain() })
