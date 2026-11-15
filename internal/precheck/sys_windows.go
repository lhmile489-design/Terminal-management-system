//go:build windows

// 预检用到的两处 Windows API：磁盘余量（替原版 statfs）与可执行文件的版本资源（替原版 process.versions.node）。
// 都只读，不起进程。

package precheck

import (
	"strconv"
	"syscall"
	"unsafe"
)

var (
	kernel32                = syscall.NewLazyDLL("kernel32.dll")
	procGetDiskFreeSpaceExW = kernel32.NewProc("GetDiskFreeSpaceExW")

	versionDLL                  = syscall.NewLazyDLL("version.dll")
	procGetFileVersionInfoSizeW = versionDLL.NewProc("GetFileVersionInfoSizeW")
	procGetFileVersionInfoW     = versionDLL.NewProc("GetFileVersionInfoW")
	procVerQueryValueW          = versionDLL.NewProc("VerQueryValueW")
)

// diskFreeBytes 即原版 statfs(cwd) 的 bsize * bavail。libuv 在 Windows 上用 GetDiskFreeSpaceW 的
// 簇大小与可用簇数相乘，结果就是调用者可用的字节数（受配额限制），与 GetDiskFreeSpaceExW 的 FreeBytesAvailable 一致。
func diskFreeBytes(cwd string) (uint64, error) {
	p, err := syscall.UTF16PtrFromString(cwd)
	if err != nil {
		return 0, err
	}
	var avail, total, free uint64
	r, _, e := procGetDiskFreeSpaceExW.Call(uintptr(unsafe.Pointer(p)),
		uintptr(unsafe.Pointer(&avail)), uintptr(unsafe.Pointer(&total)), uintptr(unsafe.Pointer(&free)))
	if r == 0 {
		return 0, e
	}
	return avail, nil
}

// vsFixedFileInfo 即 VS_FIXEDFILEINFO 的前四个 DWORD。
type vsFixedFileInfo struct {
	Signature, StrucVersion, FileVersionMS, FileVersionLS uint32
}

// fileVersion 读可执行文件版本资源里的「主.次.修订」（VS_FIXEDFILEINFO 的 FileVersion 前三段）。
// node.exe 的版本资源由 node 构建写入，前三段即 process.versions.node（实测 22.23.4.0 对 v22.23.4）。
func fileVersion(path string) (string, bool) {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return "", false
	}
	size, _, _ := procGetFileVersionInfoSizeW.Call(uintptr(unsafe.Pointer(p)), 0)
	if size == 0 {
		return "", false
	}
	buf := make([]byte, size)
	if r, _, _ := procGetFileVersionInfoW.Call(uintptr(unsafe.Pointer(p)), 0, size, uintptr(unsafe.Pointer(&buf[0]))); r == 0 {
		return "", false
	}
	root, _ := syscall.UTF16PtrFromString(`\`)
	var info *vsFixedFileInfo
	var n uint32
	if r, _, _ := procVerQueryValueW.Call(uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(root)),
		uintptr(unsafe.Pointer(&info)), uintptr(unsafe.Pointer(&n))); r == 0 || info == nil || n < uint32(unsafe.Sizeof(*info)) {
		return "", false
	}
	if info.Signature != 0xFEEF04BD {
		return "", false
	}
	v := strconv.Itoa(int(info.FileVersionMS>>16)) + "." + strconv.Itoa(int(info.FileVersionMS&0xffff)) + "." + strconv.Itoa(int(info.FileVersionLS>>16))
	return v, true
}
