// 原生集成（S32）。对应原版 src/main/index.ts 的这些部分：
//   - createWindow 里的窗口事件（关闭收托盘、扫描器可见性、导航守卫、window.open 只放行 localhost）
//   - createTray（第 153–282 行）
//   - notifyTaskDone / windowInBackground / notifyEntryProblem / notifyPlannerReminder（第 936–1044 行）
//   - applyTaskbarVisibility / applyGlobalHotkey（第 794–822 行）
//   - 单实例、window-all-closed、before-quit / will-quit（第 832–907 行）
//   - registerIpc 里 entries / alerts 事件到通知的映射（第 515–576 行）
//
// 文案与判定逐字照搬原版。品牌文案「Mile Terminal」按决策 D3 保留。

package main

import (
	"context"
	_ "embed"
	"fmt"
	"log"
	"regexp"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/egoist/mygo"

	"mile-console/internal/alerts"
	"mile-console/internal/config"
	"mile-console/internal/contract"
	"mile-console/internal/entries"
	"mile-console/internal/groups"
	"mile-console/internal/sessions"
)

// mileIcon 托盘与系统通知的图标（原版 resources/icon.png 原样复制）。
//
//go:embed resources/mile-icon.png
var mileIcon []byte

// quitCleanupTimeout 即原版 QUIT_CLEANUP_TIMEOUT_MS：退出时等进程树终止的上限，
// taskkill 卡住也不能让应用关不掉。
const quitCleanupTimeout = 6000 * time.Millisecond

// trayRebuildDelay 运行态在端口捕获、状态切换时会连发多次，合并成一次重建（原版 50ms）。
const trayRebuildDelay = 50 * time.Millisecond

// localhostURL 与 shellOpenLocalhost 同口径：window.open 只放行 localhost / 127.0.0.1。
var localhostURL = regexp.MustCompile(`(?i)^https?://(localhost|127\.0\.0\.1)(:\d+)?(/|$)`)

// taskDoneTitle 即原版 TASK_DONE_TITLE。
var taskDoneTitle = map[contract.EntryStatus]string{
	contract.EntrySucceeded: "任务完成",
	contract.EntryFailed:    "任务失败",
	contract.EntryCanceled:  "任务已取消",
}

// curWin 主窗口。托盘、通知、快捷键回调与绑定层并发读，所以用原子指针。
var curWin atomic.Pointer[mygo.Window]

func currentWin() *mygo.Window { return curWin.Load() }

// native 原生集成的状态。只在 main 里建一个。
type native struct {
	ctx    context.Context
	cfg    *config.Store
	ent    *entries.Service
	sess   *sessions.Service
	notify func(name string, payload any)
	hotkey string

	// alerts 晚于 entries 建，崩溃时要撤它排队的告警通知
	alerts *alerts.Service

	// newWindow 建主窗口（托盘「显示主窗口」、第二实例、快捷键在窗口已销毁时用）
	newWindow func() *mygo.Window

	// quitting before-quit 已触发：close 事件不再拦成「收起到托盘」，也不再弹崩溃通知
	quitting    atomic.Bool
	cleanupDone atomic.Bool

	trayMu       sync.Mutex
	tray         *mygo.Tray
	rebuildTimer *time.Timer
}

// ── 窗口 ───────────────────────────────────────────────────────────────

// showWindow 即原版托盘的 show()：没有窗口就新建，有就显示并聚焦。
func (n *native) showWindow() {
	w := currentWin()
	if w == nil {
		n.newWindow()
		return
	}
	w.Show()
	w.Focus()
}

// bringToFront 即原版通知点击、第二实例、快捷键里的那段：最小化先还原，再显示并聚焦。
// 返回 false 表示没有窗口。
func (n *native) bringToFront() bool {
	w := currentWin()
	if w == nil {
		return false
	}
	if w.IsMinimized() {
		w.Restore()
	}
	w.Show()
	w.Focus()
	return true
}

