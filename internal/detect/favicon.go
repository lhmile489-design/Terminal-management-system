// 对应 src/main/services/DetectService.ts 第 494–517、566–640 行：readFavicon、FAVICON_* 常量、tryReadIcon、parseIconHrefs。
//
// 纯只读：仅在项目目录内按常见约定找静态图标文件、或解析 index.html 的 <link rel="icon">。
// 不联网、不执行项目代码、不抓运行中的站点（红线 1）。href 一律校验落在项目根内，`..` 逃逸拒绝（红线 4）。

package detect

import (
	"encoding/base64"
	"os"
	"regexp"
	"strings"
)

// FaviconMaxBytes favicon 大小上限，超过跳过。
const FaviconMaxBytes = 256 * 1024

// faviconMIME 扩展名 → MIME，仅收位图/矢量图标类型。
var faviconMIME = map[string]string{
	".ico":  "image/x-icon",
	".svg":  "image/svg+xml",
	".png":  "image/png",
	".gif":  "image/gif",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
}

// FaviconCandidates 常见 favicon 静态位置，顺序即优先级。
var FaviconCandidates = []string{
	"public/favicon.svg",
	"public/favicon.ico",
	"public/favicon.png",
	"public/icon.svg",
	"public/logo.svg",
	"static/favicon.svg",
	"static/favicon.ico",
	"static/favicon.png",
	"src/favicon.ico",
	"src/assets/favicon.ico",
	"favicon.svg",
	"favicon.ico",
	"favicon.png",
}

// Favicon readFavicon 的返回值。
type Favicon struct {
	MIME   string `json:"mime"`
	Base64 string `json:"base64"`
}

// ReadFavicon 读取前端项目的本地 favicon，找不到返回 nil。
func (s *Service) ReadFavicon(rootDir string) *Favicon {
	for _, rel := range FaviconCandidates {
		if hit := s.tryReadIcon(rootDir, rel); hit != nil {
			return hit
		}
	}
	// 兜底：解析 index.html 里声明的图标，覆盖非约定位置（如 assets/xxx.png）
	if html, ok := readText(jsJoin(rootDir, "index.html")); ok && html != "" {
		for _, href := range parseIconHrefs(html) {
			if hit := s.tryReadIcon(rootDir, href); hit != nil {
				return hit
			}
		}
	}
	return nil
}

var leadingDotSlashRe = regexp.MustCompile(`^\.?/`)

// jsLineTerminators JS 正则里 . 不匹配的四个字符：LF、CR、U+2028、U+2029。
const jsLineTerminators = "\n\r\u2028\u2029"

// cleanIconPath 即 rel.trim().replace(/^\.?\//, ”).replace(/[?#].*$/, ”)。
// 第二个正则没有 m 标志：$ 只认整串末尾，. 不跨行终止符。所以它命中的是最左一个「之后直到串尾都没有行终止符」的 ? 或 #。
func cleanIconPath(rel string) string {
	c := leadingDotSlashRe.ReplaceAllString(jsTrim(rel), "")
	for k := 0; k < len(c); k++ {
		if (c[k] == '?' || c[k] == '#') && !strings.ContainsAny(c[k:], jsLineTerminators) {
			return c[:k]
		}
	}
	return c
}

// tryReadIcon 相对 root 的图标路径：必须落在 root 内、扩展名是已知图标类型、文件存在且不超上限。
func (s *Service) tryReadIcon(root, rel string) *Favicon {
	clean := cleanIconPath(rel)
	if clean == "" {
		return nil
	}
	mime, ok := faviconMIME[jsToLower(jsExtname(clean))]
	if !ok {
		return nil
	}
	abs := s.resolve(root, clean)
	rootAbs := s.resolve(root)
	if abs != rootAbs && !strings.HasPrefix(abs, rootAbs+`\`) {
		return nil
	}
	info, err := os.Stat(abs)
	if err != nil || !info.Mode().IsRegular() || info.Size() == 0 || info.Size() > FaviconMaxBytes {
		return nil
	}
	b, err := os.ReadFile(abs)
	if err != nil {
		return nil
	}
	return &Favicon{MIME: mime, Base64: base64.StdEncoding.EncodeToString(b)}
}

// resolve 即 path.resolve，cwd / 驱动器当前目录取自进程环境（与 node 一致）。
func (s *Service) resolve(args ...string) string {
	return jsResolve(func() string {
		wd, _ := os.Getwd()
		return wd
	}, os.LookupEnv, args...)
}

var (
	linkTagRe   = regexp.MustCompile(`(?i)<link\b[^>]*>`)
	relAttrRe   = regexp.MustCompile(`(?i)\brel\s*=\s*["']?([^"'>]+)`)
	hrefAttrRe  = regexp.MustCompile(`(?i)\bhref\s*=\s*["']([^"']+)`)
	iconRe      = regexp.MustCompile(`icon`)
	externalURL = regexp.MustCompile(`(?i)^([a-z]+:)?//`)
)

// parseIconHrefs 从 index.html 解析 rel 含 icon 的 <link> 的 href，纯正则、不执行。
// 只收相对本地路径：绝对 URL、协议相对、data: 一律跳过（不联网、不内联外链）。
func parseIconHrefs(html string) []string {
	out := []string{}
	for _, tag := range linkTagRe.FindAllString(html, -1) {
		rel := ""
		if m := relAttrRe.FindStringSubmatch(tag); m != nil {
			rel = jsToLower(m[1])
		}
		if !iconRe.MatchString(rel) {
			continue
		}
		m := hrefAttrRe.FindStringSubmatch(tag)
		if m == nil {
			continue
		}
		href := m[1]
		if href != "" && !externalURL.MatchString(href) && !strings.HasPrefix(href, "data:") {
			out = append(out, href)
		}
	}
	return out
}
