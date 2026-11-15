//go:build !windows

// 非 Windows 平台没有 ConPTY；本项目只面向 Windows，这里只为让包在别的平台上能编译。

package sessions

import "errors"

// SpawnConPTY 在非 Windows 平台不可用。
func SpawnConPTY(PTYOptions) (PTYProc, error) {
	return nil, errors.New("sessions: 仅支持 Windows（ConPTY）")
}
