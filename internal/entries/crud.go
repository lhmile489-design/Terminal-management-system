// 对应 src/main/services/EntryService.ts 的 list / get / add / update / edit / remove / reorder / commit。
//
// 与原版的分工一致：update 是主进程内部通道（字段由代码给出），edit 收界面输入、逐字段校形，
// 并在运行中挡住身份字段的改动。落盘、'.bak' 轮转由 internal/config 负责，本包只管
// 「下一个 entries 数组应该长什么样」。

package entries

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	"mile-console/internal/contract"
	"mile-console/internal/detect"
	"mile-console/internal/platform"
)

// Store 条目服务用到的配置能力，由 *config.Store 满足。
type Store interface {
	Get() contract.AppConfig
	Patch(fn func(c *contract.AppConfig)) (contract.AppConfig, error)
}

// Platform 本步骤用到的平台能力；S21b / S21c / S21d 会按需扩宽。
type Platform interface {
	PathKey(p string) string
	UnsupportedLaunchModes() map[contract.LaunchMode]bool
	RequiresExecBit() bool
	// ReadListenPorts 现查监听表（重启前等端口释放、诊断找持有者）。
	ReadListenPorts(ctx context.Context) ([]platform.ListenRow, error)
	// Binaries 各语言 / 包管理器的可执行文件候选名，命令构造按需 whichAny 定位。
	Binaries() map[platform.BinaryName][]string
	// WrapperFile 项目自带 wrapper 的文件名（mvnw.cmd / gradlew.bat）。
	WrapperFile() platform.WrapperFiles
	// WrapBatch 批处理文件（.cmd / .bat）的执行包装，Windows 经 cmd /d /s /c。
	WrapBatch(file string, args []string) (string, []string)
	// HBuilderXCandidates HBuilderX 命令行的探测位置；空表示本平台不支持。
	HBuilderXCandidates() []string
}

// Sessions 条目服务用到的会话能力：建会话与终止会话（S21c 会再加订阅输出）。
type Sessions interface {
	Kill(ctx context.Context, id string)
	Create(in contract.CreateSessionInput) (contract.SessionMeta, error)
	Stop(id string)
	History(id string) string
	OnData(fn func(contract.SessionDataEvent)) (unsubscribe func())
	OnExit(fn func(contract.SessionExitEvent)) (unsubscribe func())
}

// ImageStore 自定义图片服务（由 *images.Service 满足）。
type ImageStore interface {
	SaveFromData(data []byte) (string, error)
	Read(imageID string) (string, bool)
}

// Scanner 采集快照与进程表（由 *scanner.Service 满足）。
type Scanner interface {
	Snapshot() *contract.ScanSnapshot
	Table(ctx context.Context, hint []int) (platform.ProcessTable, error)
}

// Ownership 归属判定（由 *ownership.Service 满足）。
type Ownership interface {
	AssertKillable(pid int, table platform.ProcessMeta, sessionID string) (contract.OwnershipVerdict, error)
	Verify(pid int, table platform.ProcessMeta) contract.OwnershipVerdict
}

// Timer 与 sessions / logs 同形，便于测试注入手动定时器。
type Timer interface{ Stop() bool }

