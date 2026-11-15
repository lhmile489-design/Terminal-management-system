// S20 单测：只缩不放、长边 128、内容哈希去重、临时文件 + rename、imageId 形状校验、
// data URL 往返、删除尽力而为、解码失败文案。
//
// 原版用 Electron 的 nativeImage（Skia）解码与编码，迁到 Go 侧算法不同、产物字节不同，
// imageId 因此也不同（MIGRATION-PLAN §6），所以这里不比对字节，只钉行为分支。

package images

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func makePNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetNRGBA(x, y, color.NRGBA{R: uint8(x * 255 / max(w, 1)), G: uint8(y * 255 / max(h, 1)), B: 128, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func makeJPEG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetRGBA(x, y, color.RGBA{R: uint8(x), G: uint8(y), B: 64, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func decodeFile(t *testing.T, dir, id string) image.Image {
	t.Helper()
	f, err := os.Open(filepath.Join(dir, id))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	img, err := png.Decode(f)
	if err != nil {
		t.Fatal(err)
	}
	return img
}

func TestSaveShrinksLongEdgeOnly(t *testing.T) {
	cases := []struct{ w, h, wantW, wantH int }{
		{300, 200, MaxEdge, 85}, // 128 * 200 / 300 = 85.33
		{200, 300, 85, MaxEdge},
		{400, 400, MaxEdge, MaxEdge},
		{50, 40, 50, 40},   // 小图不动
		{128, 64, 128, 64}, // 长边正好 128，不动
		{129, 10, MaxEdge, 10},
	}
	for _, c := range cases {
		dir := t.TempDir()
		svc := New(dir)
		id, err := svc.SaveFromData(makePNG(t, c.w, c.h))
		if err != nil {
			t.Fatalf("%dx%d: %v", c.w, c.h, err)
		}
		img := decodeFile(t, dir, id)
		if got := img.Bounds().Dx(); got != c.wantW {
			t.Errorf("%dx%d 存成宽 %d，期望 %d", c.w, c.h, got, c.wantW)
		}
		if got := img.Bounds().Dy(); got != c.wantH {
			t.Errorf("%dx%d 存成高 %d，期望 %d", c.w, c.h, got, c.wantH)
		}
		if long := max(c.wantW, c.wantH); long > MaxEdge {
			t.Errorf("%dx%d 长边 %d 超过上限", c.w, c.h, long)
		}
	}
}

func TestSaveAcceptsJPEG(t *testing.T) {
	dir := t.TempDir()
	id, err := New(dir).SaveFromData(makeJPEG(t, 300, 200))
	if err != nil {
		t.Fatal(err)
	}
	if !imageIDRE.MatchString(id) {
		t.Fatalf("imageId 形状不对：%q", id)
	}
	img := decodeFile(t, dir, id)
	if img.Bounds().Dx() != MaxEdge || img.Bounds().Dy() != 85 {
		t.Fatalf("JPEG 缩成 %v，期望 128x85", img.Bounds())
	}
}

// 同一张图两次保存得到同一个 id，且已存在时不重写（先把文件换成垃圾再存一次验证）。
func TestSameInputSameIDAndNoRewrite(t *testing.T) {
	dir := t.TempDir()
	svc := New(dir)
	data := makePNG(t, 64, 64)
	id1, err := svc.SaveFromData(data)
	if err != nil {
		t.Fatal(err)
	}
	id2, err := svc.SaveFromData(data)
	if err != nil {
		t.Fatal(err)
	}
	if id1 != id2 {
		t.Fatalf("同一张图两次 id 不同：%q / %q", id1, id2)
	}
	if len(id1) != 16 || !strings.HasSuffix(id1, ".png") {
		t.Fatalf("id 长度应为 12 位 hex 加 .png，得到 %q", id1)
	}

	target := filepath.Join(dir, id1)
	if err := os.WriteFile(target, []byte("junk"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SaveFromData(data); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(target); string(got) != "junk" {
		t.Fatalf("已存在的文件被重写了：%q", got)
	}
	// 不留临时文件
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Fatalf("残留临时文件 %q", e.Name())
		}
	}
}

func TestDecodeError(t *testing.T) {
	dir := t.TempDir()
	_, err := New(dir).SaveFromData([]byte("not an image at all"))
	if err == nil || err.Error() != "无法解析为图片（仅支持 PNG / JPG 等常见位图）" {
		t.Fatalf("错误 = %v", err)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("解码失败却落盘了：%v", entries)
	}
}

func TestReadRejectsBadIDAndRoundTrips(t *testing.T) {
	dir := t.TempDir()
	svc := New(dir)
	id, err := svc.SaveFromData(makePNG(t, 32, 32))
	if err != nil {
		t.Fatal(err)
	}

	url, ok := svc.Read(id)
	if !ok {
		t.Fatal("自己的 id 读不出来")
	}
	const prefix = "data:image/png;base64,"
	if !strings.HasPrefix(url, prefix) {
		t.Fatalf("data URL 前缀不对：%q", url[:20])
	}
	got, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(url, prefix))
	if err != nil {
		t.Fatal(err)
	}
	want, _ := os.ReadFile(filepath.Join(dir, id))
	if !bytes.Equal(got, want) {
		t.Fatal("data URL 解出来的字节与文件不一致")
	}

	bad := []string{
		"../x.png",
		"..\\x.png",
		"ABCDEF123456.png",
		"abcdef12345.png",
		"abcdef1234567.png",
		"abcdef123456.png.exe",
		"abcdef1234zz.png",
		"",
		"aaaaaaaaaaaa.png",
	}
	for _, b := range bad {
		if _, ok := svc.Read(b); ok {
			t.Errorf("%q 应被拒", b)
		}
	}
}

func TestRemoveIsBestEffort(t *testing.T) {
	dir := t.TempDir()
	svc := New(dir)
	id, err := svc.SaveFromData(makePNG(t, 16, 16))
	if err != nil {
		t.Fatal(err)
	}
	svc.Remove(id)
	if _, err := os.Stat(filepath.Join(dir, id)); !os.IsNotExist(err) {
		t.Fatal("文件没被删掉")
	}
	// 再删一次、删非法 id、删合法但不存在：都不报错
	svc.Remove(id)
	svc.Remove("../x.png")
	svc.Remove("bbbbbbbbbbbb.png")
}

func TestDirIsCreated(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "deep", "images")
	svc := New(dir)
	if _, err := svc.SaveFromData(makePNG(t, 8, 8)); err != nil {
		t.Fatal(err)
	}
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		t.Fatalf("目录没建出来：%v", err)
	}
}

// 双线性采样：4x4 里只有左上角是黑，缩到 2x2 时左上角取到 2x2 块的平均。
func TestResizeBilinearAverages(t *testing.T) {
	src := image.NewNRGBA(image.Rect(0, 0, 4, 4))
	for y := 0; y < 4; y++ {
		for x := 0; x < 4; x++ {
			v := uint8(255)
			if x == 0 && y == 0 {
				v = 0
			}
			src.SetNRGBA(x, y, color.NRGBA{R: v, G: v, B: v, A: 255})
		}
	}
	dst := resizeBilinear(src, 2, 2)
	// 采样点 0.5,0.5：四邻 (0,0)=0、(1,0)/(0,1)/(1,1)=255 → 0.25*0 + 0.75*255 = 191.25
	if got := dst.NRGBAAt(0, 0).R; got != 191 {
		t.Fatalf("左上角 = %d，期望 191", got)
	}
	if got := dst.NRGBAAt(1, 1).R; got != 255 {
		t.Fatalf("右下角 = %d，期望 255", got)
	}
}

// 半透明像素缩放后不出现黑边（采样走非预乘通道）。
func TestResizeKeepsAlpha(t *testing.T) {
	src := image.NewNRGBA(image.Rect(0, 0, 8, 8))
	for y := 0; y < 8; y++ {
		for x := 0; x < 8; x++ {
			src.SetNRGBA(x, y, color.NRGBA{R: 255, G: 0, B: 0, A: 128})
		}
	}
	dst := resizeBilinear(src, 4, 4)
	c := dst.NRGBAAt(2, 2)
	if c.R != 255 || c.A != 128 {
		t.Fatalf("半透明像素被改了：%+v", c)
	}
}

func TestDefaultDirUnderDataDir(t *testing.T) {
	dir, err := DefaultDir()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(dir, string(filepath.Separator)+"images") || !strings.Contains(dir, "mile-console") {
		t.Fatalf("默认目录 = %q", dir)
	}
}

// imageId 的形状校验是防路径穿越的唯一闸门：目录外的同名文件不能被删也不能被读。
func TestPathTraversalIsBlocked(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "images")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(base, "secret.png")
	if err := os.WriteFile(secret, []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	svc := New(dir)
	svc.Remove("../secret.png")
	if _, err := os.Stat(secret); err != nil {
		t.Fatal("目录外的文件被删掉了")
	}
	if _, ok := svc.Read("../secret.png"); ok {
		t.Fatal("目录外的文件被读出来了")
	}
}

// 纵向权重取反会在这里暴露：8x8 缩到 3x3 的采样权重大约 0.83，而不是 0.5 那种对称值。
func TestResizeBilinearAsymmetricWeights(t *testing.T) {
	src := image.NewNRGBA(image.Rect(0, 0, 8, 8))
	for y := 0; y < 8; y++ {
		v := uint8(255)
		switch y {
		case 0:
			v = 0
		case 1:
			v = 200
		}
		for x := 0; x < 8; x++ {
			src.SetNRGBA(x, y, color.NRGBA{R: v, G: v, B: v, A: 255})
		}
	}
	// fx = fy = 0.5*8/3-0.5 = 0.8333：0*(1-0.8333) + 200*0.8333 = 166.7
	if got := resizeBilinear(src, 3, 3).NRGBAAt(0, 0).R; got != 167 {
		t.Fatalf("左上角 = %d，期望 167", got)
	}
}

// 校验必须是整串匹配：大写、多一位、前面还有别的内容，都既不能读也不能删 ——
// 这些名字的文件确实存在，所以「读不到」是校验挡的，不是文件不存在。
func TestShapeCheckRejectsExistingLookalikes(t *testing.T) {
	dir := t.TempDir()
	names := []string{"ABCDEF123456.png", "abcdef1234567.png", "xabcdef123456.png", "abcdef123456.png.bak"}
	for _, n := range names {
		if err := os.WriteFile(filepath.Join(dir, n), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	svc := New(dir)
	for _, n := range names {
		if _, ok := svc.Read(n); ok {
			t.Errorf("%q 不该被读出来", n)
		}
		svc.Remove(n)
		if _, err := os.Stat(filepath.Join(dir, n)); err != nil {
			t.Errorf("%q 不该被删掉", n)
		}
	}
}
