#!/usr/bin/env node
/**
 * 由 ../docs/appicon.png 生成三处应用图标资源：
 *   resources/icon.png            1024×1024  运行期窗口 + 托盘
 *   src/renderer/src/assets/logo.png  128×128 应用内标题栏
 *   build/icon.ico                多尺寸    NSIS 安装包 / 打包 exe
 *
 * 纯 Node 内置能力（zlib）实现 PNG 解码 / 编码，不引第三方库。
 *
 * 四角处理：源图是不透明 RGB 方块，四角带一圈接近白的高光，深色模式下突兀。
 * 做法是套一层圆角矩形 alpha 遮罩 —— 圆角外一律透明，圆角带做抗锯齿过渡。
 * 这样四角的白既被切掉，整体又变成圆角方形，任意背景（浅/深）都干净。
 */
const zlib = require('zlib')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SRC = path.resolve(ROOT, 'docs', 'appicon.png')

// ---------- PNG 解码（8-bit，colorType 0/2/6，非隔行） ----------
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG')
  let o = 8
  let w, h, colorType, bitDepth
  const idat = []
  while (o < buf.length) {
    const len = buf.readUInt32BE(o)
    const type = buf.toString('ascii', o + 4, o + 8)
    const data = buf.slice(o + 8, o + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      if (bitDepth !== 8) throw new Error('仅支持 8-bit，实际 ' + bitDepth)
      if (data[12] !== 0) throw new Error('不支持隔行 PNG')
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    o += 12 + len
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : null
  if (!channels) throw new Error('不支持的 colorType ' + colorType)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * channels
  // 反滤波，展开成 RGBA
  const out = Buffer.alloc(w * h * 4)
  const prev = Buffer.alloc(stride)
  const cur = Buffer.alloc(stride)
  let p = 0
  for (let y = 0; y < h; y++) {
    const filter = raw[p++]
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[p + x]
      const a = x >= channels ? cur[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      let val
      switch (filter) {
        case 0: val = rawByte; break
        case 1: val = rawByte + a; break
        case 2: val = rawByte + b; break
        case 3: val = rawByte + ((a + b) >> 1); break
        case 4: {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c)
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
          val = rawByte + pr
          break
        }
        default: throw new Error('未知滤波 ' + filter)
      }
      cur[x] = val & 0xff
    }
    p += stride
    for (let x = 0; x < w; x++) {
      const s = x * channels
      const d = (y * w + x) * 4
      if (channels === 1) {
        out[d] = out[d + 1] = out[d + 2] = cur[s]; out[d + 3] = 255
      } else {
        out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2]
        out[d + 3] = channels === 4 ? cur[s + 3] : 255
      }
    }
    cur.copy(prev)
  }
  return { width: w, height: h, data: out }
}

// ---------- PNG 编码（RGBA，无滤波，zlib 压缩） ----------
function encodePng({ width, height, data }) {
  const stride = width * 4
  const rawWithFilters = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    rawWithFilters[y * (stride + 1)] = 0 // filter none
    data.copy(rawWithFilters, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const idat = zlib.deflateSync(rawWithFilters, { level: 9 })
  const chunks = []
  const chunk = (type, payload) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(payload.length, 0)
    const t = Buffer.from(type, 'ascii')
    const body = Buffer.concat([t, payload])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0, 0)
    chunks.push(len, body, crc)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  chunk('IHDR', ihdr)
  chunk('IDAT', idat)
  chunk('IEND', Buffer.alloc(0))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks])
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return c ^ 0xffffffff
}

// ---------- 双线性缩放 ----------
function resize(img, tw, th) {
  const { width: sw, height: sh, data: src } = img
  const dst = Buffer.alloc(tw * th * 4)
  for (let y = 0; y < th; y++) {
    const sy = ((y + 0.5) * sh) / th - 0.5
    const y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(sh - 1, y0 + 1)
    const fy = sy - Math.floor(sy)
    for (let x = 0; x < tw; x++) {
      const sx = ((x + 0.5) * sw) / tw - 0.5
      const x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(sw - 1, x0 + 1)
      const fx = sx - Math.floor(sx)
      const d = (y * tw + x) * 4
      for (let ch = 0; ch < 4; ch++) {
        const p00 = src[(y0 * sw + x0) * 4 + ch]
        const p10 = src[(y0 * sw + x1) * 4 + ch]
        const p01 = src[(y1 * sw + x0) * 4 + ch]
        const p11 = src[(y1 * sw + x1) * 4 + ch]
        const top = p00 + (p10 - p00) * fx
        const bot = p01 + (p11 - p01) * fx
        dst[d + ch] = Math.round(top + (bot - top) * fy)
      }
    }
  }
  return { width: tw, height: th, data: dst }
}