// Options 可注入的时钟、id 生成、事件与定时器，零值即生产行为。
type Options struct {
	Now       func() time.Time
	NewID     func() string
	OnChanged func(entries []contract.LaunchEntry)
	// Emit 事件出口：runtime / blocked / warning / crashed / taskDone / autoRestartGaveUp / portUnreleased。
	// 绑定层（S24）把它转成页面的 Alphanumeric 事件名。
	Emit func(name string, payload any)
	// Scanner 采集快照与进程表（S15）。S21c 的端口归属、诊断与停止前重验都要它。
	Scanner Scanner
	// Ownership 归属判定（S14）：停止前重验、诊断里的持有者判定。
	Ownership Ownership
	// Precheck 预检（S17）。未注入时按「通过」处理，单测不必拖上整条预检链。
	Precheck func(ctx context.Context, entry contract.LaunchEntry, snapshot *contract.ScanSnapshot, all []contract.LaunchEntry) (contract.PrecheckResult, error)
	// ListJars 打包成功后扫描产物目录里的 jar（S21d）。未注入时跳过。
	ListJars func(entryID string) []string
	// OutputDir 任务产物目录（S21d），诊断里给任务用。
	OutputDir func(entryID string) *string
	// NodeVersion 诊断面板展示的「当前 Node 版本」（S17 读的是 PATH 里 node.exe 的版本资源）。
	NodeVersion func() string
	// Images 自定义图片读写（S20）。未注入时 SetImage 报错、读取返回空。
	Images ImageStore
	// ReadFavicon 读前端条目的本地 favicon（S16）。未注入时 Favicon 恒为空。
	ReadFavicon func(dir string) *detect.Favicon
	// SpawnDetached 拉起独立 GUI 进程（HBuilderX）。未注入时 OpenInHBuilderX 报错。
	SpawnDetached func(file string, args []string) error
	// After 可注入的等待，默认 time.After。
	After     func(d time.Duration) <-chan time.Time
	AfterFunc func(d time.Duration, f func()) Timer
	// Which 即原版 whichAny：按 PATH 目录顺序定位可执行文件，只 stat 不执行。
	// 绑定层接 S17 的 precheck.Service.WhichAny；未注入时命令构造一律报「PATH 中找不到 X」。
	Which func(candidates []string) (string, bool)
}

// Service 即原版 EntryService。S21b / S21c / S21d 在同一个结构体上加方法。
type Service struct {
	ctx  context.Context
	cfg  Store
	plat Platform
	sess Sessions
	opt  Options

	mu sync.Mutex
	// runtimes 运行态，S21c 维护；S21a 只读它来判断「运行中改身份」。
	runtimes map[string]contract.EntryRuntime
	// restartTimers 排队中的自动重启，S21c 维护；edit / remove 会撤销。
	restartTimers map[string]Timer
	// restartHistory 每个条目最近的自动重启时刻，S21c 维护。
	restartHistory map[string][]int64
	// lastErrorLine 会话退出后留档的最后一个错误行，只在内存（S21c 写，SpawnSession 清）。
	lastErrorLine map[string]string
	// awaitingHealthReady 端口已捕获、正在等健康检查首次 ok 的条目。
	awaitingHealthReady map[string]bool
	// watches 按会话 id 记的输出捕获与退出收尾状态。
	watches map[string]*Watch
	// lastTail / lastErrorTail 退出前最后 30 行可见输出与最后一个错误行，只在内存。
	lastTail      map[string][]string
	lastErrorTail map[string]string
	// lastRunMs 上次运行时长（毫秒）。
	lastRunMs map[string]int64
	// readyHistory 最近 READY_HISTORY 次启动耗时（毫秒）。
	readyHistory map[string][]int64
	// quitting 退出流程已开始：不再排任何重启、不再起新会话。
	quitting bool
	// autoStarting 正在由自动重启发起的 Start，用来区分「手动启动」。
	autoStarting map[string]bool
	// runtimeSubs / changedSubs 进程内订阅者（健康检查、告警服务用），
	// 与 Options.Emit / OnChanged 是两条路：后者给绑定层，这两个给同进程的服务。
	runtimeSubs []func(contract.EntryRuntime)
	changedSubs []func([]contract.LaunchEntry)
}

// OnRuntime 订阅运行态推送，返回退订函数。
func (s *Service) OnRuntime(fn func(contract.EntryRuntime)) func() {
	s.mu.Lock()
	idx := len(s.runtimeSubs)
	s.runtimeSubs = append(s.runtimeSubs, fn)
	s.mu.Unlock()
	return func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if idx < len(s.runtimeSubs) {
			s.runtimeSubs[idx] = func(contract.EntryRuntime) {}
		}
	}
}

// OnEntriesChanged 订阅条目变更（commit 之后），返回退订函数。
func (s *Service) OnEntriesChanged(fn func([]contract.LaunchEntry)) func() {
	s.mu.Lock()
	idx := len(s.changedSubs)
	s.changedSubs = append(s.changedSubs, fn)
	s.mu.Unlock()
	return func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if idx < len(s.changedSubs) {
			s.changedSubs[idx] = func([]contract.LaunchEntry) {}
		}
	}
}

