// 对应 src/main/lib/windowState.ts：窗口状态读写、坐标合法性、漂移容差。
//
// 窗口位置、大小、最大化状态的记忆。放在 appData/mile-console/window-state.json，
// 与 config.json 分开：它是纯展示偏好，写坏了不该牵连条目配置，也不进 .bak 轮转。
//
// 与原版差异（已接受偏差）：
//   - mygo 不持有 BrowserWindow 句柄，resize/move/close 防抖与「关闭时同步落盘」由调用方
//     （应用启动 / 窗口钩子，见迁移计划 S32）触发；本包只提供 LoadWindowState /
//     SaveWindowState 纯函数。
//   - 屏幕工作区不做 Electron 的 screen.getAllDisplays() 隐式调用，由调用方传入
//     []DisplayRect（在 S32 里来自 mygo.Screen.Displays() 的 workArea）。

package window

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
)

const (
	// MinWidth / MinHeight 窗口最小尺寸，原版 MIN_WIDTH / MIN_HEIGHT。
	MinWidth  = 1180
	MinHeight = 760

	// DefaultWidth / DefaultHeight 首次启动、文件损坏或坐标出屏时的回退尺寸。
	DefaultWidth  = 1440
	DefaultHeight = 900

	// MinVisible 窗口与某块屏幕的工作区至少重叠这么多才算「看得见」，
	// 拔掉副屏后留下的坐标会被丢弃。
	MinVisible = 100

	// DriftTolerance 缩放不是 100% 时（如 175%），DIP 与物理像素互相换算有舍入，
	// 同一个窗口每开关一次读回的尺寸会多出 2~5 像素，反复启动会越开越大。
	// 实际值与上次保存值只差几个像素时当作没变，沿用上次的值。
	DriftTolerance = 8

	// StateFileName 数据目录里的状态文件名（与 config.json 同级）。
	StateFileName = "window-state.json"
)

// WindowState 即原版 WindowState。X/Y 用 *int 以区分「未存过」与「存了 0」，
// 与原版 x?: number 语义对齐（undefined 序列化后键会消失，落盘 JSON 里没有 x/y 键时
// 反序列化回 nil）。
type WindowState struct {
	X         *int `json:"x,omitempty"`
	Y         *int `json:"y,omitempty"`
	Width     int  `json:"width"`
	Height    int  `json:"height"`
	Maximized bool `json:"maximized"`
}

// DisplayRect 即原版 Display.workArea：屏幕工作区在桌面坐标系里的矩形（不含任务栏）。
// 与 screen.getAllDisplays()[i].workArea 同形。
type DisplayRect struct {
	X      int `json:"x"`
	Y      int `json:"y"`
	Width  int `json:"width"`
	Height int `json:"height"`
}

// defaultState 即原版 DEFAULT_STATE。x/y 不带 = 交给系统居中。
func defaultState() WindowState {
	return WindowState{Width: DefaultWidth, Height: DefaultHeight, Maximized: false}
}

// stateFile 即原版 stateFile()：dir 即数据目录（%APPDATA%\mile-console\），由调用方给。
func stateFile(dir string) string {
	return filepath.Join(dir, StateFileName)
}

// visibleOnSomeDisplay 即原版 visibleOnSomeDisplay：与任意一块屏幕的工作区在 X/Y 两个
// 方向上都至少重叠 MinVisible 像素才算可见；不在任何屏上（拔掉副屏）的坐标会被丢弃。
func visibleOnSomeDisplay(x, y, w, h int, displays []DisplayRect) bool {
	for _, d := range displays {
		ox := min(x+w, d.X+d.Width) - max(x, d.X)
		oy := min(y+h, d.Y+d.Height) - max(y, d.Y)
		if ox >= MinVisible && oy >= MinVisible {
			return true
		}
	}
	return false
}

// near 即原版 near(a, b)：两个值相差 ≤ DriftTolerance 视为「没变」。
func near(a, b int) bool {
	d := a - b
	if d < 0 {
		d = -d
	}
	return d <= DriftTolerance
}

// LoadWindowState 即原版 loadWindowState()：读上次保存的窗口状态。
//   - 文件缺失、读取失败、JSON 不合法、顶层不是对象 → 返回默认值，无错误。
//   - 字段缺失 / 类型不对 → 该字段回退到默认（宽 / 高不足最小值时抬到最小值）。
//   - x/y 存在但不在任何一块屏幕的工作区上 → 丢弃 x/y（保留 width/height/maximized），
//     交给系统居中。
//
// 返回 error 永远为 nil：原版用 try/catch 包住整段 IO，本函数保持同语义——任何文件
// 问题都映射到默认值。签名留 error 是为了与未来需要硬错误（如目录权限探测）的扩展对齐。
func LoadWindowState(dir string, displays []DisplayRect) (WindowState, error) {
	b, err := os.ReadFile(stateFile(dir))
	if err != nil {
		return defaultState(), nil
	}

	// 顶层必须是一个对象；JSON.parse 不认 BOM，encoding/json 同样拒绝。
	var raw map[string]any
	if err := json.Unmarshal(b, &raw); err != nil || raw == nil {
		return defaultState(), nil
	}

	width := DefaultWidth
	if w, ok := finite(raw["width"]); ok {
		if v := int(math.Round(w)); v > MinWidth {
			width = v
		} else {
			width = MinWidth
		}
	}
	height := DefaultHeight
	if h, ok := finite(raw["height"]); ok {
		if v := int(math.Round(h)); v > MinHeight {
			height = v
		} else {
			height = MinHeight
		}
	}

	st := WindowState{
		Width:     width,
		Height:    height,
		Maximized: raw["maximized"] == true,
	}

	if fx, okX := finite(raw["x"]); okX {
		if fy, okY := finite(raw["y"]); okY {
			if visibleOnSomeDisplay(int(math.Round(fx)), int(math.Round(fy)), width, height, displays) {
				x := int(math.Round(fx))
				y := int(math.Round(fy))
				st.X = &x
				st.Y = &y
			}
		}
	}
	return st, nil
}

