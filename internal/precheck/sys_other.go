//go:build !windows

// 非 Windows 平台首版不做（D5）：两处平台 API 都报取不到，预检按原版的「无法读取，跳过」/ 版本未知处理。

package precheck

import "errors"

func diskFreeBytes(string) (uint64, error) { return 0, errors.New("unsupported platform") }

func fileVersion(string) (string, bool) { return "", false }
