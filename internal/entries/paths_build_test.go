// S21d 单测：路径与产物、图片接线、HBuilderX、安装与构建命令。

package entries

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mile-console/internal/contract"
	"mile-console/internal/detect"
)

type fakeImages struct {
	saved   []byte
	id      string
	readOK  bool
	readVal string
}

func (f *fakeImages) SaveFromData(data []byte) (string, error) {
	f.saved = data
	if f.id == "" {
		return "abcdef123456.png", nil
	}
	return f.id, nil
}

func (f *fakeImages) Read(string) (string, bool) { return f.readVal, f.readOK }

func TestTerminalCwdRejectsOutsideAndMissing(t *testing.T) {
	root := t.TempDir()
	inside := filepath.Join(root, "sub")
	if err := os.MkdirAll(inside, 0o755); err != nil {
		t.Fatal(err)
	}
	rig := newUnitRig(t, nil)
	_ = rig

	entry := mkEntry("e1", func(e *contract.LaunchEntry) { e.Path = root })
	store := &fakeStore{cfg: contract.AppConfig{Entries: []contract.LaunchEntry{entry}}}

	svc := New(context.Background(), store, fakePlatform{}, &fakeSessions{rec: &recorder{}}, Options{})

	cwd, name, err := svc.TerminalCwd("e1")
	if err != nil || cwd != root || name != "条目e1" {
		t.Fatalf("正常解析：%q %q %v", cwd, name, err)
	}

	// cwd 跳出项目根（旧配置）
	store.cfg.Entries[0].Cwd = "../escape"
	if _, _, err := svc.TerminalCwd("e1"); err == nil || !strings.Contains(err.Error(), "不在条目路径") {
		t.Fatalf("越界应拒绝，得到 %v", err)
	}

	// 目录不存在
	store.cfg.Entries[0].Cwd = ""
	store.cfg.Entries[0].Path = filepath.Join(root, "missing")
	if _, _, err := svc.TerminalCwd("e1"); err == nil || !strings.Contains(err.Error(), "目录不存在") {
		t.Fatalf("不存在应拒绝，得到 %v", err)
	}

	if _, _, err := svc.TerminalCwd("nope"); err == nil {
		t.Fatal("未知 id 应报错")
	}
}

