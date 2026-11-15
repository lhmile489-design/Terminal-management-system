//go:build windows

// S15 对拍的假世界：与 scripts/gen-scanner-cases.mjs 的 makeWorld 逐项对应。
// 监听行、进程表、pidusage 读数、cpus、内存都来自场景步骤；定时器只记录，由 fire 步骤手动触发。

package scanner

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"mile-console/internal/contract"
	"mile-console/internal/platform"
	"mile-console/internal/platform/win32"
)

type worldState struct {
	Listens    [][]json.RawMessage `json:"listens"`
	Procs      [][]json.RawMessage `json:"procs"`
	Mine       *[]int              `json:"mine"`
	Usage      json.RawMessage     `json:"usage"`
	Cpus       [][5]float64        `json:"cpus"`
	Mem        *[2]float64         `json:"mem"`
	Cost       int64               `json:"cost"`
	FailListen *string             `json:"failListen"`
	FailMeta   *string             `json:"failMeta"`
}

// merge 即 { ...state.world, ...st.world }：出现的键覆盖（null 也算出现）。
func (w *worldState) merge(raw json.RawMessage) {
	var keys map[string]json.RawMessage
	_ = json.Unmarshal(raw, &keys)
	var patch worldState
	_ = json.Unmarshal(raw, &patch)
	for k := range keys {
		switch k {
		case "listens":
			w.Listens = patch.Listens
		case "procs":
			w.Procs = patch.Procs
		case "mine":
			w.Mine = patch.Mine
		case "usage":
			w.Usage = patch.Usage
		case "cpus":
			w.Cpus = patch.Cpus
		case "mem":
			w.Mem = patch.Mem
		case "cost":
			w.Cost = patch.Cost
		case "failListen":
			w.FailListen = patch.FailListen
		case "failMeta":
			w.FailMeta = patch.FailMeta
		}
	}
}

type world struct {
	mu          sync.Mutex
	clock       int64
	st          worldState
	listenReads int
	metaReads   int
	plat        *win32.Win32
	// onListen 采集读监听行时回调一次（锁外），用来在一轮采集中途插入调用；只触发一次
	onListen func()
}

func newWorld(clock int64) *world { return &world{clock: clock, plat: win32.New()} }

func (w *world) now() int64 {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.clock
}

func num(r json.RawMessage) int { var n int; _ = json.Unmarshal(r, &n); return n }

func optStr(rs []json.RawMessage, i int) *string {
	if i >= len(rs) || string(rs[i]) == "null" {
		return nil
	}
	var s string
	_ = json.Unmarshal(rs[i], &s)
	return &s
}

// ── Source ──

func (w *world) ID() string                              { return "win32" }
func (w *world) PathKey(p string) string                 { return w.plat.PathKey(p) }
func (w *world) Attribution() platform.AttributionTables { return w.plat.Attribution() }

