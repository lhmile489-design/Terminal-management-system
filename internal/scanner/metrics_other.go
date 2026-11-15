//go:build !windows

// 非 Windows 平台还没有实现（D5：首版只做 Windows）。返回空读数，界面显示 —。

package scanner

import (
	"context"
	"errors"
)

type noMetrics struct{}

func newWinMetrics() Metrics { return noMetrics{} }

func (noMetrics) Usage(context.Context, []int) (map[int]ProcStat, error) {
	return nil, errors.New("本平台未实现进程指标")
}
func (noMetrics) Cores() int                   { return 1 }
func (noMetrics) CPUTicks() (float64, float64) { return 0, 0 }
func (noMetrics) Memory() (float64, float64)   { return 0, 0 }