// ---------- 抠掉白底方块（从边缘泛洪，只抠与边框连通的白），做透明过渡 ----------
// 源图是深色圆角 logo 摆在白色底板上；白只存在于 logo 自身圆角之外的四角与边带。
// 深色模式截图里那圈浅灰是「白底 → logo 深色」的抗锯齿过渡带残留成的半透明浅灰边。
// 关键约束：logo 本体内部也可能有浅灰/银色元素（采样发现内部有几千个浅色像素），
// 因此不能简单「凡浅色即透明」——那会把本体内的浅色抠出窟窿。
// 正解：从四条边界做泛洪，只把「与边框连通的浅色」（= 白底板及其柔边）标记为背景，
// 内部被 logo 包围的浅色元素一律保留。边界像素的 RGB 再抹向本体暗色，柔边不发灰。
function keyOutWhite(img) {
  const { width: w, height: h, data } = img
  const out = Buffer.from(data)
  const N = w * h
  const lumAt = (i) => 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
  // 泛洪判定：亮度 ≥ FLOOD 视为「可能是背景白」，从边缘扩散。
  // 阈值放低到 90：白底与 logo 暗体之间那条抗锯齿过渡带（灰度 90~250）整段都要吃进背景，
  // 否则过渡带里 lum 130~235 的像素留在图里就是肉眼可见的浅灰白边。
  // logo 本体的暗色（lum≈22）远低于 90，泛洪碰到就停，内部浅色元素不与边框连通、不受影响。
  const FLOOD = 90
  const bg = new Uint8Array(N) // 1 = 与边框连通的背景（白底 + 其抗锯齿柔边）
  const stack = []
  for (let x = 0; x < w; x++) {
    stack.push(x)            // 上边
    stack.push((h - 1) * w + x) // 下边
  }
  for (let y = 0; y < h; y++) {
    stack.push(y * w)        // 左边
    stack.push(y * w + w - 1) // 右边
  }
  while (stack.length) {
    const p = stack.pop()
    if (bg[p]) continue
    if (lumAt(p) < FLOOD) continue // 碰到 logo 本体，停
    bg[p] = 1
    const x = p % w, y = (p / w) | 0
    if (x > 0) stack.push(p - 1)
    if (x < w - 1) stack.push(p + 1)
    if (y > 0) stack.push(p - w)
    if (y < h - 1) stack.push(p + w)
  }
  // 与边框连通的背景像素一律全透明——不留任何柔边残留，白边彻底消失。
  // 再把背景边界向 logo 侧膨胀 1px：抗锯齿过渡带最内那一两像素常落在 FLOOD 阈值之下
  // （lum 略低于 90）而没被泛洪覆盖，正是它们残成一圈浅灰。膨胀 1px 一并抹平，
  // 内部浅色元素远离背景边界，不受牵连。边缘抗锯齿随后由 roundCorners 统一重建。
  const edge = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    if (bg[i]) continue
    const x = i % w, y = (i / w) | 0
    if ((x > 0 && bg[i - 1]) || (x < w - 1 && bg[i + 1]) ||
        (y > 0 && bg[i - w]) || (y < h - 1 && bg[i + w])) {
      edge[i] = 1
    }
  }
  for (let i = 0; i < N; i++) {
    if (bg[i] || edge[i]) out[i * 4 + 3] = 0
  }
  return { width: w, height: h, data: out }
}

