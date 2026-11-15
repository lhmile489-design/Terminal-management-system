// 对应 src/main/services/DetectService.ts 第 12–312 行：依赖规则、锁文件、标记文件规则与各个探测函数。
// 常量、正则、顺序逐字照搬。只读文件，不执行任何项目代码（红线 1）。

package detect

import (
	"os"
	"regexp"
	"strings"

	"mile-console/internal/contract"
)

// frameworkRule 依赖键 → 框架，按 PRD §8.1 优先级排列，取首个命中。
type frameworkRule struct {
	dep     string
	resolve func(deps map[string]bool) contract.Framework
}

func constFW(f contract.Framework) func(map[string]bool) contract.Framework {
	return func(map[string]bool) contract.Framework { return f }
}

var frameworkRules = []frameworkRule{
	{"next", constFW(contract.FrameworkNext)},
	{"nuxt", constFW(contract.FrameworkNuxt)},
	{"@angular/core", constFW(contract.FrameworkAngular)},
	{"vue", func(d map[string]bool) contract.Framework {
		if d["@vue/cli-service"] {
			return contract.FrameworkVueCLI
		}
		return contract.FrameworkVueVite
	}},
	{"react", func(d map[string]bool) contract.Framework {
		if d["react-scripts"] {
			return contract.FrameworkReactCRA
		}
		return contract.FrameworkReactVite
	}},
	{"svelte", constFW(contract.FrameworkSvelte)},
	{"electron", constFW(contract.FrameworkElectron)},
	// Hexo 走 npm，命令形状与前端项目一致，因此留在依赖表里而不是标记表
	{"hexo", constFW(contract.FrameworkHexo)},
}

// lockfiles 锁文件 → 包管理器，顺序即优先级。
var lockfiles = []struct {
	file string
	pm   contract.PackageManager
}{
	{"pnpm-lock.yaml", contract.PackageManagerPnpm},
	{"yarn.lock", contract.PackageManagerYarn},
	{"bun.lockb", contract.PackageManagerBun},
	{"package-lock.json", contract.PackageManagerNpm},
}

// markerRule 无 package.json 时的标记文件识别，PRD §8.4。顺序即优先级，取首个命中。
type markerRule struct {
	framework contract.Framework
	hint      string
	match     func(p string) bool
}

func anyExists(p string, names ...string) bool {
	for _, n := range names {
		if exists(jsJoin(p, n)) {
			return true
		}
	}
	return false
}

var markerRules = []markerRule{
	{contract.FrameworkDjango, "Django 项目（manage.py）", func(p string) bool { return exists(jsJoin(p, "manage.py")) }},
	{contract.FrameworkFastAPI, "FastAPI 项目", func(p string) bool { return pythonDeps(p, []string{"fastapi"}) }},
	{contract.FrameworkStreamlit, "Streamlit 应用", func(p string) bool { return pythonDeps(p, []string{"streamlit"}) }},
	{contract.FrameworkFlask, "Flask 项目", func(p string) bool { return pythonDeps(p, []string{"flask"}) }},
	{contract.FrameworkPython, "Python 项目", func(p string) bool { return anyExists(p, "requirements.txt", "pyproject.toml") }},
	{contract.FrameworkGo, "Go 模块（go.mod）", func(p string) bool { return exists(jsJoin(p, "go.mod")) }},
	{contract.FrameworkRust, "Rust crate（Cargo.toml）", func(p string) bool { return exists(jsJoin(p, "Cargo.toml")) }},
	// C++ 项目标记：CMake / MSBuild 工程文件，或 Makefile + 源文件。只读存在性，不构建。
	{contract.FrameworkCpp, "C++ 项目", cppMarker},
	// pom.xml 含 spring-boot 或 build.gradle 含 org.springframework.boot 才算数
	{contract.FrameworkSpringBoot, "Spring Boot 项目", springBootMarker},
	{contract.FrameworkJekyll, "Jekyll 站点（_config.yml）", func(p string) bool { return exists(jsJoin(p, "_config.yml")) }},
	// 光有 config.toml 不能算 Hugo —— 要求同时有 Hugo 的目录约定
	{contract.FrameworkHugo, "Hugo 站点", func(p string) bool {
		if !anyExists(p, "hugo.toml", "hugo.yaml", "config.toml", "config.yaml") {
			return false
		}
		return anyExists(p, "content", "layouts", "archetypes")
	}},
	{contract.FrameworkDockerCompose, "Docker Compose 编排", func(p string) bool {
		return anyExists(p, "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml")
	}},
	// uniapp 常带 index.html，必须排在 static 之前，否则会被兜底成静态站
	{contract.FrameworkUniapp, "uniapp 项目（manifest.json + pages.json）", uniappMarker},
	// 兜底：有首页、又没上面任何构建标记，就是一个直接打开就能看的静态站
	{contract.FrameworkStatic, "静态站点（index.html）", func(p string) bool { return exists(jsJoin(p, "index.html")) }},
}

