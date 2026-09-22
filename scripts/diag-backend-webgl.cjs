/**
 * 诊断：不禁用硬件加速，直接捕获 WebGL / GPU 相关崩溃
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')

// 不禁用硬件加速，模拟真实运行环境
// app.disableHardwareAcceleration()  // <-- 故意注释掉

app.setPath('appData', path.join(os.tmpdir(), 'mile-diag-backend-webgl-' + Date.now()))

app.whenReady().then(async () => {
  const mainPath = join(__dirname, '../out/main/index.js')
  if (!fs.existsSync(mainPath)) {
    console.error('❌ out/main/index.js 不存在，请先 npm run build')
    app.exit(1)
    return
  }

  require(mainPath)

  await new Promise(r => setTimeout(r, 3000))

  const wins = BrowserWindow.getAllWindows()
  if (!wins.length) { console.error('❌ 没有窗口'); app.exit(1); return }
  const win = wins[0]
  const wc = win.webContents

  const crashes = []
  wc.on('render-process-gone', (event, details) => {
    crashes.push({ type: 'render-process-gone', ...details })
    console.log('💥 渲染进程崩溃:', JSON.stringify(details))
  })

  wc.on('console-message', (event, level, message, line, sourceId) => {
    if (level >= 2 || message.includes('WebGL') || message.includes('GPU') || message.includes('Error') || message.includes('error')) {
      console.log(`[console level=${level}] ${message.slice(0, 200)}`)
    }
  })

  wc.on('did-fail-load', (event, errCode, errDesc) => {
    console.log('did-fail-load:', errCode, errDesc)
  })

  await new Promise(r => setTimeout(r, 2000))

  // 注入错误监听
  await wc.executeJavaScript(`
    window.__diagErrors = [];
    window.__diagRejections = [];
    window.addEventListener('error', (e) => {
      console.error('[DIAG error]', e.message, e.filename + ':' + e.lineno);
      window.__diagErrors.push({ message: e.message, stack: e.error?.stack });
    });
    window.addEventListener('unhandledrejection', (e) => {
      console.error('[DIAG rejection]', String(e.reason));
      window.__diagRejections.push({ reason: String(e.reason) });
    });
    'ok'
  `)

  // 点击后端控制台
  const clickResult = await wc.executeJavaScript(`
    (() => {
      const buttons = document.querySelectorAll('button, [role="button"]');
      for (const btn of buttons) {
        const text = btn.textContent || '';
        const label = btn.getAttribute('aria-label') || '';
        if (text.includes('后端') || label.includes('后端')) {
          btn.click();
          return 'clicked: ' + text.trim().slice(0, 30);
        }
      }
      return 'NOT FOUND';
    })()
  `)
  console.log('点击结果:', clickResult)

  // 等待更长时间（WebGL 崩溃可能有延迟）
  await new Promise(r => setTimeout(r, 5000))

  // 检查是否还活着
  const alive = await wc.executeJavaScript(`'alive'`).catch(e => `DEAD: ${e.message}`)
  console.log('渲染进程状态:', alive)

  if (alive === 'alive') {
    // 量一下 BackendConsole 根元素
    const layout = await wc.executeJavaScript(`
      (() => {
        const main = document.querySelector('main');
        if (!main) return 'no main';
        const children = Array.from(main.children).map(el => ({
          tag: el.tagName,
          cls: el.className.slice(0, 60),
          rect: JSON.stringify(el.getBoundingClientRect()).slice(0,80)
        }));
        return JSON.stringify(children);
      })()
    `)
    console.log('main 子节点:', layout)

    const errors = await wc.executeJavaScript(`JSON.stringify({ e: window.__diagErrors, r: window.__diagRejections })`)
    console.log('渲染层错误:', errors)
  }

  console.log('崩溃记录:', JSON.stringify(crashes))
  app.exit(0)
})
