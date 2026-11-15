// 对应 src/main/services/DetectService.ts 第 314–564、642–667 行：DetectService 类
// （detect、fallback、detectPackageManager、lockfileFor、scanChildren）与 resolveFramework、pick、toStringRecord。
//
// 项目识别，PRD §8。只读 package.json 与锁文件、标记文件的存在性与文本 —— 不执行项目代码、不 `npm ls`、
// 不安装依赖、不跑任何版本查询（红线 1）。识别不出来就交给用户手填。
//
// 原版方法都是 async，读文件失败一律吞掉；这里是同步函数，语义相同。

package detect

import (
	"os"
	"strings"

	"mile-console/internal/contract"
	"mile-console/internal/platform"
)

// Platform detect 用到的平台差异：wrapper 文件名、本平台不支持的启动方式。
type Platform interface {
	WrapperFile() platform.WrapperFiles
	UnsupportedLaunchModes() map[contract.LaunchMode]bool
}

// Service 即原版 DetectService。没有可变状态，可以并发调用。
type Service struct {
	wrappers    platform.WrapperFiles
	unsupported map[contract.LaunchMode]bool
}

// New 用平台实现构造。
func New(p Platform) *Service {
	return &Service{wrappers: p.WrapperFile(), unsupported: p.UnsupportedLaunchModes()}
}

// DevCandidates / BuildCandidates 原版 DEV_CANDIDATES / BUILD_CANDIDATES。
var (
	DevCandidates   = []string{"dev", "serve", "start", "dev:local", "develop"}
	BuildCandidates = []string{"build:prod", "build:production", "build:pro", "build"}
)

func strPtr(s string) *string { return &s }

// Detect 识别一个目录。
func (s *Service) Detect(path string) contract.DetectResult {
	warnings := []string{}
	pkgPath := jsJoin(path, "package.json")

	var pkg *jsValue
	if b, err := os.ReadFile(pkgPath); err != nil {
		// 目录不存在、无 package.json 都落到这里，区分靠 exists；读目录这类失败要把 node 的文案带出来
		if exists(pkgPath) {
			warnings = append(warnings, "package.json 解析失败："+readErrorMessage(err))
		}
	} else if v, msg := jsonParse(jsDecodeUTF8(b)); msg != "" {
		if exists(pkgPath) {
			warnings = append(warnings, "package.json 解析失败："+msg)
		}
	} else {
		pkg = v
	}

	// `if (!pkg)`：解析成 0 / "" / false / null 也走 fallback
	if pkg == nil || !pkg.truthy() {
		return s.fallback(path, warnings)
	}

	name := func(orPath bool) string {
		if n := pkg.get("name"); n != nil && n.kind == jsString && n.s != "" {
			return n.s
		}
		if b := jsBasename(path); b != "" || !orPath {
			return b
		}
		return path
	}

	// uniapp（HBuilderX）项目：有 package.json 但编译器内置在 HBuilderX 里，不走 npm 脚本。
	if uniappMarker(path) {
		warnings = append(warnings, "识别为 uniapp 项目，启动由 HBuilderX 负责")
		return contract.DetectResult{
			Path:           path,
			HasPackageJSON: true,
			Name:           name(true),
			Framework:      contract.FrameworkUniapp,
			PackageManager: s.detectPackageManager(path, pkg.get("packageManager")),
			Scripts:        toStringRecord(pkg.get("scripts")),
			RegisterOnly:   true,
			Warnings:       warnings,
		}
	}

	scripts := toStringRecord(pkg.get("scripts"))
	deps := map[string]bool{}
	for _, k := range toStringRecord(pkg.get("dependencies")).Keys() {
		deps[k] = true
	}
	for _, k := range toStringRecord(pkg.get("devDependencies")).Keys() {
		deps[k] = true
	}

	devScript := pick(scripts, DevCandidates)
	buildScript := pick(scripts, BuildCandidates)
	pm := s.detectPackageManager(path, pkg.get("packageManager"))

	if devScript == nil && scripts.Len() > 0 {
		warnings = append(warnings, "未找到 dev 类脚本，monorepo 请指定子包目录")
	}

	return contract.DetectResult{
		Path:           path,
		HasPackageJSON: true,
		Name:           name(false),
		Framework:      resolveFramework(deps),
		PackageManager: pm,
		Scripts:        scripts,
		DevScript:      devScript,
		BuildScript:    buildScript,
		MonorepoHint:   devScript == nil,
		Warnings:       warnings,
	}
}

func hintOf(f contract.Framework) string {
	for _, r := range markerRules {
		if r.framework == f {
			return r.hint
		}
	}
	return string(f)
}

