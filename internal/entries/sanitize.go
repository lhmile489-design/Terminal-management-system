// 对应 src/main/services/EntryService.ts 的 sanitizeEdit、normalizeCategory 与 groupEnv。
//
// 只放行白名单字段，并逐个校验值域 —— 越界的键静默丢弃，非法的值直接报错。
// 返回的补丁里，Patch 设了值但 Value 为 nil 表示「显式清空」，与 applyEdit 一起还原
// 原版 `{...target, ...clean}` 里 undefined 覆盖旧值的语义。

package entries

import (
	"errors"
	"fmt"

	"mile-console/internal/contract"
)

// SanitizeEdit 即原版 sanitizeEdit(target, patch)。
func (s *Service) SanitizeEdit(target contract.LaunchEntry, patch contract.EntryEdit) (contract.EntryEdit, error) {
	var out contract.EntryEdit

	if patch.Name != nil {
		name := jsTrim(*patch.Name)
		if name == "" {
			return out, errors.New("名称不能为空")
		}
		if utf16Len(name) > 60 {
			return out, errors.New("名称不能超过 60 字")
		}
		out.Name = &name
	}

	if patch.Category.Set {
		category, err := normalizeCategory(patch.Category.Value)
		if err != nil {
			return out, err
		}
		if category == "" {
			out.Category = contract.PatchNull[string]()
		} else {
			out.Category = contract.PatchOf(category)
		}
	}

	if patch.GroupID.Set {
		// null = 移出工作组（清空 groupId）；字符串 = 设置工作组 id
		if patch.GroupID.Value == nil {
			out.GroupID = contract.PatchNull[string]()
		} else {
			if utf16Len(*patch.GroupID.Value) > 64 {
				return out, errors.New("groupId 过长")
			}
			out.GroupID = contract.PatchOf(*patch.GroupID.Value)
		}
	}

	if patch.Kind != nil {
		if *patch.Kind != contract.EntryKindService && *patch.Kind != contract.EntryKindTask {
			return out, fmt.Errorf("类型非法：%s", *patch.Kind)
		}
		out.Kind = patch.Kind
	}

	if patch.Icon.Set {
		if patch.Icon.Value == nil {
			out.Icon = contract.PatchNull[contract.ServiceIcon]()
		} else {
			nextKind := target.Kind
			if patch.Kind != nil {
				nextKind = *patch.Kind
			}
			if nextKind != contract.EntryKindService {
				return out, errors.New("任务不能设置服务卡片图标")
			}
			if !serviceIconSet[*patch.Icon.Value] {
				return out, fmt.Errorf("服务图标非法：%s", *patch.Icon.Value)
			}
			out.Icon = contract.PatchOf(*patch.Icon.Value)
		}
	}

	if patch.ImageID.Set {
		// 渲染层只能经 edit 清除图片（null）。设置图片走专用的 SetImage(bytes)：
		// 由主进程压缩落盘并回填哈希文件名。这里拒绝任何字符串，杜绝渲染层指定
		// 任意文件名探测存在性 / 路径穿越。
		if patch.ImageID.Value != nil {
			return out, errors.New("图片只能经上传设置，edit 仅接受 null 清除")
		}
		out.ImageID = contract.PatchNull[string]()
	}

	if patch.Path != nil {
		if !isAbsolutePath(*patch.Path) {
			return out, errors.New("项目目录必须是绝对路径")
		}
		out.Path = patch.Path
	}

	if patch.Cwd != nil {
		// 空串等于「用项目根」，落盘存空串（omitempty），免得 join 出个多余分隔符
		cwd := jsTrim(*patch.Cwd)
		if isAbsolutePath(cwd) {
			return out, errors.New("子目录必须是相对路径")
		}
		if hasDotDot(cwd) {
			return out, errors.New("子目录不能跳出项目根")
		}
		out.Cwd = &cwd
	}

	if patch.Script.Set {
		if patch.Script.Value == nil {
			out.Script = contract.PatchNull[string]()
		} else {
			out.Script = contract.PatchOf(*patch.Script.Value)
		}
	}

	if !patch.Scripts.IsZero() {
		out.Scripts = patch.Scripts
	}

	if patch.Framework != nil {
		if !frameworkSet[*patch.Framework] {
			return out, fmt.Errorf("框架非法：%s", *patch.Framework)
		}
		out.Framework = patch.Framework
	}

	if patch.PackageManager != nil {
		if !packageManagerSet[*patch.PackageManager] {
			return out, fmt.Errorf("包管理器非法：%s", *patch.PackageManager)
		}
		out.PackageManager = patch.PackageManager
	}

	if patch.Env != nil {
		// 合并补丁：字符串设置/覆盖，null 删除，没提的键保持原值（渲染层拿不到旧值）
		merged := make(map[string]string, len(target.Env)+len(patch.Env))
		for k, v := range target.Env {
			merged[k] = v
		}
		for k, v := range patch.Env {
			if !envNameRE.MatchString(k) {
				return out, fmt.Errorf("环境变量名非法：%s", k)
			}
			if v == nil {
				delete(merged, k)
			} else {
				merged[k] = *v
			}
		}
		env := make(map[string]*string, len(merged))
		for k, v := range merged {
			value := v
			env[k] = &value
		}
		out.Env = env
	}

	if patch.ExpectedPort.Set {
		// 任务不监听端口（PRD §4.6）—— 留着会让诊断去查一个永不出现的端口
		if patch.ExpectedPort.Value == nil {
			out.ExpectedPort = contract.PatchNull[int]()
		} else {
			kind := target.Kind
			if patch.Kind != nil {
				kind = *patch.Kind
			}
			if kind == contract.EntryKindTask {
				return out, errors.New("任务不设置端口")
			}
			if port := *patch.ExpectedPort.Value; port < 1 || port > 65535 {
				return out, fmt.Errorf("端口必须是 1–65535 的整数：%d", port)
			}
			out.ExpectedPort = contract.PatchOf(*patch.ExpectedPort.Value)
		}
	}

	if patch.OutputDir.Set {
		if patch.OutputDir.Value == nil {
			out.OutputDir = contract.PatchNull[string]()
		} else {
			// 只收相对路径：knownPath() 把产物目录算进 shell.openPath 的白名单，
			// 允许绝对路径等于让渲染层往白名单里塞任意位置（PRD §11）
			dir := jsTrim(*patch.OutputDir.Value)
			if isAbsolutePath(dir) {
				return out, errors.New("产物目录必须是相对项目根的路径")
			}
			if hasDotDot(dir) {
				return out, errors.New("产物目录不能跳出项目根")
			}
			if dir == "" {
				out.OutputDir = contract.PatchNull[string]()
			} else {
				out.OutputDir = contract.PatchOf(dir)
			}
		}
	}

	if patch.LaunchMode.Set {
		if patch.LaunchMode.Value == nil {
			out.LaunchMode = contract.PatchNull[contract.LaunchMode]()
		} else {
			// 启动方式只对命令形状固定的生态有意义，且只能是固定枚举之一
			framework := target.Framework
			if patch.Framework != nil {
				framework = *patch.Framework
			}
			if !launchableFrameworks[framework] {
				return out, errors.New("该框架不支持设置启动方式")
			}
			mode := *patch.LaunchMode.Value
			if !launchModeSet[mode] {
				return out, fmt.Errorf("启动方式非法：%s", mode)
			}
			if s.plat.UnsupportedLaunchModes()[mode] {
				return out, fmt.Errorf("这台系统上暂不支持该启动方式：%s，只能仅登记", mode)
			}
			out.LaunchMode = contract.PatchOf(mode)
		}
	}

	if patch.JarPath.Set {
		if patch.JarPath.Value == nil {
			out.JarPath = contract.PatchNull[string]()
		} else {
			raw := jsTrim(*patch.JarPath.Value)
			mode := target.LaunchMode
			if patch.LaunchMode.Value != nil {
				mode = *patch.LaunchMode.Value
			}
			// python-module / uvicorn：是模块名不是路径，走标识符白名单
			if mode == contract.LaunchModePythonModule || mode == contract.LaunchModeUvicorn {
				if raw != "" && !SafePythonModule.MatchString(raw) {
					return out, fmt.Errorf("Python 模块名/规格非法：%s", raw)
				}
				out.JarPath = patchOrClear(raw)
				// 其余是项目内相对路径：相对项目根、禁 ..
			} else {
				if isAbsolutePath(raw) {
					return out, errors.New("路径必须是相对项目根的路径")
				}
				if hasDotDot(raw) {
					return out, errors.New("路径不能跳出项目根")
				}
				if raw != "" {
					if mode == contract.LaunchModeJar && !jarSuffixRE.MatchString(raw) {
						return out, errors.New("jar 路径必须以 .jar 结尾")
					}
					if mode == contract.LaunchModeCppExe && !exeSuffixRE.MatchString(raw) {
						return out, errors.New("可执行文件必须以 .exe 结尾")
					}
					if mode == contract.LaunchModePythonFile && !pySuffixRE.MatchString(raw) {
						return out, errors.New("入口文件必须以 .py 结尾")
					}
					if mode == contract.LaunchModePythonFile && !SafePythonEntry.MatchString(raw) {
						return out, fmt.Errorf("入口文件名含非法字符：%s", raw)
					}
				}
				out.JarPath = patchOrClear(raw)
			}
		}
	}

	if patch.StartAfter.Set {
		if patch.StartAfter.Value == nil {
			out.StartAfter = contract.PatchNull[[]string]()
		} else {
			ids := dedupeStrings(*patch.StartAfter.Value)
			if len(ids) > 32 {
				return out, errors.New("先等待最多 32 项")
			}
			if len(ids) == 0 {
				out.StartAfter = contract.PatchNull[[]string]()
			} else {
				out.StartAfter = contract.PatchOf(ids)
			}
		}
	}

	if patch.HealthCheck.Set {
		if patch.HealthCheck.Value == nil {
			out.HealthCheck = contract.PatchNull[contract.HealthCheckConfig]()
		} else {
			hc := *patch.HealthCheck.Value
			if !isSafeHealthPath(hc.Path) {
				return out, errors.New("健康检查路径必须以 / 开头，且只含字母、数字与 - . _ ~ / ? = & %")
			}
			// 只取这两个键：主机、端口、协议一律不收，渲染层给不出别的目标
			out.HealthCheck = contract.PatchOf(hc)
		}
	}

	if patch.AlertKeywords.Set {
		if patch.AlertKeywords.Value == nil {
			out.AlertKeywords = contract.PatchNull[[]string]()
		} else {
			words, err := sanitizeKeywords(*patch.AlertKeywords.Value)
			if err != nil {
				return out, err
			}
			if len(words) == 0 {
				out.AlertKeywords = contract.PatchNull[[]string]()
			} else {
				out.AlertKeywords = contract.PatchOf(words)
			}
		}
	}

	if patch.AutoRestart != nil {
		out.AutoRestart = patch.AutoRestart
	}
	if patch.AlertOnErrors != nil {
		out.AlertOnErrors = patch.AlertOnErrors
	}
	if patch.RegisterOnly != nil {
		out.RegisterOnly = patch.RegisterOnly
	}
	if patch.Pinned != nil {
		out.Pinned = patch.Pinned
	}

	// 类型改成任务就一并清掉端口与图标，否则旧端口会留在配置里继续参与冲突计算。
	// 任务跑完就退出，健康检查与自动重启对它没有意义。
	becameTask := out.Kind != nil && *out.Kind == contract.EntryKindTask
	providedHealth := out.HealthCheck.Set
	providedAutoRestart := out.AutoRestart != nil && *out.AutoRestart
	if becameTask {
		out.ExpectedPort = contract.PatchNull[int]()
		out.Icon = contract.PatchNull[contract.ServiceIcon]()
		out.HealthCheck = contract.PatchNull[contract.HealthCheckConfig]()
		out.AutoRestart = nil
	}
	nextKind := target.Kind
	if out.Kind != nil {
		nextKind = *out.Kind
	}
	// 已经是任务时又给了健康检查或自动重启：直接拒绝（改类型本身已清理，不在此列）
	if nextKind == contract.EntryKindTask && !becameTask && (providedAutoRestart || providedHealth) {
		return out, errors.New("任务不支持健康检查与自动重启")
	}
	return out, nil
}

