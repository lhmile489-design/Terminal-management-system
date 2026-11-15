//go:build windows

// winMetrics 真机冒烟：只读本测试进程自己（OpenProcess 用 PROCESS_QUERY_LIMITED_INFORMATION，不碰别的进程）。
// 断言口径与 pidusage 对上：首次采样 CPU 为 0、之后为相对上次的单核百分比、取不到的 PID 不出现、全取不到报错。

package scanner

import (
	"os"
	"testing"
	"time"
)

func TestWinMetricsSelf(t *testing.T) {
	m := newWinMetrics().(*winMetrics)
	self := os.Getpid()

	first, err := m.Usage(t.Context(), []int{self, self})
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 1 || first[self].CPU != 0 || first[self].Memory <= 0 {
		t.Fatalf("首次采样应为 CPU 0、内存为正：%+v", first)
	}

	// 忙等 200ms 烧点 CPU，第二次采样应大于 0、不超过 100 * 核数
	deadline := time.Now().Add(200 * time.Millisecond)
	x := 0
	for time.Now().Before(deadline) {
		x++
	}
	_ = x
	second, err := m.Usage(t.Context(), []int{self})
	if err != nil {
		t.Fatal(err)
	}
	cores := m.Cores()
	if cpu := second[self].CPU; cpu <= 0 || cpu > float64(100*cores)+1 {
		t.Errorf("第二次采样 CPU 应在 (0, %d]：%v", 100*cores, cpu)
	}

	// 取不到的 PID 不出现；全取不到报 pidusage 同款错误
	mixed, err := m.Usage(t.Context(), []int{self, 0, -1})
	if err != nil || len(mixed) != 1 {
		t.Errorf("取不到的 PID 应跳过：%+v %v", mixed, err)
	}
	if _, err := m.Usage(t.Context(), []int{0, -1}); err == nil || err.Error() != "No matching pid found" {
		t.Errorf("全取不到应报 No matching pid found：%v", err)
	}

	// 60 秒没再问到的 PID 忘掉基线
	m.now = func() int64 { return time.Now().UnixMilli() + pidusageMaxAge + 1000 }
	again, _ := m.Usage(t.Context(), []int{self})
	if again[self].CPU != 0 {
		t.Errorf("过期后应重新从 0 开始：%v", again[self].CPU)
	}
}

func TestWinMetricsSystem(t *testing.T) {
	m := newWinMetrics()
	if c := m.Cores(); c < 1 {
		t.Errorf("核数：%d", c)
	}
	idle, total := m.CPUTicks()
	if idle <= 0 || total <= idle {
		t.Errorf("CPU 计时：idle %v total %v", idle, total)
	}
	tot, free := m.Memory()
	if tot <= 0 || free <= 0 || free > tot {
		t.Errorf("内存：total %v free %v", tot, free)
	}
}

func TestSelfPidDefaultsToProcess(t *testing.T) {
	s := New(t.Context(), newWorld(0), nil, &memConfig{}, Options{Metrics: newWorld(0)})
	if s.opts.SelfPid != os.Getpid() {
		t.Errorf("SelfPid 零值应默认为本进程：%d", s.opts.SelfPid)
	}
}
