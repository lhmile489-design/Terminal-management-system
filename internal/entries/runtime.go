// 对应 src/main/services/EntryService.ts 的运行态与启停：
// expectations / setRuntime / runPrecheck / start / runScript / assertNotLive（1030–1134）、
// stop / restart / waitSessionExit / ownListenPids / waitPortReleased（1700–1801）、
// absorb / isCurrentSession / onCaptureTimeout / onSessionExit（1802–1905）。

package entries

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"mile-console/internal/contract"
	"mile-console/internal/logs"
	"mile-console/internal/platform"
	"mile-console/internal/precheck"
)

// Watch 即原版 Watch：一个会话的输出捕获与退出收尾状态。
type Watch struct {
	EntryID string
	// Captured 端口捕获只看会话开头的输出，避免把用户后续输入里的数字当端口。
	Captured bool
	Timer    Timer
	// FirstErrorLine 这一轮第一次出现的错误行，诊断面板要用。
	FirstErrorLine string
	// StoppedByUser 用户从界面中止过。taskkill 会让任务以非零码退出，
	// 不记这一笔就会显示「失败」，而 PRD §4.6 要求区分「我停的」和「它自己崩的」。
	StoppedByUser bool
	// IsPackage 标记此会话是 packageWithProfile 发起的打包构建（S21d）。
	IsPackage bool
	// Dev 这是服务的 dev 会话。自动重启只认这一种，否则一次失败的构建会被当成崩溃反复拉起。
	Dev bool
}

// EntryExpectation 即原版 EntryExpectation，供扫描器算端口冲突与回填 entryId。
type EntryExpectation struct {
	ID        string `json:"id"`
	Port      *int   `json:"port"`
	Cwd       string `json:"cwd"`
	Pid       *int   `json:"pid"`
	SessionID string `json:"sessionId,omitempty"`
}

// Expectations 即原版 expectations。
func (s *Service) Expectations() []EntryExpectation {
	list := s.List()
	out := make([]EntryExpectation, 0, len(list))
	for _, e := range list {
		s.mu.Lock()
		rt, ok := s.runtimes[e.ID]
		s.mu.Unlock()
		port := e.ExpectedPort
		if ok && rt.Port != nil {
			port = rt.Port
		}
		exp := EntryExpectation{ID: e.ID, Port: port, Cwd: precheck.ResolveCwd(e)}
		if ok {
			exp.Pid = rt.Pid
			exp.SessionID = rt.SessionID
		}
		out = append(out, exp)
	}
	return out
}

// setRuntime 即原版 setRuntime：合并补丁、写回、广播 runtime 事件。
func (s *Service) setRuntime(id string, apply func(rt *contract.EntryRuntime)) contract.EntryRuntime {
	s.mu.Lock()
	rt, ok := s.runtimes[id]
	if !ok {
		rt = contract.EntryRuntime{EntryID: id, Status: contract.EntryIdle}
	}
	apply(&rt)
	s.runtimes[id] = rt
	emit := s.opt.Emit
	subs := append([]func(contract.EntryRuntime){}, s.runtimeSubs...)
	s.mu.Unlock()
	if emit != nil {
		emit("runtime", rt)
	}
	for _, fn := range subs {
		fn(rt)
	}
	return rt
}

// RunPrecheck 即原版 runPrecheck。
func (s *Service) RunPrecheck(ctx context.Context, id string) (contract.PrecheckResult, error) {
	entry, ok := s.Get(id)
	if !ok {
		return contract.PrecheckResult{}, fmt.Errorf("条目不存在：%s", id)
	}
	result, err := s.precheck(ctx, entry)
	if err != nil {
		return contract.PrecheckResult{}, err
	}
	s.setRuntime(id, func(rt *contract.EntryRuntime) { rt.Precheck = &result })
	return result, nil
}