// normalizeCategory 即原版 normalizeCategory：trim、限长、拒控制字符，空串表示清空。
func normalizeCategory(value *string) (string, error) {
	if value == nil {
		return "", nil
	}
	category := jsTrim(*value)
	if category == "" {
		return "", nil
	}
	if utf16Len(category) > CategoryMaxLength {
		return "", fmt.Errorf("分类不能超过 %d 个字符", CategoryMaxLength)
	}
	if controlCharRE.MatchString(category) {
		return "", errors.New("分类不能包含控制字符")
	}
	return category, nil
}

func sanitizeKeywords(in []string) ([]string, error) {
	words := make([]string, 0, len(in))
	seen := make(map[string]bool, len(in))
	for _, w := range in {
		w = jsTrim(w)
		if w == "" || seen[w] {
			continue
		}
		seen[w] = true
		words = append(words, w)
	}
	if len(words) > MaxAlertKeywords {
		return nil, fmt.Errorf("告警关键词最多 %d 个", MaxAlertKeywords)
	}
	for _, w := range words {
		if utf16Len(w) > MaxAlertKeywordLen {
			return nil, fmt.Errorf("告警关键词不能超过 %d 个字符", MaxAlertKeywordLen)
		}
		if controlCharRE.MatchString(w) {
			return nil, errors.New("告警关键词不能包含控制字符")
		}
	}
	return words, nil
}

