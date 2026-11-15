// S19 接线断言：日志中心只依赖会话服务的 List / OnData / OnExit，
// 这里钉住接口形状，会话侧改动方法签名时立刻编译失败，而不是等到装配那天。

package logs_test

import (
	"mile-console/internal/logs"
	"mile-console/internal/sessions"
)

var _ logs.Sessions = (*sessions.Service)(nil)
