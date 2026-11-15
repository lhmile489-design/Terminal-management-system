// 对应 src/main/services/ScannerService.ts 的一轮采集：schedule、tick、resolveMeta、build、
// attachMetrics、publish、publishFailure、diff，以及模块级的 systemLoad。

package scanner

import (
	"math"
	"slices"
	"sort"
	"strconv"
	"time"

	"mile-console/internal/contract"
	"mile-console/internal/platform"
)

// schedule 从上一轮**开始**时刻计时，而不是结束时刻。一轮里取指标约 1s，按结束时刻排会让实际节奏退化到 3s 以上，
// 对不上 PRD 的 2 秒要求。单轮超过周期时立即接下一轮，由互斥标记兜住不会重入。
func (s *Service) schedule(startedAt int64) {
	base := s.config.Get().Settings.ScanIntervalMs
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
	s.gen++
	// App 退出后不再排（Go 侧补的生命周期；原版进程退出时定时器随之消失）
	if s.ctx.Err() != nil {
		return
	}
	interval := base
	if !s.visible {
		interval = max(base, BackgroundIntervalMs)
	}
	wait := max(0, int64(interval)-(s.opts.Now()-startedAt))
	gen := s.gen
	s.cancel = s.opts.After(time.Duration(wait)*time.Millisecond, func() {
		// 已被 clearTimeout 的定时器不该再跑：AfterFunc 的 Stop 与触发有竞争，用代数兜住
		s.mu.Lock()
		live := s.gen == gen
		s.mu.Unlock()
		if !live {
			return
		}
		at := s.opts.Now()
		s.tick()
		s.schedule(at)
	})
}

// tick 互斥：上一轮未完成则跳过本轮，防止子进程堆积，PRD §3.1。
func (s *Service) tick() {
	if s.ctx.Err() != nil {
		return
	}
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
	if err := s.collect(); err != nil {
		// 先推失败态，再报错误（原版：没有 'error' 监听器时 emit 会同步抛出，排在前面就推不出失败态）
		s.publishFailure()
		if s.opts.OnError != nil {
			s.opts.OnError(err)
		}
	}
}

func (s *Service) collect() error {
	listens, err := s.src.ReadListenPorts(s.ctx)
	if err != nil {
		return err
	}
	meta, err := s.resolveMeta(listens)
	if err != nil {
		return err
	}
	s.publish(s.build(platform.ProcessTable{ProcessMeta: meta, Listens: listens}))
	s.mu.Lock()
	s.lastListens = listens
	s.mu.Unlock()
	return nil
}

// resolveMeta 分层采集：端口用 netstat（约 55ms）每轮取；进程元数据走 CIM（约 3.5s），
// 只在出现未知 PID 或缓存过期时刷新。否则 2 秒周期根本跑不完一轮。
func (s *Service) resolveMeta(listens []platform.ListenRow) (platform.ProcessMeta, error) {
	s.mu.Lock()
	m := s.meta
	s.mu.Unlock()
	stale := m == nil || s.opts.Now()-m.At > MetaMaxAgeMs
	unknown := true
	if m != nil {
		unknown = false
		for _, l := range listens {
			if _, ok := m.ByPid[l.Pid]; !ok {
				unknown = true
				break
			}
		}
	}
	if stale || unknown {
		fresh, err := s.src.ReadProcessMeta(s.ctx)
		if err != nil {
			return platform.ProcessMeta{}, err
		}
		s.mu.Lock()
		s.meta = &fresh
		s.mu.Unlock()
		m = &fresh
	}
	return *m, nil
}