// New 构造条目服务。ctx 用于 Remove 时后台终止会话；绑定层不得传 context.Background()。
func New(ctx context.Context, cfg Store, plat Platform, sess Sessions, opt Options) *Service {
	if opt.Now == nil {
		opt.Now = time.Now
	}
	if opt.NewID == nil {
		opt.NewID = newUUID
	}
	if opt.AfterFunc == nil {
		opt.AfterFunc = func(d time.Duration, f func()) Timer { return time.AfterFunc(d, f) }
	}
	if opt.After == nil {
		opt.After = time.After
	}
	if opt.Emit == nil {
		opt.Emit = func(string, any) {}
	}
	s := &Service{
		ctx: ctx, cfg: cfg, plat: plat, sess: sess, opt: opt,
		runtimes:            map[string]contract.EntryRuntime{},
		restartTimers:       map[string]Timer{},
		restartHistory:      map[string][]int64{},
		lastErrorLine:       map[string]string{},
		awaitingHealthReady: map[string]bool{},
		watches:             map[string]*Watch{},
		lastTail:            map[string][]string{},
		lastErrorTail:       map[string]string{},
		lastRunMs:           map[string]int64{},
		readyHistory:        map[string][]int64{},
		autoStarting:        map[string]bool{},
	}
	s.subscribe()
	return s
}

// subscribe 即原版构造函数里的 sessions.on('data' | 'exit')。
func (s *Service) subscribe() {
	if s.sess == nil {
		return
	}
	s.sess.OnData(func(e contract.SessionDataEvent) { s.absorb(e.ID, e.Chunk) })
	s.sess.OnExit(func(e contract.SessionExitEvent) { s.onSessionExit(e.ID, e.ExitCode) })
}

// List 即原版 list：置顶优先、其余按 order。
func (s *Service) List() []contract.LaunchEntry {
	entries := append([]contract.LaunchEntry{}, s.cfg.Get().Entries...)
	sort.SliceStable(entries, func(i, j int) bool { return ByOrder(entries[i], entries[j]) })
	return entries
}

// Get 即原版 get。
func (s *Service) Get(id string) (contract.LaunchEntry, bool) {
	for _, e := range s.cfg.Get().Entries {
		if e.ID == id {
			return e, true
		}
	}
	return contract.LaunchEntry{}, false
}

// RuntimeOf 即原版 runtimeOf。
func (s *Service) RuntimeOf(id string) (contract.EntryRuntime, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rt, ok := s.runtimes[id]
	return rt, ok
}

// RuntimeList 即原版 runtimeList。
func (s *Service) RuntimeList() []contract.EntryRuntime {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]contract.EntryRuntime, 0, len(s.runtimes))
	for _, rt := range s.runtimes {
		out = append(out, rt)
	}
	return out
}

// putRuntime 直接整条写入运行态，供测试与 S21c 的内部初始化用。
func (s *Service) putRuntime(rt contract.EntryRuntime) {
	s.mu.Lock()
	s.runtimes[rt.EntryID] = rt
	s.mu.Unlock()
}

// Add 即原版 add：入参来自渲染层，校验口径与 edit 相同：逐字段走 SanitizeEdit，
// 白名单外的键（id、order、lastStartedAt…）静默丢弃。
func (s *Service) Add(in contract.NewLaunchEntry) (contract.LaunchEntry, error) {
	base := contract.LaunchEntry{
		Kind:           contract.EntryKindService,
		Framework:      contract.FrameworkUnknown,
		PackageManager: contract.PackageManagerNpm,
		Scripts:        contract.NewScripts(),
		Env:            map[string]string{},
	}
	clean, err := s.SanitizeEdit(base, editFromNew(in))
	if err != nil {
		return contract.LaunchEntry{}, err
	}

	required := []struct {
		field contract.EditableEntryField
		ok    bool
	}{
		{"kind", clean.Kind != nil},
		{"name", clean.Name != nil},
		{"path", clean.Path != nil},
		{"framework", clean.Framework != nil},
		{"packageManager", clean.PackageManager != nil},
	}
	for _, r := range required {
		if !r.ok {
			return contract.LaunchEntry{}, fmt.Errorf("缺少必填字段：%s", FieldLabel(r.field))
		}
	}
	if !IsDirectory(*clean.Path) {
		return contract.LaunchEntry{}, fmt.Errorf("目录不存在：%s", *clean.Path)
	}

	entry := ApplyEdit(base, clean)
	if entry.Script != nil {
		if !SafeScript.MatchString(*entry.Script) {
			return contract.LaunchEntry{}, fmt.Errorf("脚本名含非法字符：%s", *entry.Script)
		}
		if _, ok := entry.Scripts.Get(*entry.Script); !ok {
			return contract.LaunchEntry{}, fmt.Errorf("%s 不在该项目的 scripts 中", *entry.Script)
		}
	}

	entries := s.cfg.Get().Entries
	entry.ID = s.opt.NewID()
	entry.Order = len(entries)
	entry.CreatedAt = s.opt.Now().UnixMilli()
	next := append(append([]contract.LaunchEntry{}, entries...), entry)
	if err := s.commit(next); err != nil {
		return contract.LaunchEntry{}, err
	}
	return entry, nil
}

