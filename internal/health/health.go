// 对应 src/main/services/HealthService.ts。
//
// 本机 HTTP 健康检查（PRD-FEATURE-UPGRADE P0-1）。目标只由主进程决定：主机是回环地址，
// 端口与地址族取自本条目自己的监听行（条目服务的 OwnListenPids 过滤后的快照行）。
// 渲染层只能给路径，且路径在 sanitizeEdit 里按字符白名单校过。找不到自己的监听行就不发请求 ——
// 同一端口可以被两个进程分别绑 IPv4 / IPv6，按端口去探可能探到别人的服务。
//
// 结果只在内存，只用于展示与就绪时刻，不参与任何终止授权，也不触发自动重启。

package health

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"sync"
	"syscall"
	"time"

	"mile-console/internal/contract"
	"mile-console/internal/platform"
)

const (
	// VisibleInterval 窗口可见时的探测间隔。固定值，不跟 scanIntervalMs：
	// 那是用户为本机开销选的，这里影响的是被探服务。
	VisibleInterval = 15 * time.Second
	// HiddenInterval 窗口不可见时降频。
	HiddenInterval = 60 * time.Second
	// ProbeTimeout 单次探测的总时限：连接、响应头、读体都算在内。
	ProbeTimeout = 2 * time.Second
	// MaxBodyBytes 响应体最多读这么多字节，到了就关连接，不管服务还在不在写。
	MaxBodyBytes = 4096
	// userAgent 原版自报的 UA。
	userAgent = "MileTerminal-HealthCheck"
)

// ProbeResult 一次探测的结果。StatusCode 为 nil 表示没拿到响应。
type ProbeResult struct {
	StatusCode *int
	LatencyMs  *int64
	Reason     string
}

// Source 健康检查用到的条目服务能力。
type Source interface {
	List() []contract.LaunchEntry
	Get(id string) (contract.LaunchEntry, bool)
	RuntimeOf(id string) (contract.EntryRuntime, bool)
	OwnListenPids(id string) map[int]bool
	NoteHealthOk(id string)
	OnRuntime(fn func(contract.EntryRuntime)) (unsubscribe func())
	OnEntriesChanged(fn func([]contract.LaunchEntry)) (unsubscribe func())
}

// Scanner 采集侧能力：可见性与最近一次监听行。
type Scanner interface {
	IsVisible() bool
	ListenRows() []platform.ListenRow
}

// Timer 与其它包同形，便于测试注入手动定时器。
type Timer interface{ Stop() bool }

// Options 可注入的时钟、定时器、事件出口与探测实现。
type Options struct {
	Now       func() time.Time
	AfterFunc func(d time.Duration, f func()) Timer
	Emit      func(contract.EntryHealth)
	Probe     func(ctx context.Context, host string, port int, path string) ProbeResult
}

// Service 即原版 HealthService。
type Service struct {
	ctx     context.Context
	entries Source
	scanner Scanner
	opt     Options

	mu      sync.Mutex
	timer   Timer
	running bool
	stopped bool
	states  map[string]contract.EntryHealth
	// seenPort 每个条目上一次见到的「运行中端口」，只在它变化时提前探测
	seenPort map[string]int
}

// New 即原版构造函数：订阅运行态与条目变更。
func New(ctx context.Context, entries Source, scanner Scanner, opt Options) *Service {
	if opt.Now == nil {
		opt.Now = time.Now
	}
	if opt.AfterFunc == nil {
		opt.AfterFunc = func(d time.Duration, f func()) Timer { return time.AfterFunc(d, f) }
	}
	if opt.Emit == nil {
		opt.Emit = func(contract.EntryHealth) {}
	}
	if opt.Probe == nil {
		opt.Probe = Probe
	}
	s := &Service{
		ctx: ctx, entries: entries, scanner: scanner, opt: opt,
		states:   map[string]contract.EntryHealth{},
		seenPort: map[string]int{},
	}
	if entries != nil {
		entries.OnRuntime(func(rt contract.EntryRuntime) {
			// 条目离开运行态就立刻转 off，不等下一轮
			if rt.Status != contract.EntryRunning || rt.Port == nil {
				s.mu.Lock()
				delete(s.seenPort, rt.EntryID)
				s.mu.Unlock()
				if rt.Status != contract.EntryRunning {
					s.setState(rt.EntryID, contract.EntryHealth{State: contract.HealthOff}, false)
				}
				return
			}
			// 运行态推送很频繁（预检、自动重启倒计时都会推），只在刚拿到端口时提前探一次
			s.mu.Lock()
			seen, has := s.seenPort[rt.EntryID]
			s.seenPort[rt.EntryID] = *rt.Port
			s.mu.Unlock()
			if has && seen == *rt.Port {
				return
			}
			entry, ok := s.entries.Get(rt.EntryID)
			if ok && s.enabled(entry) {
				s.Kick()
			}
		})
		// 删掉的条目、关掉检查的条目，状态一并清掉
		entries.OnEntriesChanged(func(list []contract.LaunchEntry) {
			ids := make(map[string]bool, len(list))
			for _, e := range list {
				ids[e.ID] = true
			}
			s.mu.Lock()
			var stale []string
			for id := range s.states {
				stale = append(stale, id)
			}
			s.mu.Unlock()
			for _, id := range stale {
				entry, ok := s.entries.Get(id)
				if !ids[id] || !ok || !s.enabled(entry) {
					s.setState(id, contract.EntryHealth{State: contract.HealthOff}, !ids[id])
				}
			}
		})
	}
	return s
}

