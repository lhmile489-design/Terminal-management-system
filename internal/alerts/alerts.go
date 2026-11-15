// 对应 src/main/services/AlertService.ts。
//
// 输出关键词告警（PRD-FEATURE-UPGRADE P1-1）。匹配对象是日志中心已经切好、去掉 ANSI 与
// `\r` 重绘的可见行，规则不另写一份（CLAUDE.md：输出文本规则只在一处）。关键词按纯子串、
// 不区分大小写匹配，不接受正则。命中记录只在内存，不落盘。

package alerts

import (
	"strings"
	"sync"
	"time"

	"mile-console/internal/contract"
	"mile-console/internal/logs"
)

const (
	// DedupWindow 同一条目的同一关键词在这段时间内只告警一次。
	DedupWindow = 60 * time.Second
	// NotifyDelay 系统通知延迟发出：这段时间内条目崩溃了就只发崩溃通知。
	//
	// 3 秒而不是 1 秒：服务经 cmd → npm → node 链条启动，node 退出后 npm 收尾、ConPTY 发
	// exit 还要约 1 秒。实测命中行到 crashed 事件间隔约 1170ms，1 秒的延迟会让告警通知
	// 先弹出去，同一次崩溃收到两条通知。
	NotifyDelay = 3 * time.Second
	// MaxHitsPerEntry 每个条目在内存里最多留这么多条命中。
	MaxHitsPerEntry = 50
	// MaxLineChars 命中行截断长度。
	MaxLineChars = 200
	// errorLineKey 通用错误行命中时用的去重键，不会与用户关键词撞上（关键词不允许控制字符）。
	errorLineKey = "\x00error"
)

// Source 告警用到的条目服务能力。
type Source interface {
	Get(id string) (contract.LaunchEntry, bool)
	OnEntriesChanged(fn func([]contract.LaunchEntry)) (unsubscribe func())
}

// Timer 与其它包同形，便于测试注入手动定时器。
type Timer interface{ Stop() bool }

// Options 可注入的时钟、定时器与事件出口。
type Options struct {
	Now       func() time.Time
	AfterFunc func(d time.Duration, f func()) Timer
	// EmitAlert 命中即发（页面实时动态用）。
	EmitAlert func(contract.OutputAlert)
	// EmitNotify 延迟到期且没被崩溃通知吸收时才发（系统通知用）。
	EmitNotify func(contract.OutputAlert)
}

// Service 即原版 AlertService。
type Service struct {
	entries Source
	opt     Options

	mu      sync.Mutex
	lastHit map[string]int64
	hits    map[string][]contract.OutputAlert
	pending map[string][]Timer
	// lastCrash 最近一次崩溃时刻。日志中心在会话退出后还会延迟收尾末行，
	// 末行命中的告警排在崩溃之后，只撤「崩溃前排队的」挡不住它，所以到期时再看一次。
	lastCrash map[string]int64
}

// New 即原版构造函数：删掉的条目，命中记录与去重状态一并丢掉。
func New(entries Source, opt Options) *Service {
	if opt.Now == nil {
		opt.Now = time.Now
	}
	if opt.AfterFunc == nil {
		opt.AfterFunc = func(d time.Duration, f func()) Timer { return time.AfterFunc(d, f) }
	}
	if opt.EmitAlert == nil {
		opt.EmitAlert = func(contract.OutputAlert) {}
	}
	if opt.EmitNotify == nil {
		opt.EmitNotify = func(contract.OutputAlert) {}
	}
	s := &Service{
		entries: entries, opt: opt,
		lastHit:   map[string]int64{},
		hits:      map[string][]contract.OutputAlert{},
		pending:   map[string][]Timer{},
		lastCrash: map[string]int64{},
	}
	if entries != nil {
		entries.OnEntriesChanged(func(list []contract.LaunchEntry) {
			ids := make(map[string]bool, len(list))
			for _, e := range list {
				ids[e.ID] = true
			}
			s.mu.Lock()
			ids2 := make([]string, 0, len(s.hits))
			for id := range s.hits {
				ids2 = append(ids2, id)
			}
			s.mu.Unlock()
			for _, id := range ids2 {
				if !ids[id] {
					s.Forget(id)
				}
			}
		})
	}
	return s
}

// NoteCrash 即原版：条目崩溃，撤掉它排队中的告警通知，只留崩溃通知。命中记录照常保留。
func (s *Service) NoteCrash(entryID string) {
	s.mu.Lock()
	s.lastCrash[entryID] = s.opt.Now().UnixMilli()
	s.mu.Unlock()
	s.cancelPending(entryID)
}

