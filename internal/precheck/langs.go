// 对应 src/main/services/PrecheckService.ts 的 springBootItems / pythonItems / nativeLangItems
// 与 fileItem / binItem / jarItem / pathItem：非 npm 生态的预检序列。只读、不 spawn、不构建、不装依赖。

package precheck

import (
	"context"
	"regexp"
	"slices"
	"strings"

	"mile-console/internal/contract"
	"mile-console/internal/detect"
	"mile-console/internal/platform"
)

var (
	jarRe = regexp.MustCompile(`(?i)\.jar$`)
	exeRe = regexp.MustCompile(`(?i)\.exe$`)
	// splitSepRe 即原版 rel.split(/[\\/]/)
	splitSepRe = regexp.MustCompile(`[\\/]`)
)

// springBootItems 按 launchMode 校验各自前提：wrapper 文件存在 / jar 文件存在 / 系统构建工具在 PATH；
// jar 与 system 模式额外查 java 在 PATH。端口与磁盘复用 npm 路径的同款检查。
func (s *Service) springBootItems(ctx context.Context, entry contract.LaunchEntry, cwd string, snapshot *contract.ScanSnapshot, all []contract.LaunchEntry, items []contract.PrecheckItem) []contract.PrecheckItem {
	mode := entry.LaunchMode
	if mode == "" {
		return append(items, contract.PrecheckItem{
			ID: "launchMode", Label: "Spring Boot 启动方式已配置", Level: contract.PrecheckFail,
			Detail: "未选择启动方式（Maven/Gradle Wrapper、jar 或系统构建工具）",
			Fix:    fix(contract.FixPickScript, "配置启动方式"),
		})
	}

	w := s.plat.WrapperFile()
	switch mode {
	case contract.LaunchModeMavenWrapper:
		items = append(items, fileItem(detect.Join(cwd, w.Maven), "launchMode", "Maven Wrapper（"+w.Maven+"）存在", w.Maven))
	case contract.LaunchModeGradleWrapper:
		items = append(items, fileItem(detect.Join(cwd, w.Gradle), "launchMode", "Gradle Wrapper（"+w.Gradle+"）存在", w.Gradle))
	case contract.LaunchModeJar:
		items = append(items, binItem(entry, cwd, jarRe, "jar"))
	case contract.LaunchModeSystemMaven:
		items = append(items, s.pathItem(platform.BinaryMvn, "launchMode", "系统 Maven（mvn）可用", "mvn"))
	case contract.LaunchModeSystemGradle:
		items = append(items, s.pathItem(platform.BinaryGradle, "launchMode", "系统 Gradle（gradle）可用", "gradle"))
	}

	// jar / system 模式跑的是 java；wrapper 模式由 wrapper 自己找 JAVA_HOME，这里不强求
	if mode == contract.LaunchModeJar || mode == contract.LaunchModeSystemMaven || mode == contract.LaunchModeSystemGradle {
		item := contract.PrecheckItem{ID: "java", Label: "java 可执行文件可用", Level: contract.PrecheckFail, Detail: "PATH 中找不到 java，请安装 JDK 或配置 PATH"}
		if java, ok := s.WhichAny(s.binaries(platform.BinaryJava)); ok {
			item.Level, item.Detail = contract.PrecheckPass, java
		}
		items = append(items, item)
	}

	items = append(items, s.portItem(ctx, entry, snapshot, all))
	return append(items, s.diskItem(cwd))
}

// pythonItems python 在 PATH + 按 launchMode 校验入口前提 + 端口 + 磁盘。不 pip install。
func (s *Service) pythonItems(ctx context.Context, entry contract.LaunchEntry, cwd string, snapshot *contract.ScanSnapshot, all []contract.LaunchEntry, items []contract.PrecheckItem) []contract.PrecheckItem {
	items = append(items, s.pathItem(platform.BinaryPython, "python", "python 可执行文件可用", "python"))

	switch mode := entry.LaunchMode; mode {
	case contract.LaunchModePythonFile:
		// 原版 `join(cwd, entry.jarPath ?? '')` 与 `entry.jarPath || '入口文件'`
		name := entry.JarPath
		if name == "" {
			name = "入口文件"
		}
		items = append(items, fileItem(detect.Join(cwd, entry.JarPath), "launchMode", "Python 入口文件存在", name))
	case contract.LaunchModeDjango:
		items = append(items, fileItem(detect.Join(cwd, "manage.py"), "launchMode", "manage.py 存在", "manage.py"))
	case contract.LaunchModePythonModule, contract.LaunchModeUvicorn:
		item := contract.PrecheckItem{ID: "launchMode", Label: "启动模块已配置", Level: contract.PrecheckFail, Detail: "未配置模块名", Fix: fix(contract.FixPickScript, "配置模块名")}
		if entry.JarPath != "" {
			item.Level, item.Detail, item.Fix = contract.PrecheckPass, entry.JarPath, nil
		}
		items = append(items, item)
	case contract.LaunchModeFlask:
		// flask run 由 FLASK_APP 环境变量决定入口，这里不强求文件；给个信息项
		items = append(items, contract.PrecheckItem{ID: "launchMode", Label: "Flask 启动方式", Level: contract.PrecheckPass, Detail: "flask run"})
	default:
		shown := string(mode)
		if shown == "" {
			shown = "（空）"
		}
		items = append(items, contract.PrecheckItem{
			ID: "launchMode", Label: "Python 启动方式已配置", Level: contract.PrecheckFail,
			Detail: "未选择合法的启动方式：" + shown,
			Fix:    fix(contract.FixPickScript, "配置启动方式"),
		})
	}

	items = append(items, s.portItem(ctx, entry, snapshot, all))
	return append(items, s.diskItem(cwd))
}

