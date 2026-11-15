// 对应 src/main/services/ScannerService.ts：每个周期采集监听端口、进程元数据、CPU / 内存，推增量。
//
// 文件分工：scanner.go 放类型、常量与对外方法；tick.go 放一轮采集（tick / resolveMeta / build / publish / diff）；
// watch.go 放关注进程；build.go 放原版文件末尾的纯函数；metrics.go 放 pidusage 与系统负载的替身。
//
// 并发：原版靠 node 单线程，这里一把 mu 护住全部可变状态。读配置、调条目服务的回调、采集进程表、
// 发事件都在锁外做（回调里可能反过来调扫描器）。tick 的互斥用独立的 running 标记，与原版一样
// 进行中到来的 refresh 直接丢弃，不排队。

package scanner

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"mile-console/internal/config"
	"mile-console/internal/contract"
	"mile-console/internal/ownership"
	"mile-console/internal/platform"
)

// BackgroundIntervalMs 窗口不可见时的最低采集间隔。
const BackgroundIntervalMs = 10_000

// MetaMaxAgeMs 元数据兜底刷新周期：没有新 PID 时也定期刷一次，纠正 cwd / 命令行的陈旧值。
const MetaMaxAgeMs = 30_000

// VerifyMaxAgeMs 归属重校验允许的元数据陈旧上限，比采集缓存严格得多 —— 误杀窗口就在这几秒里。
const VerifyMaxAgeMs = 3000

// MaxKeywords / MaxKeywordLen 关注进程关键字数量与长度上限，避免每轮在几千个进程上跑无限多次匹配。
const (
	MaxKeywords   = 20
	MaxKeywordLen = 64
)

// MaxWatched 单次采集下发的关注命中数上限：一个 `e` 这样的关键字能命中整张进程表。
const MaxWatched = 50

// MaxHiddenOnce 「本次隐藏」只在内存里，但同样不让它随调用无限增长。
const MaxHiddenOnce = 1000

// WatchedCmdMax 下发命令行的截断长度，PRD §5.5。关注是按命令行匹配的，不给片段用户就不知道为什么命中；
// 但完整参数里可能带 token 或密码，整条摊到界面上不合适。截断是折中，不是装饰。
const WatchedCmdMax = 160

// Source 扫描器需要的平台能力，是 platform.Platform 的子集，测试换成假的。
type Source interface {
	ID() string
	ReadListenPorts(ctx context.Context) ([]platform.ListenRow, error)
	ReadProcessMeta(ctx context.Context) (platform.ProcessMeta, error)
	PathKey(p string) string
	Attribution() platform.AttributionTables
}

// ConfigStore 扫描器读写的配置，是 *config.Store 的子集。
type ConfigStore interface {
	Get() contract.AppConfig
	Patch(fn func(c *contract.AppConfig)) (contract.AppConfig, error)
}

var _ ConfigStore = (*config.Store)(nil)

// Metrics 即 pidusage 与 os.cpus / totalmem / freemem 的替身，见 metrics.go。只给原始读数，
// 换算公式（CPU 按核数折算、系统 CPU 取两次 tick 的增量、内存占比）留在本包，与原版逐行对上。
type Metrics interface {
	// Usage 即 pidusage(pids)：CPU 为相对上次采样的单核百分比，Memory 为工作集字节数。
	// 取不到的 PID 不出现在结果里；整体失败返回 error，调用方当作这一轮没有指标。
	Usage(ctx context.Context, pids []int) (map[int]ProcStat, error)
	// Cores 即 os.cpus().length。
	Cores() int
	// CPUTicks 即对 os.cpus() 的 times 求和：idle 与 user + nice + sys + idle + irq，毫秒。
	CPUTicks() (idle, total float64)
	// Memory 即 os.totalmem() 与 os.freemem()，字节。
	Memory() (total, free float64)
}

// ProcStat 即 pidusage 返回的单个进程统计里用到的两项。
type ProcStat struct {
	CPU    float64
	Memory int64
}

// Options 构造参数。零值字段用生产实现。
type Options struct {
	Now     func() int64 // 即 Date.now()
	SelfPid int          // 即 process.pid，关注进程里排除本应用；零值取 os.Getpid()
	Metrics Metrics
	// OnDiff 即 emit('diff')；OnError 即 emit('error')，为 nil 时等于没有 error 监听器（只推失败态，不报错）。
	OnDiff  func(contract.ScanDiff)
	OnError func(error)
	// After 即 setTimeout，测试注入可控定时器。返回的函数取消定时器。
	After func(d time.Duration, fn func()) (cancel func())
	// Go 即原版的 `void this.tick()`：不等它跑完。默认起协程，测试换成同步执行。
	Go func(fn func())
}

