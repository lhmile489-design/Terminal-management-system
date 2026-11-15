// 对应 src/main/services/ImageService.ts。
//
// 条目自定义图片的读写。渲染层永远不直接写盘 —— 它把选中文件的原始字节交给主进程，
// 由这里解码、压缩、按内容哈希命名后落盘，再把「文件名」（imageId）回给渲染层。
//
// 安全要点（配套 CLAUDE.md 安全红线）：
//   - imageId 是纯哈希文件名，不含用户输入、不是路径，渲染层无从指定任意文件。
//   - 读取时用固定正则校验 imageId 形状，杜绝 `../` 路径穿越。
//   - 落盘目录固定在数据目录下的 images/，主进程自建。
//   - 解码失败（非图片字节）直接报错，不落盘。
//
// 与原版的差别（D2 定案，见 MIGRATION-PLAN §7 / §6）：原版用 Electron 的 nativeImage（Skia）解码、
// 缩放与编码，这里用标准库 image/png + image/jpeg 加一个双线性缩放，同一张原图得到的 PNG 字节
// 与原版不同，imageId 因此也不同。只缩不放、长边 128、按内容哈希命名这些行为逐项一致。

package images

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"regexp"

	"mile-console/internal/config"
)

// MaxEdge 即原版 MAX_EDGE：最长边缩到 128。
const MaxEdge = 128

// imageIDRE 即原版 IMAGE_ID：12 位小写 hex 加 .png。读取前必校验，挡路径穿越。
var imageIDRE = regexp.MustCompile(`^[a-f0-9]{12}\.png$`)

// 原版的两条错误文案，逐字照搬。
var (
	errDecode   = errors.New("无法解析为图片（仅支持 PNG / JPG 等常见位图）")
	errReencode = errors.New("图片重编码失败")
)

// Service 即原版 ImageService。
type Service struct {
	dir string
}

// New 在 dir 下读写图片；dir 通常是 DefaultDir()。
func New(dir string) *Service { return &Service{dir: dir} }

// DefaultDir 即原版 `join(app.getPath('appData'), 'mile-terminal', 'images')`，
// 只把父目录换成 D4 定案的 `%APPDATA%\mile-console\`。
func DefaultDir() (string, error) {
	base, err := config.DataDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "images"), nil
}

// Dir 当前落盘目录。
func (s *Service) Dir() string { return s.dir }

// SaveFromData 即原版 saveFromData：解码 → 只缩不放到最长边 MaxEdge → 重编码 PNG →
// 按内容哈希命名落盘，返回 imageId。字节非图片或解码为空时报错，不落盘。
func (s *Service) SaveFromData(data []byte) (string, error) {
	img, err := decode(data)
	if err != nil {
		return "", err
	}

	// 只缩不放：原图小于 MaxEdge 时保持原样，避免把小图糊大
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if long := max(w, h); long > MaxEdge {
		// 按最长边等比缩放：另一维按比例算，与 nativeImage 只给一个维度的效果一致
		if w >= h {
			w, h = MaxEdge, int(math.Round(float64(h)*MaxEdge/float64(w)))
		} else {
			w, h = int(math.Round(float64(w)*MaxEdge/float64(h))), MaxEdge
		}
		w, h = max(w, 1), max(h, 1)
		img = resizeBilinear(img, w, h)
	}

	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil || buf.Len() == 0 {
		return "", errReencode
	}
	pngBytes := buf.Bytes()

	sum := sha256.Sum256(pngBytes)
	imageID := hex.EncodeToString(sum[:])[:12] + ".png"

	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return "", err
	}
	target := filepath.Join(s.dir, imageID)
	// 内容哈希命名：同图天然去重，已存在则无需重写
	if _, err := os.Stat(target); err != nil {
		tmp := filepath.Join(s.dir, "."+imageID+".tmp")
		if err := os.WriteFile(tmp, pngBytes, 0o644); err != nil {
			return "", err
		}
		if err := os.Rename(tmp, target); err != nil {
			_ = os.Remove(tmp)
			return "", err
		}
	}
	return imageID, nil
}

// Read 即原版 read：读取图片为 data URL。imageId 形状非法或文件不存在时返回 false
// （不越权读任意路径）。
func (s *Service) Read(imageID string) (string, bool) {
	if !imageIDRE.MatchString(imageID) {
		return "", false
	}
	data, err := os.ReadFile(filepath.Join(s.dir, imageID))
	if err != nil {
		return "", false
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(data), true
}

// Remove 即原版 remove：尝试删除一个图片文件（惰性、尽力而为）。
// imageId 非法或删除失败都静默忽略。
func (s *Service) Remove(imageID string) {
	if !imageIDRE.MatchString(imageID) {
		return
	}
	_ = os.Remove(filepath.Join(s.dir, imageID))
}

// decode 即原版 nativeImage.createFromBuffer + isEmpty()：只认 PNG 与 JPEG 两种位图。
func decode(data []byte) (image.Image, error) {
	if img, err := png.Decode(bytes.NewReader(data)); err == nil {
		return img, nil
	}
	if img, err := jpeg.Decode(bytes.NewReader(data)); err == nil {
		return img, nil
	}
	return nil, errDecode
}

// resizeBilinear 把 src 双线性缩放到 dw×dh。坐标取像素中心对齐，边缘夹取。
// 采样前先转成非预乘的 NRGBA，避免半透明边缘出现黑边。
func resizeBilinear(src image.Image, dw, dh int) *image.NRGBA {
	b := src.Bounds()
	sw, sh := b.Dx(), b.Dy()
	dst := image.NewNRGBA(image.Rect(0, 0, dw, dh))
	px := func(x, y int) color.NRGBA {
		return color.NRGBAModel.Convert(src.At(b.Min.X+x, b.Min.Y+y)).(color.NRGBA)
	}
	for y := 0; y < dh; y++ {
		fy := (float64(y)+0.5)*float64(sh)/float64(dh) - 0.5
		y0 := int(math.Floor(fy))
		ty := fy - float64(y0)
		if y0 < 0 {
			y0, ty = 0, 0
		}
		y1 := min(y0+1, sh-1)
		for x := 0; x < dw; x++ {
			fx := (float64(x)+0.5)*float64(sw)/float64(dw) - 0.5
			x0 := int(math.Floor(fx))
			tx := fx - float64(x0)
			if x0 < 0 {
				x0, tx = 0, 0
			}
			x1 := min(x0+1, sw-1)
			c00, c10 := px(x0, y0), px(x1, y0)
			c01, c11 := px(x0, y1), px(x1, y1)
			i := dst.PixOffset(x, y)
			dst.Pix[i+0] = blend(c00.R, c10.R, c01.R, c11.R, tx, ty)
			dst.Pix[i+1] = blend(c00.G, c10.G, c01.G, c11.G, tx, ty)
			dst.Pix[i+2] = blend(c00.B, c10.B, c01.B, c11.B, tx, ty)
			dst.Pix[i+3] = blend(c00.A, c10.A, c01.A, c11.A, tx, ty)
		}
	}
	return dst
}

// blend 双线性混合四个通道值，输出 8 位。
func blend(v00, v10, v01, v11 uint8, tx, ty float64) uint8 {
	top := float64(v00)*(1-tx) + float64(v10)*tx
	bottom := float64(v01)*(1-tx) + float64(v11)*tx
	return uint8(math.Round(top*(1-ty) + bottom*ty))
}
