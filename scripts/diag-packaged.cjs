/**
 * 模拟打包环境诊断：用 file:// 加载 out/renderer/index.html
 * 不走主进程 IPC，直接看渲染层崩溃 / JS 错误
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const os = require('node:os')
const path = require('node:path')

app.setPath('appData', path.join(os.tmpdir(), 'mile-diag-pkg-' + Date.now()))
// 不禁用硬件加速 —— 打包版用的是真实 GPU
// app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      // 打包版没有 preload，模拟裸渲染层
    }
  })

  const htmlPath = join(__dirname, '../out/renderer/index.html')
  const allErrors = []

  win.webContents.on('console-message', (e, level, msg, line, src) => {
    const tag = ['verbose','info','warn','error'][level] ?? level
    if (level >= 1) {
      console.log(`[${tag}] ${msg.slice(0, 300)}  (${src}:${line})`)
    }
    if (level >= 2) allErrors.push({ level: tag, msg: msg.slice(0, 300) })
  })

  win.webContents.on('render-process-gone', (e, details) => {
    console.log('💥 render-process-gone:', JSON.stringify(details))
    allErrors.push({ type: 'render-process-gone', ...details })
  })

  win.webContents.on('did-fail-load', (e, code, desc, url) => {
    console.log('did-fail-load:', code, desc, url)
  })

  // 加载产物 HTML
  await win.loadFile(htmlPath).catch(e => console.log('loadFile error:', e.message))
  console.log('=== 页面已加载 ===')

  await new Promise(r => setTimeout(r, 2000))

  // 注入错误捕获
  const injected = await win.webContents.executeJavaScript(`
    window.__e = []; window.__r = [];
    window.addEventListener('error', e => { window.__e.push(e.message + ' @ ' + e.filename + ':' + e.lineno); console.error('[caught]', e.message); });
    window.addEventListener('unhandledrejection', e => { window.__r.push(String(e.reason)); console.error('[rejection]', String(e.reason)); });
    'injected'
  `).catch(e => 'inject failed: ' + e.message)
  console.log('注入:', injected)

  // 检查 window.mile 是否存在（打包版有 preload，裸 file:// 没有）
  const hasMile = await win.webContents.executeJavaScript(`typeof window.mile`).catch(() => 'dead')
  console.log('window.mile:', hasMile)

  await new Promise(r => setTimeout(r, 3000))
  const errs = await win.webContents.executeJavaScript(`JSON.stringify({e:window.__e,r:window.__r})`).catch(e => 'dead:' + e.message)
  console.log('捕获的错误:', errs)
  console.log('所有错误汇总:', JSON.stringify(allErrors, null, 2))

  app.exit(0)
})
