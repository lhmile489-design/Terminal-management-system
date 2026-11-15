// 对应 src/main/lib/windowState.ts 的行为测试。原版没有单测，这里按
// docs/MIGRATION-PLAN.md S10 的验收表逐条覆盖：出屏坐标、最小尺寸、漂移容差、
// 坏文件回退、缺文件回退、写入路径与字段。
//
// 全程 t.TempDir()，不摸真实 %APPDATA%。

package window

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
)

// displays 常用的一块屏幕：1920×1080，工作区 = 整屏（不含任务栏时）。
var oneDisplay = []DisplayRect{{X: 0, Y: 0, Width: 1920, Height: 1080}}

// 双屏：主屏 0,0 1920×1080；副屏在右侧 1920,0 1920×1080。
var twoDisplays = []DisplayRect{
	{X: 0, Y: 0, Width: 1920, Height: 1080},
	{X: 1920, Y: 0, Width: 1920, Height: 1080},
}

// writeState 把一份 JSON 直接落进 dir 下，模拟「上次启动写过的状态文件」。
func writeState(t *testing.T, dir string, body string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("MkdirAll 失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, StateFileName), []byte(body), 0o644); err != nil {
		t.Fatalf("写入状态文件失败: %v", err)
	}
}

// TestLoadCoordsOutsideAllDisplays：坐标不在任何屏幕工作区时丢弃 x/y，
// width/height/maximized 仍按文件里的值取。对应原版「拔掉副屏后留下的坐标会被丢弃」。
func TestLoadCoordsOutsideAllDisplays(t *testing.T) {
	dir := t.TempDir()
	// 屏幕只剩 0..1920 × 0..1080；存的坐标 -5000,-5000 完全不在任何屏上
	writeState(t, dir, `{"x":-5000,"y":-5000,"width":1600,"height":950,"maximized":true}`)

	st, err := LoadWindowState(dir, oneDisplay)
	if err != nil {
		t.Fatalf("LoadWindowState 不应报错, got %v", err)
	}
	if st.X != nil || st.Y != nil {
		t.Fatalf("出屏坐标应被丢弃（X/Y 为 nil）, got X=%v Y=%v", st.X, st.Y)
	}
	if st.Width != 1600 || st.Height != 950 {
		t.Fatalf("宽高应按文件值, got %dx%d", st.Width, st.Height)
	}
	if !st.Maximized {
		t.Fatalf("maximized=true 应保留")
	}
}

// TestLoadCoordsOnSecondDisplay：双屏场景下，坐标落在副屏上必须被认作可见，
// 不能因为「不在主屏」被误丢。
func TestLoadCoordsOnSecondDisplay(t *testing.T) {
	dir := t.TempDir()
	writeState(t, dir, `{"x":2200,"y":300,"width":1400,"height":900,"maximized":false}`)

	st, err := LoadWindowState(dir, twoDisplays)
	if err != nil {
		t.Fatalf("LoadWindowState 不应报错, got %v", err)
	}
	if st.X == nil || st.Y == nil {
		t.Fatalf("坐标在副屏上应保留")
	}
	if *st.X != 2200 || *st.Y != 300 {
		t.Fatalf("读回的坐标应为 2200,300, got %d,%d", *st.X, *st.Y)
	}
}

// TestLoadBelowMinSizeRaised：宽高小于 MIN 时被抬到最小值（原版 Math.max(MIN, round(v))）。
func TestLoadBelowMinSizeRaised(t *testing.T) {
	dir := t.TempDir()
	writeState(t, dir, `{"width":300,"height":100,"maximized":false}`)

	st, err := LoadWindowState(dir, oneDisplay)
	if err != nil {
		t.Fatalf("LoadWindowState 不应报错, got %v", err)
	}
	if st.Width != MinWidth {
		t.Fatalf("width 应抬到 %d, got %d", MinWidth, st.Width)
	}
	if st.Height != MinHeight {
		t.Fatalf("height 应抬到 %d, got %d", MinHeight, st.Height)
	}
}

// TestSaveDriftWithinToleranceSkipsWrite：本次值与上次相差 ≤ DriftTolerance 时
// 沿用 prev、不写盘（返回 false）。
func TestSaveDriftWithinToleranceSkipsWrite(t *testing.T) {
	dir := t.TempDir()
	px, py := 100, 200
	prev := WindowState{X: &px, Y: &py, Width: 1440, Height: 900, Maximized: false}

	// 各方向都偏 8 像素（= DriftTolerance），按 near() 的「≤」语义属于没变。
	nx, ny := 108, 208
	next := WindowState{X: &nx, Y: &ny, Width: 1448, Height: 908, Maximized: false}

	saved, err := SaveWindowState(dir, prev, next)
	if err != nil {
		t.Fatalf("SaveWindowState 不应报错, got %v", err)
	}
	if saved {
		t.Fatalf("漂移 ≤ %d 时不应写盘", DriftTolerance)
	}
	// 文件不应被创建（连 dir 都可以没建出来）。
	if _, err := os.Stat(filepath.Join(dir, StateFileName)); !os.IsNotExist(err) {
		t.Fatalf("文件不应存在, stat err=%v", err)
	}
}

