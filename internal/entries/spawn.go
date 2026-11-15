// 对应 src/main/services/EntryService.ts 第 1417–1464 行的 spawnSession。
//
// 本文件只负责「解析目录 → 断言在条目内 → 构造命令 → 建会话 → 写运行态与 lastStartedAt」。
// 端口捕获计时器、watch 表与健康检查的就绪判定属于 S21c，接在同一个 Service 上。

package entries

import (
	"mile-console/internal/contract"
	"mile-console/internal/precheck"
)

// SpawnSession 即原版 spawnSession：按 framework 构造命令并起一个会话。
// kind 决定初始状态：安装会话一上来就是 running，dev / build 先 starting。
func (s *Service) SpawnSession(
	entry contract.LaunchEntry,
	script *string,
	kind contract.SessionKind,
	result *contract.PrecheckResult,
) (contract.EntryRuntime, error) {
	cwd := precheck.ResolveCwd(entry)
	if err := assertInsideEntry(entry, cwd); err != nil {
		return contract.EntryRuntime{}, err
	}

	// 每条路径都只产出 file + args 数组、从不拼 shell 字符串，子命令均为硬编码枚举
	cmd, err := s.BuildCommand(entry, cwd, script)
	if err != nil {
		return contract.EntryRuntime{}, err
	}

	projectID := entry.ID
	session, err := s.sess.Create(contract.CreateSessionInput{
		Kind:      kind,
		Cwd:       cwd,
		ProjectID: &projectID,
		Title:     entry.Name + " · " + cmd.Title,
		File:      cmd.File,
		Args:      cmd.Args,
		Env:       entry.Env,
	})
	if err != nil {
		return contract.EntryRuntime{}, err
	}

	if _, err := s.Update(entry.ID, func(e *contract.LaunchEntry) {
		at := s.opt.Now().UnixMilli()
		e.LastStartedAt = &at
	}); err != nil {
		return contract.EntryRuntime{}, err
	}

	// 新会话开始就清掉上轮留档，否则诊断会把旧错误行挂在这次运行上
	s.mu.Lock()
	delete(s.lastErrorLine, entry.ID)
	status := contract.EntryStarting
	if kind == contract.SessionKindInstall {
		status = contract.EntryRunning
	}
	pid, startedAt := session.Pid, session.StartedAt
	rt := contract.EntryRuntime{
		EntryID:   entry.ID,
		Status:    status,
		SessionID: session.ID,
		Pid:       &pid,
		StartedAt: &startedAt,
		Precheck:  result,
	}
	s.runtimes[entry.ID] = rt
	delete(s.awaitingHealthReady, entry.ID)
	s.mu.Unlock()

	return rt, nil
}