func patchOrClear(s string) contract.Patch[string] {
	if s == "" {
		return contract.PatchNull[string]()
	}
	return contract.PatchOf(s)
}

func dedupeStrings(in []string) []string {
	out := make([]string, 0, len(in))
	seen := make(map[string]bool, len(in))
	for _, v := range in {
		if seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
	}
	return out
}

// hasDotDot 即原版 `p.split(/[\\/]/).includes('..')`。
func hasDotDot(p string) bool {
	for _, seg := range pathSepRE.Split(p, -1) {
		if seg == ".." {
			return true
		}
	}
	return false
}

// ApplyEdit 即原版 `{...target, ...clean}`：补丁里补了值的字段覆盖目标，清空标记把字段归零。
func ApplyEdit(target contract.LaunchEntry, clean contract.EntryEdit) contract.LaunchEntry {
	out := target
	// 原版在 sanitizeEdit 末尾对「显式改成任务」的补丁写 out.xxx = undefined，
	// 展开时会把目标上原有的端口 / 图标 / 健康检查 / 自动重启一并抹掉
	becameTask := clean.Kind != nil && *clean.Kind == contract.EntryKindTask
	if clean.Name != nil {
		out.Name = *clean.Name
	}
	if clean.Category.Set {
		out.Category = patchValue(clean.Category)
	}
	if clean.GroupID.Set {
		out.GroupID = patchValue(clean.GroupID)
	}
	if clean.Kind != nil {
		out.Kind = *clean.Kind
	}
	if clean.Icon.Set {
		out.Icon = patchValue(clean.Icon)
	}
	if clean.ImageID.Set {
		out.ImageID = patchValue(clean.ImageID)
	}
	if clean.Path != nil {
		out.Path = *clean.Path
	}
	if clean.Cwd != nil {
		out.Cwd = *clean.Cwd
	}
	if clean.Script.Set {
		if clean.Script.Value == nil {
			out.Script = nil
		} else {
			v := *clean.Script.Value
			out.Script = &v
		}
	}
	if !clean.Scripts.IsZero() {
		out.Scripts = clean.Scripts.Clone()
	}
	if clean.Framework != nil {
		out.Framework = *clean.Framework
	}
	if clean.PackageManager != nil {
		out.PackageManager = *clean.PackageManager
	}
	if clean.Env != nil {
		env := make(map[string]string, len(clean.Env))
		for k, v := range clean.Env {
			if v != nil {
				env[k] = *v
			}
		}
		out.Env = env
	}
	if clean.ExpectedPort.Set {
		if clean.ExpectedPort.Value == nil {
			out.ExpectedPort = nil
		} else {
			v := *clean.ExpectedPort.Value
			out.ExpectedPort = &v
		}
	}
	if clean.OutputDir.Set {
		out.OutputDir = patchValue(clean.OutputDir)
	}
	if clean.LaunchMode.Set {
		out.LaunchMode = patchValue(clean.LaunchMode)
	}
	if clean.JarPath.Set {
		out.JarPath = patchValue(clean.JarPath)
	}
	if clean.RegisterOnly != nil {
		out.RegisterOnly = *clean.RegisterOnly
	}
	if clean.StartAfter.Set {
		out.StartAfter = clampNilSlice(clean.StartAfter.Value)
	}
	if clean.HealthCheck.Set {
		if clean.HealthCheck.Value == nil {
			out.HealthCheck = nil
		} else {
			v := *clean.HealthCheck.Value
			out.HealthCheck = &v
		}
	}
	if clean.AutoRestart != nil {
		v := *clean.AutoRestart
		out.AutoRestart = &v
	}
	if clean.AlertKeywords.Set {
		out.AlertKeywords = clampNilSlice(clean.AlertKeywords.Value)
	}
	if clean.AlertOnErrors != nil {
		v := *clean.AlertOnErrors
		out.AlertOnErrors = &v
	}
	if clean.Pinned != nil {
		out.Pinned = *clean.Pinned
	}
	if becameTask {
		out.ExpectedPort = nil
		out.Icon = ""
		out.HealthCheck = nil
		out.AutoRestart = nil
	}
	return out
}

