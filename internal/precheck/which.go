// 对应 src/main/services/PrecheckService.ts 的 whichAny（原版第 605 行导出，EntryService 也用它）。
//
// 只在 PATH 各目录 stat 候选文件名，不执行。

package precheck

import (
	"strings"

	"mile-console/internal/detect"
)

// pathDelimiter 即 node 的 path.delimiter（win32 为 ;）。
const pathDelimiter = ";"

// NodeBinaries 「当前 Node 版本」用的候选名（§6「Node 版本来源」）。原版 BINARIES 里没有 node，这是新增的。
var NodeBinaries = []string{"node.exe"}

// WhichAny 即原版 whichAny(names)：按 PATH 目录顺序、每个目录内按候选名顺序，返回第一个 stat 成功的路径。
// 原版用 statSafe(candidate) 非 null 判断，所以同名目录也算命中，照搬。
func (s *Service) WhichAny(names []string) (string, bool) {
	env, _ := s.opt.Getenv("PATH")
	for _, dir := range strings.Split(env, pathDelimiter) {
		if dir == "" {
			continue
		}
		for _, name := range names {
			candidate := detect.Join(dir, name)
			if exists(candidate) {
				return candidate, true
			}
		}
	}
	return "", false
}

// pathNodeVersion 在 PATH 里定位 node.exe，读它的文件版本资源（只读文件，不执行）。
func (s *Service) pathNodeVersion() (string, bool) {
	p, ok := s.WhichAny(NodeBinaries)
	if !ok {
		return "", false
	}
	return fileVersion(p)
}