// Start 即原版 start。
func (s *Service) Start() {
	s.mu.Lock()
	s.stopped = false
	s.mu.Unlock()
	s.Schedule()
}

// Stop 即原版 stop。
func (s *Service) Stop() {
	s.mu.Lock()
	s.stopped = true
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	s.mu.Unlock()
}

// List 即原版 list。
func (s *Service) List() []contract.EntryHealth {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]contract.EntryHealth, 0, len(s.states))
	for _, h := range s.states {
		out = append(out, h)
	}
	return out
}

// Schedule 即原版 schedule：按窗口可见性排下一轮。
func (s *Service) Schedule() {
	s.mu.Lock()
	if s.stopped {
		s.mu.Unlock()
		return
	}
	if s.timer != nil {
		s.timer.Stop()
	}
	interval := HiddenInterval
	if s.scanner != nil && s.scanner.IsVisible() {
		interval = VisibleInterval
	}
	s.timer = s.opt.AfterFunc(interval, func() {
		s.Tick()
		s.Schedule()
	})
	s.mu.Unlock()
}

// Kick 即原版 kick：提前跑一轮，之后照常排程。
// 原版还订阅了扫描器的 diff 事件（新 PID 进监听表要十来秒，unknown 的条目要补探）；
// Go 的扫描器用回调而不是事件，由绑定层（S24）在每轮采集后调用这里。
func (s *Service) Kick() {
	s.mu.Lock()
	stopped := s.stopped
	s.mu.Unlock()
	if stopped {
		return
	}
	s.Tick()
	s.Schedule()
}

// Tick 即原版 tick：互斥，上一轮没探完不开新一轮，避免对慢服务堆积请求。
func (s *Service) Tick() {
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return
	}
	s.running = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.running = false
		s.mu.Unlock()
	}()

	var wg sync.WaitGroup
	for _, e := range s.entries.List() {
		wg.Add(1)
		go func(e contract.LaunchEntry) {
			defer wg.Done()
			s.checkOne(e)
		}(e)
	}
	wg.Wait()
}

func (s *Service) enabled(entry contract.LaunchEntry) bool {
	return entry.Kind == contract.EntryKindService && entry.HealthCheck != nil && entry.HealthCheck.Enabled
}

func (s *Service) checkOne(entry contract.LaunchEntry) {
	if !s.enabled(entry) {
		s.mu.Lock()
		_, has := s.states[entry.ID]
		s.mu.Unlock()
		if has {
			s.setState(entry.ID, contract.EntryHealth{State: contract.HealthOff}, false)
		}
		return
	}
	rt, ok := s.entries.RuntimeOf(entry.ID)
	if !ok || rt.Status != contract.EntryRunning || rt.Port == nil {
		s.setState(entry.ID, contract.EntryHealth{State: contract.HealthOff}, false)
		return
	}
	port := *rt.Port
	host, ok := s.pickHost(entry.ID, port)
	if !ok {
		s.setState(entry.ID, contract.EntryHealth{
			State:  contract.HealthUnknown,
			Reason: "还没在监听表里找到本服务的监听",
		}, false)
		return
	}

	r := s.opt.Probe(s.ctx, host, port, entry.HealthCheck.Path)
	// 探测期间条目可能已经停了或关了检查，结果作废
	now, ok := s.entries.RuntimeOf(entry.ID)
	if !ok || now.Status != contract.EntryRunning || now.Port == nil || *now.Port != port {
		return
	}
	if cur, ok := s.entries.Get(entry.ID); !ok || !s.enabled(cur) {
		return
	}

	okStatus := r.StatusCode != nil && *r.StatusCode >= 200 && *r.StatusCode < 400
	// 首次 ok 作为启动就绪时刻（P1-2）；条目服务只认等待中的那一次
	if okStatus {
		s.entries.NoteHealthOk(entry.ID)
	}
	next := contract.EntryHealth{
		EntryID:    entry.ID,
		State:      contract.HealthFail,
		StatusCode: r.StatusCode,
		LatencyMs:  r.LatencyMs,
	}
	if okStatus {
		next.State = contract.HealthOK
	} else {
		next.Reason = r.Reason
		if next.Reason == "" && r.StatusCode != nil {
			next.Reason = "HTTP " + itoa(*r.StatusCode)
		}
	}
	s.setState(entry.ID, next, false)
}

