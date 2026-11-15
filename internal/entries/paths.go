// 对应 src/main/services/EntryService.ts 第 862–1029 行：knownPath / terminalCwd /
// packageJsonPath / favicon / setImage / clearImage / imageDataUrl / outputDir / revealOutput。

package entries

import (
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"

	"mile-console/internal/contract"
	"mile-console/internal/detect"
	"mile-console/internal/precheck"
)

// knownPath 即原版：目标是否为某条目的工作目录或其产物目录（shell.openPath 白名单）。
// 采集快照只含正在监听的进程 cwd，停止状态的条目不在其中，所以需要这一路。
func (s *Service) KnownPath(target string) bool {
	want := NormalizePath(s.plat, target)
	for _, e := range s.List() {
		cwd := resolveCwdOf(e)
		if NormalizePath(s.plat, cwd) == want {
			return true
		}
		// 旧配置里的绝对路径或带 .. 的 outputDir 一律不信
		if e.OutputDir != "" && IsSafeRelative(e.OutputDir) {
			if NormalizePath(s.plat, detect.Join(cwd, e.OutputDir)) == want {
				return true
			}
		}
	}
	return false
}

// TerminalCwd 即原版 terminalCwd：「在此目录开终端」的工作目录，渲染层只给 id（红线 4）。
// 解析结果必须仍在条目路径内且目录真实存在，任何一项不满足都报错，不回退。
func (s *Service) TerminalCwd(id string) (string, string, error) {
	entry, ok := s.Get(id)
	if !ok {
		return "", "", fmt.Errorf("条目不存在：%s", id)
	}
	cwd := resolveCwdOf(entry)
	if err := assertInsideEntry(entry, cwd); err != nil {
		return "", "", err
	}
	if !IsDirectory(cwd) {
		return "", "", fmt.Errorf("目录不存在：%s", cwd)
	}
	return cwd, entry.Name, nil
}

// PackageJsonPath 即原版：条目的 package.json 路径，供「在编辑器中打开」用。
func (s *Service) PackageJsonPath(id string) (string, bool) {
	entry, ok := s.Get(id)
	if !ok {
		return "", false
	}
	return detect.Join(resolveCwdOf(entry), "package.json"), true
}

// Favicon 即原版 favicon：前端条目的本地 favicon，返回 data URL。
// 只对前端生态尝试 —— 后端目录里的 .ico 不是网站图标。
func (s *Service) Favicon(id string) (string, bool) {
	entry, ok := s.Get(id)
	if !ok || !contract.IsWebFramework(entry.Framework) || s.opt.ReadFavicon == nil {
		return "", false
	}
	hit := s.opt.ReadFavicon(resolveCwdOf(entry))
	if hit == nil {
		return "", false
	}
	return "data:" + hit.MIME + ";base64," + hit.Base64, true
}

// SetImage 即原版 setImage：渲染层交原始字节，主进程解码压缩落盘，回填哈希文件名。
func (s *Service) SetImage(id string, data []byte) (string, error) {
	if _, ok := s.Get(id); !ok {
		return "", fmt.Errorf("条目不存在：%s", id)
	}
	if s.opt.Images == nil {
		return "", errors.New("图片服务未就绪")
	}
	imageID, err := s.opt.Images.SaveFromData(data)
	if err != nil {
		return "", err
	}
	if _, err := s.Update(id, func(e *contract.LaunchEntry) { e.ImageID = imageID }); err != nil {
		return "", err
	}
	return imageID, nil
}

// ClearImage 即原版 clearImage：清除自定义图片，回退到 icon / favicon / 框架字标。
func (s *Service) ClearImage(id string) (contract.LaunchEntry, error) {
	if _, ok := s.Get(id); !ok {
		return contract.LaunchEntry{}, fmt.Errorf("条目不存在：%s", id)
	}
	return s.Update(id, func(e *contract.LaunchEntry) { e.ImageID = "" })
}

