// 对应 src/main/services/PlannerService.ts 的服务部分：看板 / 任务 / 日程 / 错过的提醒的增删改，
// 以及 commit（写盘 + 广播）。存储层在 store.go，触发引擎在 tick.go，校形在 sanitize.go。
//
// 页面只发意图：id、order、createdAt、doneAt 全由这里生成，入参里带了也不看。
// 每个入口逐字段校形，白名单外的键丢弃，非法值返回原版逐字相同的中文错误且不落盘。
// 本服务不碰命令、进程、会话。

package planner

import (
	"cmp"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sync"
	"time"

	"mile-console/internal/contract"
)

// ConfigSource 是服务读工作组与设置的来源，即原版构造函数收的 ConfigStore（只读）。
// internal/config.Store 满足这个接口。
type ConfigSource interface {
	Get() contract.AppConfig
}

// Options 构造 Service 的可注入项。零值字段取生产默认值。
type Options struct {
	// Dev 即原版 !app.isPackaged。只有为 true 时才读 MILE_PLANNER_TICK_MS / MILE_PLANNER_NOW。
	// 绑定层传 mygo.IsDev()：`mygo build` 打出来的包为 false。
	Dev bool
	// Getenv 默认 os.Getenv。
	Getenv func(string) string
	// Wall 即 Date.now()，默认 time.Now().UnixMilli。
	Wall func() int64
	// NewID 即 randomUUID()，默认 crypto/rand 生成的 v4 UUID。
	NewID func() string
	// OnChanged 即 emit('changed', snapshot)，每次成功写盘后调用一次。
	OnChanged func(contract.PlannerSnapshot)
	// OnReminder 即 emit('reminder', fire)，在 OnChanged 之后按顺序调用。
	OnReminder func(contract.ReminderFire)
}

// Service 即原版 PlannerService。所有方法并发安全：原版跑在单线程事件循环里，
// 这里用一把锁把「读缓存 → 算下一份 → 写盘」串起来，效果相同。
type Service struct {
	store  *Store
	config ConfigSource
	opts   Options
	tickMs float64
	devNow float64

	mu sync.Mutex

	schedMu sync.Mutex
	stop    chan struct{}
}

// NewService 包一层服务在已打开的 Store 上。
func NewService(store *Store, config ConfigSource, opts Options) *Service {
	if opts.Wall == nil {
		opts.Wall = func() int64 { return time.Now().UnixMilli() }
	}
	if opts.NewID == nil {
		opts.NewID = newUUID
	}
	tick, now := devOverrides(opts.Dev, opts.Getenv)
	return &Service{store: store, config: config, opts: opts, tickMs: tick, devNow: now}
}

// newUUID 即 crypto.randomUUID()：RFC 4122 v4，小写十六进制。
func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:]) // crypto/rand.Read 不会返回错误（Go 1.24 起失败直接崩溃）
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// Snapshot 即原版 snapshot()。
func (s *Service) Snapshot() contract.PlannerSnapshot {
	return s.store.Snapshot()
}

// ── commit 与内部查找 ────────────────────────────────────────────────

// pending 是一次 commit 要发出去的事件。锁外发，免得回调里再调本服务时死锁；
// 仍在方法返回前发完，与原版同步 emit 的时序一致。
type pending struct {
	changed bool
	snap    contract.PlannerSnapshot
	fires   []contract.ReminderFire
}

func (s *Service) flush(p pending) {
	if !p.changed {
		return
	}
	if s.opts.OnChanged != nil {
		s.opts.OnChanged(p.snap)
	}
	if s.opts.OnReminder != nil {
		for _, f := range p.fires {
			s.opts.OnReminder(f)
		}
	}
}

// commit 即原版 commit：只读时抛错；先换缓存再写盘；写盘成功才广播。
// 调用方持有 s.mu。
func (s *Service) commit(next contract.PlannerData, fires []contract.ReminderFire, ev *pending) error {
	if _, err := s.store.Patch(func(d *contract.PlannerData) { *d = next }); err != nil {
		return err
	}
	ev.changed = true
	ev.snap = s.store.Snapshot()
	ev.fires = fires
	return nil
}

// board 即原版 board(id)：返回当前数据与该看板的下标。
func (s *Service) board(raw json.RawMessage) (contract.PlannerData, int, error) {
	id, ok := jsStr(raw)
	if !ok || utf16Len(id) > maxIDLen {
		return contract.PlannerData{}, -1, errors.New("看板 id 非法")
	}
	d := s.store.Get()
	for i, b := range d.Boards {
		if b.ID == id {
			return d, i, nil
		}
	}
	return contract.PlannerData{}, -1, errors.New("看板不存在")
}

// assertGroup 即原版 assertGroup。
func (s *Service) assertGroup(raw json.RawMessage) (string, error) {
	id, ok := jsStr(raw)
	if !ok || id == "" || utf16Len(id) > maxIDLen {
		return "", errors.New("工作组 id 非法")
	}
	if !slices.ContainsFunc(s.config.Get().Groups, func(g contract.ProjectGroup) bool { return g.ID == id }) {
		return "", errors.New("工作组不存在")
	}
	return id, nil
}

// groupName 即原版 groupName：工作组被删后显示「工作组已删除」。
func (s *Service) groupName(groupID string) string {
	for _, g := range s.config.Get().Groups {
		if g.ID == groupID {
			return g.Name
		}
	}
	return "工作组已删除"
}

// rankSort 即原版 reorder 的排序：列入 ids 的按 ids 下标（同一 id 出现多次取最后一次），
// 没列入的排在后面并保持原 order；稳定排序。
func rankSort[T any](items []T, ids []string, id func(T) string, order func(T) int) []T {
	rank := make(map[string]int, len(ids))
	for i, x := range ids {
		rank[x] = i
	}
	key := func(t T) int {
		if r, ok := rank[id(t)]; ok {
			return r
		}
		return 1_000_000_000 + order(t)
	}
	out := slices.Clone(items)
	slices.SortStableFunc(out, func(a, b T) int { return cmp.Compare(key(a), key(b)) })
	return out
}

func isClosed(st contract.PlannerTaskStatus) bool {
	return st == contract.TaskDone || st == contract.TaskCanceled
}