// nativeLangItems go：go 在 PATH + go.mod 存在；rust：cargo 在 PATH + Cargo.toml 存在；cpp：已配置且存在项目内 .exe。
func (s *Service) nativeLangItems(ctx context.Context, entry contract.LaunchEntry, cwd string, snapshot *contract.ScanSnapshot, all []contract.LaunchEntry, items []contract.PrecheckItem) []contract.PrecheckItem {
	switch entry.Framework {
	case contract.FrameworkGo:
		items = append(items, s.pathItem(platform.BinaryGo, "go", "go 可执行文件可用", "go"))
		items = append(items, fileItem(detect.Join(cwd, "go.mod"), "launchMode", "go.mod 存在", "go.mod"))
	case contract.FrameworkRust:
		items = append(items, s.pathItem(platform.BinaryCargo, "cargo", "cargo 可执行文件可用", "cargo"))
		items = append(items, fileItem(detect.Join(cwd, "Cargo.toml"), "launchMode", "Cargo.toml 存在", "Cargo.toml"))
	default:
		// cpp：只跑已构建 exe，复用 binItem 校验（路径约束 + 存在性）
		items = append(items, binItem(entry, cwd, exeRe, "exe"))
	}

	items = append(items, s.portItem(ctx, entry, snapshot, all))
	return append(items, s.diskItem(cwd))
}

// fileItem 文件存在性检查项：Spring Boot wrapper 等用。
func fileItem(target, id, label, name string) contract.PrecheckItem {
	if isFile(target) {
		return contract.PrecheckItem{ID: id, Label: label, Level: contract.PrecheckPass, Detail: target}
	}
	return contract.PrecheckItem{ID: id, Label: label, Level: contract.PrecheckFail, Detail: "未找到 " + name, Fix: fix(contract.FixPickScript, "改用系统构建工具")}
}

// binItem 可执行产物检查项：路径先按约束校形，再查存在性。jar / exe 通用（按后缀参数区分）。
func binItem(entry contract.LaunchEntry, cwd string, extRe *regexp.Regexp, extLabel string) contract.PrecheckItem {
	rel := entry.JarPath
	label := extLabel + " 文件存在"
	if rel == "" {
		return contract.PrecheckItem{ID: "launchMode", Label: label, Level: contract.PrecheckFail, Detail: "未配置 " + extLabel + " 路径", Fix: fix(contract.FixPickScript, "配置 "+extLabel+" 路径")}
	}
	if detect.IsAbsolute(rel) || slices.Contains(splitSepRe.Split(rel, -1), "..") || !extRe.MatchString(rel) {
		return contract.PrecheckItem{ID: "launchMode", Label: label, Level: contract.PrecheckFail, Detail: extLabel + " 路径非法：" + rel}
	}
	abs := detect.Join(cwd, rel)
	if isFile(abs) {
		return contract.PrecheckItem{ID: "launchMode", Label: label, Level: contract.PrecheckPass, Detail: abs}
	}
	return contract.PrecheckItem{ID: "launchMode", Label: label, Level: contract.PrecheckFail, Detail: extLabel + " 不存在，请先构建：" + rel}
}

// pathItem PATH 可执行文件检查项。
func (s *Service) pathItem(bin platform.BinaryName, id, label, name string) contract.PrecheckItem {
	if found, ok := s.WhichAny(s.binaries(bin)); ok {
		return contract.PrecheckItem{ID: id, Label: label, Level: contract.PrecheckPass, Detail: found}
	}
	return contract.PrecheckItem{ID: id, Label: label, Level: contract.PrecheckFail, Detail: "PATH 中找不到 " + name}
}

func (s *Service) binaries(b platform.BinaryName) []string { return s.plat.Binaries()[b] }

// pmBinaries 即原版 PM_BINARIES[pm]。不在四个包管理器之内的值（配置被手改）原版得 undefined，
// whichAny(undefined) 遍历时抛错；这里得空表、找不到。条目经 sanitize 不会出现这种值。
func (s *Service) pmBinaries(pm contract.PackageManager) []string {
	if !slices.Contains(contract.PackageManagers, pm) {
		return nil
	}
	return s.binaries(platform.BinaryName(strings.ToLower(string(pm))))
}
