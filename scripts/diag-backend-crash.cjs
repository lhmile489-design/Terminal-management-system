/**
 * 后端控制台黑屏崩溃诊断
 * 捕获切换到 'backend' 视图时的所有 JS 错误、console.error、unhandled rejections
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')

app.setPath('appData', path.join(os.tmpdir(), 'mile-diag-backend-crash-' + Date.now()))
app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const mainPath = join(__dirname, '../out/main/index.js')
  if (!fs.existsSync(mainPath)) {
    console.error('❌ out/main/index.js 不存在，请先 npm run build')
    app.exit(1)
    return
  }

  require(mainPath)

  // 等主窗口创建
  await new Promise(r => setTimeout(r, 3000))

  const wins = BrowserWindow.getAllWindows()
  if (!wins.length) {
    console.error('❌ 没有找到 BrowserWindow')
    app.exit(1)
    return
  }
  const win = wins[0]
  const wc = win.webContents

  const errors = []
  const consoleErrors = []
  const crashes = []

  // 监听渲染层 console
  wc.on('console-message', (event, level, message, line, sourceId) => {
    if (level >= 2) { // 2=warning 3=error
      consoleErrors.push({ level, message, line, sourceId })
    }
  })

  // 监听渲染层崩溃
  wc.on('render-process-gone', (event, details) => {
    crashes.push({ type: 'render-process-gone', ...details })
  })

  // 监听未处理的 promise rejection（在主进程）
  process.on('unhandledRejection', (reason) => {
    errors.push({ type: 'unhandledRejection', reason: String(reason) })
  })
  process.on('uncaughtException', (err) => {
    errors.push({ type: 'uncaughtException', message: err.message, stack: err.stack })
  })

  // 等渲染层加载完
  await new Promise(r => setTimeout(r, 2000))

  console.log('=== 初始化完成，开始切换到 backend 视图 ===')

  // 注入一个全局错误监听，捕获渲染层的所有未处理错误
  await wc.executeJavaScript(`
    window.__diagErrors = [];
    window.__diagRejections = [];
    window.addEventListener('error', (e) => {
      window.__diagErrors.push({ message: e.message, filename: e.filename, lineno: e.lineno, colno: e.colno, stack: e.error?.stack });
    });
    window.addEventListener('unhandledrejection', (e) => {
      window.__diagRejections.push({ reason: String(e.reason), stack: e.reason?.stack });
    });
    'ok'
  `)

  // 切换到 backend 视图
  // App 组件用 useState 控制 view，通过 React DevTools 没有暴露 setter
  // 改为直接点击 NavRail 里的 backend 按钮
  const clickResult = await wc.executeJavaScript(`
    (() => {
      // 找 NavRail 里的后端控制台按钮
      const buttons = document.querySelectorAll('button, [role="button"]');
      let found = null;
      for (const btn of buttons) {
        const text = btn.textContent || '';
        const label = btn.getAttribute('aria-label') || '';
        if (text.includes('后端') || label.includes('后端') || text.includes('backend') || label.includes('backend')) {
          found = btn;
          break;
        }
      }
      if (found) {
        found.click();
        return 'clicked: ' + (found.textContent || found.getAttribute('aria-label'));
      }
      // 备用：列出所有按钮文本
      return 'not found. buttons: ' + Array.from(buttons).map(b => JSON.stringify(b.textContent?.trim().slice(0,20))).slice(0,20).join(', ');
    })()
  `)
  console.log('点击结果:', clickResult)

  // 等待可能的崩溃 / 渲染完成
  await new Promise(r => setTimeout(r, 3000))

  // 收集渲染层错误
  const rendererErrors = await wc.executeJavaScript(`
    JSON.stringify({ errors: window.__diagErrors, rejections: window.__diagRejections })
  `).catch(e => `executeJavaScript failed: ${e.message}`)

  // 检查当前视图
  const currentView = await wc.executeJavaScript(`
    (() => {
      const main = document.querySelector('main');
      if (!main) return 'no main element';
      const rect = main.getBoundingClientRect();
      const firstChild = main.firstElementChild;
      return JSON.stringify({
        mainRect: { w: rect.width, h: rect.height },
        firstChildClass: firstChild?.className?.slice(0, 80),
        innerHTML_preview: main.innerHTML?.slice(0, 200)
      });
    })()
  `).catch(e => `executeJavaScript failed: ${e.message}`)

  console.log('\n=== 诊断结果 ===')
  console.log('主进程错误:', JSON.stringify(errors, null, 2))
  console.log('console.error:', JSON.stringify(consoleErrors, null, 2))
  console.log('渲染层崩溃:', JSON.stringify(crashes, null, 2))
  console.log('渲染层错误:', rendererErrors)
  console.log('当前视图状态:', currentView)

  app.exit(0)
})
