// S24 单测：sanitizeSettings 与 sanitizeLogQuery 的逐分支校验，外加几个绑定的薄层行为。

package app

import (
	"context"
	"strings"
	"testing"

	"mile-console/internal/contract"
)

func intp(v int) *int                                             { return &v }
func boolp(v bool) *bool                                          { return &v }
func themep(v contract.ThemePreference) *contract.ThemePreference { return &v }

func TestSanitizeSettingsAcceptsValidFields(t *testing.T) {
	prev := contract.Settings{ScanIntervalMs: 2000, Theme: contract.ThemeSystem, TerminalFontSize: 14, PlannerSound: true}
	next, err := SanitizeSettings(prev, contract.SettingsPatch{
		ScanIntervalMs:   intp(5000),
		Theme:            themep(contract.ThemeDark),
		TerminalFontSize: intp(18),
		Scrollback:       intp(20_000),
		CloseToTray:      boolp(true),
		PlannerSound:     boolp(false),
	})
	if err != nil {
		t.Fatal(err)
	}
	if next.ScanIntervalMs != 5000 || next.Theme != contract.ThemeDark || next.TerminalFontSize != 18 {
		t.Fatalf("补丁没生效：%+v", next)
	}
	if next.Scrollback != 20_000 || !next.CloseToTray || next.PlannerSound {
		t.Fatalf("布尔项没生效：%+v", next)
	}
}

func TestSanitizeSettingsKeepsUntouchedFields(t *testing.T) {
	prev := contract.Settings{ScanIntervalMs: 2000, Theme: contract.ThemeDark, Scrollback: 5000, CloseToTray: true}
	next, err := SanitizeSettings(prev, contract.SettingsPatch{ScanIntervalMs: intp(1000)})
	if err != nil {
		t.Fatal(err)
	}
	if next.Theme != contract.ThemeDark || next.Scrollback != 5000 || !next.CloseToTray {
		t.Fatalf("没带的字段不该变：%+v", next)
	}
}

func TestSanitizeSettingsRejects(t *testing.T) {
	prev := contract.Settings{}
	cases := []struct {
		name  string
		patch contract.SettingsPatch
		want  string
	}{
		{"采集周期", contract.SettingsPatch{ScanIntervalMs: intp(1500)}, "采集周期只接受"},
		{"主题", contract.SettingsPatch{Theme: themep("blue")}, "主题只接受 light / dark / system"},
		{"外部终端", contract.SettingsPatch{ExternalTerminal: func() *contract.ExternalTerminal {
			v := contract.ExternalTerminal("kitty")
			return &v
		}()}, "外部终端只接受"},
		{"字号下限", contract.SettingsPatch{TerminalFontSize: intp(9)}, "终端字号只接受"},
		{"字号上限", contract.SettingsPatch{TerminalFontSize: intp(23)}, "终端字号只接受"},
		{"回滚下限", contract.SettingsPatch{Scrollback: intp(999)}, "回滚行数只接受"},
		{"回滚上限", contract.SettingsPatch{Scrollback: intp(50_001)}, "回滚行数只接受"},
	}
	for _, c := range cases {
		_, err := SanitizeSettings(prev, c.patch)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s：got %v want 含 %q", c.name, err, c.want)
		}
	}
	// 报文里要带上全部合法采集周期
	_, err := SanitizeSettings(prev, contract.SettingsPatch{ScanIntervalMs: intp(1)})
	if err == nil || !strings.Contains(err.Error(), "1000 / 2000 / 5000 / 10000") {
		t.Fatalf("采集周期的提示文案不对：%v", err)
	}
}

func TestSanitizeLogQuery(t *testing.T) {
	sid := "s1"
	level := contract.LogLevelWarn
	text := "  needle  "
	limit := 10
	q, err := SanitizeLogQuery(contract.LogQuery{SessionID: &sid, Level: &level, Text: &text, Limit: &limit})
	if err != nil {
		t.Fatal(err)
	}
	if q.SessionID == nil || *q.SessionID != "s1" || q.Level == nil || *q.Level != contract.LogLevelWarn {
		t.Fatalf("字段没透传：%+v", q)
	}
	if q.Text == nil || *q.Text != "  needle  " {
		t.Fatalf("关键字应原样保留（由日志中心自己 trim）：%q", *q.Text)
	}
	if q.Limit == nil || *q.Limit != 10 {
		t.Fatalf("limit 应透传：%v", q.Limit)
	}

	bad := contract.LogLevel("trace")
	if _, err := SanitizeLogQuery(contract.LogQuery{Level: &bad}); err == nil {
		t.Fatal("非法级别应被拒")
	}
	// 超长关键字截到 200 个码元
	long := strings.Repeat("x", 300)
	q, err = SanitizeLogQuery(contract.LogQuery{Text: &long})
	if err != nil {
		t.Fatal(err)
	}
	if len(*q.Text) != 200 {
		t.Fatalf("关键字应截到 200：%d", len(*q.Text))
	}
	// 空查询合法
	if _, err := SanitizeLogQuery(contract.LogQuery{}); err != nil {
		t.Fatalf("空查询应合法：%v", err)
	}
}