func (s *Service) cancelPending(entryID string) {
	s.mu.Lock()
	timers := s.pending[entryID]
	delete(s.pending, entryID)
	s.mu.Unlock()
	for _, t := range timers {
		t.Stop()
	}
}

// List 即原版 list：某个条目最近命中的告警。
func (s *Service) List(entryID string) []contract.OutputAlert {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]contract.OutputAlert{}, s.hits[entryID]...)
}

// Dispose 即原版 dispose：撤掉所有排队中的通知。
func (s *Service) Dispose() {
	s.mu.Lock()
	ids := make([]string, 0, len(s.pending))
	for id := range s.pending {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	for _, id := range ids {
		s.cancelPending(id)
	}
}

// Check 即原版 check：一行日志进来看是否命中。由日志中心的 OnLine 驱动。
func (s *Service) Check(line contract.LogLine) {
	if line.EntryID == nil || *line.EntryID == "" {
		return
	}
	entry, ok := s.entries.Get(*line.EntryID)
	if !ok {
		return
	}
	if len(entry.AlertKeywords) == 0 && (entry.AlertOnErrors == nil || !*entry.AlertOnErrors) {
		return
	}

	hay := strings.ToLower(line.Text)
	var keyword *string
	found := false
	for _, w := range entry.AlertKeywords {
		if strings.Contains(hay, strings.ToLower(w)) {
			k := w
			keyword = &k
			found = true
			break
		}
	}
	if !found {
		if entry.AlertOnErrors == nil || !*entry.AlertOnErrors || !logs.IsErrorLine(line.Text) {
			return
		}
		// keyword 保持 nil：通用错误行命中
	}

	key := entry.ID + "\x00" + errorLineKey
	if keyword != nil {
		key = entry.ID + "\x00" + strings.ToLower(*keyword)
	}
	now := s.opt.Now().UnixMilli()
	s.mu.Lock()
	last, seen := s.lastHit[key]
	if seen && now-last < DedupWindow.Milliseconds() {
		s.mu.Unlock()
		return
	}
	s.lastHit[key] = now
	s.mu.Unlock()

	alert := contract.OutputAlert{
		EntryID:   entry.ID,
		SessionID: line.SessionID,
		Name:      entry.Name,
		Keyword:   keyword,
		Line:      truncateUnits(line.Text, MaxLineChars),
		At:        now,
	}
	s.mu.Lock()
	list := append(s.hits[entry.ID], alert)
	if len(list) > MaxHitsPerEntry {
		list = list[len(list)-MaxHitsPerEntry:]
	}
	s.hits[entry.ID] = list
	s.mu.Unlock()
	s.opt.EmitAlert(alert)

	var timer Timer
	timer = s.opt.AfterFunc(NotifyDelay, func() {
		s.mu.Lock()
		left := make([]Timer, 0, len(s.pending[entry.ID]))
		for _, t := range s.pending[entry.ID] {
			if t != timer {
				left = append(left, t)
			}
		}
		if len(left) > 0 {
			s.pending[entry.ID] = left
		} else {
			delete(s.pending, entry.ID)
		}
		// 崩溃前后各一个延迟窗口内的告警都并进崩溃通知，不再单独弹
		crashedAt, hasCrash := s.lastCrash[entry.ID]
		s.mu.Unlock()
		if hasCrash && abs(s.opt.Now().UnixMilli()-crashedAt) < NotifyDelay.Milliseconds()*2 {
			return
		}
		s.opt.EmitNotify(alert)
	})
	s.mu.Lock()
	s.pending[entry.ID] = append(s.pending[entry.ID], timer)
	s.mu.Unlock()
}

// Forget 即原版 forget：删掉的条目把命中记录、去重状态与排队通知一并清掉。
func (s *Service) Forget(entryID string) {
	s.cancelPending(entryID)
	s.mu.Lock()
	delete(s.lastCrash, entryID)
	delete(s.hits, entryID)
	prefix := entryID + "\x00"
	for k := range s.lastHit {
		if strings.HasPrefix(k, prefix) {
			delete(s.lastHit, k)
		}
	}
	s.mu.Unlock()
}

func abs(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}

// truncateUnits 即原版 `s.slice(0, n)`：按 UTF-16 码元截断。
func truncateUnits(s string, n int) string {
	units := 0
	for i, r := range s {
		w := 1
		if r >= 0x10000 {
			w = 2
		}
		if units+w > n {
			return s[:i]
		}
		units += w
	}
	return s
}
