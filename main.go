// Mile Console 的装配入口（S24）。
//
// 顺序即依赖顺序：配置 → 归属 → 会话 → 日志 → 识别 → 预检 → 扫描器 → 条目 →
// 健康 / 告警 / 导入导出 / 进度。业务规则都在各服务里，这里只接线。
//
// 根 ctx：mygo 目前没有 App.Context()，所以由 main 自己造一个，`App.Run()` 返回后取消。
// 它在语义上就是「应用生命周期」，绑定方法里仍然不出现 context.Background()。
//
// 未接入的两处（都因为 mygo v0.8.3 的 Dialog 只有 Error、没有文件/目录选择框）：
//   - DialogService.PickDirectory：新增条目选目录的主流程，需要运行时的目录选择器
//   - ConfigService.Export / Import：路径只能来自系统对话框（红线），没有对话框就没有可信路径
// 两者都不绑定；页面调用对应方法会失败。见 MIGRATION-PLAN §6「运行时缺少文件对话框」。

package main

import (
	"context"
	"errors"
	"log"
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
)

// mainWin 主窗口，WhenReady 里赋值。
//
// 为什么不让适配器直接持有窗口：`mygo generate` 只扫**顶层**的 mygo.Bind，
// 把 Bind 放进 WhenReady 会生成不出 WindowService / ThemeService / ShellService /
// ClipboardService 四个服务（实测过）。所以四个绑定放顶层，窗口在用时惰性取。
var mainWin *mygo.Window

// windowAdapter 把 mygo 的窗口方法包成 app.WindowOS（那边要 error 与返回值）。
type windowAdapter struct{}

func (windowAdapter) Minimize() error {
	if mainWin == nil {
		return errNoWindow
	}
	mainWin.Minimize()
	return nil
}
func (windowAdapter) ToggleMaximize() (bool, error) {
	if mainWin == nil {
		return false, errNoWindow
	}
	mainWin.ToggleMaximize()
	return mainWin.IsMaximized(), nil
}
func (windowAdapter) Close() error {
	if mainWin == nil {
		return errNoWindow
	}
	mainWin.Close()
	return nil
}
func (windowAdapter) IsMaximized() bool { return mainWin != nil && mainWin.IsMaximized() }

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

// themeBinding 在 app.ThemeService 之外再把偏好同步给运行时（页面据 resolved 写 data-theme）。
type themeBinding struct{ app.ThemeService }

func (t themeBinding) Set(ctx context.Context, pref string) (contract.ThemeState, error) {
	state, err := t.ThemeService.Set(ctx, pref)
	if err != nil {
		return state, err
	}
	mygo.Theme.SetSource(mygo.ThemeSource(pref))
	return state, nil
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

	imageDir, err := images.DefaultDir()
	if err != nil {
		log.Fatal(err)
	}
	imageSvc := images.New(imageDir)

	var ent *entries.Service
	ent = entries.New(ctx, cfg, plat, sess, entries.Options{
		Emit:      notify,
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
	alertSvc := alerts.New(ent, alerts.Options{
		EmitAlert: func(a contract.OutputAlert) { notify("entryAlert", a) },
	})
	// 告警的匹配对象是日志中心切好的可见行，不另写切行与去 ANSI
	logsSvc.OnLine(alertSvc.Check)

	transferSvc := transfer.New(cfg, ent, sc, transfer.Options{})

	plannerStore, err := planner.Open(dir)
	if err != nil {
		log.Fatal(err)
	}
	plannerSvc := planner.NewService(plannerStore, cfg, planner.Options{
		OnChanged:  func(s contract.PlannerSnapshot) { notify("plannerChanged", s) },
		OnReminder: func(f contract.ReminderFire) { notify("plannerReminder", f) },
	})

	// 与窗口无关的服务先绑上；窗口相关的在 WhenReady 里绑
	mygo.Bind(
		app.NewAppService(app.Deps{
			Version: appVersion, Name: appName, Cfg: cfg, Logs: logsSvc,
			Events: bus, Transfer: transferSvc,
		}),
		app.NewEntryService(ent, det, healthSvc),
		app.NewGroupService(app.Deps{Cfg: cfg}, newID, func() int64 { return time.Now().UnixMilli() }),
		app.NewPlannerService(plannerSvc),
		app.NewSessionService(sess),
		app.NewLogService(app.Deps{Logs: logsSvc}),
		app.NewScannerService(sc, cfg),
		app.NewSettingsService(app.Deps{Cfg: cfg}),
		app.NewWindowService(app.Deps{Window: windowAdapter{}}),
		app.NewThemeService(app.Deps{Cfg: cfg}, func(p contract.ThemePreference) contract.ResolvedTheme {
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
		}),
		app.NewShellService(app.Deps{Shell: shellAdapter{}}),
		app.NewClipboardService(app.Deps{Clipboard: clipboardAdapter{}}),
	)

	mygo.App.WhenReady(func() {
		win := mygo.NewWindow(mygo.WindowOptions{
			Title:           appName,
			Width:           1440,
			Height:          900,
			MinWidth:        960,
			MinHeight:       600,
			BackgroundColor: "light-dark(#f6f7fb, #0f1219)",
			StateKey:        "main",
			URL:             "/",
		})
		mainWin = win
		bus.SetSend(emitFor(win))

		// 主题偏好同步给运行时，页面再据 resolved 写 <html data-theme>
		mygo.Theme.SetSource(mygo.ThemeSource(cfg.Get().Settings.Theme))

		sc.Start()
		healthSvc.Start()
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