type cpuMark struct {
	at    int64
	total float64
}

// Service 即原版 ScannerService。
type Service struct {
	src       Source
	ownership *ownership.Service
	config    ConfigStore
	opts      Options

	mu      sync.Mutex
	cancel  func() // 当前 timer；nil 即原版 timer === null
	gen     int    // 每次 schedule 加一；已取消的定时器回调看到代数变了就不跑
	running bool
	visible bool
	// baseline 应用启动时的 (pid:port) 基线，用于「本次会话新出现」判定，PRD §7。nil 即原版 null
	baseline      map[string]struct{}
	hiddenOnce    map[string]struct{}
	previous      map[int]contract.ListenerSnapshot
	previousOrder []int // Map 插入顺序，removedPids 按它输出
	lastSuccessAt *int64
	latest        *contract.ScanSnapshot
	meta          *platform.ProcessMeta
	// lastListens 最近一次成功采集的原始监听行（含地址族），只给健康检查选回环地址用
	lastListens []platform.ListenRow
	cpuBaseline map[int]cpuMark
	// prevTicks 原版是模块级变量（全应用只有一个扫描器），这里放进实例
	prevTicks *[2]float64

	expectations ExpectationSource
	ctx          context.Context
}

// New 即 new ScannerService(ownership, config)。ctx 是 App 生命周期 ctx，所有采集从它派生。
func New(ctx context.Context, src Source, own *ownership.Service, cfg ConfigStore, opts Options) *Service {
	if opts.Now == nil {
		opts.Now = func() int64 { return time.Now().UnixMilli() }
	}
	if opts.Metrics == nil {
		opts.Metrics = newWinMetrics()
	}
	if opts.SelfPid == 0 {
		opts.SelfPid = os.Getpid()
	}
	if opts.Go == nil {
		opts.Go = func(fn func()) { go fn() }
	}
	if opts.After == nil {
		opts.After = func(d time.Duration, fn func()) func() {
			t := time.AfterFunc(d, fn)
			return func() { t.Stop() }
		}
	}
	return &Service{
		src: src, ownership: own, config: cfg, opts: opts, ctx: ctx,
		visible:      true,
		hiddenOnce:   map[string]struct{}{},
		previous:     map[int]contract.ListenerSnapshot{},
		cpuBaseline:  map[int]cpuMark{},
		expectations: func() []EntryExpectation { return nil },
	}
}

// SetExpectationSource 条目服务构造完成后回注，打破二者的循环依赖。
func (s *Service) SetExpectationSource(source ExpectationSource) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expectations = source
}

// Table 供归属重校验用的进程表。终止前必须拿新鲜数据，不能复用采集缓存 ——
// 缓存最长 30 秒，期间 PID 可能已被回收复用。
func (s *Service) Table(ctx context.Context, hintPids []int) (platform.ProcessTable, error) {
	s.mu.Lock()
	m := s.meta
	s.mu.Unlock()
	stale := m == nil || s.opts.Now()-m.At > VerifyMaxAgeMs
	// mine 与 byPid 来自两次不同的 CIM 查询，刚启动的进程可能只在 byPid 里。
	// 只看 byPid 会拿着半新不旧的缓存把自己的进程判成 foreign，停止被误拒
	unknown := true
	if m != nil {
		unknown = false
		for _, p := range hintPids {
			_, inBy := m.ByPid[p]
			_, inMine := m.Mine[p]
			if !inBy || !inMine {
				unknown = true
				break
			}
		}
	}
	if stale || unknown {
		fresh, err := s.src.ReadProcessMeta(ctx)
		if err != nil {
			return platform.ProcessTable{}, err
		}
		s.mu.Lock()
		s.meta = &fresh
		s.mu.Unlock()
		m = &fresh
	}
	listens, err := s.src.ReadListenPorts(ctx)
	if err != nil {
		return platform.ProcessTable{}, err
	}
	return platform.ProcessTable{ProcessMeta: *m, Listens: listens}, nil
}

// Start 即原版 start()：先跑一轮，结束后按这一轮的开始时刻排下一轮。
func (s *Service) Start() {
	at := s.opts.Now()
	s.opts.Go(func() {
		s.tick()
		s.schedule(at)
	})
}

// Stop 即原版 stop()。
func (s *Service) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cancel != nil {
		s.cancel()
	}
	s.cancel = nil
}

// Snapshot 即原版 snapshot()：还没有成功采集过时为 nil。返回副本。
func (s *Service) Snapshot() *contract.ScanSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.latest == nil {
		return nil
	}
	c := cloneSnapshot(*s.latest)
	return &c
}

// ListenRows 最近一次采集的监听行。每轮采集整体替换，不会原地修改；返回副本。
func (s *Service) ListenRows() []platform.ListenRow {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]platform.ListenRow(nil), s.lastListens...)
}