// pickHost 即原版：只在本条目自己的监听行里选回环地址。
// 有 IPv4 就用 127.0.0.1，只有 IPv6 才用 ::1；族解析不出时按 IPv4 处理。
func (s *Service) pickHost(entryID string, port int) (string, bool) {
	own := s.entries.OwnListenPids(entryID)
	if len(own) == 0 {
		return "", false
	}
	if s.scanner == nil {
		return "", false
	}
	var rows []platform.ListenRow
	for _, r := range s.scanner.ListenRows() {
		if r.Port == port && own[r.Pid] {
			rows = append(rows, r)
		}
	}
	if len(rows) == 0 {
		return "", false
	}
	has4, hasAny := false, false
	for _, r := range rows {
		for _, f := range r.Families {
			hasAny = true
			if f == 4 {
				has4 = true
			}
		}
	}
	if has4 || !hasAny {
		return "127.0.0.1", true
	}
	return "::1", true
}

// setState 即原版 setState：写状态并按需广播。
func (s *Service) setState(entryID string, patch contract.EntryHealth, remove bool) {
	s.mu.Lock()
	prev, had := s.states[entryID]
	next := patch
	next.EntryID = entryID
	next.CheckedAt = s.opt.Now().UnixMilli()
	if remove {
		delete(s.states, entryID)
	} else {
		s.states[entryID] = next
	}
	s.mu.Unlock()

	// off → off 不重复推送；其余每次探测都推，概览页要显示最近一次的时间与延迟
	if had && prev.State == contract.HealthOff && next.State == contract.HealthOff {
		return
	}
	if !had && next.State == contract.HealthOff {
		return
	}
	s.opt.Emit(next)
}

// Probe 即原版 probe：发一次 GET。只走 http，不跟随重定向（3xx 当作已响应），不带凭据。
// 响应头到达即记录状态码与延迟；随后读体计数，满 4KB 或总时限到了都主动断开。
func Probe(ctx context.Context, host string, port int, path string) ProbeResult {
	started := time.Now()
	reqCtx, cancel := context.WithTimeout(ctx, ProbeTimeout)
	defer cancel()

	hostport := net.JoinHostPort(host, itoa(port))
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, "http://"+hostport+path, nil)
	if err != nil {
		return ProbeResult{Reason: "请求失败"}
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Connection", "close")

	client := &http.Client{
		// 不跟随重定向：3xx 本身就算「已响应」
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Transport:     &http.Transport{DisableKeepAlives: true},
	}

	resp, err := client.Do(req)
	latency := time.Since(started).Milliseconds()
	if err != nil {
		return ProbeResult{Reason: probeReason(err)}
	}
	defer resp.Body.Close()

	code := resp.StatusCode
	_, _ = io.CopyN(io.Discard, resp.Body, MaxBodyBytes)
	return ProbeResult{StatusCode: &code, LatencyMs: &latency}
}

// probeReason 即原版对 node 错误码的映射：ECONNREFUSED 与超时各有中文说法，其余笼统报失败。
func probeReason(err error) string {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, os.ErrDeadlineExceeded) {
		return "超时"
	}
	if errors.Is(err, syscall.ECONNREFUSED) {
		return "连接被拒"
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return "超时"
	}
	return "请求失败"
}

func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var b []byte
	for v > 0 {
		b = append([]byte{byte('0' + v%10)}, b...)
		v /= 10
	}
	if neg {
		return "-" + string(b)
	}
	return string(b)
}