func (s *Service) build(table platform.ProcessTable) *contract.ScanSnapshot {
	at := s.opts.Now()
	// portsByPid：原版 Map<number, Set<number>>，按监听行首次出现的顺序
	var order []int
	portsByPid := map[int][]int{}
	for _, l := range table.Listens {
		if _, ok := table.Mine[l.Pid]; !ok {
			continue
		}
		ports, seen := portsByPid[l.Pid]
		if !seen {
			order = append(order, l.Pid)
		}
		if !slices.Contains(ports, l.Port) {
			ports = append(ports, l.Port)
		}
		portsByPid[l.Pid] = ports
	}

	s.mu.Lock()
	if s.baseline == nil {
		s.baseline = map[string]struct{}{}
		for _, pid := range order {
			for _, p := range portsByPid[pid] {
				s.baseline[pidPort(pid, p)] = struct{}{}
			}
		}
	}
	source := s.expectations
	s.mu.Unlock()

	// 配置与条目回调在锁外取：回调方可能反过来调扫描器
	cfg := s.config.Get()
	ignored := cfg.IgnoredListeners
	overrides := map[string]contract.ListenerGroup{}
	for _, o := range cfg.GroupOverrides {
		overrides[jsToLower(o.ProcessName)] = o.Group
	}
	expectations := source()
	attr := s.src.Attribution()
	listeners := []contract.ListenerSnapshot{}
	unmanaged := []contract.UnmanagedListener{}

	s.mu.Lock()
	for _, pid := range order {
		var row *platform.ProcessRow
		if r, ok := table.ByPid[pid]; ok {
			row = &r
		}
		verdict := s.ownership.Verify(pid, table.ProcessMeta)
		if verdict.Ownership == contract.OwnershipForeign {
			continue
		}

		ports := slices.Clone(portsByPid[pid])
		slices.Sort(ports)
		guessed := ""
		if row != nil && row.CommandLine != nil && *row.CommandLine != "" {
			guessed = s.guessCwd(*row.CommandLine)
		}
		entryID := s.matchEntry(expectations, pid, guessed, verdict.SessionID)
		// 命令行里没有绝对路径（如 `node server.cjs`）时推不出目录；已归到条目的进程就用条目的
		// 工作目录 —— 它本来就在 knownPath 白名单里，端口表的「复制 / 打开目录」才有值
		cwd := guessed
		if cwd == "" && entryID != "" {
			for _, e := range expectations {
				if e.ID == entryID {
					cwd = e.Cwd
					break
				}
			}
		}

		// 用户手动定过的分组优先于推断，PRD §5.2。但覆盖是按进程名生效的：
		// 把某个 node.exe 移回后台后，不能把刚从启动台拉起的服务一起带走
		pinned := verdict.Ownership == contract.OwnershipOwned || entryID != ""
		var override *contract.ListenerGroup
		if row != nil && !pinned {
			if g, ok := overrides[jsToLower(row.Name)]; ok {
				override = &g
			}
		}
		group := ClassifyGroup(attr, row, verdict.Ownership, entryID)
		if override != nil {
			group = *override
		}

		name := "pid " + strconv.Itoa(pid)
		ignoreName := ""
		l := contract.ListenerSnapshot{Pid: pid, Ports: ports, Ownership: verdict.Ownership, EntryID: entryID,
			SessionID: verdict.SessionID, Group: group, GroupOverridden: override != nil, Cwd: cwd,
			// 展示用徽标，绝不参与权限判定，PRD §5.3
			LaunchSource: TraceLaunchSource(attr, pid, table.ByPid, verdict.Ownership == contract.OwnershipOwned)}
		if row != nil {
			name, ignoreName = row.Name, row.Name
			if row.ExecPath != nil {
				l.ExecPath = *row.ExecPath
			}
			l.StartedAt = row.StartedAt
		}
		l.ProcessName = name
		listeners = append(listeners, l)

		if verdict.Ownership != contract.OwnershipExternal {
			continue
		}
		// 后台组不进新端口提醒：GUI 应用与系统进程开的端口不是用户要纳管的东西，PRD §5.4
		if group != contract.ListenerGroupMine {
			continue
		}
		for _, port := range ports {
			key := pidPort(pid, port)
			if _, ok := s.baseline[key]; ok {
				continue
			}
			if _, ok := s.hiddenOnce[key]; ok {
				continue
			}
			if slices.ContainsFunc(ignored, func(i contract.IgnoredListener) bool {
				return i.ProcessName == ignoreName && i.Port == port
			}) {
				continue
			}
			guessedName := name
			if cwd != "" {
				guessedName = s.basename(cwd)
			}
			unmanaged = append(unmanaged, contract.UnmanagedListener{Pid: pid, Port: port, ProcessName: name,
				Cwd: cwd, GuessedName: guessedName, StartedAt: l.StartedAt})
		}
	}

	// 原版 Array.prototype.sort 是稳定排序
	sort.SliceStable(listeners, func(i, j int) bool { return listeners[i].Ports[0] < listeners[j].Ports[0] })
	s.lastSuccessAt = &at
	watched := s.matchWatched(table, cfg)
	s.mu.Unlock()

	return &contract.ScanSnapshot{
		At:            at,
		Listeners:     listeners,
		Unmanaged:     unmanaged,
		Watched:       watched,
		System:        s.systemLoad(),
		PortConflicts: countConflicts(expectations, listeners),
		Failed:        false,
		LastSuccessAt: &at,
	}
}

