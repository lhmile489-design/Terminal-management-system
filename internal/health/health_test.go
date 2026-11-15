// S22 单测：探测本身（本地 httptest）、回环地址选择、状态机与排程间隔。

package health

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"

	"mile-console/internal/contract"
	"mile-console/internal/platform"
)

type fakeSource struct {
	mu       sync.Mutex
	entries  []contract.LaunchEntry
	runtimes map[string]contract.EntryRuntime
	own      map[string]map[int]bool
	runtimeF []func(contract.EntryRuntime)
	changeF  []func([]contract.LaunchEntry)
	noted    []string
}

func (f *fakeSource) List() []contract.LaunchEntry {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]contract.LaunchEntry{}, f.entries...)
}

func (f *fakeSource) Get(id string) (contract.LaunchEntry, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, e := range f.entries {
		if e.ID == id {
			return e, true
		}
	}
	return contract.LaunchEntry{}, false
}

func (f *fakeSource) RuntimeOf(id string) (contract.EntryRuntime, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	rt, ok := f.runtimes[id]
	return rt, ok
}

func (f *fakeSource) OwnListenPids(id string) map[int]bool { return f.own[id] }

func (f *fakeSource) NoteHealthOk(id string) {
	f.mu.Lock()
	f.noted = append(f.noted, id)
	f.mu.Unlock()
}

func (f *fakeSource) OnRuntime(fn func(contract.EntryRuntime)) func() {
	f.mu.Lock()
	f.runtimeF = append(f.runtimeF, fn)
	f.mu.Unlock()
	return func() {}
}

func (f *fakeSource) OnEntriesChanged(fn func([]contract.LaunchEntry)) func() {
	f.mu.Lock()
	f.changeF = append(f.changeF, fn)
	f.mu.Unlock()
	return func() {}
}

func (f *fakeSource) setRuntime(rt contract.EntryRuntime) {
	f.mu.Lock()
	f.runtimes[rt.EntryID] = rt
	fns := append([]func(contract.EntryRuntime){}, f.runtimeF...)
	f.mu.Unlock()
	for _, fn := range fns {
		fn(rt)
	}
}

func (f *fakeSource) notedCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.noted)
}

type fakeScanner struct {
	visible bool
	rows    []platform.ListenRow
}

func (s *fakeScanner) IsVisible() bool                  { return s.visible }
func (s *fakeScanner) ListenRows() []platform.ListenRow { return s.rows }

type fakeTimer struct {
	ms      int64
	f       func()
	cleared bool
}

func (t *fakeTimer) Stop() bool {
	live := !t.cleared
	t.cleared = true
	return live
}

type rig struct {
	svc    *Service
	src    *fakeSource
	scan   *fakeScanner
	timers []*fakeTimer
	events []contract.EntryHealth
	probe  func(ctx context.Context, host string, port int, path string) ProbeResult
	mu     sync.Mutex
	clock  int64
}

func newRig(t *testing.T) *rig {
	t.Helper()
	r := &rig{src: &fakeSource{runtimes: map[string]contract.EntryRuntime{}, own: map[string]map[int]bool{}},
		scan: &fakeScanner{visible: true}, clock: 1_700_000_000_000}
	r.svc = New(context.Background(), r.src, r.scan, Options{
		Now: func() time.Time { return time.UnixMilli(r.now()) },
		AfterFunc: func(d time.Duration, f func()) Timer {
			tm := &fakeTimer{ms: d.Milliseconds(), f: f}
			r.mu.Lock()
			r.timers = append(r.timers, tm)
			r.mu.Unlock()
			return tm
		},
		Emit: func(h contract.EntryHealth) {
			r.mu.Lock()
			r.events = append(r.events, h)
			r.mu.Unlock()
		},
		Probe: func(ctx context.Context, host string, port int, path string) ProbeResult {
			if r.probe != nil {
				return r.probe(ctx, host, port, path)
			}
			return ProbeResult{}
		},
	})
	return r
}

func (r *rig) now() int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.clock
}

func (r *rig) advance(ms int64) {
	r.mu.Lock()
	r.clock += ms
	r.mu.Unlock()
}

func (r *rig) lastEvent() (contract.EntryHealth, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.events) == 0 {
		return contract.EntryHealth{}, false
	}
	return r.events[len(r.events)-1], true
}

func healthEntry(id string, enabled bool) contract.LaunchEntry {
	return contract.LaunchEntry{
		ID: id, Kind: contract.EntryKindService, Name: "服务" + id,
		HealthCheck: &contract.HealthCheckConfig{Path: "/health", Enabled: enabled},
	}
}

