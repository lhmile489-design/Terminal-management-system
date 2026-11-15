// 对应 src/main/services/SessionService.ts：ConPTY 会话。
//
// 本文件是类型、构造与「创建」；输出合并刷新在 flush.go，终止与查询在 kill.go，
// 给页面的流式出口（*mygo.Channel）在 channel.go，UTF-8 / UTF-16 字符串语义在 text.go。
//
// 红线（PRD §11）：
//   - 绑定层只暴露 CreateShell：只认 kind=shell 与标题，可执行文件、参数、目录全部由这里定；
//   - Create 是主进程内部入口，只给 EntryService 用固定模板构造的规格，绝不绑定；
//   - MILE_RUN_TOKEN 只进 PTY 环境与 ownership 登记，不进 SessionMeta、事件、Channel、日志。

package sessions

import (
	"context"
	"errors"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"mile-console/internal/contract"
	"mile-console/internal/platform"
)

const (
	// MaxBufferChars 即原版 MAX_BUFFER_CHARS，按 UTF-16 码元计。
	MaxBufferChars = 400_000
	// FlushInterval 即原版 FLUSH_INTERVAL_MS。
	FlushInterval = 16 * time.Millisecond
	// StopGrace 即原版 stop() 里 setTimeout 的 3000ms。
	StopGrace = 3 * time.Second

	ptyCols = 120
	ptyRows = 30
	// pumpDrainTimeout 子进程退出后等读循环收尾的上限；超时则不再等，直接出退出事件。
	pumpDrainTimeout = 2 * time.Second
	readSize         = 32 * 1024
)

// ErrShellOnly 即原版 createShell 的 `自由终端只允许 shell`。
var ErrShellOnly = errors.New("自由终端只允许 shell")

// Platform 会话用到的平台能力。
type Platform interface {
	DefaultShell() platform.Shell
	ShellArgs(file string) []string
	ShellInit(file string) (string, bool)
	KillTree(ctx context.Context, rootPid int)
}

// Ownership 即原版 OwnershipService 里会话用到的部分。
type Ownership interface {
	IssueToken() string
	Register(sessionID string, rootPid int, runToken string)
	Unregister(sessionID string)
	AssertKillable(pid int, table platform.ProcessMeta, sessionID string) (contract.OwnershipVerdict, error)
}

// Scanner 即原版 ScannerService 里 kill 前取新鲜进程表的部分。
type Scanner interface {
	Table(ctx context.Context, hintPids []int) (platform.ProcessTable, error)
}

// Timer 即 *time.Timer 的最小面，测试里换成手动队列。
type Timer interface{ Stop() bool }

// Options 测试注入点。零值字段取真实实现。
type Options struct {
	Now       func() time.Time
	Homedir   func() (string, error)
	Environ   func() []string
	Spawn     Spawner
	AfterFunc func(d time.Duration, f func()) Timer
	After     func(d time.Duration) <-chan time.Time
}

// ShellAt 即原版 createShell 的第二个参数 at：只由主进程传入（terminalCwd 解析并校验过的条目目录）。
type ShellAt struct {
	Cwd   string
	Title string
}

type dataListener struct {
	id int
	fn func(contract.SessionDataEvent)
}

type exitListener struct {
	id int
	fn func(contract.SessionExitEvent)
}

// entry 即原版 Entry。
type entry struct {
	id       string
	pty      PTYProc
	runToken string // 绝不下发页面，见 PRD §11
	done     chan struct{}

	// emitMu 串行化 flush 的发射，保证订阅者看到的块顺序与 buffer 一致。
	emitMu sync.Mutex

	mu      sync.Mutex
	meta    contract.SessionMeta
	buffer  string
	pending string
	timer   Timer
	subs    map[int]*sub
	nextSub int
}

// Service 即原版 SessionService。
type Service struct {
	ctx  context.Context
	plat Platform
	own  Ownership
	opt  Options

	mu      sync.Mutex
	scanner Scanner
	entries map[string]*entry
	order   []string
	seq     int
	nextL   int
	onData  []dataListener
	onExit  []exitListener
}