// basename 即 node path.basename，Electron 在 Windows 上是 win32 版。
func (s *Service) basename(p string) string {
	if s.src.ID() == "win32" {
		return basenameWin32(p)
	}
	return basenamePosix(p)
}

// attachMetrics 批量取 CPU / 内存，PRD §3.2。监听项在前、关注项在后，与原版同一个顺序：
// 同一 PID 两边都有时，第一次「首轮无基线」显示 —，第二次已有基线显示数值（原版如此）。
func (s *Service) attachMetrics(snap *contract.ScanSnapshot) {
	n := len(snap.Listeners) + len(snap.Watched)
	if n == 0 {
		return
	}
	pids := make([]int, 0, n)
	for _, l := range snap.Listeners {
		pids = append(pids, l.Pid)
	}
	for _, w := range snap.Watched {
		pids = append(pids, w.Pid)
	}
	stats, err := s.opts.Metrics.Usage(s.ctx, pids)
	if err != nil {
		return
	}
	cores := s.opts.Metrics.Cores()
	if cores == 0 {
		cores = 1
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	apply := func(pid int, cpu **float64, memory *int64) {
		st, ok := stats[pid]
		if !ok {
			return
		}
		*memory = st.Memory
		// 首轮没有增量基线，显示 — 而非 0
		_, seen := s.cpuBaseline[pid]
		s.cpuBaseline[pid] = cpuMark{at: s.opts.Now(), total: st.CPU}
		if seen {
			v := jsRound((st.CPU/float64(cores))*10) / 10
			*cpu = &v
		} else {
			*cpu = nil
		}
	}
	for i := range snap.Listeners {
		apply(snap.Listeners[i].Pid, &snap.Listeners[i].CPU, &snap.Listeners[i].Memory)
	}
	for i := range snap.Watched {
		apply(snap.Watched[i].Pid, &snap.Watched[i].CPU, &snap.Watched[i].Memory)
	}
}

func (s *Service) publish(snap *contract.ScanSnapshot) {
	// 关注进程与监听进程一起取指标：一次批量调用比分两次便宜，且两边都是「当前用户的进程」
	s.attachMetrics(snap)
	s.mu.Lock()
	diff := s.diff(snap)
	s.latest = snap
	s.previous = make(map[int]contract.ListenerSnapshot, len(snap.Listeners))
	s.previousOrder = s.previousOrder[:0:0]
	for _, l := range snap.Listeners {
		s.previous[l.Pid] = l
		s.previousOrder = append(s.previousOrder, l.Pid)
	}
	// 已知原版问题 I7，见 docs/MIGRATION-PLAN.md：只留监听表里的 PID，关注进程的基线每轮都被删，CPU 永远是 —
	for pid := range s.cpuBaseline {
		if _, ok := s.previous[pid]; !ok {
			delete(s.cpuBaseline, pid)
		}
	}
	s.mu.Unlock()
	if s.opts.OnDiff != nil {
		s.opts.OnDiff(diff)
	}
}

func (s *Service) publishFailure() {
	at := s.opts.Now()
	system := s.systemLoad()
	s.mu.Lock()
	diff := contract.ScanDiff{
		At:            at,
		Added:         []contract.ListenerSnapshot{},
		Updated:       []contract.ListenerSnapshot{},
		RemovedPids:   []int{},
		Unmanaged:     []contract.UnmanagedListener{},
		Watched:       []contract.WatchedProcess{},
		System:        system,
		Failed:        true,
		LastSuccessAt: s.lastSuccessAt,
	}
	if s.latest != nil {
		diff.Unmanaged = s.latest.Unmanaged
		diff.Watched = s.latest.Watched
		diff.PortConflicts = s.latest.PortConflicts
	}
	s.mu.Unlock()
	if s.opts.OnDiff != nil {
		s.opts.OnDiff(diff)
	}
}

// diff 只推变化部分，避免每 2 秒重排整表，PRD §3.2。调用方持有 s.mu。
func (s *Service) diff(next *contract.ScanSnapshot) contract.ScanDiff {
	added := []contract.ListenerSnapshot{}
	updated := []contract.ListenerSnapshot{}
	nextPids := map[int]bool{}
	for _, l := range next.Listeners {
		nextPids[l.Pid] = true
		prev, ok := s.previous[l.Pid]
		if !ok {
			added = append(added, l)
		} else if changed(prev, l) {
			updated = append(updated, l)
		}
	}
	removed := []int{}
	for _, pid := range s.previousOrder {
		if !nextPids[pid] {
			removed = append(removed, pid)
		}
	}
	return contract.ScanDiff{
		At:            next.At,
		Added:         added,
		Updated:       updated,
		RemovedPids:   removed,
		Unmanaged:     next.Unmanaged,
		Watched:       next.Watched,
		System:        next.System,
		PortConflicts: next.PortConflicts,
		Failed:        false,
		LastSuccessAt: next.LastSuccessAt,
	}
}

// systemLoad 全机 CPU 取两次 tick 的增量；首轮无基线返回 nil，页面显示 —。
// 原版基线是模块级变量，这里放在实例上（全应用只有一个扫描器，等价）。
func (s *Service) systemLoad() contract.SystemLoad {
	total, free := s.opts.Metrics.Memory()
	idle, ticks := s.opts.Metrics.CPUTicks()
	s.mu.Lock()
	prev := s.prevTicks
	s.prevTicks = &[2]float64{idle, ticks}
	s.mu.Unlock()
	var cpu *float64
	if prev != nil {
		dTotal := ticks - prev[1]
		dIdle := idle - prev[0]
		if dTotal > 0 {
			v := jsRound((1-dIdle/dTotal)*1000) / 10
			cpu = &v
		}
	}
	memory := jsRound(((total-free)/total)*1000) / 10
	// 原版 totalmem 为 0 时得到 NaN，JSON 里是 null；Go 的 json 写不出 NaN，取 0（实际不会发生）
	if math.IsNaN(memory) || math.IsInf(memory, 0) {
		memory = 0
	}
	return contract.SystemLoad{CPU: cpu, Memory: memory}
}

func cloneSnapshot(s contract.ScanSnapshot) contract.ScanSnapshot {
	c := s
	c.Listeners = make([]contract.ListenerSnapshot, len(s.Listeners))
	for i, l := range s.Listeners {
		l.Ports = slices.Clone(l.Ports)
		c.Listeners[i] = l
	}
	c.Unmanaged = slices.Clone(s.Unmanaged)
	c.Watched = slices.Clone(s.Watched)
	return c
}
