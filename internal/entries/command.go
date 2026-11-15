// 对应 src/main/services/EntryService.ts 第 1478–1699 行的命令构造：buildCommand 与各生态的分支、
// resolveBinPath / resolveJarPath / assertInsideEntry / assertScriptDeclared。
//
// 红线（PRD §11）：每条路径都只产出 file + args 数组，从不拼 shell 字符串；子命令全部硬编码，
// 可执行文件经 whichAny 定位或取项目内产物；npm 生态的脚本名先过 SAFE_SCRIPT，
// 再由 assertScriptDeclared 重读磁盘上的 package.json 确认它真的在 scripts 里。

package entries

import (
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"

	"mile-console/internal/contract"
	"mile-console/internal/detect"
	"mile-console/internal/platform"
)

// LaunchCommand 即原版 LaunchCommand：一次启动要执行的命令，file + args 数组形式。
type LaunchCommand struct {
	File  string   `json:"file"`
	Args  []string `json:"args"`
	Title string   `json:"title"`
}

// BuildCommand 即原版 buildCommand：按 framework 选命令构造路径。
func (s *Service) BuildCommand(entry contract.LaunchEntry, cwd string, script *string) (LaunchCommand, error) {
	switch entry.Framework {
	case contract.FrameworkSpringBoot:
		return s.buildSpringBootCommand(entry, cwd)
	case contract.FrameworkDjango, contract.FrameworkFastAPI, contract.FrameworkFlask,
		contract.FrameworkStreamlit, contract.FrameworkPython:
		return s.buildPythonCommand(entry, cwd)
	case contract.FrameworkGo:
		return s.buildGoCommand(entry, cwd)
	case contract.FrameworkRust:
		return s.buildRustCommand(entry)
	case contract.FrameworkCpp:
		return s.buildCppCommand(entry, cwd)
	default:
		return s.buildNpmCommand(entry, cwd, script)
	}
}

// buildPythonCommand 即原版：file 固定为 python（whichAny 定位），子命令 / flag 硬编码。
func (s *Service) buildPythonCommand(entry contract.LaunchEntry, cwd string) (LaunchCommand, error) {
	mode := entry.LaunchMode
	python, ok := s.which(s.plat.Binaries()[platform.BinaryPython])
	if !ok {
		return LaunchCommand{}, errors.New("PATH 中找不到 python")
	}

	switch mode {
	case contract.LaunchModePythonFile:
		rel := entry.JarPath
		if rel == "" {
			return LaunchCommand{}, errors.New("Python 入口文件未配置")
		}
		if !SafePythonEntry.MatchString(rel) {
			return LaunchCommand{}, fmt.Errorf("入口文件名含非法字符：%s", rel)
		}
		abs, err := s.resolveBinPath(entry, cwd, pySuffixRE, "py")
		if err != nil {
			return LaunchCommand{}, err
		}
		return LaunchCommand{File: python, Args: []string{abs}, Title: "python " + rel}, nil
	case contract.LaunchModePythonModule:
		mod := entry.JarPath
		if mod == "" || !SafePythonModule.MatchString(mod) {
			return LaunchCommand{}, fmt.Errorf("Python 模块名非法：%s", orEmpty(mod))
		}
		return LaunchCommand{File: python, Args: []string{"-m", mod}, Title: "python -m " + mod}, nil
	case contract.LaunchModeUvicorn:
		app := entry.JarPath
		if app == "" || !SafePythonModule.MatchString(app) {
			return LaunchCommand{}, fmt.Errorf("uvicorn app 规格非法：%s", orEmpty(app))
		}
		return LaunchCommand{File: python, Args: []string{"-m", "uvicorn", app}, Title: "uvicorn " + app}, nil
	case contract.LaunchModeFlask:
		return LaunchCommand{File: python, Args: []string{"-m", "flask", "run"}, Title: "flask run"}, nil
	case contract.LaunchModeDjango:
		manage := detect.Join(cwd, "manage.py")
		if !IsFile(manage) {
			return LaunchCommand{}, errors.New("未找到 manage.py，无法启动 Django")
		}
		return LaunchCommand{File: python, Args: []string{manage, "runserver"}, Title: "manage.py runserver"}, nil
	default:
		return LaunchCommand{}, fmt.Errorf("Python 条目缺少合法的启动方式（launchMode）：%s", orEmpty(string(mode)))
	}
}

// buildGoCommand 即原版：go run <项目内包路径|.>。子命令 run 固定，包路径限项目内相对路径。
func (s *Service) buildGoCommand(entry contract.LaunchEntry, cwd string) (LaunchCommand, error) {
	if entry.LaunchMode != contract.LaunchModeGoRun {
		return LaunchCommand{}, fmt.Errorf("Go 条目启动方式非法：%s", orEmpty(string(entry.LaunchMode)))
	}
	pkg := jsTrim(entry.JarPath)
	if pkg == "" {
		pkg = "."
	}
	if !SafeGoPkg.MatchString(pkg) || hasDotDot(pkg) {
		return LaunchCommand{}, fmt.Errorf("Go 包路径非法：%s", pkg)
	}
	goBin, ok := s.which(s.plat.Binaries()[platform.BinaryGo])
	if !ok {
		return LaunchCommand{}, errors.New("PATH 中找不到 go")
	}
	// 校验包路径落在项目内（. 恒成立）
	if pkg != "." {
		if err := assertInsideEntry(entry, detect.Join(cwd, pkg)); err != nil {
			return LaunchCommand{}, err
		}
	}
	return LaunchCommand{File: goBin, Args: []string{"run", pkg}, Title: "go run " + pkg}, nil
}

