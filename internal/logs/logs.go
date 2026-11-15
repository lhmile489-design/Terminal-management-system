// 对应 src/main/services/LogService.ts 的日志中心聚合（PRD §4.8）。
//
// SessionService 的 buffer 是每个会话各自一条原始 ANSI 流，只够喂给 xterm 重放；
// 「跨会话按级别筛、搜关键字」需要的是切好的行。因此这里另建一个全局环形缓冲，
// 与终端视图共用同一个 data 事件，不改动会话本身的存储。
//
// 只留在内存：日志落盘就得连带处理保留期、体积上限与「里面可能有密钥」这些问题，
// 而这个工具的用途是看当下这轮跑得怎么样，不是审计。
//
// 切行、去 ANSI、取进度条末段、错误级别判定全部调 S05 的 outputtext.go，不在这里另写正则。

package logs

import (
	"strings"
	"sync"
	"time"

	"mile-console/internal/contract"
)

const (
	// MaxLines 即原版 MAX_LINES：环形缓冲保留的最新行数。
	MaxLines = 5000
	// MaxLineChars 即原版 MAX_LINE_CHARS：单行截断长度（UTF-16 码元）。
	MaxLineChars = 500
	// FinalFlush 即原版 FINAL_FLUSH_MS：退出后再等一小会儿收尾，容纳晚于 exit 到达的末尾数据。
	FinalFlush = 120 * time.Millisecond
	// defaultLimit 即原版 clampLimit 在拿不到数时的兜底 300。
	defaultLimit = 300
)

// Timer 与 sessions 包同形，便于测试注入手动定时器。
type Timer interface{ Stop() bool }

// Sessions 是日志中心用到的会话能力，即原版构造参数 sessions 上实际调到的两个方法。
type Sessions interface {
	List() []contract.SessionMeta
	OnData(fn func(contract.SessionDataEvent)) (unsubscribe func())
	OnExit(fn func(contract.SessionExitEvent)) (unsubscribe func())
}

// Options 可注入的时钟与定时器，零值即生产行为。
type Options struct {
	Now       func() time.Time
	AfterFunc func(d time.Duration, f func()) Timer
}

// Service 日志中心。
type Service struct {
	src Sessions
	opt Options

	mu sync.Mutex
	// lines 最新在尾，超过 MaxLines 从头挤掉。
	lines []contract.LogLine
	// seq 全局单调序号。clear 不重置它，与原版一致。
	seq int64
	// dropped 已被环形缓冲挤掉的行数，界面要能说明「只保留最近 N 行」。
	dropped int64
	// partial 每个会话尚未收到换行的残段。不缓存就会把一行拆成两条。
	partial map[string]string
	// finalizers 已退出会话的收尾计时器，见 scheduleFinalFlush。
	finalizers map[string]Timer
	// listeners 每切出一行可见行就通知一次，输出告警在这里订阅。
	listeners []func(contract.LogLine)
}

// New 即原版构造函数：订阅会话的 data 与 exit。
func New(src Sessions, opt Options) *Service {
	if opt.Now == nil {
		opt.Now = time.Now
	}
	if opt.AfterFunc == nil {
		opt.AfterFunc = func(d time.Duration, f func()) Timer { return time.AfterFunc(d, f) }
	}
	s := &Service{src: src, opt: opt, partial: map[string]string{}, finalizers: map[string]Timer{}}
	src.OnData(func(e contract.SessionDataEvent) { s.absorb(e.ID, e.Chunk) })
	// 会话退出时把残段收尾，否则最后一行（往往正是错误摘要）永远不出现
	src.OnExit(func(e contract.SessionExitEvent) { s.scheduleFinalFlush(e.ID) })
	return s
}

// absorb 即原版 absorb：拼接残段、按 \r?\n 切行，最后一段没有换行结尾留着等下一块。
// 「回到第 1 列」的绝对光标定位换成 \n —— ConPTY 换行不一定发 \n。
func (s *Service) absorb(sessionID, chunk string) {
	s.mu.Lock()
	text := CursorToNewline(s.partial[sessionID] + chunk)
	parts := splitLines(text)
	s.partial[sessionID] = parts[len(parts)-1]
	_, reschedule := s.finalizers[sessionID]
	s.mu.Unlock()

	for _, raw := range parts[:len(parts)-1] {
		s.push(sessionID, raw)
	}
	// 退出后又来了数据：把收尾推后，否则这一段会永远留在 partial 里
	if reschedule {
		s.scheduleFinalFlush(sessionID)
	}
}

// scheduleFinalFlush 即原版 scheduleFinalFlush。
//
// exit 不保证晚于最后一块 data：ConPTY 的退出事件和 SessionService 的 16ms 合并
// 刷新是两条独立路径，末尾那块常常在 exit 之后才到。收到 exit 就立刻清 partial
// 的话，末行会被丢掉，而且是间歇性的 —— 这种偶发比稳定失败更难查。
func (s *Service) scheduleFinalFlush(sessionID string) {
	s.mu.Lock()
	if t, ok := s.finalizers[sessionID]; ok {
		t.Stop()
	}
	s.finalizers[sessionID] = s.opt.AfterFunc(FinalFlush, func() { s.finalFlush(sessionID) })
	s.mu.Unlock()
}