// TestSaveDriftExceedsToleranceWrites：差值 > DriftTolerance 视为真调整，写盘并返回 true。
func TestSaveDriftExceedsToleranceWrites(t *testing.T) {
	dir := t.TempDir()
	px, py := 100, 200
	prev := WindowState{X: &px, Y: &py, Width: 1440, Height: 900, Maximized: false}

	// 宽/高都偏 9，超过容差。
	nx, ny := 109, 209
	next := WindowState{X: &nx, Y: &ny, Width: 1449, Height: 909, Maximized: false}

	saved, err := SaveWindowState(dir, prev, next)
	if err != nil {
		t.Fatalf("SaveWindowState 不应报错, got %v", err)
	}
	if !saved {
		t.Fatalf("漂移 > %d 时应写盘", DriftTolerance)
	}
	// 写出的文件能被 LoadWindowState 读回，且 X/Y 是 new（不是 prev）。
	got, err := LoadWindowState(dir, oneDisplay)
	if err != nil {
		t.Fatalf("写完后 LoadWindowState 不应报错, got %v", err)
	}
	if got.Width != 1449 || got.Height != 909 {
		t.Fatalf("落盘宽高应为新值 1449×909, got %d×%d", got.Width, got.Height)
	}
	if got.X == nil || got.Y == nil || *got.X != 109 || *got.Y != 209 {
		t.Fatalf("落盘坐标应为新值 (109,209), got %v,%v", got.X, got.Y)
	}
}

// TestSaveDriftInSizeOnlyKeepsPosition：宽高变化超过容差触发写盘；但 X/Y 仍在容差内时
// 沿用 prev 的坐标，不写成本次的实测值（这是容差的另一半职责，原版同此）。
func TestSaveDriftInSizeOnlyKeepsPosition(t *testing.T) {
	dir := t.TempDir()
	px, py := 100, 200
	prev := WindowState{X: &px, Y: &py, Width: 1440, Height: 900, Maximized: false}

	// 坐标差 5 ≤ 8（沿用 prev），但宽差 20 > 8 → 应写盘且坐标写 prev 的。
	nx, ny := 105, 205
	next := WindowState{X: &nx, Y: &ny, Width: 1460, Height: 900, Maximized: false}

	saved, err := SaveWindowState(dir, prev, next)
	if err != nil || !saved {
		t.Fatalf("应写盘, saved=%v err=%v", saved, err)
	}
	got, err := LoadWindowState(dir, oneDisplay)
	if err != nil {
		t.Fatalf("LoadWindowState err=%v", err)
	}
	if *got.X != 100 || *got.Y != 200 {
		t.Fatalf("坐标应沿用 prev (100,200), got (%d,%d)", *got.X, *got.Y)
	}
	if got.Width != 1460 {
		t.Fatalf("宽应为新值 1460, got %d", got.Width)
	}
}

// TestLoadCorruptFileReturnsDefault：JSON 损坏时返回默认值，不返回错误。
func TestLoadCorruptFileReturnsDefault(t *testing.T) {
	dir := t.TempDir()
	writeState(t, dir, `{"width": not-a-number,`)

	st, err := LoadWindowState(dir, oneDisplay)
	if err != nil {
		t.Fatalf("坏文件不应返回 error, got %v", err)
	}
	def := defaultState()
	if st != def {
		t.Fatalf("坏文件应回退默认值 %+v, got %+v", def, st)
	}
}

// TestLoadNonObjectReturnsDefault：顶层不是对象（数组 / 数字）也按默认处理。
func TestLoadNonObjectReturnsDefault(t *testing.T) {
	dir := t.TempDir()
	writeState(t, dir, `[1,2,3]`)

	st, err := LoadWindowState(dir, oneDisplay)
	if err != nil {
		t.Fatalf("非对象 JSON 不应返回 error, got %v", err)
	}
	if st != defaultState() {
		t.Fatalf("非对象应回退默认值, got %+v", st)
	}
}

// TestLoadMissingFileReturnsDefault：文件不存在 → 默认值，无 error。
func TestLoadMissingFileReturnsDefault(t *testing.T) {
	dir := t.TempDir()
	st, err := LoadWindowState(dir, oneDisplay)
	if err != nil {
		t.Fatalf("缺文件不应返回 error, got %v", err)
	}
	if st != defaultState() {
		t.Fatalf("缺文件应回退默认值, got %+v", st)
	}
}

// TestSaveCreatesDir：目录不存在时自动 MkdirAll。
func TestSaveCreatesDir(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "nested", "state")
	px, py := 10, 20
	prev := WindowState{X: &px, Y: &py, Width: 1440, Height: 900}
	nx, ny := 50, 60
	next := WindowState{X: &nx, Y: &ny, Width: 1500, Height: 950}

	saved, err := SaveWindowState(dir, prev, next)
	if err != nil {
		t.Fatalf("嵌套目录写盘失败: %v", err)
	}
	if !saved {
		t.Fatalf("首次写盘应返回 true")
	}
	if _, err := os.Stat(filepath.Join(dir, StateFileName)); err != nil {
		t.Fatalf("状态文件应已创建, stat err=%v", err)
	}
}

