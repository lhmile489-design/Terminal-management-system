// 对应 src/main/services/EntryService.ts 第 966–1000 行的 openInHBuilderX 与
// hbuilderxCliCandidates / resolveHBuilderXCli。
//
// 用本机 HBuilderX 打开 uniapp 项目：命令形状固定（file 是探测到的 cli，子命令硬编码
// `project open --path <cwd>`），路径经 assertInsideEntry 保证在登记目录内。
// 它不是受管会话：不进 SessionService、不下发 runToken、不接管日志 / 端口 / 停止。
//
// 已知原版问题 I1（见 docs/MIGRATION-PLAN.md §5，照原样搬，不修）：
// cli 的绝对路径经 `cmd.exe /d /s /c` 转发，路径含空格（如 C:\Program Files\HBuilderX\cli.exe）
// 时 cmd 会重新解析并拆断。修法要改平台的批处理包装，等用户决定。

package entries

import (
	"errors"
	"fmt"
	"os"

	"mile-console/internal/contract"
)

// HBuilderXCli 即原版 resolveHBuilderXCli：按候选顺序取第一个存在的。
// 候选里已包含 MILE_HBUILDERX_CLI 的覆盖（由平台层处理），测试可以指向夹具里的假 cli。
func HBuilderXCli(plat Platform) (string, bool) {
	for _, candidate := range plat.HBuilderXCandidates() {
		if _, err := os.Stat(candidate); err == nil {
			return candidate, true
		}
	}
	return "", false
}

// OpenInHBuilderX 即原版 openInHBuilderX：只对 uniapp 条目开放。
// 返回 true 表示已经把独立进程拉起来（不等待它结束）。
func (s *Service) OpenInHBuilderX(id string) (bool, error) {
	entry, ok := s.Get(id)
	if !ok {
		return false, errors.New("条目不存在")
	}
	if entry.Framework != contract.FrameworkUniapp {
		return false, errors.New("仅 uniapp 项目支持用 HBuilderX 打开")
	}

	cwd := resolveCwdOf(entry)
	if err := assertInsideEntry(entry, cwd); err != nil {
		return false, err
	}

	cli, ok := HBuilderXCli(s.plat)
	if !ok {
		return false, errors.New("未找到 HBuilderX cli.exe，请确认已安装 HBuilderX")
	}
	if s.opt.SpawnDetached == nil {
		return false, errors.New("外部进程启动器未就绪")
	}

	// 经 cmd.exe /d /s /c 转发：cli 若是 .cmd/.bat 批处理无法被 CreateProcess 直接执行。
	// 参数仍以数组传入、绝不拼 shell 字符串；子命令 project open 固定、路径受 assertInsideEntry 约束。
	file, args := s.plat.WrapBatch(cli, []string{"project", "open", "--path", cwd})
	if err := s.opt.SpawnDetached(file, args); err != nil {
		return false, fmt.Errorf("启动 HBuilderX 失败：%w", err)
	}
	return true, nil
}