func (s *Service) finalFlush(sessionID string) {
	s.mu.Lock()
	delete(s.finalizers, sessionID)
	rest := s.partial[sessionID]
	delete(s.partial, sessionID)
	s.mu.Unlock()
	if rest != "" {
		s.push(sessionID, rest)
	}
}

// push 即原版 push：取这一行的可见文本，判定级别，进环形缓冲并通知订阅者。
func (s *Service) push(sessionID, raw string) {
	text := LastVisiblePaint(raw)
	if text == "" {
		return
	}

	// 原版每行都现查 sessions.list()：标题取会话当前标题（`meta?.title ?? sessionId`，
	// 空标题原样保留，与 `??` 一致），会话已不存在时回落到会话 id
	title := sessionID
	var entryID *string
	for _, m := range s.src.List() {
		if m.ID == sessionID {
			title = m.Title
			entryID = m.ProjectID
			break
		}
	}

	s.mu.Lock()
	s.seq++
	line := contract.LogLine{
		Seq:       s.seq,
		SessionID: sessionID,
		EntryID:   entryID,
		Title:     title,
		Ts:        s.opt.Now().UnixMilli(),
		Level:     level(text),
		Text:      jsSlice(text, MaxLineChars),
	}
	s.lines = append(s.lines, line)
	if cut := len(s.lines) - MaxLines; cut > 0 {
		s.lines = append([]contract.LogLine(nil), s.lines[cut:]...)
		s.dropped += int64(cut)
	}
	listeners := append([]func(contract.LogLine){}, s.listeners...)
	s.mu.Unlock()

	// 订阅方出错不能拖垮日志收集：告警是附加功能
	for _, fn := range listeners {
		func() {
			defer func() { _ = recover() }()
			fn(line)
		}()
	}
}

// OnLine 即原版 onLine：每切出一行可见行通知一次。
func (s *Service) OnLine(fn func(contract.LogLine)) {
	s.mu.Lock()
	s.listeners = append(s.listeners, fn)
	s.mu.Unlock()
}

// Query 即原版 query：倒序取最近的行，筛选在主进程做，页面拿到的始终是它要显示的那一屏。
func (s *Service) Query(q contract.LogQuery) contract.LogResult {
	limit := clampLimit(q.Limit)
	needle := ""
	if q.Text != nil {
		needle = strings.ToLower(strings.TrimFunc(*q.Text, jsIsSpace))
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	matched := make([]contract.LogLine, 0, min(limit, len(s.lines)))
	total := 0
	for i := len(s.lines) - 1; i >= 0; i-- {
		line := s.lines[i]
		if q.SessionID != nil && *q.SessionID != "" && line.SessionID != *q.SessionID {
			continue
		}
		if q.EntryID != nil && *q.EntryID != "" && (line.EntryID == nil || *line.EntryID != *q.EntryID) {
			continue
		}
		if q.Level != nil && *q.Level != "" && line.Level != *q.Level {
			continue
		}
		if needle != "" && !strings.Contains(strings.ToLower(line.Text), needle) {
			continue
		}
		total++
		if len(matched) < limit {
			matched = append(matched, line)
		}
	}
	// 倒着收集，再翻回时间正序
	for i, j := 0, len(matched)-1; i < j; i, j = i+1, j-1 {
		matched[i], matched[j] = matched[j], matched[i]
	}

	return contract.LogResult{
		Lines:    matched,
		Total:    total,
		Dropped:  s.dropped,
		Capacity: MaxLines,
		Sources:  s.sourcesLocked(),
	}
}

// sourcesLocked 即原版 sources：出现过日志的会话，按第一次出现的顺序。
// 已退出的会话也留着 —— 崩溃后正要看它。
func (s *Service) sourcesLocked() []contract.LogSource {
	out := make([]contract.LogSource, 0, 4)
	index := make(map[string]int, 4)
	for _, line := range s.lines {
		if i, ok := index[line.SessionID]; ok {
			out[i].Count++
			continue
		}
		index[line.SessionID] = len(out)
		out = append(out, contract.LogSource{SessionID: line.SessionID, Title: line.Title, Count: 1})
	}
	return out
}

// Clear 即原版 clear：清空缓冲与残段，并取消挂着的收尾 ——
// 否则它会把手刚清掉的残段再写回来，用户点了清空却又冒出一行。
func (s *Service) Clear() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lines = nil
	s.dropped = 0
	s.partial = map[string]string{}
	for _, t := range s.finalizers {
		t.Stop()
	}
	s.finalizers = map[string]Timer{}
}

// level 即原版 level。
func level(text string) contract.LogLevel {
	if IsErrorLine(text) {
		return contract.LogLevelError
	}
	if IsWarnLine(text) {
		return contract.LogLevelWarn
	}
	return contract.LogLevelInfo
}

// clampLimit 即原版 clampLimit：拿不到数用 300，其余收到 [1, MaxLines]。
// Go 的 int 参数已经保证是整数，原版的 Number.isFinite 与 Math.trunc 因此不需要。
func clampLimit(v *int) int {
	if v == nil {
		return defaultLimit
	}
	return min(max(*v, 1), MaxLines)
}