// patchValue 取补丁的值；清空（null）时给出零值。
func patchValue[T any](p contract.Patch[T]) T {
	if p.Value == nil {
		var zero T
		return zero
	}
	return *p.Value
}

// clampNilSlice 让清空得到 nil 而不是空切片，与 `omitempty` / `omitzero` 的落盘形状一致。
func clampNilSlice[T any](v *[]T) []T {
	if v == nil || len(*v) == 0 {
		return nil
	}
	return *v
}

// GroupEnv 即原版 groupEnv：未分组、或工作组已被删掉时按 dev 处理 ——
// 与渲染层 confirmEnv 的口径一致：没有工作组就没有沙箱 / 生产的确认要求。
func (s *Service) GroupEnv(groupID string) contract.GroupEnvironment {
	if groupID == "" {
		return contract.GroupEnvDev
	}
	for _, g := range s.cfg.Get().Groups {
		if g.ID == groupID && g.Env != "" {
			return g.Env
		}
	}
	return contract.GroupEnvDev
}

// AssertStartAfter 即原版 assertStartAfter：不能指向自己、不能指向不存在的条目、不能成环。
func (s *Service) AssertStartAfter(id string, deps []string) error {
	all := s.cfg.Get().Entries
	byID := make(map[string]contract.LaunchEntry, len(all))
	for _, e := range all {
		byID[e.ID] = e
	}
	for _, d := range deps {
		if d == id {
			return errors.New("先等待不能指向自己")
		}
		if _, ok := byID[d]; !ok {
			return fmt.Errorf("先等待的条目不存在：%s", d)
		}
	}
	next := func(x string) []string {
		if x == id {
			return deps
		}
		return byID[x].StartAfter
	}
	seen := map[string]bool{}
	stack := append([]string{}, deps...)
	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if cur == id {
			return errors.New("先等待形成了环：这些服务会互相等待，永远起不来")
		}
		if seen[cur] {
			continue
		}
		seen[cur] = true
		stack = append(stack, next(cur)...)
	}
	return nil
}
