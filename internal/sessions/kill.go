// 对应 src/main/services/SessionService.ts 的 write / resize / history / list / stop / kill /
// ownedPids / sessionIdByPid / liveCount / disposeAll。
//
// 终止的授权只看 ownership：用 <=3 秒新鲜的进程表重验「运行 token + 进程组 + 当前用户」，
// 通过才杀整棵树（PRD §11）。端口、进程名、启动来源都不参与。

package sessions

import (
	"context"
	"sync"

	"mile-console/internal/contract"
)

// Write 即原版 write(id, data)：未知 id 静默忽略，PTY 写失败把错误交给调用方。
func (s *Service) Write(id, data string) error {
	e := s.get(id)
	if e == nil {
		return nil
	}
	_, err := e.pty.Write([]byte(data))
	return err
}

// Resize 即原版 resize(id, cols, rows)：只收 [1,1000] 的整数，越界静默忽略，PTY 报错也吞掉。
func (s *Service) Resize(id string, cols, rows int) {
	if cols < 1 || cols > 1000 || rows < 1 || rows > 1000 {
		return
	}
	e := s.get(id)
	if e == nil {
		return
	}
	_ = e.pty.Resize(cols, rows)
}

// History 即原版 history(id)：已刷新的 buffer 加上尚在 pending 的尾巴；未知 id 返回空串。
func (s *Service) History(id string) string {
	e := s.get(id)
	if e == nil {
		return ""
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.buffer + e.pending
}

// List 即原版 list()：按创建顺序，返回快照副本，永不为 nil。
func (s *Service) List() []contract.SessionMeta {
	s.mu.Lock()
	es := make([]*entry, 0, len(s.order))
	for _, id := range s.order {
		if e := s.entries[id]; e != nil {
			es = append(es, e)
		}
	}
	s.mu.Unlock()
	out := make([]contract.SessionMeta, 0, len(es))
	for _, e := range es {
		e.mu.Lock()
		out = append(out, copyMeta(e.meta))
		e.mu.Unlock()
	}
	return out
}

// Stop 即原版 stop(id)：先发 Ctrl+C，3 秒后若还在就走 Kill。
// 延迟 kill 的定时器和原版一样不随 DisposeAll 清掉；Kill 自己会因会话已退出而空转。
func (s *Service) Stop(id string) {
	e := s.get(id)
	if e == nil {
		return
	}
	_, _ = e.pty.Write([]byte{0x03})
	s.opt.AfterFunc(StopGrace, func() { s.Kill(s.ctx, id) })
}

func isDead(st contract.SessionStatus) bool {
	return st == contract.SessionStatusStopped || st == contract.SessionStatusCrashed
}

// Kill 即原版 kill(id)：可等待，返回时进程树已经被处理完。
// 会话已退出只做登记清理；没有 scanner 或归属校验不通过时不动手，只撤销登记。
func (s *Service) Kill(ctx context.Context, id string) {
	e := s.get(id)
	if e == nil {
		return
	}
	e.mu.Lock()
	dead := isDead(e.meta.Status)
	e.mu.Unlock()
	if dead {
		s.own.Unregister(id)
		return
	}
	s.doKill(ctx, e)
}

// doKill 即原版 doKill：新鲜进程表 -> assertKillable -> 杀整棵树 -> 撤销登记。
func (s *Service) doKill(ctx context.Context, e *entry) {
	s.mu.Lock()
	sc := s.scanner
	s.mu.Unlock()
	if sc == nil {
		s.own.Unregister(e.id)
		return
	}
	e.mu.Lock()
	pid := e.meta.Pid
	e.mu.Unlock()

	table, err := sc.Table(ctx, []int{pid})
	if err != nil {
		s.own.Unregister(e.id)
		return
	}
	if _, err := s.own.AssertKillable(pid, table.ProcessMeta, e.id); err != nil {
		s.own.Unregister(e.id)
		return
	}
	s.plat.KillTree(ctx, pid)
	// KillTree 已经杀了整棵树；这一步兜底根进程，错误（已退出）忽略
	_ = e.pty.Kill()
	s.own.Unregister(e.id)
}

// ordered 按创建顺序给出当前所有会话，对应原版 Map 的插入序遍历。
func (s *Service) ordered() []*entry {
	s.mu.Lock()
	defer s.mu.Unlock()
	es := make([]*entry, 0, len(s.order))
	for _, id := range s.order {
		if e, ok := s.entries[id]; ok {
			es = append(es, e)
		}
	}
	return es
}

// OwnedPids 即原版 ownedPids()：所有仍登记着的会话根 PID，永不为 nil。
func (s *Service) OwnedPids() []int {
	es := s.ordered()
	out := make([]int, 0, len(es))
	for _, e := range es {
		e.mu.Lock()
		if !isDead(e.meta.Status) {
			out = append(out, e.meta.Pid)
		}
		e.mu.Unlock()
	}
	return out
}

// SessionIDByPid 即原版 sessionIdByPid(pid)。
func (s *Service) SessionIDByPid(pid int) (string, bool) {
	es := s.ordered()
	for _, e := range es {
		e.mu.Lock()
		hit := e.meta.Pid == pid
		e.mu.Unlock()
		if hit {
			return e.id, true
		}
	}
	return "", false
}

// LiveCount 即原版 liveCount()：还没退出的会话数。
func (s *Service) LiveCount() int {
	n := 0
	for _, m := range s.List() {
		if !isDead(m.Status) {
			n++
		}
	}
	return n
}

// DisposeAll 即原版 disposeAll()：并发 Kill 所有会话并等它们全部处理完，然后清空表。
func (s *Service) DisposeAll(ctx context.Context) {
	s.mu.Lock()
	ids := make([]string, 0, len(s.order))
	ids = append(ids, s.order...)
	s.mu.Unlock()

	var wg sync.WaitGroup
	for _, id := range ids {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			s.Kill(ctx, id)
		}(id)
	}
	wg.Wait()

	s.mu.Lock()
	s.entries = map[string]*entry{}
	s.order = nil
	s.mu.Unlock()
}
