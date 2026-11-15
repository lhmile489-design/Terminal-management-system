//go:build windows

// 对拍覆盖不到的部分：Go 侧新增的 Node 版本来源（§6「Node 版本来源」）、两处 Windows API 的真机冒烟、
// 已知原版问题 I8，以及默认注入点的接线。

package precheck

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"mile-console/internal/contract"
	"mile-console/internal/detect"
	"mile-console/internal/platform/win32"
)

func npmEntry(dir string) contract.LaunchEntry {
	dev := "dev"
	return contract.LaunchEntry{ID: "e1", Path: dir, Framework: contract.FrameworkReactVite, PackageManager: contract.PackageManagerNpm, Script: &dev}
}

func writeFile(t *testing.T, p, s string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
}

func itemOf(t *testing.T, r contract.PrecheckResult, id string) contract.PrecheckItem {
	t.Helper()
	for _, it := range r.Items {
		if it.ID == id {
			return it
		}
	}
	t.Fatalf("no %s item in %+v", id, r.Items)
	return contract.PrecheckItem{}
}

func stubOptions(path string, node func() (string, bool)) Options {
	return Options{
		Getenv:       func(k string) (string, bool) { return path, strings.EqualFold(k, "PATH") },
		NodeVersion:  node,
		FreeSpace:    func(string) (uint64, error) { return 1 << 40, nil },
		FindFreePort: func(context.Context, int) (int, bool) { return 0, false },
	}
}

// 取不到 Node 版本时（PATH 里没有 node.exe、或读不出版本资源）显示「未知」，不出 warn。
func TestNodeVersionUnknownNeverWarns(t *testing.T) {
	plat := win32.New()
	for _, tc := range []struct{ engines, want string }{
		{``, "未声明 engines.node，当前 未知"},
		{`,"engines":{"node":">=99"}`, "无法解析范围 >=99，当前 未知"},
	} {
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, "package.json"), `{"scripts":{"dev":"x"}`+tc.engines+`}`)
		svc := New(plat, detect.New(plat), stubOptions("", func() (string, bool) { return "", false }))
		r, err := svc.Run(context.Background(), npmEntry(dir), nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		if it := itemOf(t, r, "node"); it.Level != contract.PrecheckPass || it.Detail != tc.want || it.Fix != nil {
			t.Errorf("%+v / want %q", it, tc.want)
		}
	}
}

// 默认的版本来源：PATH 里第一个 node.exe 的版本资源。期望值是生成对拍数据时本机 node 自报的 process.version
// （testdata 的 node 字段）；本机 node 升级后重新生成 testdata 即可。测试同样不执行 node。
func TestPathNodeVersionMatchesNodeItself(t *testing.T) {
	nodePath, err := exec.LookPath("node.exe")
	if err != nil {
		t.Skip("node.exe not on PATH")
	}
	b, err := os.ReadFile("testdata/precheck_cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var meta struct{ Node string }
	if err := json.Unmarshal(b, &meta); err != nil || !strings.HasPrefix(meta.Node, "v") {
		t.Fatalf("testdata node %q %v", meta.Node, err)
	}
	want := strings.TrimPrefix(meta.Node, "v")
	svc := New(win32.New(), nil, Options{Getenv: func(k string) (string, bool) { return filepath.Dir(nodePath), strings.EqualFold(k, "PATH") }})
	got, ok := svc.opt.NodeVersion()
	if !ok || got != want {
		t.Fatalf("got %q %v / want %q (%s)", got, ok, want, nodePath)
	}
}

// 不是 PE 文件、同名目录、不存在：都读不出版本。
func TestFileVersionRejectsNonExecutables(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "a", "node.exe"), "not a pe")
	if err := os.MkdirAll(filepath.Join(dir, "b", "node.exe"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{filepath.Join(dir, "a", "node.exe"), filepath.Join(dir, "b", "node.exe"), filepath.Join(dir, "missing.exe")} {
		if v, ok := fileVersion(p); ok {
			t.Errorf("%s: %q", p, v)
		}
	}
	// PATH 第一个命中的是假 node.exe 时不往后找（与 whichAny 一致：只取第一个），版本记为未知
	svc := New(win32.New(), nil, Options{Getenv: func(string) (string, bool) { return filepath.Join(dir, "a"), true }})
	if v, ok := svc.opt.NodeVersion(); ok {
		t.Errorf("fake node.exe gave %q", v)
	}
}

// 磁盘余量真机冒烟：与 node 的 statfs 口径一致是 bsize * bavail，这里只验合理性；不存在的目录报错，diskItem 跳过。
func TestDiskFreeBytesReal(t *testing.T) {
	free, err := diskFreeBytes(t.TempDir())
	if err != nil || free == 0 {
		t.Fatalf("free %d err %v", free, err)
	}
	if _, err := diskFreeBytes(filepath.Join(t.TempDir(), "no", "such")); err == nil {
		t.Fatal("missing dir should fail")
	}
	svc := New(win32.New(), nil, Options{})
	if it := svc.diskItem(filepath.Join(t.TempDir(), "no", "such")); it.Level != contract.PrecheckPass || it.Detail != "无法读取，跳过" {
		t.Fatalf("%+v", it)
	}
}

// 已知原版问题 I8，见 docs/MIGRATION-PLAN.md：package.json 内容是 null 时原版读 null.scripts 抛 TypeError，run() 整体 reject。
// 照原样搬：返回同文案的错误、不给结果。修的时候这条测试一起改。
func TestKnownIssueI8NullPackageJSON(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "package.json"), "null")
	plat := win32.New()
	r, err := New(plat, detect.New(plat), stubOptions("", nil)).Run(context.Background(), npmEntry(dir), nil, nil)
	if err != ErrNullPackageJSON || r.Items != nil {
		t.Fatalf("%+v %v", r, err)
	}
}

// 默认注入点都接上了真实实现；端口建议默认走 platform.FindFreePort（带着已知原版问题 I2）。
func TestDefaultOptionsWired(t *testing.T) {
	svc := New(win32.New(), nil, Options{})
	if svc.opt.Getenv == nil || svc.opt.NodeVersion == nil || svc.opt.FreeSpace == nil || svc.opt.FindFreePort == nil {
		t.Fatalf("%+v", svc.opt)
	}
}

// WhichAny 导出给 EntryService 用：PATH 未设置与只有空段都找不到。
func TestWhichAnyEmptyPath(t *testing.T) {
	for _, env := range []struct {
		v  string
		ok bool
	}{{"", false}, {";;", true}, {"", true}} {
		svc := New(win32.New(), nil, Options{Getenv: func(string) (string, bool) { return env.v, env.ok }})
		if p, ok := svc.WhichAny([]string{"cmd.exe"}); ok {
			t.Errorf("%+v found %s", env, p)
		}
	}
	// 原版 .filter(Boolean) 丢掉空段：当前目录里恰好有同名文件也不能命中（空段拼出的是相对路径）
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "npm.cmd"), "")
	t.Chdir(dir)
	svc := New(win32.New(), nil, Options{Getenv: func(string) (string, bool) { return ";", true }})
	if p, ok := svc.WhichAny([]string{"npm.cmd"}); ok {
		t.Errorf("empty segment resolved to %s", p)
	}
}
