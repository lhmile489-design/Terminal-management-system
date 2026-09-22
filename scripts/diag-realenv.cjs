/**
 * 直接在安装版的主进程逻辑上捕获错误
 * 用安装包里的 main/index.js + preload，真实 IPC 环境
 */
const Module = require('node:module')
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

app.setPath('appData', path.join(os.tmpdir(), 'mile-diag-real-' + Date.now()))
// ★ 不禁用硬件加速

app.whenReady().then(async () => {
  const mainPath = join(__dirname, '../out/main/index.js')
  if (!fs.existsSync(mainPath)) {
    console.error('❌ 请先 npm run build')
    app.exit(1)
    return
  }

  // 捕获主进程 uncaught
  process.on('uncaughtException', e => console.error('[main uncaught]', e.message, e.stack))
  process.on('unhandledRejection', r => console.error('[main rejection]', r))

  require(mainPath)

  await new Promise(r => setTimeout(r, 3500))

  const wins = BrowserWindow.getAllWindows()
  if (!wins.length) { console.error('❌ 没窗口'); app.exit(1); return }
  const win = wins[0]
  const wc = win.webContents

  // 所有 console 输出
  wc.on('console-message', (e, level, msg, line, src) => {
    const tag = ['V','I','W','E'][level] ?? level
    if (level >= 1 || msg.includes('Error') || msg.includes('WebGL') || msg.includes('GPU')) {
      console.log(`[R:${tag}] ${msg.slice(0,400)}`)
    }
  })

  wc.on('render-process-gone', (e, details) => {
    console.log('💥 render-process-gone:', JSON.stringify(details))
  })

  wc.on('did-fail-load', (e, code, desc, url) => {
    if (code !== -3) console.log('did-fail-load:', code, desc)
  })

  // GPU 进程崩溃
  app.on('gpu-process-crashed', (e, killed) => {
    console.log('💥 GPU 进程崩溃, killed:', killed)
  })

  app.on('child-process-gone', (e, details) => {
    if (details.type !== 'Utility') {
      console.log('child-process-gone:', JSON.stringify(details))
    }
  })

  await new Promise(r => setTimeout(r, 2000))
  console.log('=== 应用已启动，等待渲染层就绪 ===')

  // 注入错误监听
  const inj = await wc.executeJavaScript(`
    window.__DE = []; window.__DR = [];
    window.addEventListener('error', e => { window.__DE.push({m: e.message, s: e.error?.stack?.slice(0,200)}); });
    window.addEventListener('unhandledrejection', e => { window.__DR.push(String(e.reason).slice(0,200)); });
    'injected'
  `).catch(e => 'inject-failed:' + e.message)
  console.log('注入结果:', inj)

  // 点击 backend
  const click = await wc.executeJavaScript(`
    (() => {
      for (const btn of document.querySelectorAll('button,[role=button]')) {
        if ((btn.textContent||'').includes('后端') || (btn.getAttribute('aria-label')||'').includes('后端')) {
          btn.click(); return 'clicked:' + btn.textContent.trim().slice(0,20);
        }
      }
      return 'not-found';
    })()
  `).catch(e => 'click-failed:' + e.message)
  console.log('点击:', click)

  // 等待 8 秒，捕获所有异步错误
  for (let i = 1; i <= 8; i++) {
    await new Promise(r => setTimeout(r, 1000))
    const snapshot = await wc.executeJavaScript(`
      (() => {
        const main = document.querySelector('main');
        if (!main) return 'no-main';
        const bc = main.querySelector('.-mx-7');
        return JSON.stringify({
          tick: ${i},
          mainH: main.getBoundingClientRect().height,
          bcFound: !!bc,
          bcRect: bc ? bc.getBoundingClientRect() : null,
          errors: window.__DE.length,
          rejections: window.__DR.length,
          firstError: window.__DE[0]?.m,
          firstRej: window.__DR[0]
        })
      })()
    `).catch(e => 'dead:' + e.message)
    console.log(`t+${i}s:`, snapshot)
    if (snapshot.startsWith('dead')) break
  }

  const finalErrors = await wc.executeJavaScript(`JSON.stringify({e:window.__DE,r:window.__DR})`).catch(e => 'dead')
  console.log('最终错误:', finalErrors)

  app.exit(0)
})