// pythonDeps requirements.txt / pyproject.toml 里是否声明了某个包。
// 原版每次 new RegExp(`(^|[\s"'\[])${name}($|[\s"'\]<>=!~,;\[])`, 'm')：name 只有写死的三个小写包名，不含正则元字符。
func pythonDeps(path string, names []string) bool {
	for _, file := range []string{"requirements.txt", "pyproject.toml"} {
		text, ok := readText(jsJoin(path, file))
		if !ok {
			continue
		}
		lower := jsToLower(text)
		for _, name := range names {
			if pythonDepRe(name).MatchString(lower) {
				return true
			}
		}
	}
	return false
}

// pythonDepRe JS 的 \s 与 Go 的 \s 不同（JS 含 U+00A0、U+FEFF、U+2028 等），这里把 JS 的空白集合展开成字符类。
// m 标志下 ^ $ 在 JS 里认四种行终止符，它们都在 JS 的 \s 里，所以 (^|[\s...]) 等价于 (\A|[ws...])，不必用 Go 的 (?m)。
func pythonDepRe(name string) *regexp.Regexp {
	const ws = `\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`
	return regexp.MustCompile(`(?:\A|[` + ws + `"'\[])` + regexp.QuoteMeta(name) + `(?:\z|[` + ws + `"'\]<>=!~,;\[])`)
}

var (
	springPomRe    = regexp.MustCompile(`(?i)spring-boot`)
	springGradleRe = regexp.MustCompile(`(?i)org\.springframework\.boot`)
)

// springBootMarker 只读文件内容，绝不执行 mvn / gradle。
// /spring-boot/i 在 JS 非 unicode 模式下只折叠 ASCII（U+017F 长 s、U+212A 开尔文符号不折成 s / k），Go 的 (?i) 会折，所以先挡掉。
func springBootMarker(path string) bool {
	if pom, ok := readText(jsJoin(path, "pom.xml")); ok && pom != "" && asciiFoldMatch(springPomRe, pom) {
		return true
	}
	for _, file := range []string{"build.gradle", "build.gradle.kts"} {
		if g, ok := readText(jsJoin(path, file)); ok && g != "" && asciiFoldMatch(springGradleRe, g) {
			return true
		}
	}
	return false
}

// asciiFoldMatch 让 Go 的 (?i) 只按 ASCII 折叠：把 U+017F 与 U+212A 换成不会命中的占位后再匹配。
func asciiFoldMatch(re *regexp.Regexp, s string) bool {
	if strings.ContainsAny(s, "\u017f\u212a") {
		s = strings.NewReplacer("\u017f", "\x00", "\u212a", "\x00").Replace(s)
	}
	return re.MatchString(s)
}

// uniappMarker manifest.json 与 pages.json 同时存在。纯存在性判断。
func uniappMarker(path string) bool {
	return exists(jsJoin(path, "manifest.json")) && exists(jsJoin(path, "pages.json"))
}

var (
	vcxprojRe  = regexp.MustCompile(`(?i)\.vcxproj$`)
	makefileRe = regexp.MustCompile(`^(GNUmakefile|makefile|Makefile)$`)
	cppSrcRe   = regexp.MustCompile(`(?i)\.(cpp|cc|cxx)$`)
)

// cppMarker CMake / MSBuild 工程文件，或 Makefile 同时存在 .cpp/.cc/.cxx 源文件。
func cppMarker(path string) bool {
	if exists(jsJoin(path, "CMakeLists.txt")) {
		return true
	}
	names, ok := readDir(path)
	if !ok {
		return false
	}
	hasMake, hasSrc := false, false
	for _, n := range names {
		if asciiFoldMatch(vcxprojRe, n) {
			return true
		}
		hasMake = hasMake || makefileRe.MatchString(n)
		hasSrc = hasSrc || asciiFoldMatch(cppSrcRe, n)
	}
	return hasMake && hasSrc
}

// exists 即 stat 不抛。
func exists(target string) bool {
	_, err := os.Stat(target)
	return err == nil
}

// readText 即 readFile(target, 'utf8')：不存在或读失败返回 false。
func readText(target string) (string, bool) {
	b, err := os.ReadFile(target)
	if err != nil {
		return "", false
	}
	return jsDecodeUTF8(b), true
}

// readDir 即 readdir(path)：只要名字，顺序按系统返回（NTFS 上即按名排序）。
func readDir(path string) ([]string, bool) {
	f, err := os.Open(path)
	if err != nil {
		return nil, false
	}
	defer f.Close()
	names, err := f.Readdirnames(-1)
	if err != nil {
		return nil, false
	}
	return names, true
}