// windowInBackground 即原版：窗口当前看不到（隐藏到托盘、最小化或失焦）。
func windowInBackground() bool {
	w := currentWin()
	if w == nil {
		return true
	}
	return !w.IsVisible() || w.IsMinimized() || !w.IsFocused()
}

// hookWindow 挂原版 createWindow 里与原生集成相关的窗口事件。
func (n *native) hookWindow(win *mygo.Window, setVisible func(bool)) {
	win.OnMinimize(func() { setVisible(false) })
	win.OnRestore(func() { setVisible(true) })
	win.OnHide(func() { setVisible(false) })
	win.OnShow(func() { setVisible(true) })

	// closeToTray：关闭只收起窗口，受控进程继续跑。真正退出走托盘菜单或 before-quit，
	// 否则用户以为「关掉了」而 dev server 还在后台占端口。
	win.OnClose(func(e *mygo.CloseEvent) {
		if n.quitting.Load() || !n.cfg.Get().Settings.CloseToTray {
			return
		}
		e.PreventDefault()
		win.Hide()
	})

	page := win.Page()
	// 与 shellOpenLocalhost 保持相同口径：只允许 localhost/127.0.0.1，不接受任意外部 URL
	page.SetWindowOpenHandler(func(req mygo.WindowOpenRequest) *mygo.WindowOptions {
		if localhostURL.MatchString(req.URL) {
			_ = mygo.Shell.OpenExternal(req.URL)
		}
		return nil
	})
	// 顶层页面只能是应用自己：页面改 location 离开当前 URL 一律拦下（重载同一 URL 放行）
	page.OnWillNavigate(func(e *mygo.NavigateEvent) {
		if e.URL != page.URL() {
			e.PreventDefault()
		}
	})
}

// applyTaskbarVisibility 即原版：「从任务栏隐藏」只动任务栏按钮，托盘始终在。
func applyTaskbarVisibility(hide bool) {
	if w := currentWin(); w != nil {
		w.SetSkipTaskbar(hide)
	}
}

// ── 全局快捷键 ─────────────────────────────────────────────────────────

// applyGlobalHotkey 即原版：唤起窗口并打开命令面板。回调只导航，不触发启停这类写操作。
// 组合键被别的程序占了时只在实时动态里提示，不抛错、不挡设置保存。
func (n *native) applyGlobalHotkey() {
	if mygo.GlobalShortcut.IsRegistered(n.hotkey) {
		mygo.GlobalShortcut.Unregister(n.hotkey)
	}
	if !n.cfg.Get().Settings.GlobalHotkey {
		return
	}
	err := mygo.GlobalShortcut.Register(n.hotkey, func() {
		if currentWin() == nil {
			// 新窗口加载完才有页面可接收（原版 did-finish-load 之后再发）
			w := n.newWindow()
			var off func()
			off = w.Page().OnDidFinishLoad(func() {
				off()
				n.notify("appOpenPalette", struct{}{})
			})
			return
		}
		n.bringToFront()
		n.notify("appOpenPalette", struct{}{})
	})
	if err != nil {
		n.notify("entryWarning", fmt.Sprintf("全局快捷键 %s 已被其他程序占用，未能注册", n.hotkey))
	}
}

// ── 系统通知 ───────────────────────────────────────────────────────────

// toast 弹一条系统通知。不可用（策略关闭、专注助手）时静默跳过而不是报错。
// onClick 只把窗口带到前台、让页面定位，不做任何写操作：通知是从系统层来的输入。
func toast(title, body string, silent bool, onClick func()) {
	if !mygo.NotificationsSupported() {
		return
	}
	nt := mygo.NewNotification(mygo.NotificationOptions{
		Title:  title,
		Body:   body,
		Silent: silent,
		Image:  mileIcon,
	})
	if onClick != nil {
		nt.OnClick(onClick)
	}
	go func() {
		if err := nt.Show(); err != nil {
			log.Printf("系统通知未能显示：%v", err)
		}
	}()
}

