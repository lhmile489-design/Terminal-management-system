// Mile Console 的装配入口（S24）。
//
// 顺序即依赖顺序：配置 → 归属 → 会话 → 日志 → 识别 → 预检 → 扫描器 → 条目 →
// 健康 / 告警 / 导入导出 / 进度。业务规则都在各服务里，这里只接线。
//
// 根 ctx：mygo 目前没有 App.Context()，所以由 main 自己造一个，`App.Run()` 返回后取消。
// 它在语义上就是「应用生命周期」，绑定方法里仍然不出现 context.Background()。
//
// 托盘、系统通知、全局快捷键、单实例、退出清理等原生集成在 native.go（S32）。
// 文件 / 目录选择走 mygo.Dialog（dialogAdapter），路径只来自系统对话框的返回值（红线）。

package main

import (
	"context"
	"errors"
	"log"
	"os"
	"os/exec"
	"time"

	"github.com/egoist/mygo"

	"mile-console/internal/alerts"
	"mile-console/internal/app"
	"mile-console/internal/config"
	"mile-console/internal/contract"
	"mile-console/internal/detect"
	"mile-console/internal/entries"
	"mile-console/internal/events"
	"mile-console/internal/health"
	"mile-console/internal/images"
	"mile-console/internal/logs"
	"mile-console/internal/ownership"
	"mile-console/internal/planner"
	"mile-console/internal/platform/win32"
	"mile-console/internal/precheck"
	"mile-console/internal/scanner"
	"mile-console/internal/sessions"
	"mile-console/internal/transfer"
)

const (
	appName    = "Mile Console"
	appVersion = "0.1.0"
)

// 事件名与负载类型一一对应（BINDINGS-CONTRACT §3 的事件表）。名字纯字母数字。
var (
	evEntryChanged   = mygo.NewEvent[[]contract.LaunchEntry]("entryChanged")
	evEntryRuntime   = mygo.NewEvent[contract.EntryRuntime]("entryRuntimeChanged")
	evEntryWarning   = mygo.NewEvent[string]("entryWarning")
	evEntryHealth    = mygo.NewEvent[contract.EntryHealth]("entryHealth")
	evEntryAlert     = mygo.NewEvent[contract.OutputAlert]("entryAlert")
	evGroupChanged   = mygo.NewEvent[[]contract.ProjectGroup]("groupChanged")
	evPlannerChanged = mygo.NewEvent[contract.PlannerSnapshot]("plannerChanged")
	evPlannerRemind  = mygo.NewEvent[contract.ReminderFire]("plannerReminder")
	evSessionExit    = mygo.NewEvent[contract.SessionExitEvent]("sessionExit")
	evScannerDiff    = mygo.NewEvent[contract.ScanDiff]("scannerDiff")
	evWinMaximize    = mygo.NewEvent[bool]("windowMaximizeChanged")
	evThemeChanged   = mygo.NewEvent[contract.ThemeState]("themeChanged")
	evSettings       = mygo.NewEvent[contract.Settings]("settingsChanged")
	evFocusEntry     = mygo.NewEvent[contract.FocusEntryRequest]("appFocusEntry")
	evOpenPalette    = mygo.NewEvent[struct{}]("appOpenPalette")
	evPlannerFocus   = mygo.NewEvent[contract.PlannerFocusRequest]("plannerFocus")
)

// 主窗口在 native.go 的 curWin（原子指针），建窗时赋值、关窗后清空。
//
// 为什么不让适配器直接持有窗口：`mygo generate` 只扫**顶层**的 mygo.Bind，
// 把 Bind 放进 WhenReady 会生成不出 WindowService / ThemeService / ShellService /
// ClipboardService 四个服务（实测过）。所以绑定放顶层，窗口在用时惰性取。

// windowAdapter 把 mygo 的窗口方法包成 app.WindowOS（那边要 error 与返回值）。
type windowAdapter struct{}

func (windowAdapter) Minimize() error {
	w := currentWin()
	if w == nil {
		return errNoWindow
	}
	w.Minimize()
	return nil
}
func (windowAdapter) ToggleMaximize() (bool, error) {
	w := currentWin()
	if w == nil {
		return false, errNoWindow
	}
	w.ToggleMaximize()
	return w.IsMaximized(), nil
}
func (windowAdapter) Close() error {
	w := currentWin()
	if w == nil {
		return errNoWindow
	}
	w.Close()
	return nil
}
func (windowAdapter) IsMaximized() bool {
	w := currentWin()
	return w != nil && w.IsMaximized()
}