// fallback 无 package.json：按标记文件认出生态。命令形状固定的可启动，其余仅登记、不推断命令。
func (s *Service) fallback(path string, warnings []string) contract.DetectResult {
	framework := contract.FrameworkUnknown
	for _, r := range markerRules {
		if r.match(path) {
			framework = r.framework
			break
		}
	}
	name := jsBasename(path)
	if name == "" {
		name = path
	}
	base := contract.DetectResult{
		Path:           path,
		Name:           name,
		Framework:      framework,
		PackageManager: contract.PackageManagerNpm,
		Scripts:        contract.NewScripts(),
	}

	// Spring Boot：命令形状固定（wrapper/jar + 硬编码子命令），可启动，预填启动方式与端口。
	if framework == contract.FrameworkSpringBoot {
		mode := s.detectSpringBootLaunchMode(path)
		port := detectSpringBootPort(path)
		base.Warnings = append(warnings, "识别为 Spring Boot 项目，默认启动方式："+string(mode))
		base.DetectedLaunchMode = mode
		base.DetectedPort = port
		return base
	}

	// Python / Go / Rust / C++：命令形状固定，可启动。本平台不支持的启动方式落到下面的仅登记分支。
	if mode, ok := detectLaunchableMode(framework, path); ok && !s.unsupported[mode] {
		base.Warnings = append(warnings, "识别为 "+hintOf(framework)+"，默认启动方式："+string(mode))
		base.DetectedLaunchMode = mode
		return base
	}

	if framework == contract.FrameworkUnknown {
		warnings = append(warnings, "无 package.json，需手动填写命令")
	} else {
		warnings = append(warnings, "识别为 "+hintOf(framework)+"，仅登记不推断启动命令")
	}
	base.RegisterOnly = true
	base.Warnings = warnings
	return base
}

// detectPackageManager packageManager 字段优先，其次锁文件，最后默认 npm，PRD §8.2。
func (s *Service) detectPackageManager(path string, field *jsValue) contract.PackageManager {
	if field != nil && field.kind == jsString {
		name, _, _ := strings.Cut(field.s, "@")
		name = jsToLower(jsTrim(name))
		switch contract.PackageManager(name) {
		case contract.PackageManagerNpm, contract.PackageManagerPnpm, contract.PackageManagerYarn, contract.PackageManagerBun:
			return contract.PackageManager(name)
		}
	}
	for _, l := range lockfiles {
		if exists(jsJoin(path, l.file)) {
			return l.pm
		}
	}
	return contract.PackageManagerNpm
}

// LockfileFor 锁文件对应的包管理器，没有锁文件返回空串（原版 null）。供预检出 warn，PRD §5.1 第 7 项。
func (s *Service) LockfileFor(path string) (contract.PackageManager, bool) {
	for _, l := range lockfiles {
		if exists(jsJoin(path, l.file)) {
			return l.pm, true
		}
	}
	return "", false
}

var scanSkip = map[string]bool{
	"node_modules": true, "dist": true, "build": true, "out": true, "target": true, "release": true, "coverage": true,
}

// DefaultScanLimit scanChildren 的 limit 默认值。
const DefaultScanLimit = 60

// ScanChildren 批量导入：只列 root 下一层子目录，逐个复用 Detect。
// 跳过隐藏目录、node_modules 与常见产物目录；没有任何可识别标记的目录不返回。
// root 只能来自刚打开的系统目录选择框，调用方负责保证，这里不接受页面传来的路径。
func (s *Service) ScanChildren(root string, limit int) []contract.DetectResult {
	names, ok := readDir(root)
	if !ok {
		return []contract.DetectResult{}
	}
	sortLocale(names)
	var dirs []string
	for _, name := range names {
		if strings.HasPrefix(name, ".") || scanSkip[jsToLower(name)] {
			continue
		}
		full := jsJoin(root, name)
		if info, err := os.Stat(full); err == nil && info.IsDir() {
			dirs = append(dirs, full)
		}
		if len(dirs) >= limit {
			break
		}
	}
	out := []contract.DetectResult{}
	for _, dir := range dirs {
		r := s.Detect(dir)
		if r.HasPackageJSON || r.Framework != contract.FrameworkUnknown {
			out = append(out, r)
		}
	}
	return out
}

func resolveFramework(deps map[string]bool) contract.Framework {
	for _, r := range frameworkRules {
		if deps[r.dep] {
			return r.resolve(deps)
		}
	}
	return contract.FrameworkNode
}

func pick(scripts contract.Scripts, candidates []string) *string {
	for _, k := range candidates {
		if _, ok := scripts.Get(k); ok {
			return strPtr(k)
		}
	}
	return nil
}

// toStringRecord 只收值为字符串的键；非对象（含数组、null）得空表。
// 原版 `out[k] = val` 对键 "__proto__" 是改原型、不建自有属性，所以这个键被丢掉。
func toStringRecord(v *jsValue) contract.Scripts {
	out := contract.NewScripts()
	if v == nil || v.kind != jsObject {
		return out
	}
	for _, k := range v.keys {
		if k == "__proto__" {
			continue
		}
		if val := v.props[k]; val.kind == jsString {
			out.Set(k, val.s)
		}
	}
	return out
}

// readErrorMessage readFile 失败时 node 的 err.message。exists(pkgPath) 为真还读不出来，实际只有
// package.json 是个目录（EISDIR，node 22 实测文案）与没有读权限两种。
// 后一种没有在 node 上实测（要改 ACL），用 Go 的错误文本，登记为已接受偏差。
func readErrorMessage(err error) string {
	if pe, ok := err.(*os.PathError); ok {
		if info, statErr := os.Stat(pe.Path); statErr == nil && info.IsDir() {
			return "EISDIR: illegal operation on a directory, read"
		}
	}
	return err.Error()
}
