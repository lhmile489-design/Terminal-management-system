/**
 * M17 自定义图片验证（上传 + 压缩 + 本地存储 + 两视图显示）。
 *
 * 走真实主进程 + 真实 out/ 产物。覆盖用户诉求的两点：
 *   1. 任意条目（服务和任务）都能上传自定义图片，自动压缩后存本地。
 *   2. 卡片与列表两种形态都显示该图片（直接覆盖「卡片形态不显示图」的报告）。
 *
 * 图片字节在 harness 里用 Electron nativeImage 现造一张 256x200 的位图再 toPNG，
 * 这样不依赖任何夹具图片文件，且尺寸已知（最长边 256 > 128），能验证「压缩到 ≤128」。
 *
 * harness 必须在 require 主进程包之前 setPath('appData')，否则会写真实用户配置。
 */
const { app, BrowserWindow, nativeImage } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, statSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const SANDBOX = join(tmpdir(), `mile-m17-image-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
app.setPath('appData', SANDBOX)
const CONFIG = join(SANDBOX, 'mile-terminal', 'config.json')
const IMAGES_DIR = join(SANDBOX, 'mile-terminal', 'images')

const TYPES = readFileSync(join(ROOT, 'src', 'shared', 'types.ts'), 'utf8')
const CONFIG_VERSION = Number((TYPES.match(/CONFIG_VERSION\s*=\s*(\d+)/) || [])[1] || 1)

// 一个真实项目目录（内容无所谓，条目只要有合法 path）
const PROJECT = join(SANDBOX, 'proj')
mkdirSync(PROJECT, { recursive: true })
writeFileSync(join(PROJECT, 'package.json'), JSON.stringify({ name: 'p', scripts: { dev: 'x' } }), 'utf8')

writeFileSync(
  CONFIG,
  JSON.stringify({ version: CONFIG_VERSION, entries: [], ignoredListeners: [], settings: {} }, null, 2),
  'utf8'
)

require(join(ROOT, 'out', 'main', 'index.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(label, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail++
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 造一张 w×h 的不透明位图 PNG（BGRA），最长边 > 128 用来验证压缩 */
function makePng(w, h) {
  const buf = Buffer.alloc(w * h * 4)
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 0x40 // B
    buf[i + 1] = 0x80 // G
    buf[i + 2] = 0xc0 // R
    buf[i + 3] = 0xff // A
  }
  const img = nativeImage.createFromBitmap(buf, { width: w, height: h })
  return img.toPNG()
}

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    console.log('FAIL 没有取到窗口')
    app.exit(1)
    return
  }

  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r))
    const js = (code) => win.webContents.executeJavaScript(code, true)

    // 建一个任务条目（专挑任务：现有预设图标只服务可选，任务此前只能显框架字标，
    // 是「卡片不显示图」最容易暴露的场景）
    const task = await js(`window.mile.entry.add({
      kind: 'task', name: 'Build Task', path: ${JSON.stringify(PROJECT)},
      framework: 'node', packageManager: 'npm', script: 'dev', scripts: { dev: 'x' },
      env: {}, registerOnly: false, pinned: false
    })`)
    check('新增任务条目', !!task && task.kind === 'task')
    const taskId = task.id

    // ── 1. 上传 + 压缩 + 落盘 ────────────────────────────────────────────
    console.log('\n=== 1. 上传 + 压缩 + 落盘 ===')
    const png = makePng(256, 200)
    const origSize = png.length
    // 经 IPC 把字节交给主进程（executeJavaScript 里用 Uint8Array 传，结构化克隆保留）
    const b64 = png.toString('base64')
    const imageId = await js(`(async () => {
      const bin = atob(${JSON.stringify(b64)})
      const arr = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
      return window.mile.entry.setImage(${JSON.stringify(taskId)}, arr.buffer)
    })()`)
    check('setImage 返回哈希文件名', /^[a-f0-9]{12}\.png$/.test(String(imageId)), String(imageId))

    const onDisk = join(IMAGES_DIR, imageId)
    check('图片已落盘到 images/', existsSync(onDisk))
    const savedSize = existsSync(onDisk) ? statSync(onDisk).size : Infinity
    check('压缩后体积小于原图', savedSize < origSize, `${savedSize} < ${origSize}`)

    // 读回并断言最长边 ≤ 128
    const dataUrl = await js(`window.mile.entry.image(${JSON.stringify(taskId)})`)
    check('image() 返回 data URL', /^data:image\/png;base64,/.test(String(dataUrl)), String(dataUrl).slice(0, 32))
    if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image')) {
      const savedPng = Buffer.from(dataUrl.split(',')[1], 'base64')
      const size = nativeImage.createFromBuffer(savedPng).getSize()
      check('压缩后最长边 ≤ 128', Math.max(size.width, size.height) <= 128, `${size.width}x${size.height}`)
      // 只缩不放大：原 256x200 应等比缩到 128x100
      check('等比缩放（宽 128 / 高 100）', size.width === 128 && size.height === 100, `${size.width}x${size.height}`)
    }

    // 条目落盘带上了 imageId
    const disk1 = JSON.parse(readFileSync(CONFIG, 'utf8'))
    check('条目落盘含 imageId', disk1.entries.find((e) => e.id === taskId)?.imageId === imageId)

    // ── 2. 两视图都显示（卡片 + 列表）──────────────────────────────────
    console.log('\n=== 2. 卡片与列表都显示 ===')
    // 切到启动台（与 m14 harness 同一导航选择器）
    await js(`document.querySelector('nav button[aria-label="前端启动台"]')?.click(); true`)
    await sleep(400)
    // 确保是卡片视图（默认即卡片，但保险起见点一下）
    await js(`[...document.querySelectorAll('[role=radio]')].find(el => el.getAttribute('aria-label') === '卡片视图')?.click(); true`)
    await sleep(400)
    const cardImg = await (async (ms = 4000) => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        const src = await js(`(() => {
          const card = document.querySelector('section[data-category-kind="task"] article');
          const img = card && card.querySelector('img');
          return img ? img.src : null;
        })()`)
        if (src) return src
        await sleep(150)
      }
      return null
    })()
    check('卡片视图任务卡片显示图片', typeof cardImg === 'string' && cardImg.startsWith('data:image'), String(cardImg).slice(0, 24))

    // 切到列表视图：点「列表视图」radio
    await js(`[...document.querySelectorAll('[role=radio],[aria-label]')].find(el => el.getAttribute('aria-label') === '列表视图')?.click?.(); true`)
    await sleep(400)
    const rowImg = await (async (ms = 4000) => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        const src = await js(`(() => {
          const row = document.querySelector('section[data-category-kind="task"] [data-entry-row]');
          const img = row && row.querySelector('img');
          return img ? img.src : null;
        })()`)
        if (src) return src
        await sleep(150)
      }
      return null
    })()
    check('列表视图任务行显示图片', typeof rowImg === 'string' && rowImg.startsWith('data:image'), String(rowImg).slice(0, 24))

    // ── 3. 安全：非法输入被拒 / 不越权读 ─────────────────────────────────
    console.log('\n=== 3. 安全 ===')
    const editEscape = await js(`window.mile.entry.edit(${JSON.stringify(taskId)}, { imageId: '../../config.json' })
      .then(() => 'ACCEPTED').catch(e => 'REJECTED: ' + e.message)`)
    check('edit 直接塞 imageId 字符串被拒', String(editEscape).startsWith('REJECTED'), String(editEscape))

    // 非图片字节被拒
    const nonImage = await js(`(async () => {
      const arr = new TextEncoder().encode('not an image at all')
      return window.mile.entry.setImage(${JSON.stringify(taskId)}, arr.buffer)
        .then(() => 'ACCEPTED').catch(e => 'REJECTED: ' + e.message)
    })()`)
    check('非图片字节被拒', String(nonImage).startsWith('REJECTED'), String(nonImage))

    // 落盘 imageId 仍是合法哈希（没被非法 edit 污染）
    const disk2 = JSON.parse(readFileSync(CONFIG, 'utf8'))
    check('落盘 imageId 未被污染', /^[a-f0-9]{12}\.png$/.test(disk2.entries.find((e) => e.id === taskId)?.imageId ?? ''))

    // ── 4. 清除后回退 ───────────────────────────────────────────────────
    console.log('\n=== 4. 清除 ===')
    await js(`window.mile.entry.clearImage(${JSON.stringify(taskId)})`)
    await sleep(200)
    const afterClear = await js(`window.mile.entry.image(${JSON.stringify(taskId)})`)
    check('清除后 image() 返回 null', afterClear === null, String(afterClear))
    const disk3 = JSON.parse(readFileSync(CONFIG, 'utf8'))
    check('清除后落盘无 imageId', !disk3.entries.find((e) => e.id === taskId)?.imageId)

    // ── 5. 服务条目同样可上传（覆盖「所有条目都能」）────────────────────
    console.log('\n=== 5. 服务条目也可上传 ===')
    const svc = await js(`window.mile.entry.add({
      kind: 'service', name: 'Web Svc', path: ${JSON.stringify(PROJECT)},
      framework: 'react-vite', packageManager: 'npm', script: 'dev', scripts: { dev: 'x' },
      env: {}, registerOnly: false, pinned: false
    })`)
    const svcImageId = await js(`(async () => {
      const bin = atob(${JSON.stringify(b64)})
      const arr = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
      return window.mile.entry.setImage(${JSON.stringify(svc.id)}, arr.buffer)
    })()`)
    check('服务条目 setImage 成功', /^[a-f0-9]{12}\.png$/.test(String(svcImageId)))
    // 同图去重：任务与服务用同一张图，应落到同一个哈希文件名
    check('同图去重（服务与任务同哈希）', svcImageId === imageId, `${svcImageId} vs ${imageId}`)
    // 服务是 web 框架但有自定义图 → 显示自定义图而非 favicon（优先级）
    const svcUrl = await js(`window.mile.entry.image(${JSON.stringify(svc.id)})`)
    check('服务自定义图优先于 favicon', typeof svcUrl === 'string' && svcUrl.startsWith('data:image'))
  } catch (err) {
    console.log('HARNESS ERROR', err)
    fail++
  }

  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`)
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
})