// notifyTaskDone 即原版。开关每次都现读配置，不在启动时缓存。
func (n *native) notifyTaskDone(name string, status contract.EntryStatus, exitCode int) {
	if !n.cfg.Get().Settings.NotifyOnTaskDone {
		return
	}
	title, ok := taskDoneTitle[status]
	if !ok {
		return
	}
	body := fmt.Sprintf("退出码 %d", exitCode)
	if status == contract.EntrySucceeded {
		body = "退出码 0"
	}
	toast(title+" · "+name, body, false, func() { n.bringToFront() })
}

// notifyEntryProblem 即原版：服务崩溃、启动被拦、端口未释放、自动重启放弃、输出告警。
// 退出清理期间不弹：killOwnedOnQuit 杀进程会让每个服务走一遍 crashed 路径。
func (n *native) notifyEntryProblem(entryID, title, body string, tab contract.FocusTab) {
	s := n.cfg.Get().Settings
	if !s.NotifyOnCrash || n.quitting.Load() {
		return
	}
	if s.NotifyOnlyWhenBackground && !windowInBackground() {
		return
	}
	toast(title, body, false, func() {
		if !n.bringToFront() {
			return
		}
		n.notify("appFocusEntry", contract.FocusEntryRequest{ID: entryID, Tab: tab})
	})
}

// notifyPlannerReminder 即原版：应用内提醒卡片 + 系统通知同时推；
// 前台也弹，不受「仅后台时通知」限制。
func (n *native) notifyPlannerReminder(f contract.ReminderFire) {
	n.notify("plannerReminder", f)
	s := n.cfg.Get().Settings
	if !s.PlannerNotify {
		return
	}
	toast("日程提醒 · "+f.GroupName, f.Title+"　"+f.When, !s.PlannerSound, func() {
		if !n.bringToFront() {
			return
		}
		n.notify("plannerFocus", contract.PlannerFocusRequest{
			BoardID: f.BoardID, TaskID: f.TaskID, Tab: contract.PlannerTabSchedules,
		})
	})
}

// notifyAlert 即原版 alerts.on('notify')。
func (n *native) notifyAlert(a contract.OutputAlert) {
	what := "错误行"
	if a.Keyword != nil {
		what = "命中「" + *a.Keyword + "」"
	}
	n.notifyEntryProblem(a.EntryID, "输出告警 · "+a.Name, what+"："+headRunes(a.Line, 120), contract.FocusTabOutput)
}

// entryName 即原版 entryName。
func (n *native) entryName(id string) string {
	if e, ok := n.ent.Get(id); ok {
		return e.Name
	}
	return "服务"
}

// entriesEmit 即原版 registerIpc 里对 EntryService 各事件的订阅。条目包按原版事件名发，
// 这里翻成页面的事件名或系统通知。entryChanged 不走这里（Options.OnChanged，带脱敏）。
func (n *native) entriesEmit(name string, payload any) {
	switch name {
	case "runtime":
		n.notify("entryRuntimeChanged", payload)
	case "warning":
		// 这条以前没人订阅：「端口 5 秒未释放」只在主进程 emit 一下就没了
		n.notify("entryWarning", payload)
	case "taskDone":
		m, _ := payload.(map[string]any)
		status, _ := m["status"].(contract.EntryStatus)
		n.notifyTaskDone(str(m, "name"), status, num(m, "exitCode"))
	case "crashed":
		m, _ := payload.(map[string]any)
		id := str(m, "entryId")
		// 同一次崩溃只发一条通知：先撤掉该条目排队中的告警通知
		if n.alerts != nil {
			n.alerts.NoteCrash(id)
		}
		body := fmt.Sprintf("退出码 %d，点击查看输出", num(m, "exitCode"))
		if line := str(m, "lastErrorLine"); line != "" {
			body = fmt.Sprintf("退出码 %d：%s", num(m, "exitCode"), headRunes(line, 120))
		}
		n.notifyEntryProblem(id, "服务已崩溃 · "+str(m, "name"), body, contract.FocusTabOutput)
	case "blocked":
		m, _ := payload.(map[string]any)
		n.notifyEntryProblem(str(m, "entryId"), "启动被拦下 · "+str(m, "name"),
			"启动前检查没通过，点击查看原因和修复入口", contract.FocusTabDiagnose)
	case "portUnreleased":
		m, _ := payload.(map[string]any)
		id := str(m, "entryId")
		n.notifyEntryProblem(id, "端口未释放 · "+n.entryName(id),
			fmt.Sprintf(":%d 在 5 秒内没有放手，重启后可能仍被占用", num(m, "port")), contract.FocusTabDiagnose)
	case "autoRestartGaveUp":
		m, _ := payload.(map[string]any)
		n.notifyEntryProblem(str(m, "entryId"), "已停止自动重启 · "+str(m, "name"),
			"10 分钟内已重启 3 次仍然退出，点击查看输出", contract.FocusTabOutput)
	}
}

