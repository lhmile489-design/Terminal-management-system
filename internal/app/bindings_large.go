// S24 的四个大绑定：Entry / Planner / Session / Scanner（BINDINGS-CONTRACT §3.5 / §3.7 / §3.8 / §3.10）。
//
// 与大服务一样只做「校形 → 调服务 → 返回」。planer 的入参本来就是 json.RawMessage
// （S12 的绑定形状），这里原样透传，不重复解码。

package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/egoist/mygo"

	"mile-console/internal/contract"
	"mile-console/internal/detect"
	"mile-console/internal/entries"
	"mile-console/internal/health"
	"mile-console/internal/planner"
	"mile-console/internal/scanner"
	"mile-console/internal/sessions"
)

// EntryService 对应 §3.5。
type EntryService struct {
	entries *entries.Service
	detect  *detect.Service
	health  *health.Service
}

// NewEntryService 构造。
func NewEntryService(e *entries.Service, d *detect.Service, h *health.Service) EntryService {
	return EntryService{entries: e, detect: d, health: h}
}

func (s EntryService) need() error {
	if s.entries == nil {
		return errors.New("条目服务未接入")
	}
	return nil
}

// List 全部条目（置顶优先、其余按 order）。
func (s EntryService) List(context.Context) ([]contract.LaunchEntry, error) {
	if err := s.need(); err != nil {
		return nil, err
	}
	return s.entries.List(), nil
}

// Add 新建条目，入参走 sanitizeEdit。
func (s EntryService) Add(_ context.Context, in contract.NewLaunchEntry) (contract.LaunchEntry, error) {
	if err := s.need(); err != nil {
		return contract.LaunchEntry{}, err
	}
	return s.entries.Add(in)
}

// Edit 编辑条目，入参走 sanitizeEdit；运行中禁改身份字段。
func (s EntryService) Edit(_ context.Context, id string, patch contract.EntryEdit) (contract.LaunchEntry, error) {
	if err := s.need(); err != nil {
		return contract.LaunchEntry{}, err
	}
	return s.entries.Edit(id, patch)
}

// Remove 删除条目。
func (s EntryService) Remove(_ context.Context, id string) error {
	if err := s.need(); err != nil {
		return err
	}
	return s.entries.Remove(id)
}

// Reorder 按 id 顺序重排。
func (s EntryService) Reorder(_ context.Context, ids []string) ([]contract.LaunchEntry, error) {
	if err := s.need(); err != nil {
		return nil, err
	}
	return s.entries.Reorder(ids)
}

// Detect 识别目录（只读文件，不执行项目代码）。
func (s EntryService) Detect(_ context.Context, path string) (contract.DetectResult, error) {
	if s.detect == nil {
		return contract.DetectResult{}, errors.New("识别服务未接入")
	}
	return s.detect.Detect(path), nil
}

// Precheck 启动前静态检查。
func (s EntryService) Precheck(ctx context.Context, id string) (contract.PrecheckResult, error) {
	if err := s.need(); err != nil {
		return contract.PrecheckResult{}, err
	}
	return s.entries.RunPrecheck(ctx, id)
}

// Start 启动条目。
func (s EntryService) Start(ctx context.Context, id string) (contract.EntryStartResult, error) {
	if err := s.need(); err != nil {
		return contract.EntryStartResult{}, err
	}
	return s.entries.Start(ctx, id)
}

// StartOrdered 按 startAfter 分层启动一批。
func (s EntryService) StartOrdered(ctx context.Context, ids []string) ([]contract.OrderedStartResult, error) {
	if err := s.need(); err != nil {
		return nil, err
	}
	return s.entries.StartOrdered(ctx, ids), nil
}

// Stop 停止条目（归属三重判定在服务里）。
func (s EntryService) Stop(ctx context.Context, id string) (contract.EntryRuntime, error) {
	if err := s.need(); err != nil {
		return contract.EntryRuntime{}, err
	}
	return s.entries.Stop(ctx, id)
}

// Restart 重启条目。
func (s EntryService) Restart(ctx context.Context, id string) (contract.EntryStartResult, error) {
	if err := s.need(); err != nil {
		return contract.EntryStartResult{}, err
	}
	return s.entries.Restart(ctx, id)
}

