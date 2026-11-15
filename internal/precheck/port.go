// 对应 src/main/services/PrecheckService.ts 的 portItem / diskItem。

package precheck

import (
	"context"
	"math"
	"slices"
	"strconv"
	"strings"

	"mile-console/internal/contract"
)

// portItem 预期端口空闲。
//
// 优先检查配置冲突：其他条目（不论启动状态）与本条目配置了同一端口，OS 还没有监听也能在启动前拦住。
// 但另一个进程已经真的在听这个端口时让实时检查先说话：受控的给「停止它」（停止前仍走归属校验），外部的给换端口。
//
// 实时检查取**全部**占用者再排掉自己，不能取第一个就下结论：同一端口可以被 IPv4 / IPv6 两个进程同时占住，
// 第一行恰好是自己时结论就反了（原版注释里的 Vite 与 Next 撞 3000 现场）。
func (s *Service) portItem(ctx context.Context, entry contract.LaunchEntry, snapshot *contract.ScanSnapshot, all []contract.LaunchEntry) contract.PrecheckItem {
	const label = "预期端口空闲"
	// 原版 `if (!port)`：未设置或为 0 都算没设
	if entry.ExpectedPort == nil || *entry.ExpectedPort == 0 {
		return contract.PrecheckItem{ID: "port", Label: label, Level: contract.PrecheckPass, Detail: "未设置预期端口"}
	}
	port := *entry.ExpectedPort
	canSwitch := entry.Framework == contract.FrameworkNext

	liveOther := false
	if snapshot != nil {
		for _, l := range snapshot.Listeners {
			if slices.Contains(l.Ports, port) && l.EntryID != entry.ID {
				liveOther = true
				break
			}
		}
	}
	var names []string
	for _, e := range all {
		if e.ID != entry.ID && e.ExpectedPort != nil && *e.ExpectedPort == port {
			names = append(names, e.Name)
		}
	}
	if len(names) > 0 && !liveOther {
		return contract.PrecheckItem{
			ID: "port", Label: label, Level: contract.PrecheckWarn,
			Detail: "端口 :" + strconv.Itoa(port) + " 与「" + strings.Join(names, "、") + "」配置重复，同时运行时会冲突",
			Fix:    s.switchFix(ctx, port, canSwitch),
		}
	}

	if snapshot == nil {
		return contract.PrecheckItem{ID: "port", Label: label, Level: contract.PrecheckPass, Detail: "尚无采集快照，跳过"}
	}

	var holders, others []contract.ListenerSnapshot
	for _, l := range snapshot.Listeners {
		if slices.Contains(l.Ports, port) {
			holders = append(holders, l)
			if l.EntryID != entry.ID {
				others = append(others, l)
			}
		}
	}
	if len(others) == 0 {
		return contract.PrecheckItem{ID: "port", Label: label, Level: contract.PrecheckPass, Detail: ":" + strconv.Itoa(port) + " 空闲"}
	}

	owned := others[0]
	for _, l := range others {
		if l.Ownership == contract.OwnershipOwned {
			owned = l
			break
		}
	}
	more := ""
	if len(others) > 1 {
		more = "，另有 " + strconv.Itoa(len(others)-1) + " 个进程也在监听"
	}
	self := ""
	if len(holders) > len(others) {
		self = "本条目也在监听同一端口，"
	}
	kind := "外部"
	if owned.Ownership == contract.OwnershipOwned {
		kind = "受控"
	}

	// 原版这里无论哪个分支都先扫一次空闲端口（受控分支用不上），顺序照搬
	f := s.switchFix(ctx, port, canSwitch)
	if owned.Ownership == contract.OwnershipOwned {
		f = fix(contract.FixResolvePort, "停止它")
	}
	return contract.PrecheckItem{
		ID: "port", Label: label, Level: contract.PrecheckWarn,
		Detail: self + ":" + strconv.Itoa(port) + " 被 " + owned.ProcessName + "（PID " + strconv.Itoa(owned.Pid) + "，" + kind + "）占用" + more,
		Fix:    f,
	}
}

// switchFix 换端口的修复入口。只有 Next 的 PORT 是已验证的注入入口；其他框架改 expectedPort 不会改变实际监听，不给一键切换。
func (s *Service) switchFix(ctx context.Context, port int, canSwitch bool) *contract.PrecheckFix {
	suggested, ok := s.opt.FindFreePort(ctx, port+1)
	f := fix(contract.FixSwitchPort, "改用其他端口")
	if canSwitch && ok {
		f.Label = "切换到 :" + strconv.Itoa(suggested)
		f.SuggestedPort = &suggested
	}
	return f
}

// diskItem 磁盘余量。读不出来时 pass 并写明跳过。
func (s *Service) diskItem(cwd string) contract.PrecheckItem {
	const label = "磁盘剩余空间 > 500MB"
	free, err := s.opt.FreeSpace(cwd)
	if err != nil {
		return contract.PrecheckItem{ID: "disk", Label: label, Level: contract.PrecheckPass, Detail: "无法读取，跳过"}
	}
	level := contract.PrecheckWarn
	if free > MinFreeBytes {
		level = contract.PrecheckPass
	}
	// 原版 Math.round(free / 1024 / 1024)：一半朝 +∞，free 非负所以等于 math.Floor(x + 0.5)
	mb := math.Floor(float64(free)/1024/1024 + 0.5)
	return contract.PrecheckItem{ID: "disk", Label: label, Level: level, Detail: "剩余 " + strconv.FormatFloat(mb, 'f', -1, 64) + " MB"}
}
