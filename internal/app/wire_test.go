// S24 装配前的接口自查：这些断言保证真实服务满足绑定层的接口，
// 装配 main.go 时不会因为某个方法签名对不上而返工。
// 用 build tag 之外的形式放在测试里，编译失败就是接口漂移。

package app_test

import (
	"context"
	"encoding/json"

	"mile-console/internal/app"
	"mile-console/internal/config"
	"mile-console/internal/detect"
	"mile-console/internal/entries"
	"mile-console/internal/health"
	"mile-console/internal/logs"
	"mile-console/internal/platform/win32"
	"mile-console/internal/precheck"
	"mile-console/internal/scanner"
	"mile-console/internal/sessions"
	"mile-console/internal/transfer"
)

// 平台适配层同时满足三方对 Platform 的要求。
var (
	_ detect.Platform   = (*win32.Win32)(nil)
	_ precheck.Platform = (*win32.Win32)(nil)
	_ entries.Platform  = (*win32.Win32)(nil)
	_ sessions.Platform = (*win32.Win32)(nil)
	_ health.Scanner    = (*scanner.Service)(nil)
	_ transfer.Entries  = (*entries.Service)(nil)
	_ app.Logs          = (*logs.Service)(nil)
)

// 配置存储满足三方对 Store 的要求。
var (
	_ health.Source       = (*entries.Service)(nil)
	_ app.SettingsStore   = (*config.Store)(nil)
	_ transfer.Config     = (*config.Store)(nil)
	_ scanner.ConfigStore = (*config.Store)(nil)
)

var _ = json.RawMessage(nil)
var _ = context.Background