// Install 安装依赖（用户显式触发）。
func (s EntryService) Install(_ context.Context, id string) (contract.EntryRuntime, error) {
	if err := s.need(); err != nil {
		return contract.EntryRuntime{}, err
	}
	return s.entries.Install(id)
}

// MavenRun 执行 Maven / Gradle 构建目标。
func (s EntryService) MavenRun(_ context.Context, id, goal string) (contract.EntryRuntime, error) {
	if err := s.need(); err != nil {
		return contract.EntryRuntime{}, err
	}
	return s.entries.MavenRun(id, contract.MavenGoal(goal))
}

// PackageWithProfile 带 profile 打包（空串表示不带 profile）。
func (s EntryService) PackageWithProfile(_ context.Context, id, profile string) (contract.EntryRuntime, error) {
	if err := s.need(); err != nil {
		return contract.EntryRuntime{}, err
	}
	var p *string
	if profile != "" {
		p = &profile
	}
	return s.entries.PackageWithProfile(id, p)
}

// DetectProfiles 扫描 Spring Boot 的 profile 文件（只读目录）。
func (s EntryService) DetectProfiles(_ context.Context, id string) ([]string, error) {
	if err := s.need(); err != nil {
		return nil, err
	}
	entry, ok := s.entries.Get(id)
	if !ok {
		return nil, fmt.Errorf("条目不存在：%s", id)
	}
	if s.detect == nil {
		return nil, errors.New("识别服务未接入")
	}
	return s.detect.DetectSpringBootProfiles(entry.Path), nil
}

// ListJars 列出 target/ 下的主体 jar。
func (s EntryService) ListJars(_ context.Context, id string) ([]string, error) {
	if err := s.need(); err != nil {
		return nil, err
	}
	return s.entries.ListJars(id), nil
}

// SwitchPort 切换预期端口（范围与运行中锁定由校形统一把关）。
func (s EntryService) SwitchPort(_ context.Context, id string, port int) error {
	if err := s.need(); err != nil {
		return err
	}
	return s.entries.SwitchPort(id, port)
}

// RunScript 跑条目 package.json 里的已声明脚本。
func (s EntryService) RunScript(_ context.Context, id, script string) (contract.EntryRuntime, error) {
	if err := s.need(); err != nil {
		return contract.EntryRuntime{}, err
	}
	return s.entries.RunScript(id, script)
}

// Diagnose 诊断（只显示环境变量键名）。
func (s EntryService) Diagnose(ctx context.Context, id string) (contract.EntryDiagnosis, error) {
	if err := s.need(); err != nil {
		return contract.EntryDiagnosis{}, err
	}
	return s.entries.Diagnose(ctx, id)
}

// OutputDir 任务产物目录。
func (s EntryService) OutputDir(_ context.Context, id string) (*string, error) {
	if err := s.need(); err != nil {
		return nil, err
	}
	return s.entries.OutputDir(id), nil
}

// RevealOutput 在资源管理器里定位产物。
func (s EntryService) RevealOutput(_ context.Context, id string) (bool, error) {
	if err := s.need(); err != nil {
		return false, err
	}
	res := s.entries.RevealOutput(id)
	if res.Path == nil {
		return false, nil
	}
	return true, nil
}

// OpenPackageJSON 打开条目的 package.json（路径由 Go 拼）。
func (s EntryService) OpenPackageJSON(_ context.Context, id string) (bool, error) {
	if err := s.need(); err != nil {
		return false, err
	}
	if _, ok := s.entries.PackageJsonPath(id); !ok {
		return false, nil
	}
	return true, nil
}

// OpenInHBuilderX 用本机 HBuilderX 打开 uniapp 项目（已知原版问题 I1）。
func (s EntryService) OpenInHBuilderX(_ context.Context, id string) (bool, error) {
	if err := s.need(); err != nil {
		return false, err
	}
	return s.entries.OpenInHBuilderX(id)
}