// precheck 即原版 this.precheck.run(entry, snapshot, list())。未注入时按「通过」处理，
// 让命令构造与状态机的单测不必拖上整条预检链。
func (s *Service) precheck(ctx context.Context, entry contract.LaunchEntry) (contract.PrecheckResult, error) {
	if s.opt.Precheck == nil {
		return contract.PrecheckResult{OK: true}, nil
	}
	return s.opt.Precheck(ctx, entry, s.snapshot(), s.List())
}

// snapshot 即原版 this.scanner.snapshot()。
func (s *Service) snapshot() *contract.ScanSnapshot {
	if s.opt.Scanner == nil {
		return nil
	}
	return s.opt.Scanner.Snapshot()
}

// Start 即原版 start：预检 → 构造命令 → 起会话。
func (s *Service) Start(ctx context.Context, id string) (contract.EntryStartResult, error) {
	entry, ok := s.Get(id)
	if !ok {
		return contract.EntryStartResult{}, fmt.Errorf("条目不存在：%s", id)
	}
	// 退出流程中一律不起新会话：disposeAll 正在杀进程树，这时起的会话会留在后台占端口
	s.mu.Lock()
	quitting := s.quitting
	autoStarting := s.autoStarting[id]
	s.mu.Unlock()
	if quitting {
		return contract.EntryStartResult{}, errors.New("应用正在退出，不再启动服务")
	}

	// 手动启动：撤掉排队中的重启，重新计数，清掉「已停止自动重启」
	if !autoStarting {
		s.clearRestartTimerPublish(id, false)
		s.mu.Lock()
		delete(s.restartHistory, id)
		rt, hasRT := s.runtimes[id]
		s.mu.Unlock()
		_ = rt
		if hasRT && rt.AutoRestartGaveUp != nil && *rt.AutoRestartGaveUp {
			s.setRuntime(id, func(r *contract.EntryRuntime) {
				no := false
				r.AutoRestartGaveUp = &no
			})
		}
	}

	s.mu.Lock()
	existing, hasExisting := s.runtimes[id]
	s.mu.Unlock()
	// 停止中的会话马上就会退出，把它当「已在运行」返回 ok 会让调用方以为起来了
	if hasExisting && existing.Status == contract.EntryStopping {
		return contract.EntryStartResult{}, fmt.Errorf("%s 正在停止中，等它停下再启动", entry.Name)
	}
	if hasExisting && IsLive(existing.Status) {
		pre := contract.PrecheckResult{OK: true}
		if existing.Precheck != nil {
			pre = *existing.Precheck
		}
		rt := existing
		return contract.EntryStartResult{OK: true, Precheck: pre, Runtime: &rt}, nil
	}

	s.setRuntime(id, func(r *contract.EntryRuntime) {
		r.Status = contract.EntryPrecheck
		r.ExitCode = nil
		r.PortUnknown = false
	})
	result, err := s.precheck(ctx, entry)
	if err != nil {
		return contract.EntryStartResult{}, err
	}
	if !result.OK {
		s.setRuntime(id, func(r *contract.EntryRuntime) {
			r.Status = contract.EntryBlocked
			r.Precheck = &result
		})
		// 系统通知用：窗口收起时点启动被拦下，用户要能知道
		s.emitEvent("blocked", map[string]any{"entryId": id, "name": entry.Name})
		return contract.EntryStartResult{OK: false, Precheck: result}, nil
	}

	script := entry.Script
	rt, err := s.SpawnSession(entry, script, contract.SessionKindDev, &result)
	if err != nil {
		// spawn 抛错（非法脚本名、cwd 越界、包管理器缺失）时必须退出 precheck 态，
		// 否则条目永远停在「运行中」的判定里，后续启动会被直接短路掉
		s.setRuntime(id, func(r *contract.EntryRuntime) {
			r.Status = contract.EntryBlocked
			r.Precheck = &result
		})
		return contract.EntryStartResult{}, err
	}
	return contract.EntryStartResult{OK: true, Precheck: result, Runtime: &rt}, nil
}

