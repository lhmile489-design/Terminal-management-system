import { app, nativeImage } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 条目自定义图片的读写。渲染层永远不直接写盘 —— 它把选中文件的原始字节交给主进程，
 * 由这里解码、压缩、按内容哈希命名后落盘，再把「文件名」（imageId）回给渲染层。
 *
 * 安全要点（配套 CLAUDE.md 安全红线）：
 *   - imageId 是纯哈希文件名，不含用户输入、不是路径，渲染层无从指定任意文件。
 *   - 读取时用固定正则校验 imageId 形状，杜绝 `../` 路径穿越。
 *   - 落盘目录固定在 %APPDATA%/mile-terminal/images/，与 config 同父目录，主进程自建。
 *   - 解码失败（非图片字节）直接抛错，不落盘。
 *
 * 压缩：用 Electron 内置 nativeImage（Skia）解码 + 缩放，无需第三方依赖。最长边缩到
 * MAX_EDGE，重编码为 PNG。个人自用场景产物通常几 KB，不做引用计数删除（同图去重后
 * 多条目可能共享同一文件，首版只加不删，避免误删）。
 */
const MAX_EDGE = 128
/** imageId 合法形状：12 位小写 hex + .png。读取前必校验，挡路径穿越。 */
const IMAGE_ID = /^[a-f0-9]{12}\.png$/

export class ImageService {
  private readonly dir = join(app.getPath('appData'), 'mile-terminal', 'images')

  /**
   * 从原始字节解码 → 只缩不放到最长边 MAX_EDGE → 重编码 PNG → 按内容哈希命名落盘。
   * 返回文件名（imageId）。字节非图片或解码为空时抛错。
   */
  async saveFromData(bytes: Uint8Array): Promise<{ imageId: string }> {
    const buf = Buffer.from(bytes)
    let img = nativeImage.createFromBuffer(buf)
    if (img.isEmpty()) throw new Error('无法解析为图片（仅支持 PNG / JPG 等常见位图）')

    // 只缩不放：原图小于 MAX_EDGE 时保持原样，避免把小图糊大
    const { width, height } = img.getSize()
    const longEdge = Math.max(width, height)
    if (longEdge > MAX_EDGE) {
      // 按最长边等比缩放：resize 只给一个维度，另一维由 nativeImage 保持比例
      img = width >= height ? img.resize({ width: MAX_EDGE }) : img.resize({ height: MAX_EDGE })
    }

    const png = img.toPNG()
    if (!png || png.length === 0) throw new Error('图片重编码失败')

    const imageId = createHash('sha256').update(png).digest('hex').slice(0, 12) + '.png'
    mkdirSync(this.dir, { recursive: true })
    const target = join(this.dir, imageId)
    // 内容哈希命名：同图天然去重，已存在则无需重写
    if (!existsSync(target)) {
      const tmp = join(this.dir, `.${imageId}.tmp`)
      writeFileSync(tmp, png)
      renameSync(tmp, target)
    }
    return { imageId }
  }

  /** 读取图片为 data URL。imageId 形状非法或文件不存在时返回 null（不越权读任意路径）。 */
  async read(imageId: string): Promise<string | null> {
    if (!IMAGE_ID.test(imageId)) return null
    const target = join(this.dir, imageId)
    if (!existsSync(target)) return null
    try {
      const b64 = readFileSync(target).toString('base64')
      return `data:image/png;base64,${b64}`
    } catch {
      return null
    }
  }

  /** 尝试删除一个图片文件（惰性、尽力而为）。imageId 非法或删除失败都静默忽略。 */
  remove(imageId: string): void {
    if (!IMAGE_ID.test(imageId)) return
    try {
      rmSync(join(this.dir, imageId), { force: true })
    } catch {
      // 尽力而为，删不掉不影响任何判定
    }
  }
}
