// 对应 src/main/services/ScannerService.ts 文件末尾的模块级纯函数：
// changed、normalizeKeywords、truncate、matchEntry、countConflicts、sameDir、guessCwd。

package scanner

import (
	"regexp"
	"slices"
	"strconv"
	"strings"

	"mile-console/internal/contract"
)

// EntryExpectation 即原版 EntryExpectation：条目预期端口的提供方，由条目服务注入，避免扫描器反向依赖启动台。
// Port 为 0 表示没有（原版 `if (!exp.port) continue`）；Pid 为 nil 表示 undefined。
type EntryExpectation struct {
	ID   string
	Port int
	Cwd  string
	Pid  *int
	// SessionID 该条目当前会话，用于把会话的后代进程归到条目名下。空串表示没有。
	SessionID string
}

// ExpectationSource 即原版 ExpectationSource。
type ExpectationSource func() []EntryExpectation

// changed 即原版 changed(a, b)。不比 cwd / processName / sessionId / execPath / startedAt，与原版一致。
func changed(a, b contract.ListenerSnapshot) bool {
	return !sameCPU(a.CPU, b.CPU) ||
		a.Memory != b.Memory ||
		a.Ownership != b.Ownership ||
		a.EntryID != b.EntryID ||
		// 分组变了必须进 updated，否则手动提升后要等这个 PID 消失才换组
		a.Group != b.Group ||
		a.GroupOverridden != b.GroupOverridden ||
		a.LaunchSource != b.LaunchSource ||
		joinPorts(a.Ports) != joinPorts(b.Ports)
}

func sameCPU(a, b *float64) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// joinPorts 即 ports.join()。
func joinPorts(ports []int) string {
	parts := make([]string, len(ports))
	for i, p := range ports {
		parts[i] = strconv.Itoa(p)
	}
	return strings.Join(parts, ",")
}

// normalizeKeywords 关键字规整：去空、小写、去重、限长限量。空字符串会命中一切，必须挡掉。
// 入参是已经筛掉非字符串的列表（原版 `typeof raw !== 'string'` 跳过，由调用方做）。
func normalizeKeywords(input []string) []string {
	out := []string{}
	for _, raw := range input {
		k := utf16Prefix(jsToLower(jsTrim(raw)), MaxKeywordLen)
		if k == "" || slices.Contains(out, k) {
			continue
		}
		out = append(out, k)
		if len(out) >= MaxKeywords {
			break
		}
	}
	return out
}

// truncate 即原版 truncate：按 UTF-16 码元计长，超出截断并补省略号。空串视为 undefined。
func truncate(value string, max int) string {
	if value == "" {
		return ""
	}
	if utf16Len(value) <= max {
		return value
	}
	return utf16Prefix(value, max) + "…"
}

// matchEntry 端口反查条目：PID 精确匹配 → 会话归属 → 工作目录全等 → 目录前缀匹配，PRD §14。
// 端口相同**不作为**匹配依据 —— 那正是「因为端口一样就当成自己的」的错误。
// 返回空串表示没匹配上（原版 undefined）。
func (s *Service) matchEntry(expectations []EntryExpectation, pid int, cwd, sessionID string) string {
	for _, e := range expectations {
		if e.Pid != nil && *e.Pid == pid {
			return e.ID
		}
	}
	if sessionID != "" {
		for _, e := range expectations {
			if e.SessionID == sessionID {
				return e.ID
			}
		}
	}
	if cwd == "" {
		return ""
	}
	for _, e := range expectations {
		if s.sameDir(e.Cwd, cwd) {
			return e.ID
		}
	}
	// 前缀比较走平台的路径键：Windows 不区分大小写、分隔符是 \；macOS 保留大小写、分隔符是 /
	sep := "/"
	if s.src.ID() == "win32" {
		sep = `\`
	}
	key := s.src.PathKey(cwd)
	for _, e := range expectations {
		if strings.HasPrefix(key, s.src.PathKey(e.Cwd)+sep) {
			return e.ID
		}
	}
	return ""
}

// countConflicts 预期端口被非本条目的进程占用即为冲突，PRD §3.4。
// 必须看全部占用者：同一端口能被 IPv4 与 IPv6 两个进程同时占住，只看第一行会把「我这条也中招了」漏掉。
func countConflicts(expectations []EntryExpectation, listeners []contract.ListenerSnapshot) int {
	count := 0
	for _, exp := range expectations {
		if exp.Port == 0 {
			continue
		}
		for _, l := range listeners {
			if slices.Contains(l.Ports, exp.Port) && l.EntryID != exp.ID {
				count++
				break
			}
		}
	}
	return count
}

func (s *Service) sameDir(a, b string) bool {
	return s.src.PathKey(a) == s.src.PathKey(b)
}

// jsSpaceClass 即 JS 正则里 \s 的字符集（Go 的 \s 只认 ASCII）。
const jsSpaceClass = `\t\n\x{0B}\f\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}`

// 原版正则逐字搬；posix 版的 \s 换成 JS 的空白集。
var (
	absWin32 = regexp.MustCompile(`([a-zA-Z]:[\\/](?:[^"'*?<>|\r\n]*?))\.(?:js|cjs|mjs|ts)\b`)
	absPosix = regexp.MustCompile(`(\/(?:[^"'*?<>|\r\n` + jsSpaceClass + `]*?))\.(?:js|cjs|mjs|ts)\b`)
	// 原版 /[\\/]node_modules[\\/]/i。不用 (?i)：Go 的大小写折叠会把 U+017F、U+212A 认成 s、k，JS 非 u 模式不认
	nodeModules = regexp.MustCompile(`[\\/][nN][oO][dD][eE]_[mM][oO][dD][uU][lL][eE][sS][\\/]`)
)

// guessCwd 从命令行里的脚本路径推测项目目录；纯字符串处理，不触碰磁盘。
// 脚本通常在 node_modules 里（如 <root>/node_modules/vite/bin/vite.js），直接取脚本父目录会得到
// `vite/bin` 这种无意义的名字，所以在 node_modules 处截断，拿到的才是项目根。
func (s *Service) guessCwd(commandLine string) string {
	// Windows 认盘符开头的绝对路径，macOS 认 / 开头的绝对路径
	abs := absPosix
	if s.src.ID() == "win32" {
		abs = absWin32
	}
	m := abs.FindStringSubmatch(commandLine)
	if m == nil || m[1] == "" {
		return ""
	}
	script := m[1]
	if loc := nodeModules.FindStringIndex(script); loc != nil && loc[0] > 0 {
		return script[:loc[0]]
	}
	cut := max(strings.LastIndex(script, `\`), strings.LastIndex(script, "/"))
	// 原版比的是 UTF-16 下标 cut > 2
	if cut >= 0 && utf16Len(script[:cut]) > 2 {
		return script[:cut]
	}
	return ""
}