// RunScript 即原版 runScript：跑条目 package.json 里已声明的脚本（build 型，不做端口捕获）。
func (s *Service) RunScript(id, script string) (contract.EntryRuntime, error) {
	entry, ok := s.Get(id)
	if !ok {
		return contract.EntryRuntime{}, fmt.Errorf("条目不存在：%s", id)
	}
	// Spring Boot 没有 npm scripts，命令面板的「脚本」分组对它不成立
	if entry.Framework == contract.FrameworkSpringBoot {
		return contract.EntryRuntime{}, errors.New("Spring Boot 条目不支持运行 npm 脚本")
	}
	if err := s.assertNotLive(entry, "执行其他脚本"); err != nil {
		return contract.EntryRuntime{}, err
	}
	return s.SpawnSession(entry, &script, contract.SessionKindBuild, nil)
}

// assertNotLive 即原版：一个条目同一时刻只挂一个会话。
func (s *Service) assertNotLive(entry contract.LaunchEntry, action string) error {
	s.mu.Lock()
	existing, ok := s.runtimes[entry.ID]
	s.mu.Unlock()
	if ok && IsLive(existing.Status) {
		return fmt.Errorf("%s 正在运行中，先停止再%s", entry.Name, action)
	}
	return nil
}

// Stop 即原版 stop：先重验归属，再让会话发 Ctrl+C，状态转 stopping。
func (s *Service) Stop(ctx context.Context, id string) (contract.EntryRuntime, error) {
	// 用户停止（含托盘、面板、重启的前半段）：排队中的自动重启一并撤掉
	s.clearRestartTimer(id)
	s.mu.Lock()
	runtime, has := s.runtimes[id]
	s.mu.Unlock()
	if !has || runtime.SessionID == "" || runtime.Pid == nil {
		return s.setRuntime(id, func(r *contract.EntryRuntime) { r.Status = contract.EntryStopped }), nil
	}

	// 终止前重校验归属：从判定到执行之间 PID 可能被回收复用，PRD §6.3 步骤 4
	table, err := s.table(ctx, []int{*runtime.Pid})
	if err != nil {
		return contract.EntryRuntime{}, err
	}
	if _, err := s.opt.Ownership.AssertKillable(*runtime.Pid, table.ProcessMeta, runtime.SessionID); err != nil {
		return contract.EntryRuntime{}, err
	}

	s.mu.Lock()
	if w := s.watches[runtime.SessionID]; w != nil {
		w.StoppedByUser = true
	}
	s.mu.Unlock()

	s.setRuntime(id, func(r *contract.EntryRuntime) { r.Status = contract.EntryStopping })
	s.sess.Stop(runtime.SessionID)
	s.mu.Lock()
	out := s.runtimes[id]
	s.mu.Unlock()
	return out, nil
}

// Restart 即原版 restart：先记下自有监听 PID，停、等退出、等端口释放，再启动。
func (s *Service) Restart(ctx context.Context, id string) (contract.EntryStartResult, error) {
	entry, ok := s.Get(id)
	if !ok {
		return contract.EntryStartResult{}, fmt.Errorf("条目不存在：%s", id)
	}
	s.mu.Lock()
	rt, has := s.runtimes[id]
	s.mu.Unlock()
	port := entry.ExpectedPort
	if has && rt.Port != nil {
		port = rt.Port
	}

	// 先记下「本条目自己的监听 PID」，停完只等这些消失。
	// 同一端口可能还有另一个条目在听（IPv4 / IPv6 各绑一个都会成功），
	// 按端口整体等释放的话，那一直不放手的是别人，本条目却要白等 5 秒再报「端口未释放」。
	own := s.OwnListenPids(id)
	if _, err := s.Stop(ctx, id); err != nil {
		return contract.EntryStartResult{}, err
	}
	// 停不下来就不能接着 start：旧会话还挂着时 start() 会被拒，硬起只会得到「重启成功」的假象
	if !s.waitSessionExit(ctx, id, 8*time.Second) {
		return contract.EntryStartResult{}, fmt.Errorf("%s 在 8 秒内没有停下，已取消重启，请稍后再试或强制关闭", entry.Name)
	}
	if port != nil {
		s.waitPortReleased(ctx, *port, own, id)
	}
	return s.Start(ctx, id)
}

