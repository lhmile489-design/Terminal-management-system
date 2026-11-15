// 对应 src/main/services/EntryService.ts 第 757–807 行的 startOrdered 与 waitRunning。

package entries

import (
	"context"
	"strings"
	"time"

	"mile-console/internal/contract"
)

// StartOrdered 即原版 startOrdered：按 startAfter 分层启动一批条目（2.3.0）。
// 同层并发，下一层等上一层都进入运行中；只看本批次内的依赖；
// 前置没起来（被拦、崩溃、抛错）的，依赖它的条目跳过并写明原因。每一个仍走 Start。
func (s *Service) StartOrdered(ctx context.Context, ids []string) []contract.OrderedStartResult {
	seen := map[string]bool{}
	batch := make([]contract.LaunchEntry, 0, len(ids))
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		if e, ok := s.Get(id); ok {
			batch = append(batch, e)
		}
	}
	inBatch := map[string]bool{}
	for _, e := range batch {
		inBatch[e.ID] = true
	}
	deps := make(map[string][]string, len(batch))
	for _, e := range batch {
		var d []string
		for _, x := range e.StartAfter {
			if inBatch[x] {
				d = append(d, x)
			}
		}
		deps[e.ID] = d
	}
	results := make(map[string]contract.OrderedStartResult, len(batch))
	done := map[string]bool{}
	okSet := map[string]bool{}

	for len(done) < len(batch) {
		var layer []contract.LaunchEntry
		for _, e := range batch {
			if done[e.ID] {
				continue
			}
			ready := true
			for _, d := range deps[e.ID] {
				if !done[d] {
					ready = false
					break
				}
			}
			if ready {
				layer = append(layer, e)
			}
		}
		// 剩下的互相依赖：校验挡住了新增的环，这里兜底旧配置，直接放行别卡死
		run := layer
		if len(run) == 0 {
			for _, e := range batch {
				if !done[e.ID] {
					run = append(run, e)
				}
			}
		}

		type outcome struct {
			id  string
			res contract.OrderedStartResult
		}
		ch := make(chan outcome, len(run))
		for _, e := range run {
			go func(e contract.LaunchEntry) {
				var bad []string
				if len(layer) > 0 {
					for _, d := range deps[e.ID] {
						if !okSet[d] {
							bad = append(bad, d)
						}
					}
				}
				if len(layer) > 0 && len(bad) > 0 {
					names := make([]string, 0, len(bad))
					for _, d := range bad {
						if pre, ok := s.Get(d); ok {
							names = append(names, pre.Name)
						} else {
							names = append(names, d)
						}
					}
					ch <- outcome{e.ID, contract.OrderedStartResult{ID: e.ID, OK: false, Skipped: "前置服务没起来：" + strings.Join(names, "、")}}
					return
				}
				r, err := s.Start(ctx, e.ID)
				if err != nil {
					ch <- outcome{e.ID, contract.OrderedStartResult{ID: e.ID, OK: false, Skipped: err.Error()}}
					return
				}
				if !r.OK {
					pre := r.Precheck
					ch <- outcome{e.ID, contract.OrderedStartResult{ID: e.ID, OK: false, Precheck: &pre}}
					return
				}
				if s.waitRunning(ctx, e.ID) {
					ch <- outcome{e.ID, contract.OrderedStartResult{ID: e.ID, OK: true}}
					return
				}
				ch <- outcome{e.ID, contract.OrderedStartResult{ID: e.ID, OK: false, Skipped: "启动后没有进入运行中"}}
			}(e)
		}
		for i := 0; i < len(run); i++ {
			o := <-ch
			results[o.id] = o.res
			done[o.id] = true
			if o.res.OK {
				okSet[o.id] = true
			}
		}
	}

	out := make([]contract.OrderedStartResult, 0, len(batch))
	for _, e := range batch {
		out = append(out, results[e.ID])
	}
	return out
}

// waitRunning 即原版：等条目进入 running；退出（崩溃、被停）或超时返回 false。
// 端口捕获超时本身会把它转成 running。
func (s *Service) waitRunning(ctx context.Context, id string) bool {
	deadline := s.now().Add(PortCaptureTimeoutMS*time.Millisecond + 5*time.Second)
	for s.now().Before(deadline) {
		s.mu.Lock()
		rt, ok := s.runtimes[id]
		s.mu.Unlock()
		if ok && rt.Status == contract.EntryRunning {
			return true
		}
		if !ok || !IsLive(rt.Status) {
			return false
		}
		if !s.sleepCtx(ctx, 200*time.Millisecond) {
			return false
		}
	}
	return false
}