func str(m map[string]any, k string) string {
	v, _ := m[k].(string)
	return v
}

func num(m map[string]any, k string) int {
	switch v := m[k].(type) {
	case int:
		return v
	case int64:
		return int(v)
	case float64:
		return int(v)
	}
	return 0
}

// headRunes 即原版 `s.slice(0, n)` 在通知正文里的用途：按字符截断。
func headRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// ── 托盘 ───────────────────────────────────────────────────────────────

// startable 与页面 isGroupStartable 同口径：常驻服务、可启动、不由 HBuilderX 接管。
func startable(e contract.LaunchEntry) bool {
	return e.Kind == contract.EntryKindService && !e.RegisterOnly && e.Framework != contract.FrameworkUniapp
}

func isLive(s contract.EntryStatus) bool {
	return s == contract.EntryPrecheck || s == contract.EntryStarting || s == contract.EntryRunning || s == contract.EntryStopping
}

func (n *native) liveSet() map[string]bool {
	live := map[string]bool{}
	for _, r := range n.ent.RuntimeList() {
		if isLive(r.Status) {
			live[r.EntryID] = true
		}
	}
	return live
}

// createTray 即原版。closeToTray 打开后窗口会被收进这里，所以托盘必须始终存在。
func (n *native) createTray() {
	t, err := mygo.NewTray(mygo.TrayOptions{ID: "main", Icon: mileIcon, ToolTip: "Mile Terminal"})
	if err != nil {
		log.Printf("托盘创建失败：%v", err)
		return
	}
	n.trayMu.Lock()
	n.tray = t
	n.trayMu.Unlock()
	t.OnClick(n.showWindow)
	n.ent.OnRuntime(func(contract.EntryRuntime) { n.scheduleTrayRebuild() })
	n.ent.OnEntriesChanged(func([]contract.LaunchEntry) { n.scheduleTrayRebuild() })
	n.rebuildTray()
}

// scheduleTrayRebuild 50ms 内的多次变化合并成一次重建。
func (n *native) scheduleTrayRebuild() {
	n.trayMu.Lock()
	defer n.trayMu.Unlock()
	if n.tray == nil || n.rebuildTimer != nil {
		return
	}
	n.rebuildTimer = time.AfterFunc(trayRebuildDelay, func() {
		n.trayMu.Lock()
		n.rebuildTimer = nil
		n.trayMu.Unlock()
		n.rebuildTray()
	})
}