// waitSessionExit 即原版 waitSessionExit：等条目退出活跃态，超时返回 false。
func (s *Service) waitSessionExit(ctx context.Context, id string, timeout time.Duration) bool {
	deadline := s.now().Add(timeout)
	for {
		s.mu.Lock()
		rt, ok := s.runtimes[id]
		s.mu.Unlock()
		if !ok || !IsLive(rt.Status) {
			return true
		}
		if s.now().After(deadline) {
			return false
		}
		if !s.sleepCtx(ctx, 200*time.Millisecond) {
			return false
		}
	}
}

// OwnListenPids 即原版 ownListenPids：根 PID 之外并上快照里 entryId 等于本条目的 PID。
//
// 真正监听端口的常是 cmd.exe → npm → node 链条末端的 node.exe，而条目记的是根 PID，
// 所以不能只看 runtime.pid。采集快照已按会话归属把 entryId 回填到叶子进程。
func (s *Service) OwnListenPids(id string) map[int]bool {
	own := map[int]bool{}
	s.mu.Lock()
	if rt, ok := s.runtimes[id]; ok && rt.Pid != nil {
		own[*rt.Pid] = true
	}
	s.mu.Unlock()
	if snap := s.snapshot(); snap != nil {
		for _, l := range snap.Listeners {
			if l.EntryID == id {
				own[l.Pid] = true
			}
		}
	}
	return own
}

// waitPortReleased 即原版：轮询确认端口释放，最多 5s；未释放只告警不重试（PRD §6.3 步骤 3）。
func (s *Service) waitPortReleased(ctx context.Context, port int, own map[int]bool, entryID string) bool {
	deadline := s.now().Add(PortReleaseTimeoutMS * time.Millisecond)
	held := func(rows []platform.ListenRow) bool {
		for _, r := range rows {
			if r.Port != port {
				continue
			}
			if len(own) > 0 {
				if own[r.Pid] {
					return true
				}
				continue
			}
			return true
		}
		return false
	}
	for s.now().Before(deadline) {
		rows, err := s.listenRows(ctx)
		if err == nil && !held(rows) {
			return true
		}
		if !s.sleepCtx(ctx, 250*time.Millisecond) {
			return false
		}
	}
	s.emitEvent("warning", fmt.Sprintf("端口 :%d 在 5 秒内未释放，重启后可能仍被占用", port))
	if entryID != "" {
		s.emitEvent("portUnreleased", map[string]any{"entryId": entryID, "port": port})
	}
	return false
}

