// 对应 src/main/services/PrecheckService.ts：启动前预检，PRD §5。
//
// 只读文件系统：不写入、不安装依赖、不起任何进程（连 `node -v` 都不跑）。
// fail 阻止启动，warn 只提示。
//
// 本文件是 run() 主序列与 npm 生态的检查项；Spring Boot / Python / Go / Rust / C++ 在 langs.go，
// 端口与磁盘在 port.go，PATH 定位与 Node 版本在 which.go。

package precheck

import (
	"context"
	"errors"
	"os"
	"strings"

	"mile-console/internal/contract"
	"mile-console/internal/detect"
	"mile-console/internal/platform"
)

// MinFreeBytes 即原版 MIN_FREE_BYTES = 500 * 1024 * 1024。
const MinFreeBytes = 500 * 1024 * 1024

// Platform 预检用到的平台能力：可执行文件候选名与 wrapper 文件名。
type Platform interface {
	Binaries() map[platform.BinaryName][]string
	WrapperFile() platform.WrapperFiles
}

// Lockfiles 即原版构造参数 DetectService，只用到 lockfileFor。
type Lockfiles interface {
	LockfileFor(path string) (contract.PackageManager, bool)
}

// Options 测试注入点。零值字段取真实实现。
type Options struct {
	// Getenv 即 process.env[key]，默认 os.LookupEnv。
	Getenv func(key string) (string, bool)
	// NodeVersion 「当前 Node 版本」，原版是本进程的 process.versions.node。
	// 默认在 PATH 里定位 node.exe 后读它的 PE 版本资源（用户 2026-11-15 选定，§6「Node 版本来源」），不执行它。
	// ok 为 false 表示取不到。
	NodeVersion func() (string, bool)
	// FreeSpace 即 statfs(cwd) 的 bsize * bavail，默认 GetDiskFreeSpaceExW。
	FreeSpace func(cwd string) (uint64, error)
	// FindFreePort 即原版 findFreePort(start)，默认 platform.FindFreePort（带着已知原版问题 I2）。
	FindFreePort func(ctx context.Context, start int) (int, bool)
}

// Service 即原版 PrecheckService。
type Service struct {
	plat  Platform
	locks Lockfiles
	opt   Options
}

// New 组装预检服务。
func New(p Platform, locks Lockfiles, opt Options) *Service {
	if opt.Getenv == nil {
		opt.Getenv = os.LookupEnv
	}
	s := &Service{plat: p, locks: locks, opt: opt}
	if s.opt.NodeVersion == nil {
		s.opt.NodeVersion = s.pathNodeVersion
	}
	if s.opt.FreeSpace == nil {
		s.opt.FreeSpace = diskFreeBytes
	}
	if s.opt.FindFreePort == nil {
		s.opt.FindFreePort = platform.FindFreePort
	}
	return s
}

func strPtr(s string) *string { return &s }

func fix(action contract.PrecheckFixAction, label string) *contract.PrecheckFix {
	return &contract.PrecheckFix{Action: action, Label: label}
}