// confirmEnv 即原版托盘的 confirmEnv，规则同页面 confirmEnv：prod 任何条目都确认，
// sandbox 只有 spring-boot 确认。托盘入口不能因为换了入口就绕过这道确认。
func (n *native) confirmEnv(list []contract.LaunchEntry, groupID string) bool {
	if groupID == "" {
		return true
	}
	var group *contract.ProjectGroup
	for _, g := range n.cfg.Get().Groups {
		if g.ID == groupID {
			g := g
			group = &g
			break
		}
	}
	if group == nil {
		return true
	}
	names := ""
	for i, e := range list {
		if i > 0 {
			names += "、"
		}
		names += "「" + e.Name + "」"
	}
	message := ""
	switch {
	case group.Env == contract.GroupEnvProd:
		message = fmt.Sprintf("工作组「%s」处于%s环境，启动 %s 会影响真实业务数据。", group.Name, contract.GroupEnvLabel[contract.GroupEnvProd], names)
	case group.Env == contract.GroupEnvSandbox && hasSpringBoot(list):
		message = fmt.Sprintf("工作组「%s」处于%s环境，确认后启动 %s。", group.Name, contract.GroupEnvLabel[contract.GroupEnvSandbox], names)
	}
	if message == "" {
		return true
	}
	res, err := mygo.Dialog.Message(mygo.MessageOptions{
		Parent:        currentWin(),
		Type:          mygo.MessageWarning,
		Title:         "确认启动",
		Message:       "在" + contract.GroupEnvLabel[group.Env] + "环境启动？",
		Detail:        message,
		Buttons:       []string{"确认启动", "取消"},
		DefaultButton: 1,
		CancelButton:  1,
	})
	return err == nil && res.Button == 0
}

func hasSpringBoot(list []contract.LaunchEntry) bool {
	for _, e := range list {
		if e.Framework == contract.FrameworkSpringBoot {
			return true
		}
	}
	return false
}

// startList 即原版：按 startAfter 分层启动，与界面「全部启动」一致；被拦、出错都记在结果里。
func (n *native) startList(list []contract.LaunchEntry, groupID string) {
	live := n.liveSet()
	var todo []contract.LaunchEntry
	for _, e := range list {
		if startable(e) && !live[e.ID] {
			todo = append(todo, e)
		}
	}
	if len(todo) == 0 || !n.confirmEnv(todo, groupID) {
		return
	}
	ids := make([]string, len(todo))
	for i, e := range todo {
		ids[i] = e.ID
	}
	n.ent.StartOrdered(n.ctx, ids)
}

// stopList 即原版：Stop 内部走归属判定，拒绝时报错，这里逐个吞掉不影响其余条目。
func (n *native) stopList(list []contract.LaunchEntry) {
	live := n.liveSet()
	var wg sync.WaitGroup
	for _, e := range list {
		if !live[e.ID] {
			continue
		}
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			_, _ = n.ent.Stop(n.ctx, id)
		}(e.ID)
	}
	wg.Wait()
}