// finite 即原版 finite(n)：JSON 反序列化只把对象值放进 any 时是 float64；
// NaN / ±Inf 不会从 encoding/json 里出现（语法上非法），但显式拒绝以贴原语义。
func finite(v any) (float64, bool) {
	f, ok := v.(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, false
	}
	return f, true
}

// SaveWindowState 即原版 save() 的纯逻辑：把候选状态与上次保存值比对、应用漂移容差，
// 决定要不要落盘，落盘走临时文件 + rename 的原子写。
//
//   - prev：上一次已成功写入的状态（原版模块级 lastSaved）。第一次启动由调用方
//     先调 LoadWindowState 作为 prev。
//   - next：本次拿到的窗口最新状态（原版 win.getNormalBounds() + isMaximized()）。
//
// 行为对齐原版：
//   - next.Width/Height 与 prev 相差 ≤ DriftTolerance → 沿用 prev 的宽高。
//   - next.X/Y 与 prev 相差 ≤ DriftTolerance → 沿用 prev 的 X/Y（要求 prev.X/Y 非 nil）。
//   - 应用容差后的 state 与 prev 完全一致 → 不落盘，返回 (false, nil)。
//     原版每次 resize/move/close 都会写一遍文件，不做整体短路；这里加了「写完和上次
//     一样就跳过」的微优化，行为对外不可见（文件内容一致、调用方拿到的还是 prev）。
//   - 写文件走 `<file>.<pid>.tmp` + os.Rename；目录缺失时 MkdirAll(dir, 0o755)。
//
// 返回值：bool 表示「真的写盘了」；error 来自 IO（MkdirAll / WriteFile / Rename），
// 与原版 try/catch 静默吞错不同——本包把错误交回给调用方，由调用方决定是日志还是吞掉。
// 这与原版「记不住窗口位置不值得打断使用」一致：调用方拿到 error 一般只 log，不上抛。
func SaveWindowState(dir string, prev, next WindowState) (bool, error) {
	// 应用漂移容差。prev.X/Y 为 nil 时跳过位置容差（原版要求 lastSaved.x/y 都 defined）。
	if near(next.Width, prev.Width) && near(next.Height, prev.Height) {
		next.Width = prev.Width
		next.Height = prev.Height
	}
	if prev.X != nil && prev.Y != nil && next.X != nil && next.Y != nil &&
		near(*next.X, *prev.X) && near(*next.Y, *prev.Y) {
		x := *prev.X
		y := *prev.Y
		next.X = &x
		next.Y = &y
	}

	// 与上次一致就不动盘。注意 prev 的 X/Y 是 *int，不能 == 比指针，按值比。
	if stateEqual(prev, next) {
		return false, nil
	}

	if err := os.MkdirAll(dir, 0o755); err != nil {
		return false, err
	}
	b, err := marshalState(next)
	if err != nil {
		return false, err
	}
	file := stateFile(dir)
	tmp := fmt.Sprintf("%s.%d.tmp", file, os.Getpid())
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return false, err
	}
	if err := os.Rename(tmp, file); err != nil {
		return false, err
	}
	return true, nil
}

// stateEqual 按字段值比较两个 WindowState。X/Y 用 *int：两边都 nil 视为相等，都非 nil
// 比对指向的值。
func stateEqual(a, b WindowState) bool {
	if a.Width != b.Width || a.Height != b.Height || a.Maximized != b.Maximized {
		return false
	}
	if (a.X == nil) != (b.X == nil) {
		return false
	}
	if a.X != nil && *a.X != *b.X {
		return false
	}
	if (a.Y == nil) != (b.Y == nil) {
		return false
	}
	if a.Y != nil && *a.Y != *b.Y {
		return false
	}
	return true
}

// marshalState 即原版 JSON.stringify(state)：紧凑 JSON、UTF-8 无 BOM、不转义 < > &。
// 原版写文件不带缩进，所以这里不 SetIndent。
func marshalState(s WindowState) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(s); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

// min / max 直接用 Go 1.21+ 的内置泛型；不重复造。