// Favicon 前端条目的本地 favicon（base64 data URL）。
func (s EntryService) Favicon(_ context.Context, id string) (*string, error) {
	if err := s.need(); err != nil {
		return nil, err
	}
	url, ok := s.entries.Favicon(id)
	if !ok {
		return nil, nil
	}
	return &url, nil
}

// SetImage 设置自定义图片，返回哈希文件名。
func (s EntryService) SetImage(_ context.Context, id string, data []byte) (string, error) {
	if err := s.need(); err != nil {
		return "", err
	}
	return s.entries.SetImage(id, data)
}

// ClearImage 清除自定义图片。
func (s EntryService) ClearImage(_ context.Context, id string) (contract.LaunchEntry, error) {
	if err := s.need(); err != nil {
		return contract.LaunchEntry{}, err
	}
	return s.entries.ClearImage(id)
}

// Image 读取自定义图片为 data URL。
func (s EntryService) Image(_ context.Context, id string) (*string, error) {
	if err := s.need(); err != nil {
		return nil, err
	}
	url, ok := s.entries.ImageDataURL(id)
	if !ok {
		return nil, nil
	}
	return &url, nil
}

// Runtimes 全部运行态。
func (s EntryService) Runtimes(context.Context) ([]contract.EntryRuntime, error) {
	if err := s.need(); err != nil {
		return nil, err
	}
	return s.entries.RuntimeList(), nil
}

// HealthList 健康检查结果（只在内存）。
func (s EntryService) HealthList(context.Context) ([]contract.EntryHealth, error) {
	if s.health == nil {
		return nil, errors.New("健康检查未接入")
	}
	return s.health.List(), nil
}

// CancelAutoRestart 撤销排队中的自动重启。
func (s EntryService) CancelAutoRestart(_ context.Context, id string) (*contract.EntryRuntime, error) {
	if err := s.need(); err != nil {
		return nil, err
	}
	rt, ok, err := s.entries.CancelAutoRestart(id)
	if err != nil || !ok {
		return nil, err
	}
	return &rt, nil
}

// RevealLastJar 打开最近一次打包产物。产物定位依赖原生壳，随 S32 一起接。
func (s EntryService) RevealLastJar(context.Context, string) (bool, error) {
	return false, errors.New("定位产物尚未接入（随 S32 原生集成）")
}

// OpenExternalTerminal 在条目目录打开外部终端。随 S32 原生集成接入。
func (s EntryService) OpenExternalTerminal(context.Context, string) error {
	return errors.New("外部终端尚未接入（随 S32 原生集成）")
}

// PlannerService 对应 §3.7。入参都是 json.RawMessage，原样透传给 S12 的服务。
type PlannerService struct{ planner *planner.Service }

// NewPlannerService 构造。
func NewPlannerService(p *planner.Service) PlannerService { return PlannerService{planner: p} }

func (s PlannerService) need() error {
	if s.planner == nil {
		return errors.New("进度服务未接入")
	}
	return nil
}

// Get 整份进度快照。
func (s PlannerService) Get(context.Context) (contract.PlannerSnapshot, error) {
	if err := s.need(); err != nil {
		return contract.PlannerSnapshot{}, err
	}
	return s.planner.Snapshot(), nil
}

// AddBoard 新建看板。
func (s PlannerService) AddBoard(_ context.Context, groupID json.RawMessage) (contract.PlannerBoard, error) {
	if err := s.need(); err != nil {
		return contract.PlannerBoard{}, err
	}
	return s.planner.AddBoard(groupID)
}

// EditBoard 编辑看板。
func (s PlannerService) EditBoard(_ context.Context, boardID, patch json.RawMessage) (contract.PlannerBoard, error) {
	if err := s.need(); err != nil {
		return contract.PlannerBoard{}, err
	}
	return s.planner.EditBoard(boardID, patch)
}

// ReassignBoard 改看板所属工作组。
func (s PlannerService) ReassignBoard(_ context.Context, boardID, groupID json.RawMessage) (contract.PlannerBoard, error) {
	if err := s.need(); err != nil {
		return contract.PlannerBoard{}, err
	}
	return s.planner.ReassignBoard(boardID, groupID)
}

// RemoveBoard 删除看板。
func (s PlannerService) RemoveBoard(_ context.Context, boardID json.RawMessage) error {
	if err := s.need(); err != nil {
		return err
	}
	return s.planner.RemoveBoard(boardID)
}