// IsVisible 窗口当前是否可见：健康检查据此降频，不跟采集间隔走。
func (s *Service) IsVisible() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.visible
}

// KnownPath 路径白名单：只有最近一次采集里出现过的目录才允许在资源管理器打开。精确相等，不做规整。
func (s *Service) KnownPath(target string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.latest == nil {
		return false
	}
	for _, l := range s.latest.Listeners {
		if l.Cwd != "" && l.Cwd == target {
			return true
		}
	}
	return false
}

// SetVisible 窗口不可见时降频到 10s；恢复可见立即补一次采集，PRD §3.1。
func (s *Service) SetVisible(visible bool) {
	s.mu.Lock()
	if s.visible == visible {
		s.mu.Unlock()
		return
	}
	s.visible = visible
	s.mu.Unlock()
	s.schedule(s.opts.Now())
	if visible {
		s.opts.Go(s.tick)
	}
}

// Refresh 即原版 refresh()：进行中时丢弃。
func (s *Service) Refresh() { s.opts.Go(s.tick) }

// Reschedule 采集周期设置变更后立即换节奏，否则要等当前 timer 走完才生效。
func (s *Service) Reschedule() { s.schedule(s.opts.Now()) }

// Ignore 「忽略此监听」：按进程名 + 端口落盘，上限 MaxIgnoredListeners。入参由绑定层校形。
func (s *Service) Ignore(processName string, port int) error {
	list := s.config.Get().IgnoredListeners
	dup := false
	for _, i := range list {
		if i.ProcessName == processName && i.Port == port {
			dup = true
			break
		}
	}
	if len(list) < config.MaxIgnoredListeners && !dup {
		// 落盘失败时原版 patch 抛错，后面的 tick 不跑
		if _, err := s.config.Patch(func(c *contract.AppConfig) {
			c.IgnoredListeners = append(append([]contract.IgnoredListener{}, list...), contract.IgnoredListener{ProcessName: processName, Port: port})
		}); err != nil {
			return err
		}
	}
	s.opts.Go(s.tick)
	return nil
}

// HideOnce 「本次隐藏」：只在内存，上限 MaxHiddenOnce。
func (s *Service) HideOnce(pid, port int) {
	s.mu.Lock()
	if len(s.hiddenOnce) < MaxHiddenOnce {
		s.hiddenOnce[pidPort(pid, port)] = struct{}{}
	}
	s.mu.Unlock()
	s.opts.Go(s.tick)
}

// SetGroup 手动提升 / 移回，PRD §5.2。按进程名存而不是 PID：PID 每次重启都变。
// group 为 nil 即原版 null（清除覆盖）。分组只影响列表怎么排，不影响能不能停。
func (s *Service) SetGroup(processName string, group *contract.ListenerGroup) error {
	if jsTrim(processName) == "" {
		return nil
	}
	name := jsTrim(processName)
	lower := jsToLower(name)
	var rest []contract.GroupOverride
	for _, o := range s.config.Get().GroupOverrides {
		if jsToLower(o.ProcessName) != lower {
			rest = append(rest, o)
		}
	}
	if rest == nil {
		rest = []contract.GroupOverride{}
	}
	if group != nil {
		rest = append(rest, contract.GroupOverride{ProcessName: name, Group: *group})
	}
	if _, err := s.config.Patch(func(c *contract.AppConfig) { c.GroupOverrides = rest }); err != nil {
		return err
	}
	s.opts.Go(s.tick)
	return nil
}

// SetWatchedKeywords 关注关键字整表替换，逐项规整后落盘，PRD §5.5。
// 原版入参是 unknown：不是数组抛错，数组里的非字符串跳过。这里收页面传来的原始 JSON，同样在服务里判。
func (s *Service) SetWatchedKeywords(raw json.RawMessage) ([]string, error) {
	var items []json.RawMessage
	t := strings.TrimSpace(string(raw))
	if !strings.HasPrefix(t, "[") || json.Unmarshal(raw, &items) != nil {
		return nil, errors.New("关注关键字必须是数组")
	}
	strs := []string{}
	for _, it := range items {
		var str string
		if strings.HasPrefix(strings.TrimSpace(string(it)), `"`) && json.Unmarshal(it, &str) == nil {
			strs = append(strs, str)
		}
	}
	clean := normalizeKeywords(strs)
	if _, err := s.config.Patch(func(c *contract.AppConfig) { c.WatchedKeywords = clean }); err != nil {
		return nil, err
	}
	s.opts.Go(s.tick)
	return clean, nil
}

func pidPort(pid, port int) string { return strconv.Itoa(pid) + ":" + strconv.Itoa(port) }