func (w *world) ReadListenPorts(context.Context) ([]platform.ListenRow, error) {
	w.mu.Lock()
	hook := w.onListen
	w.onListen = nil
	w.mu.Unlock()
	if hook != nil {
		hook()
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	w.listenReads++
	w.clock += w.st.Cost
	if w.st.FailListen != nil && *w.st.FailListen != "" {
		return nil, errors.New(*w.st.FailListen)
	}
	rows := make([]platform.ListenRow, 0, len(w.st.Listens))
	for _, l := range w.st.Listens {
		fam := []int{4}
		if len(l) > 2 {
			_ = json.Unmarshal(l[2], &fam)
		}
		rows = append(rows, platform.ListenRow{Port: num(l[0]), Pid: num(l[1]), Families: fam})
	}
	return rows, nil
}

func (w *world) ReadProcessMeta(context.Context) (platform.ProcessMeta, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.metaReads++
	if w.st.FailMeta != nil && *w.st.FailMeta != "" {
		return platform.ProcessMeta{}, errors.New(*w.st.FailMeta)
	}
	m := platform.ProcessMeta{ByPid: map[int]platform.ProcessRow{}, Mine: map[int]struct{}{}, At: w.clock}
	for _, p := range w.st.Procs {
		row := platform.ProcessRow{Pid: num(p[0]), Ppid: num(p[1])}
		_ = json.Unmarshal(p[2], &row.Name)
		if len(p) > 3 && string(p[3]) != "null" {
			v := int64(num(p[3]))
			row.StartedAt = &v
		}
		row.CommandLine = optStr(p, 4)
		row.ExecPath = optStr(p, 5)
		m.ByPid[row.Pid] = row
		if w.st.Mine == nil {
			m.Mine[row.Pid] = struct{}{}
		}
	}
	if w.st.Mine != nil {
		for _, p := range *w.st.Mine {
			m.Mine[p] = struct{}{}
		}
	}
	return m, nil
}

// ── Metrics ──

func (w *world) Usage(_ context.Context, pids []int) (map[int]ProcStat, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if string(w.st.Usage) == `"fail"` {
		return nil, errors.New("pidusage failed")
	}
	var u map[string][2]float64
	_ = json.Unmarshal(w.st.Usage, &u)
	out := map[int]ProcStat{}
	for _, p := range pids {
		if v, ok := u[itoaTest(p)]; ok {
			out[p] = ProcStat{CPU: v[0], Memory: int64(v[1])}
		}
	}
	return out, nil
}

func (w *world) Cores() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.st.Cpus == nil {
		return 1
	}
	return len(w.st.Cpus)
}

func (w *world) CPUTicks() (idle, total float64) {
	w.mu.Lock()
	defer w.mu.Unlock()
	cpus := w.st.Cpus
	if cpus == nil {
		cpus = [][5]float64{{}}
	}
	for _, c := range cpus {
		idle += c[3]
		total += c[0] + c[1] + c[2] + c[3] + c[4]
	}
	return idle, total
}

func (w *world) Memory() (total, free float64) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.st.Mem == nil {
		return 100, 50
	}
	return w.st.Mem[0], w.st.Mem[1]
}

// ── 定时器 ──

type timerLog struct {
	Set   *int64 `json:"set,omitempty"`
	Clear bool   `json:"clear,omitempty"`
}

type fakeTimers struct {
	mu      sync.Mutex
	log     []timerLog
	pending []*pendingTimer
}

type pendingTimer struct {
	fn   func()
	dead bool
}

func (f *fakeTimers) after(d time.Duration, fn func()) func() {
	f.mu.Lock()
	defer f.mu.Unlock()
	ms := d.Milliseconds()
	f.log = append(f.log, timerLog{Set: &ms})
	p := &pendingTimer{fn: fn}
	f.pending = append(f.pending, p)
	return func() {
		f.mu.Lock()
		defer f.mu.Unlock()
		p.dead = true
		f.log = append(f.log, timerLog{Clear: true})
	}
}

// fire 即生成器的 fire：触发最后一个还活着的定时器。
func (f *fakeTimers) fire() error {
	f.mu.Lock()
	var p *pendingTimer
	for i := len(f.pending) - 1; i >= 0; i-- {
		if !f.pending[i].dead {
			p = f.pending[i]
			break
		}
	}
	if p != nil {
		p.dead = true
	}
	f.mu.Unlock()
	if p == nil {
		return errors.New("no pending timer")
	}
	p.fn()
	return nil
}

func (f *fakeTimers) take() []timerLog {
	f.mu.Lock()
	defer f.mu.Unlock()
	l := f.log
	f.log = nil
	return l
}

// ── 配置 ──

type memConfig struct {
	mu  sync.Mutex
	cfg contract.AppConfig
}

func (c *memConfig) Get() contract.AppConfig {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.cfg
}

func (c *memConfig) Patch(fn func(*contract.AppConfig)) (contract.AppConfig, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	fn(&c.cfg)
	return c.cfg, nil
}