// ReorderBoards 重排看板。
func (s PlannerService) ReorderBoards(_ context.Context, ids json.RawMessage) error {
	if err := s.need(); err != nil {
		return err
	}
	return s.planner.ReorderBoards(ids)
}

// AddTask 新建任务。
func (s PlannerService) AddTask(_ context.Context, boardID, input json.RawMessage) (contract.PlannerTask, error) {
	if err := s.need(); err != nil {
		return contract.PlannerTask{}, err
	}
	return s.planner.AddTask(boardID, input)
}

// EditTask 编辑任务。
func (s PlannerService) EditTask(_ context.Context, boardID, taskID, patch json.RawMessage) (contract.PlannerTask, error) {
	if err := s.need(); err != nil {
		return contract.PlannerTask{}, err
	}
	return s.planner.EditTask(boardID, taskID, patch)
}

// RemoveTask 删除任务。
func (s PlannerService) RemoveTask(_ context.Context, boardID, taskID json.RawMessage) error {
	if err := s.need(); err != nil {
		return err
	}
	return s.planner.RemoveTask(boardID, taskID)
}

// ReorderTasks 重排任务。
func (s PlannerService) ReorderTasks(_ context.Context, boardID, ids json.RawMessage) error {
	if err := s.need(); err != nil {
		return err
	}
	return s.planner.ReorderTasks(boardID, ids)
}

// AddSchedule 新建日程。
func (s PlannerService) AddSchedule(_ context.Context, boardID, input json.RawMessage) (contract.PlannerSchedule, error) {
	if err := s.need(); err != nil {
		return contract.PlannerSchedule{}, err
	}
	return s.planner.AddSchedule(boardID, input)
}

// EditSchedule 编辑日程。
func (s PlannerService) EditSchedule(_ context.Context, boardID, scheduleID, patch json.RawMessage) (contract.PlannerSchedule, error) {
	if err := s.need(); err != nil {
		return contract.PlannerSchedule{}, err
	}
	return s.planner.EditSchedule(boardID, scheduleID, patch)
}

// RemoveSchedule 删除日程。
func (s PlannerService) RemoveSchedule(_ context.Context, boardID, scheduleID json.RawMessage) error {
	if err := s.need(); err != nil {
		return err
	}
	return s.planner.RemoveSchedule(boardID, scheduleID)
}

// CompleteTask 把日程对应任务标完成。
func (s PlannerService) CompleteTask(_ context.Context, boardID, scheduleID string) error {
	if err := s.need(); err != nil {
		return err
	}
	raw := func(v string) json.RawMessage { b, _ := json.Marshal(v); return b }
	return s.planner.CompleteScheduleTask(raw(boardID), raw(scheduleID))
}

// DismissMissed 忽略错过的提醒（at 为 0 表示清掉该日程全部）。
func (s PlannerService) DismissMissed(_ context.Context, boardID, scheduleID string, at int64) error {
	if err := s.need(); err != nil {
		return err
	}
	raw := func(v any) json.RawMessage { b, _ := json.Marshal(v); return b }
	return s.planner.DismissMissed(raw(boardID), raw(scheduleID), raw(at))
}

// ClearMissed 清掉全部错过的提醒。
func (s PlannerService) ClearMissed(context.Context) error {
	if err := s.need(); err != nil {
		return err
	}
	return s.planner.ClearMissed()
}

// SessionService 对应 §3.8。
type SessionService struct{ sessions *sessions.Service }

// NewSessionService 构造。
func NewSessionService(s *sessions.Service) SessionService { return SessionService{sessions: s} }

func (s SessionService) need() error {
	if s.sessions == nil {
		return errors.New("会话服务未接入")
	}
	return nil
}

// List 全部会话。
func (s SessionService) List(context.Context) ([]contract.SessionMeta, error) {
	if err := s.need(); err != nil {
		return nil, err
	}
	return s.sessions.List(), nil
}