// TestSaveAtomicNoTmpLeft：写盘完成后不应残留 .tmp 文件（os.Rename 已生效）。
func TestSaveAtomicNoTmpLeft(t *testing.T) {
	dir := t.TempDir()
	prev := WindowState{Width: 1440, Height: 900}
	next := WindowState{Width: 1500, Height: 950}
	if _, err := SaveWindowState(dir, prev, next); err != nil {
		t.Fatalf("SaveWindowState err=%v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir err=%v", err)
	}
	for _, e := range entries {
		if filepath.Ext(e.Name()) == ".tmp" || len(e.Name()) > 4 && e.Name()[len(e.Name())-4:] == ".tmp" {
			t.Fatalf("不应残留 tmp 文件: %s", e.Name())
		}
	}
	// 也检查 .N.tmp 这种形式（前缀含 PID）
	for _, e := range entries {
		if e.Name() != StateFileName {
			t.Fatalf("目录里只应有 %s, 多了 %s", StateFileName, e.Name())
		}
	}
}

// TestRoundtripFieldNames：写出的 JSON 字段名与原版一致（小写 width/height/maximized，
// x/y 用 omitempty，未设置时不出现）。回归保护——重命名字段会破坏向后兼容。
func TestRoundtripFieldNames(t *testing.T) {
	dir := t.TempDir()
	prev := WindowState{Width: 1440, Height: 900}
	nx, ny := 42, 56
	next := WindowState{X: &nx, Y: &ny, Width: 1500, Height: 950, Maximized: true}
	if _, err := SaveWindowState(dir, prev, next); err != nil {
		t.Fatalf("SaveWindowState err=%v", err)
	}
	b, err := os.ReadFile(filepath.Join(dir, StateFileName))
	if err != nil {
		t.Fatalf("ReadFile err=%v", err)
	}
	var raw map[string]any
	if err := json.Unmarshal(b, &raw); err != nil {
		t.Fatalf("写出的 JSON 应可解析: %v", err)
	}
	if raw["x"] != float64(42) || raw["y"] != float64(56) {
		t.Fatalf("x/y 字段名应为小写, got %v", raw)
	}
	if raw["width"] != float64(1500) || raw["height"] != float64(950) {
		t.Fatalf("width/height 字段名应为小写, got %v", raw)
	}
	if raw["maximized"] != true {
		t.Fatalf("maximized 字段应为 true, got %v", raw)
	}
	// 不带 x/y 的状态写盘后不应有 x/y 键。
	dir2 := t.TempDir()
	if _, err := SaveWindowState(dir2, WindowState{Width: 1440, Height: 900}, WindowState{Width: 1500, Height: 950}); err != nil {
		t.Fatalf("SaveWindowState err=%v", err)
	}
	b2, _ := os.ReadFile(filepath.Join(dir2, StateFileName))
	var raw2 map[string]any
	if err := json.Unmarshal(b2, &raw2); err != nil {
		t.Fatalf("unmarshal err=%v", err)
	}
	if _, ok := raw2["x"]; ok {
		t.Fatalf("X=nil 时 JSON 不应有 x 键, got %v", raw2)
	}
	if _, ok := raw2["y"]; ok {
		t.Fatalf("Y=nil 时 JSON 不应有 y 键, got %v", raw2)
	}
}

// TestFiniteNaNInf：finite 应拒绝非有限值（与原版 Number.isFinite 同语义）。
func TestFiniteNaNInf(t *testing.T) {
	if _, ok := finite(math.NaN()); ok {
		t.Fatalf("NaN 应被拒绝")
	}
	if _, ok := finite(math.Inf(1)); ok {
		t.Fatalf("+Inf 应被拒绝")
	}
	if _, ok := finite(math.Inf(-1)); ok {
		t.Fatalf("-Inf 应被拒绝")
	}
	if v, ok := finite(42.5); !ok || v != 42.5 {
		t.Fatalf("普通数值应通过")
	}
	if _, ok := finite("42"); ok {
		t.Fatalf("字符串应被拒绝")
	}
	if _, ok := finite(nil); ok {
		t.Fatalf("nil 应被拒绝")
	}
}

// TestNear：near 的「≤」语义（原版 `Math.abs(a-b) <= DRIFT_TOLERANCE`）。
func TestNear(t *testing.T) {
	if !near(100, 108) {
		t.Fatalf("差 8 应在容差内")
	}
	if !near(108, 100) {
		t.Fatalf("差 8 应在容差内（对称）")
	}
	if near(100, 109) {
		t.Fatalf("差 9 应在容差外")
	}
	if !near(100, 100) {
		t.Fatalf("相等应在容差内")
	}
}