func TestProbeAgainstLocalServer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			w.WriteHeader(404)
			return
		}
		w.WriteHeader(204)
		_, _ = w.Write([]byte("ok"))
	}))
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)

	r := Probe(context.Background(), host, port, "/health")
	if r.StatusCode == nil || *r.StatusCode != 204 {
		t.Fatalf("状态码 = %v", r.StatusCode)
	}
	if r.LatencyMs == nil || *r.LatencyMs < 0 {
		t.Fatalf("延迟 = %v", r.LatencyMs)
	}

	// 非 2xx / 3xx 由调用方判 fail，这里只关心状态码拿到了
	r = Probe(context.Background(), host, port, "/nope")
	if r.StatusCode == nil || *r.StatusCode != 404 {
		t.Fatalf("404 应原样返回：%v", r.StatusCode)
	}
}

func TestProbeDoesNotFollowRedirect(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/old" {
			http.Redirect(w, r, "/new", http.StatusFound)
			return
		}
		w.WriteHeader(200)
	}))
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)
	r := Probe(context.Background(), host, port, "/old")
	if r.StatusCode == nil || *r.StatusCode != 302 {
		t.Fatalf("3xx 应当作已响应，得到 %v", r.StatusCode)
	}
}

func TestProbeTimeoutAndRefused(t *testing.T) {
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(3 * time.Second)
	}))
	defer slow.Close()
	host, port := splitHostPort(t, slow.URL)
	start := time.Now()
	r := Probe(context.Background(), host, port, "/health")
	if r.Reason != "超时" {
		t.Fatalf("应判超时，得到 %q", r.Reason)
	}
	if took := time.Since(start); took > 3*time.Second {
		t.Fatalf("超时控制没生效：%v", took)
	}

	// 关掉的端口：连接被拒
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	deadPort := l.Addr().(*net.TCPAddr).Port
	_ = l.Close()
	r = Probe(context.Background(), "127.0.0.1", deadPort, "/health")
	if r.Reason == "" || r.StatusCode != nil {
		t.Fatalf("关掉的端口应报错：%+v", r)
	}
}

func TestProbeStopsReadingHugeBody(t *testing.T) {
	blob := make([]byte, 1<<20)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		_, _ = w.Write(blob)
	}))
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)
	start := time.Now()
	r := Probe(context.Background(), host, port, "/")
	if r.StatusCode == nil || *r.StatusCode != 200 {
		t.Fatalf("大 body 也要拿到状态码：%+v", r)
	}
	if took := time.Since(start); took > 2*time.Second {
		t.Fatalf("读体没有被截断：%v", took)
	}
}

func TestPickHostFamilySelection(t *testing.T) {
	cases := []struct {
		name string
		rows []platform.ListenRow
		own  map[int]bool
		want string
		ok   bool
	}{
		{"IPv4", []platform.ListenRow{{Port: 3000, Pid: 1, Families: []int{4}}}, map[int]bool{1: true}, "127.0.0.1", true},
		{"只有 IPv6", []platform.ListenRow{{Port: 3000, Pid: 1, Families: []int{6}}}, map[int]bool{1: true}, "::1", true},
		{"双栈", []platform.ListenRow{{Port: 3000, Pid: 1, Families: []int{4, 6}}}, map[int]bool{1: true}, "127.0.0.1", true},
		{"族解析不出", []platform.ListenRow{{Port: 3000, Pid: 1}}, map[int]bool{1: true}, "127.0.0.1", true},
		{"不是自己", []platform.ListenRow{{Port: 3000, Pid: 2, Families: []int{4}}}, map[int]bool{1: true}, "", false},
		{"没有自有 PID", []platform.ListenRow{{Port: 3000, Pid: 1}}, map[int]bool{}, "", false},
		{"端口不同", []platform.ListenRow{{Port: 3001, Pid: 1, Families: []int{4}}}, map[int]bool{1: true}, "", false},
	}
	for _, c := range cases {
		r := newRig(t)
		r.scan.rows = c.rows
		r.src.own["e1"] = c.own
		host, ok := r.svc.pickHost("e1", 3000)
		if ok != c.ok || host != c.want {
			t.Errorf("%s：got %q,%v want %q,%v", c.name, host, ok, c.want, c.ok)
		}
	}
}