// CreateShell 新建自由终端：只认 kind 与标题，可执行文件与参数由 Go 定。
func (s SessionService) CreateShell(_ context.Context, in contract.CreateShellSessionInput) (contract.SessionMeta, error) {
	if err := s.need(); err != nil {
		return contract.SessionMeta{}, err
	}
	return s.sessions.CreateShell(in, nil)
}

// History 环形缓冲里的历史输出。
func (s SessionService) History(_ context.Context, id string) (string, error) {
	if err := s.need(); err != nil {
		return "", err
	}
	return s.sessions.History(id), nil
}

// Stop 给会话发 Ctrl+C（3 秒后兜底 kill，在服务里）。
func (s SessionService) Stop(_ context.Context, id string) error {
	if err := s.need(); err != nil {
		return err
	}
	s.sessions.Stop(id)
	return nil
}

// Write 写入会话。
func (s SessionService) Write(_ context.Context, id, data string) error {
	if err := s.need(); err != nil {
		return err
	}
	return s.sessions.Write(id, data)
}

// Resize 调整终端尺寸。
func (s SessionService) Resize(_ context.Context, id string, cols, rows int) error {
	if err := s.need(); err != nil {
		return err
	}
	s.sessions.Resize(id, cols, rows)
	return nil
}

// Attach 流式输出（契约 §4）。
func (s SessionService) Attach(ctx context.Context, id string, ch *mygo.Channel[contract.SessionDataEvent]) error {
	if err := s.need(); err != nil {
		return err
	}
	return s.sessions.Attach(ctx, id, ch)
}

// ScannerService 对应 §3.10。
type ScannerService struct {
	scanner *scanner.Service
	cfg     SettingsStore
}

// NewScannerService 构造。
func NewScannerService(s *scanner.Service, cfg SettingsStore) ScannerService {
	return ScannerService{scanner: s, cfg: cfg}
}

func (s ScannerService) need() error {
	if s.scanner == nil {
		return errors.New("扫描器未接入")
	}
	return nil
}

// Snapshot 最近一次采集快照。
func (s ScannerService) Snapshot(context.Context) (*contract.ScanSnapshot, error) {
	if err := s.need(); err != nil {
		return nil, err
	}
	return s.scanner.Snapshot(), nil
}

// Refresh 立刻采集一次。
func (s ScannerService) Refresh(context.Context) error {
	if err := s.need(); err != nil {
		return err
	}
	s.scanner.Refresh()
	return nil
}

// SetVisible 窗口可见性变化（决定采集频率与健康检查间隔）。
func (s ScannerService) SetVisible(_ context.Context, visible bool) error {
	if err := s.need(); err != nil {
		return err
	}
	s.scanner.SetVisible(visible)
	return nil
}

// Ignore 永久忽略某个监听。
func (s ScannerService) Ignore(_ context.Context, processName string, port int) error {
	if err := s.need(); err != nil {
		return err
	}
	return s.scanner.Ignore(processName, port)
}

// HideOnce 只看这一轮。
func (s ScannerService) HideOnce(_ context.Context, pid, port int) error {
	if err := s.need(); err != nil {
		return err
	}
	s.scanner.HideOnce(pid, port)
	return nil
}

// SetGroup 手动指定分组（nil 表示清除）。
func (s ScannerService) SetGroup(_ context.Context, processName string, group *string) error {
	if err := s.need(); err != nil {
		return err
	}
	var g *contract.ListenerGroup
	if group != nil {
		v := contract.ListenerGroup(*group)
		g = &v
	}
	return s.scanner.SetGroup(processName, g)
}

// WatchedKeywords 当前关注关键字。
func (s ScannerService) WatchedKeywords(context.Context) ([]string, error) {
	if s.cfg == nil {
		return nil, errors.New("配置未接入")
	}
	return append([]string{}, s.cfg.Get().WatchedKeywords...), nil
}

// SetWatchedKeywords 设置关注关键字，规整只在扫描器一处。
func (s ScannerService) SetWatchedKeywords(_ context.Context, keywords []string) ([]string, error) {
	if err := s.need(); err != nil {
		return nil, err
	}
	body, err := json.Marshal(keywords)
	if err != nil {
		return nil, err
	}
	return s.scanner.SetWatchedKeywords(body)
}