// absorb 即原版 absorb：抓第一个错误行，并在会话开头捕获端口。
func (s *Service) absorb(sessionID, chunk string) {
	s.mu.Lock()
	watch, ok := s.watches[sessionID]
	if !ok {
		s.mu.Unlock()
		return
	}
	if watch.FirstErrorLine == "" {
		for _, line := range splitCRLF(chunk) {
			plain := logs.StripAnsi(line)
			if logs.IsErrorLine(plain) {
				watch.FirstErrorLine = truncateRunes(strings.TrimSpace(plain), 200)
				break
			}
		}
	}
	if watch.Captured {
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()

	port, found := CapturePort(chunk)
	if !found {
		return
	}

	s.mu.Lock()
	if watch.Timer != nil {
		watch.Timer.Stop()
		watch.Timer = nil
	}
	watch.Captured = true
	current := s.runtimes[watch.EntryID].SessionID == sessionID
	entry, hasEntry := s.getLocked(watch.EntryID)
	healthOn := hasEntry && entry.HealthCheck != nil && entry.HealthCheck.Enabled
	entryID := watch.EntryID
	s.mu.Unlock()

	// 只认条目当前挂着的会话：旧会话的迟到输出不能改写新会话的运行态
	if !current {
		return
	}
	s.setRuntime(entryID, func(r *contract.EntryRuntime) {
		r.Status = contract.EntryRunning
		p := port
		r.Port = &p
		r.PortUnknown = false
	})
	// 启动耗时：开了健康检查就等首次 ok 再记，否则取端口打印出来的这一刻
	if healthOn {
		s.mu.Lock()
		s.awaitingHealthReady[entryID] = true
		s.mu.Unlock()
	} else {
		s.recordReady(entryID, contract.ReadyPort)
	}
	// 端口没变就不写盘：每次启动都落盘会白白轮转一次 .bak
	if !hasEntry {
		return
	}
	prev := entry.ExpectedPort
	if prev != nil && *prev == port {
		return
	}
	if _, err := s.Update(entryID, func(e *contract.LaunchEntry) {
		p := port
		e.ExpectedPort = &p
	}); err != nil {
		s.emitEvent("warning", fmt.Sprintf("回填端口失败：%v", err))
	}
}

// isCurrentSession 即原版：运行态里记的会话是不是这个。
func (s *Service) isCurrentSession(entryID, sessionID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	rt, ok := s.runtimes[entryID]
	return ok && rt.SessionID == sessionID
}

// onCaptureTimeout 即原版：60 秒没报端口但进程还活着，只标端口未知。
func (s *Service) onCaptureTimeout(entryID, sessionID string) {
	s.mu.Lock()
	rt, ok := s.runtimes[entryID]
	s.mu.Unlock()
	if !ok || rt.Status != contract.EntryStarting {
		return
	}
	if rt.SessionID != sessionID {
		return
	}
	s.setRuntime(entryID, func(r *contract.EntryRuntime) {
		r.Status = contract.EntryRunning
		r.PortUnknown = true
	})
}

// onSessionExit 即原版：会话退出后的收尾、留档、状态判定与事件。
func (s *Service) onSessionExit(sessionID string, exitCode int) {
	s.mu.Lock()
	watch, ok := s.watches[sessionID]
	if !ok {
		s.mu.Unlock()
		return
	}
	if watch.Timer != nil {
		watch.Timer.Stop()
	}
	delete(s.watches, sessionID)
	// 被新会话顶掉的旧会话：留档、运行态、退出码、通知都属于新会话，这里一概不碰
	current := false
	if rt, has := s.runtimes[watch.EntryID]; has && rt.SessionID == sessionID {
		current = true
	}
	if !current {
		s.mu.Unlock()
		return
	}
	// 没等到健康检查 ok 就退出了：这次没有可信的就绪时刻
	if watch.Dev {
		delete(s.awaitingHealthReady, watch.EntryID)
	}
	// 先留档再清运行态，诊断面板要在会话消失后仍能回顾
	if watch.FirstErrorLine != "" {
		s.lastErrorLine[watch.EntryID] = watch.FirstErrorLine
	}
	startedAt := s.runtimes[watch.EntryID].StartedAt
	entryID := watch.EntryID
	dev, isPackage, stoppedByUser := watch.Dev, watch.IsPackage, watch.StoppedByUser
	s.mu.Unlock()

	// 退出前的现场：会话缓冲在 exit 前已 flush，取最后 TAIL_LINES 行可见输出
	tail := logs.VisibleTail(s.sess.History(sessionID), TailLines)
	lastError, hasLastError := logs.PickLastError(tail)
	s.mu.Lock()
	s.lastTail[entryID] = tail
	if hasLastError {
		s.lastErrorTail[entryID] = truncateRunes(lastError, 200)
	} else {
		delete(s.lastErrorTail, entryID)
	}
	if startedAt != nil {
		ms := s.now().UnixMilli() - *startedAt
		s.lastRunMs[entryID] = ms
	}
	s.mu.Unlock()

	entry, hasEntry := s.Get(entryID)
	var status contract.EntryStatus
	if hasEntry && entry.Kind == contract.EntryKindTask {
		status = TaskStatus(exitCode, stoppedByUser)
	} else if exitCode == 0 || stoppedByUser {
		status = contract.EntryStopped
	} else {
		status = contract.EntryCrashed
	}

	code := exitCode
	s.setRuntime(entryID, func(r *contract.EntryRuntime) {
		r.Status = status
		r.ExitCode = &code
		r.Pid = nil
		r.Port = nil
		r.PortUnknown = false
	})
	if _, err := s.Update(entryID, func(e *contract.LaunchEntry) {
		c := exitCode
		e.LastExitCode = &c
	}); err != nil {
		s.emitEvent("warning", fmt.Sprintf("记录退出码失败：%v", err))
	}

	// packageWithProfile 打包成功：扫描 target/ 写入 lastBuiltJar（S21d 接线）
	if isPackage && exitCode == 0 && hasEntry && s.opt.ListJars != nil {
		if jars := s.opt.ListJars(entryID); len(jars) > 0 {
			first := jars[0]
			s.setRuntime(entryID, func(r *contract.EntryRuntime) { r.LastBuiltJar = first })
		}
	}

	if hasEntry && entry.Kind == contract.EntryKindTask && !stoppedByUser {
		s.emitEvent("taskDone", map[string]any{"entryId": entry.ID, "name": entry.Name, "status": status, "exitCode": exitCode})
	}

	// 服务自己崩溃（非用户停止、非任务）：一个会话只可能走到这一次
	if hasEntry && entry.Kind != contract.EntryKindTask && status == contract.EntryCrashed && !stoppedByUser {
		s.mu.Lock()
		lastErr := s.lastErrorTail[entry.ID]
		s.mu.Unlock()
		s.emitEvent("crashed", map[string]any{
			"entryId": entry.ID, "name": entry.Name, "exitCode": exitCode,
			"sessionId": sessionID, "lastErrorLine": lastErr,
		})
		if dev {
			s.maybeScheduleRestart(entry)
		}
	}
}

// splitCRLF 即 JS 的 `chunk.split(/\r?\n/)`。
func splitCRLF(s string) []string {
	parts := strings.Split(s, "\n")
	for i := 0; i < len(parts)-1; i++ {
		parts[i] = strings.TrimSuffix(parts[i], "\r")
	}
	return parts
}

// truncateRunes 即原版 `s.slice(0, n)` 在本处的用途：按字符数截断。
func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

func (s *Service) emitEvent(name string, payload any) {
	if s.opt.Emit != nil {
		s.opt.Emit(name, payload)
	}
}

func (s *Service) now() time.Time { return s.opt.Now() }

func (s *Service) sleepCtx(ctx context.Context, d time.Duration) bool {
	if s.opt.After != nil {
		select {
		case <-s.opt.After(d):
			return true
		case <-ctx.Done():
			return false
		}
	}
	return true
}

func (s *Service) table(ctx context.Context, pids []int) (platform.ProcessTable, error) {
	if s.opt.Scanner == nil {
		return platform.ProcessTable{}, errors.New("扫描器未就绪")
	}
	return s.opt.Scanner.Table(ctx, pids)
}

func (s *Service) listenRows(ctx context.Context) ([]platform.ListenRow, error) {
	return s.plat.ReadListenPorts(ctx)
}

// getLocked 在已持有 s.mu 时读条目。
func (s *Service) getLocked(id string) (contract.LaunchEntry, bool) {
	for _, e := range s.cfg.Get().Entries {
		if e.ID == id {
			return e, true
		}
	}
	return contract.LaunchEntry{}, false
}