// dialogAdapter 把 mygo.Dialog 包成 app.DialogOS（原版 dialog.showOpenDialog / showSaveDialog）。
// 没有主窗口时与原版一样当作取消。
type dialogAdapter struct{}

var jsonFilter = []mygo.FileFilter{{Name: "JSON", Extensions: []string{"json"}}}

func (dialogAdapter) PickDirectory(_ context.Context, title string) (string, bool, error) {
	return openOne(mygo.OpenDialogOptions{Title: title, Directory: true})
}
func (dialogAdapter) PickJSONToOpen(_ context.Context, title string) (string, bool, error) {
	return openOne(mygo.OpenDialogOptions{Title: title, Filters: jsonFilter})
}
func (dialogAdapter) PickJSONToSave(_ context.Context, title, defaultName string) (string, bool, error) {
	w := currentWin()
	if w == nil {
		return "", false, nil
	}
	file, err := mygo.Dialog.Save(mygo.SaveDialogOptions{Parent: w, Title: title, DefaultPath: defaultName, Filters: jsonFilter})
	if err != nil || file == "" {
		return "", false, err
	}
	return file, true, nil
}

func openOne(opts mygo.OpenDialogOptions) (string, bool, error) {
	w := currentWin()
	if w == nil {
		return "", false, nil
	}
	opts.Parent = w
	paths, err := mygo.Dialog.Open(opts)
	if err != nil || len(paths) == 0 {
		return "", false, err
	}
	return paths[0], true, nil
}

var errNoWindow = errors.New("窗口尚未创建")

// shellAdapter 把 mygo.Shell 包成 app.ShellOS。
type shellAdapter struct{}

func (shellAdapter) OpenLocalhost(port int) error {
	return mygo.Shell.OpenExternal("http://localhost:" + itoa(port))
}
func (shellAdapter) OpenPath(target string) error { return mygo.Shell.OpenPath(target) }
func (shellAdapter) OpenProjectLink(key contract.ProjectLink) error {
	return mygo.Shell.OpenExternal(contract.ProjectLinks[key])
}

// clipboardAdapter 只写不读。
type clipboardAdapter struct{}

func (clipboardAdapter) WriteText(text string) error {
	mygo.Clipboard.WriteText(text)
	return nil
}

// emitFor 把事件总线的一次投递分发到对应的事件实例。
func emitFor(win *mygo.Window) events.SendFunc {
	return func(name string, payload any) error {
		switch name {
		case "entryChanged":
			if v, ok := payload.([]contract.LaunchEntry); ok {
				return evEntryChanged.Emit(win, v)
			}
		case "entryRuntimeChanged":
			if v, ok := payload.(contract.EntryRuntime); ok {
				return evEntryRuntime.Emit(win, v)
			}
		case "entryWarning":
			if v, ok := payload.(string); ok {
				return evEntryWarning.Emit(win, v)
			}
		case "entryHealth":
			if v, ok := payload.(contract.EntryHealth); ok {
				return evEntryHealth.Emit(win, v)
			}
		case "entryAlert":
			if v, ok := payload.(contract.OutputAlert); ok {
				return evEntryAlert.Emit(win, v)
			}
		case "groupChanged":
			if v, ok := payload.([]contract.ProjectGroup); ok {
				return evGroupChanged.Emit(win, v)
			}
		case "plannerChanged":
			if v, ok := payload.(contract.PlannerSnapshot); ok {
				return evPlannerChanged.Emit(win, v)
			}
		case "plannerReminder":
			if v, ok := payload.(contract.ReminderFire); ok {
				return evPlannerRemind.Emit(win, v)
			}
		case "sessionExit":
			if v, ok := payload.(contract.SessionExitEvent); ok {
				return evSessionExit.Emit(win, v)
			}
		case "themeChanged":
			if v, ok := payload.(contract.ThemeState); ok {
				return evThemeChanged.Emit(win, v)
			}
		case "settingsChanged":
			if v, ok := payload.(contract.Settings); ok {
				return evSettings.Emit(win, v)
			}
		case "windowMaximizeChanged":
			if v, ok := payload.(bool); ok {
				return evWinMaximize.Emit(win, v)
			}
		case "appFocusEntry":
			if v, ok := payload.(contract.FocusEntryRequest); ok {
				return evFocusEntry.Emit(win, v)
			}
		case "appOpenPalette":
			return evOpenPalette.Emit(win, struct{}{})
		case "plannerFocus":
			if v, ok := payload.(contract.PlannerFocusRequest); ok {
				return evPlannerFocus.Emit(win, v)
			}
		case "scannerDiff":
			if v, ok := payload.(contract.ScanDiff); ok {
				return evScannerDiff.Emit(win, v)
			}
		}
		// 未知事件名不报错：宁可丢一条通知，也不要打断服务
		return nil
	}
}