// rebuildTray 即原版 rebuild()。菜单点击在主线程回调，启停与确认框都会等主线程，所以一律另起 goroutine。
func (n *native) rebuildTray() {
	n.trayMu.Lock()
	t := n.tray
	n.trayMu.Unlock()
	if t == nil {
		return
	}
	all := n.ent.List()
	live := n.liveSet()
	liveCount := 0
	for _, e := range all {
		if live[e.ID] {
			liveCount++
		}
	}

	var groupItems []*mygo.MenuItem
	for _, g := range groups.OrderGroups(n.cfg.Get().Groups) {
		var members []contract.LaunchEntry
		anyStartable, anyLive := false, false
		for _, e := range all {
			if e.GroupID != g.ID {
				continue
			}
			members = append(members, e)
			if startable(e) && !live[e.ID] {
				anyStartable = true
			}
			if live[e.ID] {
				anyLive = true
			}
		}
		gid := g.ID
		groupItems = append(groupItems, &mygo.MenuItem{
			Label: g.Name + "（" + contract.GroupEnvLabel[g.Env] + "）",
			Submenu: []*mygo.MenuItem{
				{Label: "启动全部", Disabled: !anyStartable, Click: func(*mygo.MenuItem, *mygo.Window) { go n.startList(members, gid) }},
				{Label: "停止全部", Disabled: !anyLive, Click: func(*mygo.MenuItem, *mygo.Window) { go n.stopList(members) }},
			},
		})
	}

	var recent []contract.LaunchEntry
	for _, e := range all {
		if startable(e) && e.LastStartedAt != nil && *e.LastStartedAt != 0 {
			recent = append(recent, e)
		}
	}
	sort.SliceStable(recent, func(i, j int) bool { return *recent[i].LastStartedAt > *recent[j].LastStartedAt })
	if len(recent) > 5 {
		recent = recent[:5]
	}
	var recentItems []*mygo.MenuItem
	for _, e := range recent {
		e := e
		wasLive := live[e.ID]
		recentItems = append(recentItems, &mygo.MenuItem{
			Label:   e.Name,
			Type:    mygo.MenuItemCheckbox,
			Checked: wasLive,
			Click: func(*mygo.MenuItem, *mygo.Window) {
				if wasLive {
					go n.stopList([]contract.LaunchEntry{e})
				} else {
					go n.startList([]contract.LaunchEntry{e}, e.GroupID)
				}
			},
		})
	}

	tip := "Mile Terminal"
	if liveCount > 0 {
		tip = fmt.Sprintf("Mile Terminal · %d 个运行中", liveCount)
	}
	t.SetToolTip(tip)
	t.SetMenu(mygo.NewMenu([]*mygo.MenuItem{
		{Label: fmt.Sprintf("%d 个运行中", liveCount), Disabled: true},
		{Type: mygo.MenuItemSeparator},
		{Label: "显示主窗口", Click: func(*mygo.MenuItem, *mygo.Window) { n.showWindow() }},
		{Type: mygo.MenuItemSeparator},
		{Label: "工作组", Disabled: len(groupItems) == 0, Submenu: groupItems},
		{Label: "最近使用", Disabled: len(recentItems) == 0, Submenu: recentItems},
		{Label: "全部停止", Disabled: liveCount == 0, Click: func(*mygo.MenuItem, *mygo.Window) { go n.stopList(all) }},
		{Type: mygo.MenuItemSeparator},
		// 这里必须走 App.Quit()：直接关窗会跳过 before-quit，killOwnedOnQuit 的清理就不会执行
		{Label: "退出", Click: func(*mygo.MenuItem, *mygo.Window) { mygo.App.Quit() }},
	}))
}

// ── 退出 ───────────────────────────────────────────────────────────────

// beforeQuit 即原版 before-quit。stopServices 停掉扫描器、健康检查、告警、日程调度。
//
// 必须先 BeginQuit 再 DisposeAll：退出流程杀会话不设 stoppedByUser，会被判成崩溃。
// 先打标记，onSessionExit 就不会给这些会话排自动重启，Start 也直接拒绝。
func (n *native) beforeQuit(e *mygo.QuitEvent, stopServices func()) {
	n.quitting.Store(true)
	n.ent.BeginQuit()
	stopServices()
	if n.cleanupDone.Load() || !n.cfg.Get().Settings.KillOwnedOnQuit || n.sess.LiveCount() == 0 {
		return
	}
	// 不等的话进程退出时 taskkill 还没跑完，dev server 会留在后台占端口
	e.PreventDefault()
	n.cleanupDone.Store(true)
	live := n.sess.LiveCount()
	log.Printf("退出清理：%d 个会话，等进程树终止（上限 %v）", live, quitCleanupTimeout)
	go func() {
		start := time.Now()
		ctx, cancel := context.WithTimeout(n.ctx, quitCleanupTimeout)
		defer cancel()
		done := make(chan struct{})
		go func() {
			n.sess.DisposeAll(ctx)
			close(done)
		}()
		select {
		case <-done:
			log.Printf("退出清理：完成，用时 %v", time.Since(start).Round(time.Millisecond))
		case <-time.After(quitCleanupTimeout):
			log.Printf("退出清理：超过 %v 上限，不再等待", quitCleanupTimeout)
		}
		mygo.App.Quit()
	}()
}