// Run 即原版 run(entry, snapshot, allEntries)。snapshot 为 nil 即原版的 null。
func (s *Service) Run(ctx context.Context, entry contract.LaunchEntry, snapshot *contract.ScanSnapshot, allEntries []contract.LaunchEntry) (contract.PrecheckResult, error) {
	items := []contract.PrecheckItem{}
	cwd := ResolveCwd(entry)

	// 1. 工作目录
	if info, err := os.Stat(cwd); err != nil || !info.IsDir() {
		items = append(items, contract.PrecheckItem{
			ID: "cwd", Label: "工作目录存在且可读", Level: contract.PrecheckFail,
			Detail: cwd + " 不存在或不是目录",
			Fix:    fix(contract.FixPickDirectory, "重新选择目录"),
		})
		return finish(items)
	}
	items = append(items, contract.PrecheckItem{ID: "cwd", Label: "工作目录存在且可读", Level: contract.PrecheckPass, Detail: cwd})

	// Spring Boot 走独立预检序列：它没有 package.json / node_modules / npm 脚本，后面那套 npm 专属检查全不适用。
	// 放在 registerOnly 分支之前 —— Spring Boot 是 registerOnly=false 的非 npm 生态，不能落进「仅登记」的 fail。
	switch entry.Framework {
	case contract.FrameworkSpringBoot:
		return finish(s.springBootItems(ctx, entry, cwd, snapshot, allEntries, items))
	case contract.FrameworkGo, contract.FrameworkRust, contract.FrameworkCpp:
		return finish(s.nativeLangItems(ctx, entry, cwd, snapshot, allEntries, items))
	case contract.FrameworkPython, contract.FrameworkDjango, contract.FrameworkFastAPI, contract.FrameworkFlask, contract.FrameworkStreamlit:
		return finish(s.pythonItems(ctx, entry, cwd, snapshot, allEntries, items))
	}

	// Python 等仅登记条目到此为止，后面的检查项都以 package.json 为前提
	if entry.RegisterOnly {
		items = append(items, contract.PrecheckItem{
			ID: "registerOnly", Label: "条目为仅登记", Level: contract.PrecheckFail,
			Detail: "该条目只做监控，未配置可启动的命令",
			Fix:    fix(contract.FixPickScript, "配置启动命令"),
		})
		return finish(items)
	}

	// 2. package.json 可解析
	pkgPath := detect.Join(cwd, "package.json")
	pkg, msg := detect.ReadPackageJSON(pkgPath)
	if pkg == nil {
		missing := !exists(pkgPath)
		item := contract.PrecheckItem{ID: "packageJson", Label: "package.json 存在且能解析", Level: contract.PrecheckFail, Detail: msg, Fix: fix(contract.FixOpenInEditor, "在编辑器中打开")}
		if missing {
			item.Detail = pkgPath + " 不存在"
			item.Fix = fix(contract.FixPickDirectory, "重新选择目录")
		}
		return finish(append(items, item))
	}
	items = append(items, contract.PrecheckItem{ID: "packageJson", Label: "package.json 存在且能解析", Level: contract.PrecheckPass})
	if pkg.IsNull() {
		// 已知原版问题 I8，见 docs/MIGRATION-PLAN.md：package.json 内容是 null 时，原版 `pkg.scripts` 抛 TypeError，
		// run() 整体 reject，没有结果。这里照样不给结果，返回同文案的错误，由调用方按「预检抛错」处理。
		return contract.PrecheckResult{}, ErrNullPackageJSON
	}

	// 3. 脚本存在于 scripts
	scripts := pkg.StringRecord("scripts")
	engines := pkg.StringRecord("engines")
	script := ""
	if entry.Script != nil {
		script = *entry.Script
	}
	if cmd, ok := scripts.Get(script); script == "" || !ok {
		detail := "未配置脚本"
		if script != "" {
			have := strings.Join(scripts.Keys(), ", ")
			if have == "" {
				have = "（空）"
			}
			detail = "scripts 中没有 " + script + "，现有：" + have
		}
		items = append(items, contract.PrecheckItem{ID: "script", Label: "配置的脚本存在于 scripts", Level: contract.PrecheckFail, Detail: detail, Fix: fix(contract.FixPickScript, "选择其他脚本")})
	} else {
		items = append(items, contract.PrecheckItem{ID: "script", Label: "配置的脚本存在于 scripts", Level: contract.PrecheckPass, Detail: script + " → " + cmd})
	}

	// 4. 包管理器可执行文件在 PATH 中
	pm := entry.PackageManager
	if pmPath, ok := s.WhichAny(s.pmBinaries(pm)); !ok {
		avail := []string{}
		for _, m := range contract.PackageManagers {
			if _, found := s.WhichAny(s.pmBinaries(m)); found {
				avail = append(avail, string(m))
			}
		}
		have := strings.Join(avail, ", ")
		if have == "" {
			have = "无"
		}
		item := contract.PrecheckItem{ID: "packageManager", Label: "包管理器可执行文件可用", Level: contract.PrecheckFail, Detail: "PATH 中找不到 " + string(pm) + "；检测到：" + have}
		if pm != contract.PackageManagerNpm {
			item.Fix = fix(contract.FixUseNpm, "改用 npm")
		}
		items = append(items, item)
	} else {
		items = append(items, contract.PrecheckItem{ID: "packageManager", Label: "包管理器可执行文件可用", Level: contract.PrecheckPass, Detail: pmPath})
	}

	// 5. Node 版本满足 engines.node —— 不 spawn node
	items = append(items, s.nodeItem(engines))

	// 6. node_modules 存在 —— 缺失是 fail，不自动安装，PRD §5.2
	if info, err := os.Stat(detect.Join(cwd, "node_modules")); err != nil || !info.IsDir() {
		items = append(items, contract.PrecheckItem{
			ID: "nodeModules", Label: "node_modules 存在", Level: contract.PrecheckFail,
			Detail: "依赖未安装。自动安装会执行依赖的 postinstall 脚本，必须由你显式发起",
			Fix:    fix(contract.FixCreateInstallSession, "创建安装会话"),
		})
	} else {
		items = append(items, contract.PrecheckItem{ID: "nodeModules", Label: "node_modules 存在", Level: contract.PrecheckPass})
	}

	// 7. 锁文件与包管理器一致
	lock, hasLock := s.locks.LockfileFor(cwd)
	switch {
	case hasLock && lock != pm:
		items = append(items, contract.PrecheckItem{ID: "lockfile", Label: "锁文件与包管理器一致", Level: contract.PrecheckWarn, Detail: "锁文件指向 " + string(lock) + "，条目配置为 " + string(pm)})
	case hasLock:
		items = append(items, contract.PrecheckItem{ID: "lockfile", Label: "锁文件与包管理器一致", Level: contract.PrecheckPass, Detail: string(lock) + " 锁文件"})
	default:
		items = append(items, contract.PrecheckItem{ID: "lockfile", Label: "锁文件与包管理器一致", Level: contract.PrecheckPass, Detail: "无锁文件"})
	}

	// 8. 预期端口空闲 —— 查最近一次采集快照，不额外发起探测
	items = append(items, s.portItem(ctx, entry, snapshot, allEntries))
	// 9. 磁盘余量
	items = append(items, s.diskItem(cwd))
	return finish(items)
}

