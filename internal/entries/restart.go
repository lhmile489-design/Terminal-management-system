// 对应 src/main/services/EntryService.ts 的崩溃自动重启（PRD-FEATURE-UPGRADE P0-2）
// 与启动耗时（P1-2）：beginQuit / cancelAutoRestart / maybeScheduleRestart /
// noteHealthOk / recordReady / clearRestartTimer。

package entries

import (
	"fmt"
	"time"

	"mile-console/internal/contract"
)

// BeginQuit 即原版 beginQuit：退出流程开始，之后不再排任何重启，已排的全部撤掉。
//
// 必须在 sessions.DisposeAll() **之前**调用。退出流程杀会话不经 Stop，不会设
// StoppedByUser，这些会话会被判成 crashed —— 没有这个标记，每次退出都会触发自动重启。
func (s *Service) BeginQuit() {
	s.mu.Lock()
	s.quitting = true
	ids := make([]string, 0, len(s.restartTimers))
	for id := range s.restartTimers {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	for _, id := range ids {
		s.clearRestartTimer(id)
	}
}

// CancelAutoRestart 即原版 cancelAutoRestart：只撤计时器，不改条目配置。
func (s *Service) CancelAutoRestart(id string) (contract.EntryRuntime, bool, error) {
	if _, ok := s.Get(id); !ok {
		return contract.EntryRuntime{}, false, fmt.Errorf("条目不存在：%s", id)
	}
	s.clearRestartTimer(id)
	s.mu.Lock()
	rt, ok := s.runtimes[id]
	s.mu.Unlock()
	return rt, ok, nil
}

// maybeScheduleRestart 即原版：崩溃后是否排一次重启。
func (s *Service) maybeScheduleRestart(entry contract.LaunchEntry) {
	s.mu.Lock()
	quitting := s.quitting
	s.mu.Unlock()
	if quitting {
		return
	}
	if entry.Kind != contract.EntryKindService || entry.AutoRestart == nil || !*entry.AutoRestart || entry.RegisterOnly {
		return
	}
	// 此刻读到的工作组环境是 dev 才排：用户事后把工作组改成沙箱 / 生产也立即生效
	if s.GroupEnv(entry.GroupID) != contract.GroupEnvDev {
		return
	}

	now := s.now().UnixMilli()
	s.mu.Lock()
	history := make([]int64, 0, len(s.restartHistory[entry.ID])+1)
	for _, t := range s.restartHistory[entry.ID] {
		if now-t < AutoRestartWindowMS {
			history = append(history, t)
		}
	}
	if len(history) >= AutoRestartMax {
		s.restartHistory[entry.ID] = history
		s.mu.Unlock()
		s.setRuntime(entry.ID, func(r *contract.EntryRuntime) {
			r.AutoRestart = nil
			yes := true
			r.AutoRestartGaveUp = &yes
		})
		s.emitEvent("autoRestartGaveUp", map[string]any{"entryId": entry.ID, "name": entry.Name})
		return
	}

	attempt := len(history) + 1
	delay := AutoRestartBackoffMS[min(attempt, len(AutoRestartBackoffMS))-1]
	history = append(history, now)
	s.restartHistory[entry.ID] = history
	s.mu.Unlock()

	s.clearRestartTimerPublish(entry.ID, false)
	timer := s.opt.AfterFunc(millis(delay), func() {
		s.mu.Lock()
		delete(s.restartTimers, entry.ID)
		q := s.quitting
		s.mu.Unlock()
		s.setRuntime(entry.ID, func(r *contract.EntryRuntime) { r.AutoRestart = nil })
		if q {
			return
		}
		// 与手动启动同一条路径：预检、脚本声明校验、命令构造全部照旧
		s.mu.Lock()
		s.autoStarting[entry.ID] = true
		s.mu.Unlock()
		defer func() {
			s.mu.Lock()
			delete(s.autoStarting, entry.ID)
			s.mu.Unlock()
		}()
		if _, err := s.Start(s.ctx, entry.ID); err != nil {
			s.emitEvent("warning", fmt.Sprintf("%s 自动重启失败：%v", entry.Name, err))
		}
	})
	s.mu.Lock()
	s.restartTimers[entry.ID] = timer
	s.mu.Unlock()
	s.setRuntime(entry.ID, func(r *contract.EntryRuntime) {
		r.AutoRestart = &contract.AutoRestartPending{NextAt: now + delay, Attempt: attempt, Max: AutoRestartMax}
		no := false
		r.AutoRestartGaveUp = &no
	})
}

// NoteHealthOk 即原版 noteHealthOk：HealthService 首次探到 ok 时调用。
// 只认「端口已捕获、正在等健康检查」的那一次，之后每 15 秒的 ok 都不再算启动耗时。
func (s *Service) NoteHealthOk(id string) {
	s.mu.Lock()
	_, waiting := s.awaitingHealthReady[id]
	s.mu.Unlock()
	if !waiting {
		return
	}
	s.recordReady(id, contract.ReadyHealth)
}

// recordReady 即原版 recordReady：记一次启动耗时并写进历史。
func (s *Service) recordReady(id string, source contract.ReadySource) {
	s.mu.Lock()
	delete(s.awaitingHealthReady, id)
	rt, ok := s.runtimes[id]
	var startedAt *int64
	if ok {
		startedAt = rt.StartedAt
	}
	status := contract.EntryStatus("")
	if ok {
		status = rt.Status
	}
	s.mu.Unlock()
	if startedAt == nil || status != contract.EntryRunning {
		return
	}
	ms := max(0, s.now().UnixMilli()-*startedAt)
	s.mu.Lock()
	history := append([]int64{}, s.readyHistory[id]...)
	history = append(history, ms)
	if len(history) > ReadyHistory {
		history = history[len(history)-ReadyHistory:]
	}
	s.readyHistory[id] = history
	s.mu.Unlock()
	s.setRuntime(id, func(r *contract.EntryRuntime) {
		v := ms
		r.ReadyMs = &v
		r.ReadySource = source
		r.ReadyHistory = history
	})
}

func millis(ms int64) time.Duration { return time.Duration(ms) * time.Millisecond }