func TestCheckOneStates(t *testing.T) {
	port := 3000
	mk := func() *rig {
		r := newRig(t)
		r.src.entries = []contract.LaunchEntry{healthEntry("e1", true)}
		r.src.runtimes["e1"] = contract.EntryRuntime{EntryID: "e1", Status: contract.EntryRunning, Port: &port}
		r.src.own["e1"] = map[int]bool{7: true}
		r.scan.rows = []platform.ListenRow{{Port: 3000, Pid: 7, Families: []int{4}}}
		return r
	}

	// ok：2xx，并记一次就绪
	r := mk()
	r.probe = func(context.Context, string, int, string) ProbeResult {
		code := 200
		lat := int64(12)
		return ProbeResult{StatusCode: &code, LatencyMs: &lat}
	}
	r.svc.Tick()
	h, _ := r.lastEvent()
	if h.State != contract.HealthOK || h.StatusCode == nil || *h.StatusCode != 200 {
		t.Fatalf("ok 状态不对：%+v", h)
	}
	if r.src.notedCount() != 1 {
		t.Fatal("首次 ok 应通知就绪")
	}

	// fail：500，理由带状态码
	r = mk()
	r.probe = func(context.Context, string, int, string) ProbeResult {
		code := 500
		return ProbeResult{StatusCode: &code}
	}
	r.svc.Tick()
	h, _ = r.lastEvent()
	if h.State != contract.HealthFail || h.Reason != "HTTP 500" {
		t.Fatalf("fail 状态不对：%+v", h)
	}
	if r.src.notedCount() != 0 {
		t.Fatal("失败不该记就绪")
	}

	// fail：连接被拒
	r = mk()
	r.probe = func(context.Context, string, int, string) ProbeResult { return ProbeResult{Reason: "连接被拒"} }
	r.svc.Tick()
	if h, _ = r.lastEvent(); h.State != contract.HealthFail || h.Reason != "连接被拒" {
		t.Fatalf("拒绝的文案不对：%+v", h)
	}

	// unknown：监听表里没有自己的行
	r = mk()
	r.scan.rows = nil
	r.svc.Tick()
	if h, _ = r.lastEvent(); h.State != contract.HealthUnknown || h.Reason == "" {
		t.Fatalf("unknown 状态不对：%+v", h)
	}

	// off：没在运行 —— 状态照样写进表里（原版 setState 也是 set 不是 delete），只是首次不推送
	r = mk()
	r.src.runtimes["e1"] = contract.EntryRuntime{EntryID: "e1", Status: contract.EntryStopped}
	before := len(r.events)
	r.svc.Tick()
	states := r.svc.List()
	if len(states) != 1 || states[0].State != contract.HealthOff {
		t.Fatalf("应记一条 off：%+v", states)
	}
	if len(r.events) != before {
		t.Fatal("首次 off 不该推送")
	}
}

func TestOffToOffIsNotEmitted(t *testing.T) {
	r := newRig(t)
	r.src.entries = []contract.LaunchEntry{healthEntry("e1", true)}
	r.src.runtimes["e1"] = contract.EntryRuntime{EntryID: "e1", Status: contract.EntryRunning}
	r.svc.checkOne(r.src.entries[0]) // -> off
	r.svc.checkOne(r.src.entries[0]) // 再来一次 off
	r.mu.Lock()
	n := len(r.events)
	r.mu.Unlock()
	if n != 0 {
		t.Fatalf("off → off 不该推送：%d", n)
	}
}

func TestScheduleIntervalFollowsVisibility(t *testing.T) {
	r := newRig(t)
	r.svc.Start()
	r.mu.Lock()
	first := r.timers[len(r.timers)-1].ms
	r.mu.Unlock()
	if first != 15_000 { // 字面量：拿常量自己比会随变异一起变
		t.Fatalf("可见时间隔 = %d", first)
	}
	r.scan.visible = false
	r.svc.Schedule()
	r.mu.Lock()
	second := r.timers[len(r.timers)-1].ms
	r.mu.Unlock()
	if second != 60_000 {
		t.Fatalf("不可见时间隔 = %d", second)
	}
	r.svc.Stop()
	r.svc.Schedule()
	r.mu.Lock()
	n := len(r.timers)
	r.mu.Unlock()
	if n != 2 {
		t.Fatal("停止后不该再排程")
	}
}

func TestRuntimeEventTriggersProbeOnPortChange(t *testing.T) {
	r := newRig(t)
	r.src.entries = []contract.LaunchEntry{healthEntry("e1", true)}
	r.src.own["e1"] = map[int]bool{7: true}
	r.scan.rows = []platform.ListenRow{{Port: 3000, Pid: 7, Families: []int{4}}}
	r.probe = func(context.Context, string, int, string) ProbeResult {
		code := 200
		return ProbeResult{StatusCode: &code}
	}
	port := 3000
	r.src.setRuntime(contract.EntryRuntime{EntryID: "e1", Status: contract.EntryRunning, Port: &port})
	// 端口没变再来一次：不该再排程
	before := len(r.timers)
	r.src.setRuntime(contract.EntryRuntime{EntryID: "e1", Status: contract.EntryRunning, Port: &port})
	if len(r.timers) != before {
		t.Fatal("端口没变不该重新探测")
	}
	// 离开运行态 → 立刻 off（前一态是 ok，所以这次要推）
	r.src.setRuntime(contract.EntryRuntime{EntryID: "e1", Status: contract.EntryStopped})
	if h, ok := r.lastEvent(); !ok || h.State != contract.HealthOff {
		t.Fatalf("离开运行态应推 off：%+v %v", h, ok)
	}
}

func splitHostPort(t *testing.T, url string) (string, int) {
	t.Helper()
	u := url[len("http://"):]
	host, portStr, err := net.SplitHostPort(u)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatal(err)
	}
	return host, port
}