func main() {
	// 单实例锁（原版第 832–844 行）：再双击快捷方式不起第二个实例（两个实例会抢同一份
	// config.json 和同一批端口扫描），第二个实例自己退出，并让第一个实例把窗口带到前台。
	// 第二个实例还没建任何服务，没有清理要做，直接 return。
	// mygo 的锁按应用名 + 标识符区分，不会与本机别的应用互相挤掉，所以 `mygo dev`（也是打包形态）同样启用。
	if mygo.App.IsPackaged() || os.Getenv("MILE_FORCE_SINGLE_INSTANCE") == "1" {
		if !mygo.App.RequestSingleInstanceLock() {
			return
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	bus := events.New(nil)
	notify := func(name string, payload any) { _ = bus.Emit(name, payload) }

	plat := win32.New()

	dir, err := config.DataDir()
	if err != nil {
		log.Fatal(err)
	}
	cfg, err := config.Open(dir, plat)
	if err != nil {
		log.Fatal(err)
	}

	own := ownership.New(func() int64 { return time.Now().UnixMilli() })
	sess := sessions.New(ctx, plat, own, sessions.Options{})
	logsSvc := logs.New(sess, logs.Options{})

	det := detect.New(plat)
	pre := precheck.New(plat, det, precheck.Options{})

	sc := scanner.New(ctx, plat, own, cfg, scanner.Options{
		OnDiff:  func(d contract.ScanDiff) { notify("scannerDiff", d) },
		OnError: func(err error) { notify("entryWarning", err.Error()) },
	})

	// 原版第 863 行：scanner 晚于 sessions 构建，后注入供 kill 前重校验归属用（PRD §6.3 步骤 4）。
	// 漏了这一步 doKill 拿不到新鲜进程表，会只撤登记、不杀进程树
	sess.SetScanner(sc)

	imageDir, err := images.DefaultDir()
	if err != nil {
		log.Fatal(err)
	}
	imageSvc := images.New(imageDir)

	nat := &native{ctx: ctx, cfg: cfg, sess: sess, notify: notify, hotkey: plat.GlobalHotkey()}

	var ent *entries.Service
	ent = entries.New(ctx, cfg, plat, sess, entries.Options{
		Emit: nat.entriesEmit,
		// 原版 entries.on('changed', list => send(entryChanged, redactList(list)))：环境变量的值不出 Go 进程
		OnChanged: func(list []contract.LaunchEntry) { notify("entryChanged", app.RedactList(list)) },
		Scanner:   sc,
		Ownership: own,
		Precheck: func(c context.Context, e contract.LaunchEntry, snap *contract.ScanSnapshot, all []contract.LaunchEntry) (contract.PrecheckResult, error) {
			return pre.Run(c, e, snap, all)
		},
		Which:       pre.WhichAny,
		Images:      imageSvc,
		ReadFavicon: det.ReadFavicon,
		SpawnDetached: func(file string, args []string) error {
			// HBuilderX 是独立 GUI，脱离本应用生命周期
			cmd := exec.Command(file, args...)
			return cmd.Start()
		},
		ListJars:  func(id string) []string { return ent.ListJars(id) },
		OutputDir: func(id string) *string { return ent.OutputDir(id) },
	})
	// 条目与扫描器互相需要：扫描器先建、条目后建，最后回注期望来源。
	// 两边各有一套 EntryExpectation 类型（扫描器那份 Port 是 int，0 表示没有预期端口），
	// 这里做一次转换，避免把扫描器绑死在条目包的类型上。
	sc.SetExpectationSource(func() []scanner.EntryExpectation {
		list := ent.Expectations()
		out := make([]scanner.EntryExpectation, 0, len(list))
		for _, e := range list {
			port := 0
			if e.Port != nil {
				port = *e.Port
			}
			out = append(out, scanner.EntryExpectation{
				ID: e.ID, Port: port, Cwd: e.Cwd, Pid: e.Pid, SessionID: e.SessionID,
			})
		}
		return out
	})

	healthSvc := health.New(ctx, ent, sc, health.Options{
		Emit: func(h contract.EntryHealth) { notify("entryHealth", h) },
	})
	nat.ent = ent
	alertSvc := alerts.New(ent, alerts.Options{
		EmitAlert: func(a contract.OutputAlert) { notify("entryAlert", a) },
		// 系统通知由告警服务延迟 3 秒发出，期间崩溃则撤掉
		EmitNotify: nat.notifyAlert,
	})
	nat.alerts = alertSvc
	// 告警的匹配对象是日志中心切好的可见行，不另写切行与去 ANSI
	logsSvc.OnLine(alertSvc.Check)

	transferSvc := transfer.New(cfg, ent, sc, transfer.Options{})

	plannerStore, err := planner.Open(dir)
	if err != nil {
		log.Fatal(err)
	}
	plannerSvc := planner.NewService(plannerStore, cfg, planner.Options{
		OnChanged:  func(s contract.PlannerSnapshot) { notify("plannerChanged", s) },
		OnReminder: nat.notifyPlannerReminder,
	})

	// 原版 groups.on('changed')：推给页面（原样的配置顺序），并重建托盘菜单
	groupsChanged := func() {
		notify("groupChanged", cfg.Get().Groups)
		nat.scheduleTrayRebuild()
	}
	groupRemoved := func(id string) {
		if _, err := plannerSvc.PauseSchedulesOfGroup(id); err != nil {
			log.Printf("暂停工作组日程失败：%v", err)
		}
	}

	// 对应原版 ThemeService：resolved 跟随运行时；set 时同步 themeSource 并广播 changed；
	// 系统外观变化只在偏好为 system 时广播
	resolveTheme := func(p contract.ThemePreference) contract.ResolvedTheme {
		switch p {
		case contract.ThemeLight:
			return contract.ResolvedLight
		case contract.ThemeDark:
			return contract.ResolvedDark
		default:
			if mygo.Theme.IsDark() {
				return contract.ResolvedDark
			}
			return contract.ResolvedLight
		}
	}
	applyTheme := func(p contract.ThemePreference) {
		mygo.Theme.SetSource(mygo.ThemeSource(p))
		notify("themeChanged", contract.ThemeState{Preference: p, Resolved: resolveTheme(p)})
	}

	// 对应原版 index.ts settingsPatch 处理器落盘之后的那几步
	afterSettings := func(patch contract.SettingsPatch, next contract.Settings) {
		// 采集周期改了要立刻生效，否则要等下一轮才换节奏
		if patch.ScanIntervalMs != nil {
			sc.Reschedule()
		}
		// 主题同步运行时并广播（落盘已由 SettingsService 做过）
		if patch.Theme != nil {
			applyTheme(next.Theme)
		}
		// 任务栏可见性即时生效：托盘常驻，隐藏后窗口仍能从托盘唤出
		if patch.HideFromTaskbar != nil {
			applyTaskbarVisibility(next.HideFromTaskbar)
		}
		if patch.GlobalHotkey != nil {
			nat.applyGlobalHotkey()
		}
		notify("settingsChanged", next)
	}

	// 与窗口无关的服务先绑上；窗口相关的在 WhenReady 里绑
	mygo.Bind(
		app.NewAppService(app.Deps{
			Version: appVersion, Name: appName, Cfg: cfg, Logs: logsSvc,
			Events: bus, Transfer: transferSvc,
		}),
		app.NewEntryService(ent, det, healthSvc),
		app.NewGroupService(app.Deps{Cfg: cfg, OnGroupsChanged: groupsChanged, OnGroupRemoved: groupRemoved}, newID, func() int64 { return time.Now().UnixMilli() }),
		app.NewPlannerService(plannerSvc),
		app.NewSessionService(sess),
		app.NewLogService(app.Deps{Logs: logsSvc}),
		app.NewScannerService(sc, cfg),
		app.NewSettingsService(app.Deps{Cfg: cfg, AfterSettingsPatch: afterSettings}),
		app.NewWindowService(app.Deps{Window: windowAdapter{}}),
		app.NewThemeService(app.Deps{Cfg: cfg}, resolveTheme, applyTheme),
		app.NewShellService(app.Deps{Shell: shellAdapter{}}),
		app.NewClipboardService(app.Deps{Clipboard: clipboardAdapter{}}),
		app.NewDialogService(app.Deps{Dialog: dialogAdapter{}, Detect: det}),
		app.NewConfigService(app.Deps{Dialog: dialogAdapter{}, Transfer: transferSvc, OnGroupsChanged: groupsChanged}),
	)

	// 对应原版 createWindow。托盘「显示主窗口」、第二实例、快捷键在窗口已销毁时也走这里
	nat.newWindow = func() *mygo.Window {
		win := mygo.NewWindow(mygo.WindowOptions{
			Title: appName,
			// 对应原版 lib/windowState.ts：DEFAULT_STATE 1440×900，MIN_WIDTH 1180，MIN_HEIGHT 760
			Width:     1440,
			Height:    900,
			MinWidth:  1180,
			MinHeight: 760,
			// 从任务栏隐藏（仅托盘）：构造时读一次，托盘重建窗口也走这条路
			SkipTaskbar: cfg.Get().Settings.HideFromTaskbar,
			// 原版 Windows 是 titleBarStyle: hidden + 页面自绘三个窗口控件（CLAUDE.md §8）。
			// HideWindowButtons 保留阴影、圆角与四边缩放，只把系统按钮让给页面的 TitleBar
			TitleBarStyle:     mygo.TitleBarHidden,
			HideWindowButtons: true,
			TitleBarHeight:    40,
			BackgroundColor:   "light-dark(#f6f7fb, #0f1219)",
			StateKey:          "main",
			URL:               "/",
		})
		curWin.Store(win)
		bus.SetSend(emitFor(win))
		// 新页面开始：未就绪期间的事件进队列，页面订阅完调 ready() 再补投（契约 §2）
		win.Page().OnDidNavigate(func(string) { bus.Navigate() })
		// 窗口销毁后放掉引用：采集、会话输出仍在推送，事件留在队列里等下一个窗口
		win.OnClosed(func() {
			curWin.CompareAndSwap(win, nil)
			bus.Navigate()
		})
		// 原版 index.ts 的 notifyMaximize：最大化 / 还原都推一次当前状态，TitleBar 据此换图标
		notifyMaximize := func() { notify("windowMaximizeChanged", win.IsMaximized()) }
		win.OnMaximize(notifyMaximize)
		win.OnUnmaximize(notifyMaximize)
		nat.hookWindow(win, sc.SetVisible)
		return win
	}

	mygo.App.OnSecondInstance(func([]string, string) {
		if currentWin() == nil {
			if mygo.App.IsReady() {
				nat.newWindow()
			}
			return
		}
		nat.bringToFront()
	})

	// closeToTray 打开时窗口是被 Hide 而非销毁，走不到这里；关掉时按常规退出。
	// 不能无条件退出，否则托盘驻留形同虚设（注册了监听，mygo 就不会自己退出）。
	mygo.App.OnWindowAllClosed(func() {
		if !cfg.Get().Settings.CloseToTray {
			mygo.App.Quit()
		}
	})
	mygo.App.OnBeforeQuit(func(e *mygo.QuitEvent) {
		nat.beforeQuit(e, func() {
			sc.Stop()
			healthSvc.Stop()
			alertSvc.Dispose()
			plannerSvc.Dispose()
		})
	})
	mygo.App.OnWillQuit(func(*mygo.QuitEvent) { mygo.GlobalShortcut.UnregisterAll() })

	mygo.App.WhenReady(func() {
		nat.newWindow()

		// 主题偏好同步给运行时，页面再据 resolved 写 <html data-theme>
		mygo.Theme.SetSource(mygo.ThemeSource(cfg.Get().Settings.Theme))
		mygo.Theme.OnUpdated(func() {
			if p := cfg.Get().Settings.Theme; p == contract.ThemeSystem {
				notify("themeChanged", contract.ThemeState{Preference: p, Resolved: resolveTheme(p)})
			}
		})

		nat.createTray()
		nat.applyGlobalHotkey()
		sc.Start()
		healthSvc.Start()
		// 日程提醒调度（P2 §5.3）：30s 轮询 + 休眠唤醒 / 解锁后立即补查
		plannerSvc.StartScheduler(ctx)
		mygo.Power.OnResume(func() { _ = plannerSvc.Tick() })
		mygo.Power.OnUnlockScreen(func() { _ = plannerSvc.Tick() })
	})

	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
	cancel()
}

// newID 工作组 id（运行时由绑定层注入，这里给一个可预测的兜底）。
func newID() string { return "g-" + itoa(int(time.Now().UnixNano()%1_000_000_000)) }

// itoa 不引 strconv，保持 main 的依赖面最小。
func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var b []byte
	for v > 0 {
		b = append([]byte{byte('0' + v%10)}, b...)
		v /= 10
	}
	if neg {
		return "-" + string(b)
	}
	return string(b)
}
