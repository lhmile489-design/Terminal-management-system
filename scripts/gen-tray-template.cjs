/**
 * 生成 macOS 托盘模板图 resources/trayTemplate.png（16px）与 @2x（32px）。
 *
 * macOS 菜单栏图标要用「模板图」：只看 alpha 通道，系统按明暗模式自己上色。
 * 所以这里只画纯黑 + 透明，形状是终端提示符「>_」。只依赖 Node 自带的 zlib，不引入依赖。
 *
 *   node scripts/gen-tray-template.cjs
 */
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { deflateSync } = require('node:zlib')

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
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** 在 size×size 的画布上按 16 网格的坐标画线段，粗细随倍数放大 */
function render(size) {
  const s = size / 16
  const alpha = new Float32Array(size * size)
  const stroke = 1.6 * s
  const segs = [
    // 「>」
    [3, 4, 7.5, 8],
    [7.5, 8, 3, 12],
    // 「_」
    [9, 12, 13, 12]
  ].map((p) => p.map((v) => v * s))

  const distToSeg = (px, py, [x1, y1, x2, y2]) => {
    const dx = x2 - x1
    const dy = y2 - y1
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)))
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
  }

  // 4×4 超采样抗锯齿
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hit = 0
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const px = x + (sx + 0.5) / 4
          const py = y + (sy + 0.5) / 4
          if (segs.some((g) => distToSeg(px, py, g) <= stroke / 2)) hit++
        }
      }
      alpha[y * size + x] = hit / 16
    }
  }

  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // 过滤类型：无
    for (let x = 0; x < size; x++) {
      const o = y * (size * 4 + 1) + 1 + x * 4
      raw[o] = 0
      raw[o + 1] = 0
      raw[o + 2] = 0
      raw[o + 3] = Math.round(alpha[y * size + x] * 255)
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const OUT = join(__dirname, '..', 'resources')
writeFileSync(join(OUT, 'trayTemplate.png'), render(16))
writeFileSync(join(OUT, 'trayTemplate@2x.png'), render(32))
console.log('trayTemplate.png 16px, trayTemplate@2x.png 32px')