func TestOutputDirAndReveal(t *testing.T) {
	root := t.TempDir()
	rig := newUnitRig(t, nil)
	entry := mkEntry("e1", func(e *contract.LaunchEntry) { e.Path = root })
	store := &fakeStore{cfg: contract.AppConfig{Entries: []contract.LaunchEntry{entry}}}
	svc := New(context.Background(), store, fakePlatform{}, &fakeSessions{rec: &recorder{}}, Options{})
	_ = rig

	// 没有产物目录
	if svc.OutputDir("e1") != nil {
		t.Fatal("没有产物目录时应返回 nil")
	}
	if got := svc.RevealOutput("e1"); got.Kind != "none" || got.Path != nil {
		t.Fatalf("没有产物应报 none：%+v", got)
	}

	// 配置了 outputDir：存在才返回
	dist := filepath.Join(root, "dist")
	if err := os.MkdirAll(dist, 0o755); err != nil {
		t.Fatal(err)
	}
	store.cfg.Entries[0].OutputDir = "dist"
	if got := svc.OutputDir("e1"); got == nil || *got != dist {
		t.Fatalf("配置的产物目录没找到：%v", got)
	}

	// 旧配置里的绝对路径读取侧也要拒
	store.cfg.Entries[0].OutputDir = `C:\evil`
	if svc.OutputDir("e1") != nil {
		t.Fatal("绝对路径的 outputDir 应被拒")
	}
	store.cfg.Entries[0].OutputDir = "../evil"
	if svc.OutputDir("e1") != nil {
		t.Fatal("带 .. 的 outputDir 应被拒")
	}

	// 没配置时按候选顺序探测
	store.cfg.Entries[0].OutputDir = ""
	build := filepath.Join(root, "build")
	if err := os.MkdirAll(build, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := svc.OutputDir("e1"); got == nil || *got != filepath.Join(root, "dist") {
		t.Fatalf("应优先命中 dist：%v", got)
	}

	// 产物优先级：安装包 > 压缩包 > jar > 网页入口
	for _, n := range []string{"index.html", "app.jar", "bundle.zip", "setup.exe"} {
		if err := os.WriteFile(filepath.Join(dist, n), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got := svc.RevealOutput("e1")
	if got.Kind != "file" || got.Path == nil || filepath.Base(*got.Path) != "setup.exe" {
		t.Fatalf("应优先安装包：%+v", got)
	}
}

func TestKnownPathAndPackageJson(t *testing.T) {
	root := t.TempDir()
	store := &fakeStore{cfg: contract.AppConfig{Entries: []contract.LaunchEntry{
		mkEntry("e1", func(e *contract.LaunchEntry) { e.Path = root; e.OutputDir = "dist" }),
		mkEntry("e2", func(e *contract.LaunchEntry) { e.Path = root; e.OutputDir = `C:\evil` }),
	}}}
	svc := New(context.Background(), store, fakePlatform{}, &fakeSessions{rec: &recorder{}}, Options{})

	if !svc.KnownPath(root) {
		t.Fatal("条目目录应命中")
	}
	if !svc.KnownPath(filepath.Join(root, "DIST")) {
		t.Fatal("产物目录应命中（Windows 大小写不敏感）")
	}
	if svc.KnownPath(filepath.Join(root, "evil")) {
		t.Fatal("绝对路径的 outputDir 不该进白名单")
	}
	if p, ok := svc.PackageJsonPath("e1"); !ok || filepath.Base(p) != "package.json" {
		t.Fatalf("packageJsonPath = %q %v", p, ok)
	}
	if _, ok := svc.PackageJsonPath("nope"); ok {
		t.Fatal("未知条目应返回 false")
	}
}

func TestListJarsFilters(t *testing.T) {
	root := t.TempDir()
	rig := newUnitRig(t, []contract.LaunchEntry{mkEntry("e1", func(e *contract.LaunchEntry) {
		e.Path = root
		e.Framework = contract.FrameworkSpringBoot
	})})
	if got := rig.svc.ListJars("e1"); got != nil {
		t.Fatalf("没有 target 时应为空：%v", got)
	}
	target := filepath.Join(root, "target")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"app.jar", "app-sources.jar", "app-javadoc.jar", "original-app.jar", "app.txt", "upper.JAR"} {
		if err := os.WriteFile(filepath.Join(target, n), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got := rig.svc.ListJars("e1")
	if len(got) != 2 || got[0] != "target/app.jar" || got[1] != "target/upper.JAR" {
		t.Fatalf("jar 过滤不对：%v", got)
	}
	// 非 Spring Boot 条目直接空
	rig.store.cfg.Entries[0].Framework = contract.FrameworkNext
	if got := rig.svc.ListJars("e1"); got != nil {
		t.Fatal("非 Spring Boot 不该扫 jar")
	}
}

func TestMavenGoalAndPackageCommands(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{"mvnw.cmd", "gradlew.bat"} {
		if err := os.WriteFile(filepath.Join(dir, n), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	rig := newUnitRig(t, nil)
	// system-maven / system-gradle 要经 whichAny 定位，这里给一个恒命中的假实现
	rig.svc.opt.Which = func(c []string) (string, bool) { return "C:/bin/" + c[0], true }
	sb := func(mode contract.LaunchMode) contract.LaunchEntry {
		return mkEntry("e", func(e *contract.LaunchEntry) {
			e.Framework, e.LaunchMode, e.Path = contract.FrameworkSpringBoot, mode, dir
		})
	}

	cases := []struct {
		mode contract.LaunchMode
		goal contract.MavenGoal
		sub  string
	}{
		{contract.LaunchModeMavenWrapper, contract.MavenGoalPackage, "package"},
		{contract.LaunchModeMavenWrapper, contract.MavenGoalClean, "clean"},
		{contract.LaunchModeGradleWrapper, contract.MavenGoalCompile, "compileJava"},
		{contract.LaunchModeGradleWrapper, contract.MavenGoalInstall, "publishToMavenLocal"},
		{contract.LaunchModeSystemMaven, contract.MavenGoalVerify, "verify"},
		{contract.LaunchModeSystemGradle, contract.MavenGoalPackage, "build"},
	}
	for _, c := range cases {
		cmd, err := rig.svc.BuildMavenGoalCommand(sb(c.mode), dir, c.goal)
		if err != nil {
			t.Fatalf("%s/%s: %v", c.mode, c.goal, err)
		}
		if !contains(cmd.Args, c.sub) {
			t.Errorf("%s/%s 的参数 %v 里没有 %q", c.mode, c.goal, cmd.Args, c.sub)
		}
		if !strings.Contains(cmd.Title, c.sub) {
			t.Errorf("%s/%s 标题 = %q", c.mode, c.goal, cmd.Title)
		}
	}

	// jar 模式没有内置构建命令
	if _, err := rig.svc.BuildMavenGoalCommand(sb(contract.LaunchModeJar), dir, contract.MavenGoalPackage); err == nil || !strings.Contains(err.Error(), "jar 模式无内置构建命令") {
		t.Fatalf("jar 模式应报错：%v", err)
	}
	if _, err := rig.svc.BuildPackageCommand(sb(contract.LaunchModeJar), dir, nil); err == nil || !strings.Contains(err.Error(), "jar 模式无内置构建命令") {
		t.Fatalf("打包在 jar 模式应报错：%v", err)
	}

	// 打包：Maven 用两个独立参数，Gradle 用 -P<profile>
	profile := "prod"
	cmd, err := rig.svc.BuildPackageCommand(sb(contract.LaunchModeMavenWrapper), dir, &profile)
	if err != nil {
		t.Fatal(err)
	}
	if !contains(cmd.Args, "-P") || !contains(cmd.Args, "prod") {
		t.Fatalf("maven profile 参数：%v", cmd.Args)
	}
	if cmd.Title != "mvnw package -P prod" {
		t.Fatalf("maven 打包标题 = %q", cmd.Title)
	}
	cmd, err = rig.svc.BuildPackageCommand(sb(contract.LaunchModeGradleWrapper), dir, &profile)
	if err != nil {
		t.Fatal(err)
	}
	if !contains(cmd.Args, "-Pprod") {
		t.Fatalf("gradle profile 参数：%v", cmd.Args)
	}
	if cmd.Title != "gradlew build -Pprod" {
		t.Fatalf("gradle 打包标题 = %q", cmd.Title)
	}
	// 不带 profile
	cmd, err = rig.svc.BuildPackageCommand(sb(contract.LaunchModeMavenWrapper), dir, nil)
	if err != nil || contains(cmd.Args, "-P") {
		t.Fatalf("不带 profile 时不该有 -P：%v %v", cmd.Args, err)
	}
}

func TestPackageWithProfileValidation(t *testing.T) {
	rig := newUnitRig(t, []contract.LaunchEntry{mkEntry("e1", func(e *contract.LaunchEntry) {
		e.Framework = contract.FrameworkSpringBoot
	})})
	bad := []string{"prod;rm", "a b", strings.Repeat("p", 65), "生产"}
	for _, p := range bad {
		if _, err := rig.svc.PackageWithProfile("e1", &p); err == nil || !strings.Contains(err.Error(), "Profile 名非法") {
			t.Errorf("%q 应被拒：%v", p, err)
		}
	}
	// 非 Spring Boot
	rig.store.cfg.Entries[0].Framework = contract.FrameworkNext
	ok := "prod"
	if _, err := rig.svc.PackageWithProfile("e1", &ok); err == nil {
		t.Fatal("非 Spring Boot 应被拒")
	}
}

func TestMavenRunValidation(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "mvnw.cmd"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	rig := newUnitRig(t, []contract.LaunchEntry{mkEntry("e1", func(e *contract.LaunchEntry) {
		e.Framework, e.LaunchMode, e.Path = contract.FrameworkSpringBoot, contract.LaunchModeMavenWrapper, dir
	})})
	// 启动方式合法、目录就绪，唯一的问题只能是 goal —— 这样才验得到白名单那一步
	if err := os.MkdirAll(filepath.Join(dir, "target"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := rig.svc.MavenRun("e1", "bogus"); err == nil || !strings.Contains(err.Error(), "非法构建目标") {
		t.Fatalf("非法 goal 应被拒：%v", err)
	}
	rig.svc.putRuntime(contract.EntryRuntime{EntryID: "e1", Status: contract.EntryRunning})
	if _, err := rig.svc.MavenRun("e1", contract.MavenGoalPackage); err == nil || !strings.Contains(err.Error(), "正在运行中") {
		t.Fatalf("运行中应拒绝构建：%v", err)
	}
	rig.store.cfg.Entries[0].Framework = contract.FrameworkNext
	if _, err := rig.svc.MavenRun("e1", contract.MavenGoalPackage); err == nil {
		t.Fatal("非 Spring Boot 应被拒")
	}
}

func TestInstallValidation(t *testing.T) {
	rig := newUnitRig(t, []contract.LaunchEntry{mkEntry("e1", func(e *contract.LaunchEntry) {
		e.Framework = contract.FrameworkSpringBoot
	})})
	if _, err := rig.svc.Install("e1"); err == nil || !strings.Contains(err.Error(), "不支持 npm 安装会话") {
		t.Fatalf("Spring Boot 不该有安装会话：%v", err)
	}
	rig.store.cfg.Entries[0].Framework = contract.FrameworkNext
	rig.svc.putRuntime(contract.EntryRuntime{EntryID: "e1", Status: contract.EntryRunning})
	if _, err := rig.svc.Install("e1"); err == nil {
		t.Fatal("运行中应拒绝安装")
	}
	rig.svc.putRuntime(contract.EntryRuntime{EntryID: "e1", Status: contract.EntryIdle})
	rig.store.cfg.Entries[0].Path = serviceDir(t)
	rig.svc.opt.Which = func(c []string) (string, bool) { return "C:/bin/" + c[0], true }
	rt, err := rig.svc.Install("e1")
	if err != nil {
		t.Fatal(err)
	}
	if rt.Status != contract.EntryRunning {
		t.Fatalf("安装会话应直接 running：%s", rt.Status)
	}
}

func TestSwitchPortGoesThroughEdit(t *testing.T) {
	rig := newUnitRig(t, []contract.LaunchEntry{mkEntry("e1", nil), mkEntry("t1", func(e *contract.LaunchEntry) {
		e.Kind = contract.EntryKindTask
	})})
	if err := rig.svc.SwitchPort("e1", 4321); err != nil {
		t.Fatal(err)
	}
	if got := rig.store.cfg.Entries[0].ExpectedPort; got == nil || *got != 4321 {
		t.Fatalf("端口没写进去：%v", got)
	}
	if err := rig.svc.SwitchPort("e1", 70000); err == nil {
		t.Fatal("越界端口应被拒")
	}
	if err := rig.svc.SwitchPort("t1", 3000); err == nil {
		t.Fatal("任务不设端口")
	}
	rid := rig.store.cfg.Entries[0].ID
	rig.svc.putRuntime(contract.EntryRuntime{EntryID: rid, Status: contract.EntryRunning})
	if err := rig.svc.SwitchPort(rid, 3000); err == nil {
		t.Fatal("运行中改端口应被拒")
	}
}

func TestSetImageAndClearImage(t *testing.T) {
	imgs := &fakeImages{}
	rig := newUnitRig(t, []contract.LaunchEntry{mkEntry("e1", nil)})
	rig.svc.opt.Images = imgs

	id, err := rig.svc.SetImage("e1", []byte("png-bytes"))
	if err != nil {
		t.Fatal(err)
	}
	if id != "abcdef123456.png" || string(imgs.saved) != "png-bytes" {
		t.Fatalf("图片没存进去：%q %q", id, imgs.saved)
	}
	if got := rig.store.cfg.Entries[0].ImageID; got != id {
		t.Fatalf("imageId 没回填：%q", got)
	}

	imgs.readOK, imgs.readVal = true, "data:image/png;base64,AAA"
	if url, ok := rig.svc.ImageDataURL("e1"); !ok || url != imgs.readVal {
		t.Fatalf("读图片 = %q %v", url, ok)
	}

	if _, err := rig.svc.ClearImage("e1"); err != nil {
		t.Fatal(err)
	}
	if got := rig.store.cfg.Entries[0].ImageID; got != "" {
		t.Fatalf("清除后还有 imageId：%q", got)
	}
	if _, ok := rig.svc.ImageDataURL("e1"); ok {
		t.Fatal("清除后应读不到")
	}
}

func TestFaviconOnlyForWebFrameworks(t *testing.T) {
	called := 0
	rig := newUnitRig(t, []contract.LaunchEntry{
		mkEntry("web", func(e *contract.LaunchEntry) { e.Framework = contract.FrameworkNext }),
		mkEntry("svc", func(e *contract.LaunchEntry) { e.Framework = contract.FrameworkGo }),
	})
	rig.svc.opt.ReadFavicon = func(string) *detect.Favicon {
		called++
		return &detect.Favicon{MIME: "image/png", Base64: "AAA"}
	}
	if url, ok := rig.svc.Favicon("web"); !ok || url != "data:image/png;base64,AAA" {
		t.Fatalf("前端条目应拿到 favicon：%q %v", url, ok)
	}
	if _, ok := rig.svc.Favicon("svc"); ok {
		t.Fatal("后端条目不该读 favicon")
	}
	if called != 1 {
		t.Fatalf("不该为后端条目调用读取：%d", called)
	}
}

// 已知原版问题 I1：cli 的绝对路径经 cmd.exe /d /s /c 转发，含空格时 cmd 会拆断。
// 这里钉住原样行为（argv 里仍是一个元素），修的时候测试一起改。
func TestOpenInHBuilderXArgsAndI1(t *testing.T) {
	// 假 cli 放在带空格的目录里，模拟 Program Files
	base := filepath.Join(t.TempDir(), "Program Files", "HBuilderX")
	if err := os.MkdirAll(base, 0o755); err != nil {
		t.Fatal(err)
	}
	cli := filepath.Join(base, "cli.exe")
	if err := os.WriteFile(cli, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	proj := t.TempDir()
	rig := newUnitRig(t, []contract.LaunchEntry{
		mkEntry("uni", func(e *contract.LaunchEntry) { e.Framework = contract.FrameworkUniapp; e.Path = proj }),
		mkEntry("web", func(e *contract.LaunchEntry) { e.Framework = contract.FrameworkNext; e.Path = proj }),
	})
	rig.svc.plat = &hbxPlatform{cli: cli}

	var gotFile string
	var gotArgs []string
	rig.svc.opt.SpawnDetached = func(file string, args []string) error {
		gotFile, gotArgs = file, args
		return nil
	}

	ok, err := rig.svc.OpenInHBuilderX("web")
	if ok || err == nil {
		t.Fatal("非 uniapp 应被拒")
	}
	// cwd 跳出条目根：拒绝
	rig.store.cfg.Entries[0].Cwd = "../escape"
	if _, err := rig.svc.OpenInHBuilderX("uni"); err == nil || !strings.Contains(err.Error(), "不在条目路径") {
		t.Fatalf("越界 cwd 应被拒：%v", err)
	}
	rig.store.cfg.Entries[0].Cwd = ""

	ok, err = rig.svc.OpenInHBuilderX("uni")
	if !ok || err != nil {
		t.Fatalf("uniapp 应能打开：%v", err)
	}
	if gotFile != "cmd.exe" || len(gotArgs) < 6 {
		t.Fatalf("包装不对：%q %v", gotFile, gotArgs)
	}
	// I1：含空格的 cli 路径在 argv 里仍是一个元素，但 cmd 重新解析时会拆断
	if gotArgs[3] != cli {
		t.Fatalf("cli 路径应原样作为一个参数：%q", gotArgs[3])
	}
	if !strings.Contains(gotArgs[3], " ") {
		t.Fatal("夹具路径应含空格才能覆盖 I1 场景")
	}
	if !contains(gotArgs, "--path") {
		t.Fatalf("argv 里应带 --path：%v", gotArgs)
	}
	if gotArgs[len(gotArgs)-1] != proj {
		t.Fatalf("项目路径应原样传入：%v", gotArgs)
	}
}

// hbxPlatform 只覆盖 HBuilderX 候选，其余沿用 fakePlatform。
type hbxPlatform struct {
	fakePlatform
	cli string
}

func (p *hbxPlatform) HBuilderXCandidates() []string {
	return []string{filepath.Join(os.TempDir(), "mile-no-such-hbuilderx", "cli.exe"), p.cli}
}

func contains(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}
