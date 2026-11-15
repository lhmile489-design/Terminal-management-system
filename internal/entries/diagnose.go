// 对应 src/main/services/EntryService.ts 的 diagnose / findPortHolder / entryIdForSession
// （第 2010–2085 行）。

package entries

import (
	"context"
	"fmt"
	"sort"

	"mile-console/internal/contract"
	"mile-console/internal/platform"
)

// Diagnose 即原版 diagnose：现查端口持有者，拼出诊断面板要的全部现场。
func (s *Service) Diagnose(ctx context.Context, id string) (contract.EntryDiagnosis, error) {
	entry, ok := s.Get(id)
	if !ok {
		return contract.EntryDiagnosis{}, fmt.Errorf("条目不存在：%s", id)
	}

	precheck, err := s.precheck(ctx, entry)
	if err != nil {
		return contract.EntryDiagnosis{}, err
	}
	s.mu.Lock()
	runtime, hasRuntime := s.runtimes[id]
	lastRunMs, hasLastRun := s.lastRunMs[id]
	firstError := s.lastErrorLine[id]
	lastError := s.lastErrorTail[id]
	tail := append([]string{}, s.lastTail[id]...)
	s.mu.Unlock()

	port := entry.ExpectedPort
	if hasRuntime && runtime.Port != nil {
		port = runtime.Port
	}

	// 端口现状要现查，不能用采集快照 —— 快照最多滞后一个采集周期，
	// 而诊断的用途正是「刚失败，现在到底谁占着」。
	var holder *contract.PortHolder
	if port != nil {
		h, err := s.findPortHolder(ctx, *port, s.OwnListenPids(id))
		if err != nil {
			return contract.EntryDiagnosis{}, err
		}
		holder = h
	}

	var path *string
	if p, ok := s.which(s.plat.Binaries()[platform.BinaryName(entry.PackageManager)]); ok {
		path = &p
	}

	// 只给键名，绝不含值 —— 避免泄露 token 与密钥（PRD §4.4）。
	// Go 的 map 无序，按键名排序，页面的下拉顺序因此稳定。
	envKeys := make([]string, 0, len(entry.Env))
	for k := range entry.Env {
		envKeys = append(envKeys, k)
	}
	sort.Strings(envKeys)

	var outputDir *string
	if entry.Kind == contract.EntryKindTask && s.opt.OutputDir != nil {
		outputDir = s.opt.OutputDir(id)
	}

	node := ""
	if s.opt.NodeVersion != nil {
		node = s.opt.NodeVersion()
	}

	diag := contract.EntryDiagnosis{
		EntryID:            id,
		Precheck:           precheck,
		Port:               port,
		PortHolder:         holder,
		LastExitCode:       entry.LastExitCode,
		LastStartedAt:      entry.LastStartedAt,
		FirstErrorLine:     firstError,
		LastErrorLine:      lastError,
		TailLines:          tail,
		Node:               node,
		PackageManager:     entry.PackageManager,
		PackageManagerPath: path,
		EnvKeys:            envKeys,
		OutputDir:          outputDir,
	}
	if hasLastRun {
		v := lastRunMs
		diag.LastRunMs = &v
	}
	return diag, nil
}

// findPortHolder 即原版：现查端口占用者（跳过 exclude 里的自有 PID），并用归属服务判定受控还是外部。
func (s *Service) findPortHolder(ctx context.Context, port int, exclude map[int]bool) (*contract.PortHolder, error) {
	rows, err := s.listenRows(ctx)
	if err != nil {
		return nil, err
	}
	var row *platform.ListenRow
	for i := range rows {
		if rows[i].Port == port && !exclude[rows[i].Pid] {
			row = &rows[i]
			break
		}
	}
	if row == nil {
		return nil, nil
	}

	table, err := s.table(ctx, []int{row.Pid})
	if err != nil {
		return nil, err
	}
	verdict := s.opt.Ownership.Verify(row.Pid, table.ProcessMeta)
	holder := &contract.PortHolder{
		Pid:         row.Pid,
		ProcessName: "未知进程",
		Ownership:   verdict.Ownership,
	}
	if r, ok := table.ByPid[row.Pid]; ok && r.Name != "" {
		holder.ProcessName = r.Name
	}
	if verdict.Ownership == contract.OwnershipOwned {
		if entryID := s.entryIDForSession(verdict.SessionID, row.Pid); entryID != "" {
			holder.EntryID = entryID
		}
	}
	return holder, nil
}

// entryIDForSession 即原版：监听端口相同不能作为条目归属依据。
// 受控进程的会话 id 来自归属服务的父链验证，再映射到运行态是唯一能安全用于「停止它」的链路；
// 扫描快照只作同 PID 的后备展示。
func (s *Service) entryIDForSession(sessionID string, pid int) string {
	if sessionID != "" {
		s.mu.Lock()
		for _, rt := range s.runtimes {
			if rt.SessionID == sessionID {
				id := rt.EntryID
				s.mu.Unlock()
				if _, ok := s.Get(id); ok {
					return id
				}
				return ""
			}
		}
		s.mu.Unlock()
	}
	if snap := s.snapshot(); snap != nil {
		for _, l := range snap.Listeners {
			if l.Pid == pid {
				return l.EntryID
			}
		}
	}
	return ""
}
