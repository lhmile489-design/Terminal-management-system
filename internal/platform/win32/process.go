//go:build windows

// 对应 src/main/platform/win32/process.ts。

package win32

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"

	"mile-console/internal/platform"
)

const (
	// readListenPortsTimeout 即原版 readListenPorts 的默认 timeoutMs。
	readListenPortsTimeout = 4000 * time.Millisecond
	// readListenPortsMaxBuffer 即原版的 maxBuffer: 16 * 1024 * 1024。
	readListenPortsMaxBuffer = 16 * 1024 * 1024
	// readProcessMetaTimeout 即原版 readProcessMeta 的默认 timeoutMs（15_000）。
	readProcessMetaTimeout = 15000 * time.Millisecond
)

// ReadListenPorts 快层：netstat 取监听端口，实测 ~55ms。
//
// 不用 Get-NetTCPConnection —— 那是 CIM 查询，单次 2.8s，放不进 2 秒采集周期。
//
// 不加 `-p TCP`：那只出 IPv4。Vite 8 等默认绑 `[::1]`，只查 IPv4 会整个漏掉
// （实测 :5174 在 `-p TCP` 下不可见，在 `-p TCPv6` 下才有）。不带 -p 一次覆盖
// 两个协议族，耗时相同，UDP 行没有 LISTENING 状态会被 parseNetstat 过掉。
//
// 已知原版问题 I3，见 docs/MIGRATION-PLAN.md：netstat 输出按控制台代码页编码，原版按 UTF-8 解码。
// 这里只影响中文表头（被 LISTENING 过滤掉），解析结果不受影响；照原样搬。
func (w *Win32) ReadListenPorts(ctx context.Context) ([]platform.ListenRow, error) {
	ctx, cancel := context.WithTimeout(ctx, readListenPortsTimeout)
	defer cancel()
	stdout, _, err := w.sys.run(ctx, "netstat.exe", []string{"-ano"}, readListenPortsMaxBuffer)
	if err != nil {
		return nil, err
	}
	return parseNetstat(jsDecodeUTF8(stdout)), nil
}

// parseNetstat 逐行对应原版同名函数。
func parseNetstat(stdout string) []platform.ListenRow {
	rows := []platform.ListenRow{}
	seen := map[string]int{} // key -> rows 下标

	for _, line := range jsSplitLines(stdout) {
		// 原版 /LISTENING/i：非 unicode 模式只折叠 ASCII
		if !jsContainsFold(line, "LISTENING") {
			continue
		}
		f := jsSplitFields(line)
		if len(f) < 4 {
			continue
		}

		local := f[1]
		port := jsToNumber(local[strings.LastIndex(local, ":")+1:])
		pid := jsToNumber(f[len(f)-1])
		if !jsIsInteger(port) || port < 1 || !jsIsInteger(pid) || pid <= 4 {
			continue
		}
		// netstat 的 IPv6 本地地址一律带方括号：[::]:3000、[::1]:5174
		family := 4
		if strings.HasPrefix(local, "[") {
			family = 6
		}

		// IPv4 与 IPv6 会各出一行同 (pid, port)：合并成一行，只记下两族都在
		key := jsNumberKey(pid) + ":" + jsNumberKey(port)
		if i, ok := seen[key]; ok {
			if !slices.Contains(rows[i].Families, family) {
				rows[i].Families = append(rows[i].Families, family)
			}
			continue
		}
		seen[key] = len(rows)
		rows = append(rows, platform.ListenRow{Port: toInt(port), Pid: toInt(pid), Families: []int{family}})
	}
	return rows
}