// Update 即原版 update：主进程内部通道。id / createdAt / order 不接受覆盖，order 只能走 Reorder。
func (s *Service) Update(id string, patch func(e *contract.LaunchEntry)) (contract.LaunchEntry, error) {
	entries := s.cfg.Get().Entries
	idx := -1
	for i := range entries {
		if entries[i].ID == id {
			idx = i
			break
		}
	}
	if idx < 0 {
		return contract.LaunchEntry{}, fmt.Errorf("条目不存在：%s", id)
	}
	next := entries[idx]
	patch(&next)
	next.ID = entries[idx].ID
	next.CreatedAt = entries[idx].CreatedAt
	next.Order = entries[idx].Order

	out := append([]contract.LaunchEntry{}, entries...)
	out[idx] = next
	if err := s.commit(out); err != nil {
		return contract.LaunchEntry{}, err
	}
	return next, nil
}

// Edit 即原版 edit：用户编辑（PRD §4.6）。
func (s *Service) Edit(id string, patch contract.EntryEdit) (contract.LaunchEntry, error) {
	target, ok := s.Get(id)
	if !ok {
		return contract.LaunchEntry{}, fmt.Errorf("条目不存在：%s", id)
	}

	clean, err := s.SanitizeEdit(target, patch)
	if err != nil {
		return contract.LaunchEntry{}, err
	}

	// 命令、工作目录、端口与类型决定「这张卡片是谁」，运行中改了会让停止与归属对不上
	if rt, ok := s.RuntimeOf(id); ok && IsLive(rt.Status) {
		var locked []string
		for _, f := range identityFields {
			if identityChanged(f, clean, target) {
				locked = append(locked, FieldLabel(f))
			}
		}
		if len(locked) > 0 {
			return contract.LaunchEntry{}, fmt.Errorf("%s 正在运行，%s需要先停止再改", target.Name, strings.Join(locked, "、"))
		}
	}

	// 换了目录就必须重认脚本表：留着旧 scripts 会让「脚本已声明」的校验参照错的项目
	if clean.Path != nil && NormalizePath(s.plat, *clean.Path) != NormalizePath(s.plat, target.Path) {
		if !IsDirectory(*clean.Path) {
			return contract.LaunchEntry{}, fmt.Errorf("目录不存在：%s", *clean.Path)
		}
	}

	if clean.Script.Value != nil {
		if !SafeScript.MatchString(*clean.Script.Value) {
			return contract.LaunchEntry{}, fmt.Errorf("脚本名含非法字符：%s", *clean.Script.Value)
		}
		scripts := target.Scripts
		if !clean.Scripts.IsZero() {
			scripts = clean.Scripts
		}
		if _, ok := scripts.Get(*clean.Script.Value); !ok {
			return contract.LaunchEntry{}, fmt.Errorf("%s 不在该项目的 scripts 中", *clean.Script.Value)
		}
	}

	if clean.StartAfter.Set && clean.StartAfter.Value != nil {
		if err := s.AssertStartAfter(id, *clean.StartAfter.Value); err != nil {
			return contract.LaunchEntry{}, err
		}
	}

	// 自动重启只在 dev / 未分组环境开放。这里拦是给界面一个明确的报错；
	// 权威判断在排程时再读一次工作组环境，用户事后改了工作组环境也立即生效
	if clean.AutoRestart != nil && *clean.AutoRestart {
		groupID := target.GroupID
		if clean.GroupID.Set {
			groupID = patchValue(clean.GroupID)
		}
		if env := s.GroupEnv(groupID); env != contract.GroupEnvDev {
			label := "沙箱"
			if env == contract.GroupEnvProd {
				label = "生产"
			}
			return contract.LaunchEntry{}, fmt.Errorf("%s 所在工作组是%s环境，不支持自动重启", target.Name, label)
		}
	}

	next, err := s.Update(id, func(e *contract.LaunchEntry) { *e = ApplyEdit(*e, clean) })
	if err != nil {
		return contract.LaunchEntry{}, err
	}
	// 编辑过条目就撤掉排队中的重启：重启要按新配置由用户决定，不替用户拿旧计划去起
	s.clearRestartTimer(id)
	return next, nil
}