// New 组装会话服务。ctx 是 App 生命周期 ctx，stop 的延迟 kill 从它派生。
func New(ctx context.Context, plat Platform, own Ownership, opt Options) *Service {
	if opt.Now == nil {
		opt.Now = time.Now
	}
	if opt.Homedir == nil {
		opt.Homedir = os.UserHomeDir
	}
	if opt.Environ == nil {
		opt.Environ = os.Environ
	}
	if opt.Spawn == nil {
		opt.Spawn = SpawnConPTY
	}
	if opt.After == nil {
		opt.After = time.After
	}
	if opt.AfterFunc == nil {
		opt.AfterFunc = func(d time.Duration, f func()) Timer { return time.AfterFunc(d, f) }
	}
	return &Service{ctx: ctx, plat: plat, own: own, opt: opt, entries: map[string]*entry{}}
}

// SetScanner 即原版 setScanner：scanner 晚于 sessions 构建，避免构造时循环依赖。
func (s *Service) SetScanner(sc Scanner) {
	s.mu.Lock()
	s.scanner = sc
	s.mu.Unlock()
}

// OnData 订阅 flush 之后的输出块（原版 'data' 事件之外的内部订阅；页面走 Attach）。返回取消订阅函数。
func (s *Service) OnData(fn func(contract.SessionDataEvent)) func() {
	s.mu.Lock()
	s.nextL++
	id := s.nextL
	s.onData = append(s.onData, dataListener{id: id, fn: fn})
	s.mu.Unlock()
	return func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		for i, l := range s.onData {
			if l.id == id {
				s.onData = append(s.onData[:i:i], s.onData[i+1:]...)
				return
			}
		}
	}
}

// OnExit 订阅会话退出（原版 'exit' 事件）。返回取消订阅函数。
func (s *Service) OnExit(fn func(contract.SessionExitEvent)) func() {
	s.mu.Lock()
	s.nextL++
	id := s.nextL
	s.onExit = append(s.onExit, exitListener{id: id, fn: fn})
	s.mu.Unlock()
	return func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		for i, l := range s.onExit {
			if l.id == id {
				s.onExit = append(s.onExit[:i:i], s.onExit[i+1:]...)
				return
			}
		}
	}
}

// CreateShell 即原版 createShell(input, at)：IPC 的「新建终端」入口。
// 入参里除 kind 与 title 以外的任何字段（可执行文件、参数、目录）在类型上就不存在，更不会被读取。
func (s *Service) CreateShell(in contract.CreateShellSessionInput, at *ShellAt) (contract.SessionMeta, error) {
	if in.Kind != contract.SessionKindShell {
		return contract.SessionMeta{}, ErrShellOnly
	}
	shell := s.plat.DefaultShell()
	title := shell.Title
	if t := jsTrim(in.Title); t != "" {
		title = truncateHead(t, 80)
	}
	cwd := ""
	if at != nil {
		cwd = at.Cwd
		if at.Title != "" {
			title = at.Title
		}
	}
	return s.Create(contract.CreateSessionInput{
		Kind:  contract.SessionKindShell,
		File:  shell.File,
		Args:  s.plat.ShellArgs(shell.File),
		Cwd:   cwd,
		Title: title,
	})
}

