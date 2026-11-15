//go:build windows

// pidusage 与 os.cpus / totalmem / freemem 在 Windows 上的替身。
//
// 原版 pidusage 4.0.1 在 Windows 上实际总是走 gwmi：它探测 wmic 用的是 `spawn('wmic', callback)`，
// 第二个参数不是数组，node 同步抛 ERR_INVALID_ARG_TYPE，于是每轮采集都起一个 PowerShell 跑
// Get-WmiObject Win32_Process。这里直接调 Windows API，不起子进程：
//   - 进程：OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION) + GetProcessTimes + K32GetProcessMemoryInfo
//   - 全机 CPU：GetSystemTimes；内存：GlobalMemoryStatusEx；核数：GetSystemInfo.dwNumberOfProcessors
// 算法与 pidusage 相同（相对上次采样的单核百分比，首次采样为 0，60 秒没再问到的 PID 忘掉），
// 精度不同：pidusage 用整秒的 os.uptime() 当分母，这里用毫秒级墙钟。见 docs/MIGRATION-PLAN.md §6。

package scanner

import (
	"context"
	"errors"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

var (
	kernel32                = syscall.NewLazyDLL("kernel32.dll")
	procGetSystemTimes      = kernel32.NewProc("GetSystemTimes")
	procGlobalMemoryStatus  = kernel32.NewProc("GlobalMemoryStatusEx")
	procGetSystemInfo       = kernel32.NewProc("GetSystemInfo")
	procGetProcessMemoryInf = kernel32.NewProc("K32GetProcessMemoryInfo")
)

const processQueryLimitedInformation = 0x1000

// pidusageMaxAge 即 pidusage history 的 DEFAULT_MAXAGE。
const pidusageMaxAge = 60_000

type usageMark struct {
	cpu100ns uint64 // kernel + user，100ns
	wall     int64  // ms
	created  uint64 // 创建时间，PID 复用时丢掉旧基线
	seen     int64
}

type winMetrics struct {
	mu      sync.Mutex
	history map[int]usageMark
	now     func() int64
}

func newWinMetrics() Metrics {
	return &winMetrics{history: map[int]usageMark{}, now: func() int64 { return time.Now().UnixMilli() }}
}

func ft(f syscall.Filetime) uint64 { return uint64(f.HighDateTime)<<32 | uint64(f.LowDateTime) }

func (m *winMetrics) Usage(ctx context.Context, pids []int) (map[int]ProcStat, error) {
	out := map[int]ProcStat{}
	now := m.now()
	m.mu.Lock()
	defer m.mu.Unlock()
	for pid, h := range m.history {
		if now-h.seen > pidusageMaxAge {
			delete(m.history, pid)
		}
	}
	for _, pid := range pids {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if _, done := out[pid]; done {
			continue // 同一 PID 在监听与关注里各出现一次时只采一次（pidusage 结果按 pid 去重）
		}
		created, cpu, mem, ok := readProcess(pid)
		if !ok {
			continue
		}
		h, had := m.history[pid]
		pct := 0.0
		if had && h.created == created {
			if dt := now - h.wall; dt > 0 {
				pct = float64(cpu-h.cpu100ns) / 10_000 / float64(dt) * 100
			}
		}
		m.history[pid] = usageMark{cpu100ns: cpu, wall: now, created: created, seen: now}
		out[pid] = ProcStat{CPU: pct, Memory: mem}
	}
	if len(out) == 0 {
		return nil, errors.New("No matching pid found") // 与 pidusage 的报错文案一致
	}
	return out, nil
}

func readProcess(pid int) (created, cpu uint64, mem int64, ok bool) {
	if pid <= 0 {
		return 0, 0, 0, false
	}
	h, err := syscall.OpenProcess(processQueryLimitedInformation, false, uint32(pid))
	if err != nil {
		return 0, 0, 0, false
	}
	defer syscall.CloseHandle(h)
	var c, e, k, u syscall.Filetime
	if err := syscall.GetProcessTimes(h, &c, &e, &k, &u); err != nil {
		return 0, 0, 0, false
	}
	// PROCESS_MEMORY_COUNTERS：cb、PageFaultCount、PeakWorkingSetSize、WorkingSetSize ……
	var pmc struct {
		Cb                         uint32
		PageFaultCount             uint32
		PeakWorkingSetSize         uintptr
		WorkingSetSize             uintptr
		QuotaPeakPagedPoolUsage    uintptr
		QuotaPagedPoolUsage        uintptr
		QuotaPeakNonPagedPoolUsage uintptr
		QuotaNonPagedPoolUsage     uintptr
		PagefileUsage              uintptr
		PeakPagefileUsage          uintptr
	}
	pmc.Cb = uint32(unsafe.Sizeof(pmc))
	if r, _, _ := procGetProcessMemoryInf.Call(uintptr(h), uintptr(unsafe.Pointer(&pmc)), uintptr(pmc.Cb)); r == 0 {
		return 0, 0, 0, false
	}
	return ft(c), ft(k) + ft(u), int64(pmc.WorkingSetSize), true
}

func (m *winMetrics) Cores() int {
	var si struct {
		ProcessorArchitecture     uint16
		Reserved                  uint16
		PageSize                  uint32
		MinimumApplicationAddress uintptr
		MaximumApplicationAddress uintptr
		ActiveProcessorMask       uintptr
		NumberOfProcessors        uint32
		ProcessorType             uint32
		AllocationGranularity     uint32
		ProcessorLevel            uint16
		ProcessorRevision         uint16
	}
	procGetSystemInfo.Call(uintptr(unsafe.Pointer(&si)))
	return int(si.NumberOfProcessors)
}

// CPUTicks 毫秒。GetSystemTimes 的 kernel 含 idle：total = user + kernel = user + sys + idle。
// 原版 os.cpus() 另加 irq（libuv 取 InterruptTime，它本已含在 kernel 里），这里不重复加。
func (m *winMetrics) CPUTicks() (idle, total float64) {
	var i, k, u syscall.Filetime
	if r, _, _ := procGetSystemTimes.Call(uintptr(unsafe.Pointer(&i)), uintptr(unsafe.Pointer(&k)), uintptr(unsafe.Pointer(&u))); r == 0 {
		return 0, 0
	}
	return float64(ft(i)) / 10_000, float64(ft(k)+ft(u)) / 10_000
}

func (m *winMetrics) Memory() (total, free float64) {
	var ms struct {
		Length               uint32
		MemoryLoad           uint32
		TotalPhys            uint64
		AvailPhys            uint64
		TotalPageFile        uint64
		AvailPageFile        uint64
		TotalVirtual         uint64
		AvailVirtual         uint64
		AvailExtendedVirtual uint64
	}
	ms.Length = uint32(unsafe.Sizeof(ms))
	if r, _, _ := procGlobalMemoryStatus.Call(uintptr(unsafe.Pointer(&ms))); r == 0 {
		return 0, 0
	}
	return float64(ms.TotalPhys), float64(ms.AvailPhys)
}