// jsNumberKey 即模板字符串里 `${n}` 对整数值 Number 的格式化。超过 1e21 的整数 JS 会写成指数形式，
// 这里用 'g' 格式的同一分界保持键的区分方式一致（两个不同的 Number 得到不同的键）。
func jsNumberKey(f float64) string {
	if math.Abs(f) < 1e21 {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	return strconv.FormatFloat(f, 'g', -1, 64)
}

// toInt 把已确认是整数的 Number 转成 int。超出 int 范围的值（原版照收，下游按 Number 比较）在 64 位上
// 不会出现：netstat 的端口与 PID 都远小于 2^53；合成输入里超过 2^63 的值钳到边界，并在测试里单独登记。
func toInt(f float64) int {
	switch {
	case f >= math.MaxInt64:
		return math.MaxInt64
	case f <= math.MinInt64:
		return math.MinInt64
	}
	return int(f)
}

// metaScript 慢层：进程元数据（命令行、启动时间、父子关系）与当前用户 PID 集合，实测 ~3.5s。
//
// 归属用 Win32_LogonSession → Win32_SessionProcess 批量关联，而不是对每个 PID 调
// Invoke-CimMethod GetOwnerSid —— 后者每 PID 约 800ms，30 个监听进程就 26s，
// 根本放不进采集周期。批量关联一次拿到当前用户登录会话下的全部 PID，效果等价。
//
// 原文逐字照搬原版 META_SCRIPT（String.raw 模板，含首尾换行）；win32_test 与原版逐字比对。
const metaScript = `
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value

$mineLogon = New-Object System.Collections.Generic.HashSet[string]
foreach ($s in @(Get-CimInstance Win32_LogonSession)) {
  try {
    foreach ($a in @(Get-CimAssociatedInstance -InputObject $s -ResultClassName Win32_Account)) {
      if ($a.SID -eq $me) { [void]$mineLogon.Add([string]$s.LogonId) }
    }
  } catch { }
}

$minePid = New-Object System.Collections.Generic.HashSet[int]
foreach ($sp in @(Get-CimInstance Win32_SessionProcess)) {
  if ($mineLogon.Contains([string]$sp.Antecedent.LogonId)) {
    [void]$minePid.Add([int]$sp.Dependent.Handle)
  }
}

$procs = @(Get-CimInstance -Query "SELECT ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate FROM Win32_Process" |
  ForEach-Object {
    [pscustomobject]@{
      pid  = [int]$_.ProcessId
      ppid = [int]$_.ParentProcessId
      name = $_.Name
      exe  = $_.ExecutablePath
      cmd  = $_.CommandLine
      at   = if ($_.CreationDate) { [long]([datetimeoffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { $null }
    }
  })

[pscustomobject]@{ procs = $procs; mine = @($minePid) } | ConvertTo-Json -Compress -Depth 4
`

// rawRow 即原版 RawRow。exe / cmd / at 缺省与 null 都解成 nil（原版 `?? undefined`）。
type rawRow struct {
	Pid  int     `json:"pid"`
	Ppid int     `json:"ppid"`
	Name string  `json:"name"`
	Exe  *string `json:"exe"`
	Cmd  *string `json:"cmd"`
	At   *int64  `json:"at"`
}

// rawMeta 即原版 RawMeta：procs / mine 可能是数组、单个对象或 null（ConvertTo-Json 单元素时不包数组）。
type rawMeta struct {
	Procs json.RawMessage `json:"procs"`
	Mine  json.RawMessage `json:"mine"`
}

// toArray 即原版 toArray：null / 缺省为空，单个值包成一个元素的数组。
func toArray[T any](raw json.RawMessage) ([]T, error) {
	t := strings.TrimSpace(string(raw))
	if t == "" || t == "null" {
		return nil, nil
	}
	if strings.HasPrefix(t, "[") {
		var xs []T
		err := json.Unmarshal(raw, &xs)
		return xs, err
	}
	var x T
	if err := json.Unmarshal(raw, &x); err != nil {
		return nil, err
	}
	return []T{x}, nil
}

// errNoMetaOutput 文案照搬原版。
var errNoMetaOutput = errors.New("进程元数据采集无输出")

// ReadProcessMeta 即原版 readProcessMeta。
//
// 与原版的差异：原版 JSON.parse 不校验字段类型（pid 是字符串也照收），这里按声明类型解码，类型不符时报错。
// META_SCRIPT 输出的字段类型是固定的（[int] / [long] 强转），实际不会触发。
func (w *Win32) ReadProcessMeta(ctx context.Context) (platform.ProcessMeta, error) {
	out, err := w.runPowerShell(ctx, metaScript, readProcessMetaTimeout)
	if err != nil {
		return platform.ProcessMeta{}, err
	}
	return parseProcessMeta(out, w.sys.now())
}

func parseProcessMeta(out string, now int64) (platform.ProcessMeta, error) {
	raw := jsTrim(out)
	if raw == "" {
		return platform.ProcessMeta{}, errNoMetaOutput
	}
	// 顶层按 JSON.parse 之后读属性的语义：null 读 .procs 抛 TypeError；标量与数组读出 undefined，等于空表
	if !json.Valid([]byte(raw)) {
		var probe any
		return platform.ProcessMeta{}, json.Unmarshal([]byte(raw), &probe)
	}
	switch raw[0] {
	case 'n':
		return platform.ProcessMeta{}, errors.New("Cannot read properties of null (reading 'procs')")
	case '{':
	default:
		return platform.ProcessMeta{ByPid: map[int]platform.ProcessRow{}, Mine: map[int]struct{}{}, At: now}, nil
	}
	var payload rawMeta
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return platform.ProcessMeta{}, err
	}
	procs, err := toArray[rawRow](payload.Procs)
	if err != nil {
		return platform.ProcessMeta{}, err
	}
	mine, err := toArray[int](payload.Mine)
	if err != nil {
		return platform.ProcessMeta{}, err
	}

	byPid := make(map[int]platform.ProcessRow, len(procs))
	for _, r := range procs {
		byPid[r.Pid] = platform.ProcessRow{
			Pid:         r.Pid,
			Ppid:        r.Ppid,
			Name:        r.Name,
			ExecPath:    r.Exe,
			CommandLine: r.Cmd,
			StartedAt:   r.At,
		}
	}
	mineSet := make(map[int]struct{}, len(mine))
	for _, p := range mine {
		mineSet[p] = struct{}{}
	}
	return platform.ProcessMeta{ByPid: byPid, Mine: mineSet, At: now}, nil
}