// Create 即原版 create(input)：主进程内部入口，调用方负责构造可信的完整规格。
func (s *Service) Create(in contract.CreateSessionInput) (contract.SessionMeta, error) {
	file := in.File
	if file == "" {
		file = s.plat.DefaultShell().File
	}
	args := in.Args
	if args == nil {
		args = s.plat.ShellArgs(file)
	}
	cwd := in.Cwd
	if cwd == "" {
		home, err := s.opt.Homedir()
		if err != nil {
			return contract.SessionMeta{}, err
		}
		cwd = home
	}

	id := s.newID()
	token := s.own.IssueToken()
	env := buildEnv(s.opt.Environ(), in.Env, token, id)
	full := append([]string{file}, args...)

	pty, err := s.opt.Spawn(PTYOptions{Path: file, Args: full, Dir: cwd, Env: env, Cols: ptyCols, Rows: ptyRows})
	if err != nil {
		return contract.SessionMeta{}, err
	}

	title := in.Title
	if title == "" {
		title = string(in.Kind)
	}
	meta := contract.SessionMeta{
		ID:        id,
		ProjectID: in.ProjectID,
		Kind:      in.Kind,
		Title:     title,
		Command:   strings.Join(full, " "),
		Cwd:       cwd,
		Pid:       pty.Pid(),
		Status:    contract.SessionStatusStarting,
		StartedAt: s.opt.Now().UnixMilli(),
	}
	e := &entry{id: id, pty: pty, runToken: token, done: make(chan struct{}), meta: meta, subs: map[int]*sub{}}

	s.mu.Lock()
	s.entries[id] = e
	s.order = append(s.order, id)
	s.mu.Unlock()
	s.own.Register(id, meta.Pid, token)

	pumpDone := make(chan struct{})
	go s.pump(e, pumpDone)
	go s.watch(e, pumpDone)

	// Windows PowerShell 要先切 UTF-8（ConPTY 默认代码页 936）
	if init, ok := s.plat.ShellInit(file); ok {
		_, _ = pty.Write([]byte(init))
	}

	e.mu.Lock()
	out := copyMeta(e.meta)
	e.mu.Unlock()
	return out, nil
}

// newID 即原版 nextId：`s${++seq}-${Date.now().toString(36)}`。
func (s *Service) newID() string {
	s.mu.Lock()
	s.seq++
	n := s.seq
	s.mu.Unlock()
	return "s" + strconv.Itoa(n) + "-" + strconv.FormatInt(s.opt.Now().UnixMilli(), 36)
}

// envKey 取 "KEY=VALUE" 的键（大写，Windows 环境变量名不分大小写）。
// 以 '=' 开头的是 cmd 的隐藏变量（=C:），键从第二个 '=' 之前算。
func envKey(kv string) string {
	if kv == "" {
		return ""
	}
	i := strings.IndexByte(kv[1:], '=')
	if i < 0 {
		return strings.ToUpper(kv)
	}
	return strings.ToUpper(kv[:i+1])
}

// buildEnv 即原版 env 展开：process.env，再 input.env，再固定覆盖项。
// 同名（不分大小写）后者覆盖前者，位置留在第一次出现处。extra 的键序在 Go 里不定，按字典序固定下来。
func buildEnv(base []string, extra map[string]string, token, sessionID string) []string {
	out := make([]string, 0, len(base)+len(extra)+8)
	index := map[string]int{}
	set := func(kv string) {
		k := envKey(kv)
		if i, ok := index[k]; ok {
			out[i] = kv
			return
		}
		index[k] = len(out)
		out = append(out, kv)
	}
	for _, kv := range base {
		set(kv)
	}
	keys := make([]string, 0, len(extra))
	for k := range extra {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		set(k + "=" + extra[k])
	}
	set("MILE_RUN_TOKEN=" + token)
	set("MILE_SESSION_ID=" + sessionID)
	set("LANG=zh_CN.UTF-8")
	set("LC_ALL=zh_CN.UTF-8")
	set("PYTHONIOENCODING=utf-8")
	set("FORCE_COLOR=1")
	set("TERM=xterm-256color")
	// 关掉 npm 转轮进度：它用 \r 反复重绘同一行，会擦掉紧邻的无换行结尾的真实输出。
	set("npm_config_progress=false")
	return out
}

// copyMeta 深拷贝指针字段，调用方拿到的快照与内部状态互不牵连。
func copyMeta(m contract.SessionMeta) contract.SessionMeta {
	if m.ProjectID != nil {
		v := *m.ProjectID
		m.ProjectID = &v
	}
	if m.Port != nil {
		v := *m.Port
		m.Port = &v
	}
	if m.ExitCode != nil {
		v := *m.ExitCode
		m.ExitCode = &v
	}
	return m
}

func (s *Service) get(id string) *entry {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.entries[id]
}