// buildRustCommand 即原版：cargo run [--release]。子命令固定，无用户自由输入。
func (s *Service) buildRustCommand(entry contract.LaunchEntry) (LaunchCommand, error) {
	mode := entry.LaunchMode
	if mode != contract.LaunchModeCargoRun && mode != contract.LaunchModeCargoRunRelease {
		return LaunchCommand{}, fmt.Errorf("Rust 条目启动方式非法：%s", orEmpty(string(mode)))
	}
	cargo, ok := s.which(s.plat.Binaries()[platform.BinaryCargo])
	if !ok {
		return LaunchCommand{}, errors.New("PATH 中找不到 cargo")
	}
	args := []string{"run"}
	if mode == contract.LaunchModeCargoRunRelease {
		args = []string{"run", "--release"}
	}
	return LaunchCommand{File: cargo, Args: args, Title: "cargo " + strings.Join(args, " ")}, nil
}

// buildCppCommand 即原版：只跑项目内已构建的 .exe（相对项目根、禁 ..、须存在），不代编译。
func (s *Service) buildCppCommand(entry contract.LaunchEntry, cwd string) (LaunchCommand, error) {
	if entry.LaunchMode != contract.LaunchModeCppExe {
		return LaunchCommand{}, fmt.Errorf("C++ 条目启动方式非法：%s", orEmpty(string(entry.LaunchMode)))
	}
	abs, err := s.resolveBinPath(entry, cwd, exeSuffixRE, "exe")
	if err != nil {
		return LaunchCommand{}, err
	}
	// exe 是真可执行文件，可直接 CreateProcess，无需经 cmd
	title := entry.JarPath
	if title == "" {
		title = "exe"
	}
	return LaunchCommand{File: abs, Args: []string{}, Title: title}, nil
}

// buildNpmCommand 即原版：`cmd /d /s /c <pm> run <脚本>` 或 `<pm> install`。脚本名双重校验。
func (s *Service) buildNpmCommand(entry contract.LaunchEntry, cwd string, script *string) (LaunchCommand, error) {
	if script != nil {
		if !SafeScript.MatchString(*script) {
			return LaunchCommand{}, fmt.Errorf("脚本名含非法字符，拒绝执行：%s", *script)
		}
		if err := assertScriptDeclared(cwd, *script); err != nil {
			return LaunchCommand{}, err
		}
	}

	pm, ok := s.which(s.plat.Binaries()[platform.BinaryName(entry.PackageManager)])
	if !ok {
		return LaunchCommand{}, fmt.Errorf("PATH 中找不到 %s", entry.PackageManager)
	}

	// Windows 上 npm.cmd / pnpm.cmd 是批处理文件，CreateProcess 不能直接执行，必须经 cmd.exe；
	// 参数始终是数组，脚本名另有白名单，不做字符串拼接。
	args := []string{"install"}
	title := "install"
	if script != nil {
		args = []string{"run", *script}
		title = *script
	}
	file, wrapped := s.plat.WrapBatch(pm, args)
	return LaunchCommand{File: file, Args: wrapped, Title: title}, nil
}