type fakeStore struct {
	cfg     contract.AppConfig
	patches int
}

func (f *fakeStore) Get() contract.AppConfig { return f.cfg }
func (f *fakeStore) PatchSettings(fn func(st *contract.Settings)) (contract.AppConfig, error) {
	fn(&f.cfg.Settings)
	f.patches++
	return f.cfg, nil
}
func (f *fakeStore) Patch(fn func(c *contract.AppConfig)) (contract.AppConfig, error) {
	fn(&f.cfg)
	f.patches++
	return f.cfg, nil
}

func TestSettingsServicePatchRejectsWithoutPersisting(t *testing.T) {
	store := &fakeStore{cfg: contract.AppConfig{Settings: contract.Settings{ScanIntervalMs: 2000}}}
	svc := NewSettingsService(Deps{Cfg: store})
	if _, err := svc.Patch(context.Background(), contract.SettingsPatch{ScanIntervalMs: intp(1234)}); err == nil {
		t.Fatal("非法值应报错")
	}
	if store.patches != 0 {
		t.Fatal("非法值不该落盘")
	}
	got, err := svc.Patch(context.Background(), contract.SettingsPatch{ScanIntervalMs: intp(5000)})
	if err != nil || got.ScanIntervalMs != 5000 || store.patches != 1 {
		t.Fatalf("合法补丁应落盘一次：%+v %v %d", got, err, store.patches)
	}
}

func TestThemeServiceSetValidates(t *testing.T) {
	store := &fakeStore{cfg: contract.AppConfig{Settings: contract.Settings{Theme: contract.ThemeSystem}}}
	svc := NewThemeService(Deps{Cfg: store}, func(p contract.ThemePreference) contract.ResolvedTheme {
		if p == contract.ThemeDark {
			return contract.ResolvedDark
		}
		return contract.ResolvedLight
	})
	state, err := svc.Set(context.Background(), "dark")
	if err != nil || state.Preference != contract.ThemeDark || state.Resolved != contract.ResolvedDark {
		t.Fatalf("设置主题：%+v %v", state, err)
	}
	if _, err := svc.Set(context.Background(), "blue"); err == nil {
		t.Fatal("非法主题应被拒")
	}
	if store.patches != 1 {
		t.Fatalf("只有一次合法落盘：%d", store.patches)
	}
}

func TestShellServiceValidatesInputs(t *testing.T) {
	var opened []string
	svc := NewShellService(Deps{Shell: &fakeShell{onLocalhost: func(p int) { opened = append(opened, "port") }, onLink: func(k contract.ProjectLink) {
		opened = append(opened, string(k))
	}}})
	ctx := context.Background()
	if err := svc.OpenLocalhost(ctx, 0); err == nil {
		t.Fatal("端口 0 应被拒")
	}
	if err := svc.OpenLocalhost(ctx, 65536); err == nil {
		t.Fatal("端口 65536 应被拒")
	}
	if err := svc.OpenLocalhost(ctx, 3000); err != nil {
		t.Fatal(err)
	}
	if err := svc.OpenProjectLink(ctx, "nope"); err == nil {
		t.Fatal("未知键名应被拒")
	}
	for key := range contract.ProjectLinks {
		if err := svc.OpenProjectLink(ctx, string(key)); err != nil {
			t.Fatalf("%s 应被放行：%v", key, err)
		}
		break
	}
	if len(opened) != 2 {
		t.Fatalf("应真的调了两次外链：%v", opened)
	}
	if err := svc.OpenPath(ctx, "  "); err == nil {
		t.Fatal("空路径应被拒")
	}
}

type fakeShell struct {
	onLocalhost func(int)
	onLink      func(contract.ProjectLink)
	onPath      func(string)
}

func (f *fakeShell) OpenLocalhost(port int) error {
	if f.onLocalhost != nil {
		f.onLocalhost(port)
	}
	return nil
}
func (f *fakeShell) OpenPath(target string) error {
	if f.onPath != nil {
		f.onPath(target)
	}
	return nil
}
func (f *fakeShell) OpenProjectLink(key contract.ProjectLink) error {
	if f.onLink != nil {
		f.onLink(key)
	}
	return nil
}