// ---------- 裁到不透明内容的外接框，让 logo 填满图标、不留白边距 ----------
function trimToContent(img, pad = 0) {
  const { width: w, height: h, data } = img
  let minX = w, minY = h, maxX = -1, maxY = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 16) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return img // 全透明，别裁
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad)
  maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad)
  const nw = maxX - minX + 1
  const nh = maxY - minY + 1
  // 补成正方形（居中），避免非等比缩放拉伸
  const side = Math.max(nw, nh)
  const dst = Buffer.alloc(side * side * 4)
  const ox = ((side - nw) >> 1) - minX
  const oy = ((side - nh) >> 1) - minY
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const s = (y * w + x) * 4
      const dx = x + ox, dy = y + oy
      const dd = (dy * side + dx) * 4
      dst[dd] = data[s]; dst[dd + 1] = data[s + 1]; dst[dd + 2] = data[s + 2]; dst[dd + 3] = data[s + 3]
    }
  }
  return { width: side, height: side, data: dst }
}

// ---------- 圆角 alpha 遮罩（抗锯齿），仅作安全兜底裁切 ----------
function roundCorners(img, radiusRatio) {
  const { width: w, height: h, data } = img
  const r = Math.min(w, h) * radiusRatio
  const out = Buffer.from(data)
  // 每个像素到圆角矩形的“覆盖率”：矩形内 =1，圆角外过渡到 0，做 1px 抗锯齿
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cx = Math.min(Math.max(x + 0.5, r), w - r)
      const cy = Math.min(Math.max(y + 0.5, r), h - r)
      const dx = x + 0.5 - cx
      const dy = y + 0.5 - cy
      const dist = Math.hypot(dx, dy)
      // 只有落在四个圆角象限时 dist 才非 0；边与内部 dist=0
      let cover = 1
      if (dist > 0) {
        cover = Math.min(Math.max(r + 0.5 - dist, 0), 1) // r-0.5..r+0.5 之间做过渡
      }
      const d = (y * w + x) * 4
      out[d + 3] = Math.round(data[d + 3] * cover)
    }
  }
  return { width: w, height: h, data: out }
}

// ---------- ICO 组装（每个尺寸内嵌 PNG） ----------
function buildIco(entries) {
  // entries: [{ size, png(Buffer) }]
  const count = entries.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(count, 4)
  const dir = Buffer.alloc(16 * count)
  let offset = 6 + 16 * count
  const bodies = []
  entries.forEach((e, i) => {
    const b = 16 * i
    dir[b] = e.size >= 256 ? 0 : e.size // 256 记为 0
    dir[b + 1] = e.size >= 256 ? 0 : e.size
    dir[b + 2] = 0; dir[b + 3] = 0
    dir.writeUInt16LE(1, b + 4)   // color planes
    dir.writeUInt16LE(32, b + 6)  // bpp
    dir.writeUInt32LE(e.png.length, b + 8)
    dir.writeUInt32LE(offset, b + 12)
    offset += e.png.length
    bodies.push(e.png)
  })
  return Buffer.concat([header, dir, ...bodies])
}

// ---------- 主流程 ----------
// 先在原分辨率抠白底、裁到内容外接框，再缩放；圆角只作兜底（logo 自带圆角，半径给大避免二次切角）
const SAFETY_RADIUS = 0.12
const src = decodePng(fs.readFileSync(SRC))
console.log(`源图 ${src.width}×${src.height}`)
const keyed = trimToContent(keyOutWhite(src), 0)
console.log(`抠白+裁边后 ${keyed.width}×${keyed.height}`)

function make(size) {
  const scaled = resize(keyed, size, size)
  return roundCorners(scaled, SAFETY_RADIUS)
}

// resources/icon.png 1024
const icon1024 = make(1024)
fs.writeFileSync(path.join(ROOT, 'resources', 'icon.png'), encodePng(icon1024))
console.log('写入 resources/icon.png (1024)')

// src/renderer/src/assets/logo.png 128
const logo128 = make(128)
fs.writeFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'assets', 'logo.png'), encodePng(logo128))
console.log('写入 src/renderer/src/assets/logo.png (128)')

// build/icon.ico 多尺寸
const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const icoEntries = icoSizes.map((s) => ({ size: s, png: encodePng(make(s)) }))
fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), buildIco(icoEntries))
console.log('写入 build/icon.ico (' + icoSizes.join(',') + ')')
console.log('完成')