// nodeItem 第 5 项。原版 `engines.node ?? null` 后用 `!required` 判断：空串也当未声明。
func (s *Service) nodeItem(engines contract.Scripts) contract.PrecheckItem {
	const label = "Node 运行时版本满足 engines.node"
	required, _ := engines.Get("node")
	current, ok := s.opt.NodeVersion()
	if !ok {
		// 取不到版本时按 §6「Node 版本来源」：显示「未知」，不出 warn
		current = "未知"
	}
	if required == "" {
		return contract.PrecheckItem{ID: "node", Label: label, Level: contract.PrecheckPass, Detail: "未声明 engines.node，当前 " + current}
	}
	sat, known := false, false
	if ok {
		sat, known = Satisfies(current, required)
	}
	if !known {
		return contract.PrecheckItem{ID: "node", Label: label, Level: contract.PrecheckPass, Detail: "无法解析范围 " + required + "，当前 " + current}
	}
	item := contract.PrecheckItem{ID: "node", Label: label, Level: contract.PrecheckPass, Detail: "要求 " + required + "，当前 " + current}
	if !sat {
		item.Level = contract.PrecheckWarn
		item.Fix = fix(contract.FixShowNodeRequirement, "查看版本要求")
	}
	return item
}

func finish(items []contract.PrecheckItem) (contract.PrecheckResult, error) {
	ok := true
	for _, i := range items {
		if i.Level == contract.PrecheckFail {
			ok = false
		}
	}
	return contract.PrecheckResult{OK: ok, Items: items}, nil
}

// ErrNullPackageJSON 即原版读 null.scripts 时 V8 的 TypeError 文案（已知原版问题 I8）。
var ErrNullPackageJSON = errors.New("Cannot read properties of null (reading 'scripts')")

// ResolveCwd 即原版导出的 resolveCwd：monorepo 子包的 cwd 为相对路径时拼到 path 下。
// 只做拼接，不做越界校验（越界校验属于 S21d 的 terminalCwd）。
func ResolveCwd(entry contract.LaunchEntry) string {
	if entry.Cwd == "" {
		return entry.Path
	}
	if detect.IsAbsolute(entry.Cwd) {
		return entry.Cwd
	}
	return detect.Join(entry.Path, entry.Cwd)
}

// exists 即原版 statSafe(target) 非 null：stat 成功（文件、目录都算）。
func exists(target string) bool {
	_, err := os.Stat(target)
	return err == nil
}

func isFile(target string) bool {
	info, err := os.Stat(target)
	return err == nil && info.Mode().IsRegular()
}