// Remove 即原版 remove。先撤排队中的重启，再摘掉会话并终止，最后才删配置 ——
// 会话退出时 onSessionExit 找不到运行态就直接返回，不会把已删除条目写回界面。
func (s *Service) Remove(id string) error {
	s.clearRestartTimer(id)
	s.mu.Lock()
	delete(s.restartHistory, id)
	rt, hasRT := s.runtimes[id]
	delete(s.runtimes, id)
	s.mu.Unlock()

	if hasRT && rt.SessionID != "" {
		sessionID := rt.SessionID
		go s.sess.Kill(s.ctx, sessionID)
	}

	entries := s.cfg.Get().Entries
	out := make([]contract.LaunchEntry, 0, len(entries))
	for _, e := range entries {
		if e.ID != id {
			out = append(out, e)
		}
	}
	return s.commit(out)
}

// Reorder 即原版 reorder：按传入的 id 顺序重排，未列出的条目保持在后面。
func (s *Service) Reorder(ids []string) ([]contract.LaunchEntry, error) {
	entries := s.cfg.Get().Entries
	rank := make(map[string]int, len(ids))
	for i, id := range ids {
		rank[id] = i
	}
	rankOf := func(id string) int {
		if r, ok := rank[id]; ok {
			return r
		}
		return math.MaxInt32
	}
	sorted := append([]contract.LaunchEntry{}, entries...)
	sort.SliceStable(sorted, func(i, j int) bool { return rankOf(sorted[i].ID) < rankOf(sorted[j].ID) })
	for i := range sorted {
		sorted[i].Order = i
	}
	if err := s.commit(sorted); err != nil {
		return nil, err
	}
	return s.List(), nil
}

// commit 即原版 commit：落盘并广播 changed（原版同步 emit，广播先于调用返回到达页面）。
func (s *Service) commit(entries []contract.LaunchEntry) error {
	if _, err := s.cfg.Patch(func(c *contract.AppConfig) { c.Entries = entries }); err != nil {
		return err
	}
	list := s.List()
	if s.opt.OnChanged != nil {
		s.opt.OnChanged(list)
	}
	s.mu.Lock()
	subs := append([]func([]contract.LaunchEntry){}, s.changedSubs...)
	s.mu.Unlock()
	for _, fn := range subs {
		fn(list)
	}
	return nil
}

// clearRestartTimer 即原版 `clearRestartTimer(id)`：撤销排队中的自动重启并广播。
func (s *Service) clearRestartTimer(id string) { s.clearRestartTimerPublish(id, true) }

// clearRestartTimerPublish 即原版 `clearRestartTimer(id, publish)`：
// publish 为 false 时不改运行态 —— 启动与删除时条目马上要换状态，多余的广播会把旧值写回界面。
func (s *Service) clearRestartTimerPublish(id string, publish bool) {
	s.mu.Lock()
	t, ok := s.restartTimers[id]
	delete(s.restartTimers, id)
	_, hasRT := s.runtimes[id]
	s.mu.Unlock()
	if !ok {
		return
	}
	if t != nil {
		t.Stop()
	}
	if publish && hasRT {
		s.setRuntime(id, func(r *contract.EntryRuntime) { r.AutoRestart = nil })
	}
}