// ImageDataURL 即原版 imageDataUrl：读取条目自定义图片为 data URL，无图片或失败返回 false。
func (s *Service) ImageDataURL(id string) (string, bool) {
	entry, ok := s.Get(id)
	if !ok || entry.ImageID == "" || s.opt.Images == nil {
		return "", false
	}
	return s.opt.Images.Read(entry.ImageID)
}

// OutputDir 即原版 outputDir（PRD §4.2）：条目已配置则用它，否则按常见约定探测。
// 只做目录存在性检查，不读内容。
func (s *Service) OutputDir(id string) *string {
	entry, ok := s.Get(id)
	if !ok {
		return nil
	}
	cwd := resolveCwdOf(entry)
	// 旧配置里可能留着绝对路径或带 .. 的 outputDir（add 以前不校验）：读侧同样不信它
	if entry.OutputDir != "" && !IsSafeRelative(entry.OutputDir) {
		return nil
	}
	var candidates []string
	if entry.OutputDir != "" {
		candidates = []string{detect.Join(cwd, entry.OutputDir)}
	} else {
		for _, d := range OutputDirCandidates {
			candidates = append(candidates, detect.Join(cwd, d))
		}
	}
	for _, dir := range candidates {
		if IsDirectory(dir) {
			out := dir
			return &out
		}
	}
	return nil
}

// RevealResult 即原版 revealOutput 的返回值：找到的具体文件 / 产物目录 / 都没有。
type RevealResult struct {
	Kind string // file | dir | none
	Path *string
}

// 产物目录里的优先级：安装包 > 压缩包 > Java 产物 > Node 产物 > 网页入口
var revealPriorityExts = [][]string{
	{".exe", ".msi", ".dmg", ".pkg", ".appimage", ".deb", ".rpm"},
	{".zip", ".tar.gz", ".tgz", ".7z"},
	{".jar"},
	{".js", ".cjs", ".mjs"},
	{".html"},
}

// RevealOutput 即原版 revealOutput：在资源管理器里定位产物。
// 路径全由主进程构造，渲染层只给 id（PRD §11）。
func (s *Service) RevealOutput(id string) RevealResult {
	dir := s.OutputDir(id)
	if dir == nil {
		return RevealResult{Kind: "none"}
	}
	entries, err := os.ReadDir(*dir)
	if err != nil {
		// 目录刚写完可能还没刷新，fallback 到 openPath
		return RevealResult{Kind: "dir", Path: dir}
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for _, exts := range revealPriorityExts {
		for _, n := range names {
			lower := strings.ToLower(n)
			for _, ext := range exts {
				if strings.HasSuffix(lower, ext) {
					p := detect.Join(*dir, n)
					return RevealResult{Kind: "file", Path: &p}
				}
			}
		}
	}
	return RevealResult{Kind: "dir", Path: dir}
}

// ListJars 即原版 listJars：扫描 Spring Boot 项目 target/ 下的主体 jar，返回相对项目根的路径。
// 过滤掉 -sources / -javadoc 辅助包与 original- 前缀。只读目录，不执行代码。
func (s *Service) ListJars(id string) []string {
	entry, ok := s.Get(id)
	if !ok || entry.Framework != contract.FrameworkSpringBoot {
		return nil
	}
	targetDir := detect.Join(resolveCwdOf(entry), "target")
	entries, err := os.ReadDir(targetDir)
	if err != nil {
		return nil // target/ 不存在（还没打包）
	}
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		n := e.Name()
		if !jarSuffixRE.MatchString(n) || strings.Contains(n, "-sources") ||
			strings.Contains(n, "-javadoc") || strings.HasPrefix(n, "original-") {
			continue
		}
		out = append(out, "target/"+n)
	}
	sort.Strings(out)
	return out
}

// resolveCwdOf 即原版 resolveCwd(entry)，直接用 S17 移植的实现，保持单一来源。
func resolveCwdOf(entry contract.LaunchEntry) string { return precheck.ResolveCwd(entry) }