// buildSpringBootCommand 即原版：五种启动方式的可执行文件与子命令全部固定，用户只能选「哪种方式」。
func (s *Service) buildSpringBootCommand(entry contract.LaunchEntry, cwd string) (LaunchCommand, error) {
	mode := entry.LaunchMode
	if mode == "" || !springBootModeSet[mode] {
		return LaunchCommand{}, errors.New("Spring Boot 条目缺少合法的启动方式（launchMode）")
	}
	wrapper := s.plat.WrapperFile()

	switch mode {
	case contract.LaunchModeMavenWrapper:
		path := detect.Join(cwd, wrapper.Maven)
		if !IsRunnable(s.plat, path) {
			return LaunchCommand{}, fmt.Errorf("未找到 %s，无法用 Maven Wrapper 启动", wrapper.Maven)
		}
		// 用 wrapper 的绝对路径：cmd /c 不会去 cwd 搜可执行文件（只搜 PATH），
		// 而项目本地的 mvnw.cmd 不在 PATH 里。路径由主进程用常量文件名拼，非用户输入。
		file, args := s.plat.WrapBatch(path, []string{"spring-boot:run"})
		return LaunchCommand{File: file, Args: args, Title: "spring-boot:run"}, nil
	case contract.LaunchModeGradleWrapper:
		path := detect.Join(cwd, wrapper.Gradle)
		if !IsRunnable(s.plat, path) {
			return LaunchCommand{}, fmt.Errorf("未找到 %s，无法用 Gradle Wrapper 启动", wrapper.Gradle)
		}
		file, args := s.plat.WrapBatch(path, []string{"bootRun"})
		return LaunchCommand{File: file, Args: args, Title: "bootRun"}, nil
	case contract.LaunchModeJar:
		jarAbs, err := s.resolveJarPath(entry, cwd)
		if err != nil {
			return LaunchCommand{}, err
		}
		java, ok := s.which(s.plat.Binaries()[platform.BinaryJava])
		if !ok {
			return LaunchCommand{}, errors.New("PATH 中找不到 java")
		}
		// java.exe 可直接 CreateProcess，无需经 cmd；jar 路径已校验在项目内且存在
		return LaunchCommand{File: java, Args: []string{"-jar", jarAbs}, Title: "java -jar " + entry.JarPath}, nil
	case contract.LaunchModeSystemMaven:
		mvn, ok := s.which(s.plat.Binaries()[platform.BinaryMvn])
		if !ok {
			return LaunchCommand{}, errors.New("PATH 中找不到 mvn")
		}
		file, args := s.plat.WrapBatch(mvn, []string{"spring-boot:run"})
		return LaunchCommand{File: file, Args: args, Title: "mvn spring-boot:run"}, nil
	case contract.LaunchModeSystemGradle:
		gradle, ok := s.which(s.plat.Binaries()[platform.BinaryGradle])
		if !ok {
			return LaunchCommand{}, errors.New("PATH 中找不到 gradle")
		}
		file, args := s.plat.WrapBatch(gradle, []string{"bootRun"})
		return LaunchCommand{File: file, Args: args, Title: "gradle bootRun"}, nil
	}
	return LaunchCommand{}, errors.New("Spring Boot 条目缺少合法的启动方式（launchMode）")
}

// resolveBinPath 即原版：把 jarPath 解析成绝对路径并校验 —— 相对项目根、禁 `..`、
// 须匹配指定后缀、文件须存在。约束与 outputDir 一致（它同样会进 shell.openPath 白名单）。
func (s *Service) resolveBinPath(entry contract.LaunchEntry, cwd string, ext *regexp.Regexp, extLabel string) (string, error) {
	rel := entry.JarPath
	if rel == "" {
		return "", fmt.Errorf("未配置 %s 路径", extLabel)
	}
	if isAbsolutePath(rel) {
		return "", errors.New("路径必须是相对项目根的路径")
	}
	if hasDotDot(rel) {
		return "", errors.New("路径不能跳出项目根")
	}
	if !ext.MatchString(rel) {
		return "", fmt.Errorf("路径必须以 .%s 结尾", extLabel)
	}
	abs := detect.Join(cwd, rel)
	if !IsFile(abs) {
		return "", fmt.Errorf("%s 文件不存在：%s", extLabel, rel)
	}
	return abs, nil
}

// resolveJarPath 即原版：Spring Boot jar 模式的 .jar 产物路径校验。
func (s *Service) resolveJarPath(entry contract.LaunchEntry, cwd string) (string, error) {
	return s.resolveBinPath(entry, cwd, jarSuffixRE, "jar")
}

// assertInsideEntry 即原版：工作目录必须落在条目登记路径内，防止 cwd 被改成任意位置（PRD §11）。
func assertInsideEntry(entry contract.LaunchEntry, cwd string) error {
	rel, err := filepath.Rel(entry.Path, cwd)
	if err != nil {
		// 不同盘符：原版 path.relative 直接返回绝对路径，同样算越界
		return fmt.Errorf("工作目录 %s 不在条目路径 %s 内", cwd, entry.Path)
	}
	if rel != "" && rel != "." && (strings.HasPrefix(rel, "..") || filepath.IsAbs(rel)) {
		return fmt.Errorf("工作目录 %s 不在条目路径 %s 内", cwd, entry.Path)
	}
	return nil
}

// assertScriptDeclared 即原版：脚本只能来自该项目 package.json 的 scripts 键，启动时再确认一次。
// 重读磁盘而不是用条目里的 scripts 快照 —— 快照可能是上次识别时的旧值。
func assertScriptDeclared(cwd, script string) error {
	pkg, msg := detect.ReadPackageJSON(filepath.Join(cwd, "package.json"))
	if pkg == nil {
		return errors.New(msg)
	}
	if pkg.IsNull() {
		// 原版此时抛 TypeError：Cannot read properties of null (reading 'scripts')
		return errors.New("Cannot read properties of null (reading 'scripts')")
	}
	if _, ok := pkg.StringRecord("scripts").Get(script); !ok {
		return fmt.Errorf("%s 不在 package.json scripts 中，拒绝执行", script)
	}
	return nil
}

// orEmpty 即原版错误文案里的 `x ?? '（空）'`。
func orEmpty(v string) string {
	if v == "" {
		return "（空）"
	}
	return v
}

// which 即原版 whichAny：候选名按 PATH 顺序定位，只在磁盘上 stat，不执行。
func (s *Service) which(candidates []string) (string, bool) {
	if s.opt.Which != nil {
		return s.opt.Which(candidates)
	}
	return "", false
}