// identityChanged 即原版 `f in clean && !same(clean[f], target[f])`。
func identityChanged(f contract.EditableEntryField, clean contract.EntryEdit, target contract.LaunchEntry) bool {
	switch f {
	case "kind":
		return clean.Kind != nil && *clean.Kind != target.Kind
	case "path":
		return clean.Path != nil && *clean.Path != target.Path
	case "cwd":
		return clean.Cwd != nil && *clean.Cwd != target.Cwd
	case "script":
		return clean.Script.Set && !sameJSON(clean.Script.Value, target.Script)
	case "packageManager":
		return clean.PackageManager != nil && *clean.PackageManager != target.PackageManager
	case "expectedPort":
		return clean.ExpectedPort.Set && !sameJSON(clean.ExpectedPort.Value, target.ExpectedPort)
	case "env":
		return clean.Env != nil && !sameJSON(clean.Env, target.Env)
	case "launchMode":
		return clean.LaunchMode.Set && patchValue(clean.LaunchMode) != target.LaunchMode
	case "jarPath":
		return clean.JarPath.Set && patchValue(clean.JarPath) != target.JarPath
	}
	return false
}

// editFromNew 把新建入参投影成编辑补丁：原版 `add` 直接把入参当 EntryEdit 交给 sanitizeEdit。
// Go 的 NewLaunchEntry 是非可选字段的结构体，所以按「空值 = 没提」还原。
func editFromNew(in contract.NewLaunchEntry) contract.EntryEdit {
	var out contract.EntryEdit
	if in.Kind != "" {
		v := in.Kind
		out.Kind = &v
	}
	if in.Name != "" {
		v := in.Name
		out.Name = &v
	}
	if in.Category != "" {
		out.Category = contract.PatchOf(in.Category)
	}
	if in.GroupID != "" {
		out.GroupID = contract.PatchOf(in.GroupID)
	}
	if in.Icon != "" {
		out.Icon = contract.PatchOf(in.Icon)
	}
	if in.ImageID != "" {
		out.ImageID = contract.PatchOf(in.ImageID)
	}
	if in.Path != "" {
		v := in.Path
		out.Path = &v
	}
	if in.Cwd != "" {
		v := in.Cwd
		out.Cwd = &v
	}
	if in.Script != nil {
		out.Script = contract.PatchOf(*in.Script)
	}
	if !in.Scripts.IsZero() {
		out.Scripts = in.Scripts
	}
	if in.Framework != "" {
		v := in.Framework
		out.Framework = &v
	}
	if in.PackageManager != "" {
		v := in.PackageManager
		out.PackageManager = &v
	}
	if in.Env != nil {
		env := make(map[string]*string, len(in.Env))
		for k, v := range in.Env {
			value := v
			env[k] = &value
		}
		out.Env = env
	}
	if in.ExpectedPort != nil {
		out.ExpectedPort = contract.PatchOf(*in.ExpectedPort)
	}
	if in.OutputDir != "" {
		out.OutputDir = contract.PatchOf(in.OutputDir)
	}
	if in.LaunchMode != "" {
		out.LaunchMode = contract.PatchOf(in.LaunchMode)
	}
	if in.JarPath != "" {
		out.JarPath = contract.PatchOf(in.JarPath)
	}
	if in.RegisterOnly != nil {
		out.RegisterOnly = in.RegisterOnly
	}
	if len(in.StartAfter) > 0 {
		out.StartAfter = contract.PatchOf(in.StartAfter)
	}
	if in.HealthCheck != nil {
		out.HealthCheck = contract.PatchOf(*in.HealthCheck)
	}
	if in.AutoRestart != nil {
		out.AutoRestart = in.AutoRestart
	}
	if len(in.AlertKeywords) > 0 {
		out.AlertKeywords = contract.PatchOf(in.AlertKeywords)
	}
	if in.AlertOnErrors != nil {
		out.AlertOnErrors = in.AlertOnErrors
	}
	if in.Pinned != nil {
		out.Pinned = in.Pinned
	}
	return out
}

// newUUID 即 node:crypto 的 randomUUID（RFC 4122 v4）。
func newUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// 取不到随机数时退回时间戳，宁可 id 不完美也不要整个新建失败
		return fmt.Sprintf("00000000-0000-4000-8000-%012x", time.Now().UnixNano()&0xffffffffffff)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}
