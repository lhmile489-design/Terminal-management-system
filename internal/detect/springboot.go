// 对应 src/main/services/DetectService.ts 第 205–312 行：detectLaunchableMode、detectSpringBootLaunchMode、
// detectSpringBootPort、detectSpringBootProfiles。只看文件存在性与文本，不查 PATH、不执行任何东西。

package detect

import (
	"regexp"
	"slices"
	"strconv"

	"mile-console/internal/contract"
)

// launchable 为命令形状固定的语言探测默认启动方式；ok 为 false 表示不属于「可启动的非 npm 语言」。
func detectLaunchableMode(framework contract.Framework, path string) (contract.LaunchMode, bool) {
	switch framework {
	case contract.FrameworkDjango:
		return contract.LaunchModeDjango, true
	case contract.FrameworkFastAPI:
		return contract.LaunchModeUvicorn, true
	case contract.FrameworkFlask:
		return contract.LaunchModeFlask, true
	case contract.FrameworkStreamlit, contract.FrameworkPython:
		// 原版先 stat main.py / app.py，两个分支都给 python-file（用户在编辑面板填入口）。stat 没有副作用，这里照样做一遍。
		_ = exists(jsJoin(path, "main.py"))
		_ = exists(jsJoin(path, "app.py"))
		return contract.LaunchModePythonFile, true
	case contract.FrameworkGo:
		return contract.LaunchModeGoRun, true
	case contract.FrameworkRust:
		return contract.LaunchModeCargoRun, true
	case contract.FrameworkCpp:
		return contract.LaunchModeCppExe, true
	}
	return "", false
}

// detectSpringBootLaunchMode 优先项目自带 wrapper，缺失时退回系统 mvn / gradle。
func (s *Service) detectSpringBootLaunchMode(path string) contract.LaunchMode {
	w := s.wrappers
	hasMvnw := exists(jsJoin(path, w.Maven))
	hasGradlew := exists(jsJoin(path, w.Gradle))
	hasPom := exists(jsJoin(path, "pom.xml"))
	switch {
	case hasMvnw:
		return contract.LaunchModeMavenWrapper
	case hasGradlew:
		return contract.LaunchModeGradleWrapper
	case hasPom:
		return contract.LaunchModeSystemMaven
	}
	return contract.LaunchModeSystemGradle
}

// 原版：/^\s*server\.port\s*[=:]\s*(\d{1,5})\s*$/m 与 /^\s*port\s*:\s*(\d{1,5})\s*$/m。
// JS 的 \s 含 U+00A0、U+FEFF、U+2028 等，m 模式的 ^ $ 认四种行终止符；Go 的 \s 只有 ASCII 空白、(?m) 只认 \n，
// 所以把两边的集合都展开。\d 两边都只认 ASCII 数字。
const (
	jsWS = `[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`
	jsLT = `\n\r\x{2028}\x{2029}`
)

var (
	serverPortRe = regexp.MustCompile(`(?:\A|[` + jsLT + `])` + jsWS + `*server\.port` + jsWS + `*[=:]` + jsWS + `*([0-9]{1,5})` + jsWS + `*(?:\z|[` + jsLT + `])`)
	portRe       = regexp.MustCompile(`(?:\A|[` + jsLT + `])` + jsWS + `*port` + jsWS + `*:` + jsWS + `*([0-9]{1,5})` + jsWS + `*(?:\z|[` + jsLT + `])`)
)

// firstMatch 即 text.match(re)（非 g）：最左匹配。JS 回溯与 Go RE2 在这类锚定模式下最左位置相同，
// 但 \s* 跨行吃掉换行时，JS 取最左起点的那个匹配——Go 的 FindStringSubmatchIndex 同样是最左起点。
// 唯一要注意的是行终止符被前缀吃掉后不能再给下一次匹配当 ^：match 只找一次，不受影响。
func firstMatch(re *regexp.Regexp, text string) (string, bool) {
	m := re.FindStringSubmatch(text)
	if m == nil {
		return "", false
	}
	return m[1], true
}

// detectSpringBootPort 从 application.properties / application.yml 读 server.port；读不到返回 nil。
func detectSpringBootPort(path string) *int {
	res := jsJoin(path, "src", "main", "resources")
	locations := []string{
		jsJoin(res, "application.properties"),
		jsJoin(res, "application.yml"),
		jsJoin(res, "application.yaml"),
		jsJoin(path, "application.properties"),
		jsJoin(path, "application.yml"),
		jsJoin(path, "application.yaml"),
	}
	for _, file := range locations {
		text, ok := readText(file)
		if !ok || text == "" {
			continue
		}
		d, ok := firstMatch(serverPortRe, text)
		if !ok {
			d, ok = firstMatch(portRe, text)
		}
		if ok {
			port, _ := strconv.Atoi(d)
			if port > 0 && port <= 65535 {
				return &port
			}
		}
	}
	return nil
}

var (
	profileFileRe = regexp.MustCompile(`(?i)^application-([^.]+)\.(properties|ya?ml)$`)
	safeProfileRe = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
)

// DetectSpringBootProfiles 扫描 application-{profile}.properties/yml/yaml，返回去重后按 UTF-16 码元排序的 profile 名。
// 只读目录结构，不读文件内容。
func (s *Service) DetectSpringBootProfiles(projectPath string) []string {
	found := map[string]bool{}
	order := []string{}
	for _, dir := range []string{jsJoin(projectPath, "src", "main", "resources"), projectPath} {
		names, ok := readDir(dir)
		if !ok {
			continue
		}
		for _, name := range names {
			// (?i) 只作用于 application- 与扩展名这些 ASCII；U+017F / U+212A 同样挡掉，见 asciiFoldMatch
			m := profileFileRe.FindStringSubmatch(name)
			if m == nil || !asciiFoldMatch(profileFileRe, name) {
				continue
			}
			p := m[1]
			if safeProfileRe.MatchString(p) && !found[p] {
				found[p] = true
				order = append(order, p)
			}
		}
	}
	// [...set].sort()：默认比较按 UTF-16 码元；白名单保证只有 ASCII，字节序即码元序
	slices.Sort(order)
	return order
}
