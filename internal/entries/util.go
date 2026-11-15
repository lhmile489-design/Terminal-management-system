// 对应 src/main/services/EntryService.ts 第 2086–2161 行的文件尾工具函数，
// 外加 sanitizeEdit 需要的一小撮 JS 字符串语义（trim 与 UTF-16 长度）。

package entries

import (
	"encoding/json"
	"os"
	"strings"
	"unicode"
	"unicode/utf16"

	"mile-console/internal/contract"
	"mile-console/internal/detect"
	"mile-console/internal/logs"
)

// ByOrder 即原版 byOrder：置顶优先，其余按 order 升序。
func ByOrder(a, b contract.LaunchEntry) bool {
	if a.Pinned != b.Pinned {
		return a.Pinned
	}
	return a.Order < b.Order
}

// IsLive 即原版 isLive：这几个状态算「还在跑」，运行中不可改身份字段。
func IsLive(status contract.EntryStatus) bool {
	switch status {
	case contract.EntryPrecheck, contract.EntryStarting, contract.EntryRunning, contract.EntryStopping:
		return true
	}
	return false
}

// TaskStatus 即原版 taskStatus（PRD §4.6）。
//
// 「用户中止」优先于退出码：taskkill 掉的任务退出码是什么全看它当时在干什么，
// 按码判会把用户自己按的停止显示成失败。130 只在任务自然退出时才作数。
func TaskStatus(exitCode int, stoppedByUser bool) contract.EntryStatus {
	if stoppedByUser {
		return contract.EntryStopped
	}
	if exitCode == 0 {
		return contract.EntrySucceeded
	}
	if exitCode == TaskCanceledCode {
		return contract.EntryCanceled
	}
	return contract.EntryFailed
}

// CapturePort 即原版 capturePort：先剥 ANSI、遮掉「端口被占用」那句话，再按顺序匹配。
// 返回 0,false 表示这一块里没有端口。
func CapturePort(chunk string) (int, bool) {
	text := PortTaken.ReplaceAllString(logs.StripAnsi(chunk), " ")
	for _, re := range PortPatterns {
		m := re.FindStringSubmatch(text)
		if m == nil {
			continue
		}
		port := 0
		for _, c := range m[1] {
			if c < '0' || c > '9' {
				break
			}
			port = port*10 + int(c-'0')
		}
		if port > 0 && port <= 65535 {
			return port, true
		}
	}
	return 0, false
}

// IsSafeRelative 即原版 isSafeRelative：相对路径且不含 ..。写侧已这样收，读侧再验一次兜住旧配置。
func IsSafeRelative(p string) bool {
	if isAbsolutePath(p) {
		return false
	}
	for _, seg := range pathSepRE.Split(p, -1) {
		if seg == ".." {
			return false
		}
	}
	return true
}

// NormalizePath 即原版 normalizePath：走平台路径比较键（Windows 消掉大小写与冗余分隔符）。
func NormalizePath(plat Platform, target string) string { return plat.PathKey(target) }

// IsDirectory 即原版 isDirectory。
func IsDirectory(target string) bool {
	st, err := os.Stat(target)
	return err == nil && st.IsDir()
}

// IsFile 即原版 isFile。
func IsFile(target string) bool {
	st, err := os.Stat(target)
	return err == nil && st.Mode().IsRegular()
}

// IsRunnable 即原版 isRunnable：项目自带的 wrapper 是文件，且平台要求时有执行位。
func IsRunnable(plat Platform, target string) bool {
	if !IsFile(target) {
		return false
	}
	if !plat.RequiresExecBit() {
		return true
	}
	st, err := os.Stat(target)
	if err != nil {
		return false
	}
	return st.Mode()&0o111 != 0
}

// jsIsSpace 是 JS String.prototype.trim 认的空白：WhiteSpace 加 LineTerminator。
func jsIsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', '\u2028', '\u2029', '\ufeff':
		return true
	}
	return unicode.Is(unicode.Zs, r)
}

// jsTrim 即 JS 的 String.prototype.trim。Go 的 TrimSpace 与它差两个码点：
// U+FEFF（JS 算空白，Go 不算）与 U+0085（Go 算空白，JS 不算）。
func jsTrim(s string) string { return strings.TrimFunc(s, jsIsSpace) }

// utf16Len 即 JS 字符串的 .length：按 UTF-16 码元计数。
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += len(utf16.Encode([]rune{r}))
			continue
		}
		n++
	}
	return n
}

// isSafeHealthPath 即原版 SAFE_HEALTH_PATH：
// 以 `/` 开头、不以 `//` 开头（那会被当成协议相对地址里的主机），1–256 字符，
// 只允许非保留字符加 `/ ? = & %`。Go 的正则没有负向前瞻，所以按字符逐个判定。
func isSafeHealthPath(p string) bool {
	if p == "" || p[0] != '/' {
		return false
	}
	if len(p) > 1 && p[1] == '/' {
		return false
	}
	for _, r := range p[1:] {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '-', r == '.', r == '_', r == '~', r == '/', r == '?', r == '=', r == '&', r == '%':
		default:
			return false
		}
	}
	// 原版按 UTF-16 码元限制 0–255（不含开头那个 /），白名单里全是 ASCII，逐字符计数等价
	return len(p)-1 <= 255
}

// sameJSON 即原版 same()：按内容比较两个值，引用不同但内容相同算没变。
func sameJSON(a, b any) bool {
	x, err1 := json.Marshal(a)
	y, err2 := json.Marshal(b)
	return err1 == nil && err2 == nil && string(x) == string(y)
}

// isAbsolutePath 即 node:path 的 isAbsolute（win32 口径，`/foo` 也算绝对路径）。
// 直接复用 S16 移植的 V8 / win32 path 语义，不在这里另写一份。
func isAbsolutePath(p string) bool { return detect.IsAbsolute(p) }
