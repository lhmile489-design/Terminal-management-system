/**
 * 使用真实 AppData，捕获完整错误堆栈
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// 使用真实 AppData
app.whenReady().then(async () => {
  const mainPath = join(__dirname, '../out/main/index.js')
  require(mainPath)

  await new Promise(r => setTimeout(r, 4000))

  const wins = BrowserWindow.getAllWindows()
  if (!wins.length) { app.exit(1); return }
  const wc = wins[0].webContents

  wc.on('console-message', (e, level, msg, line, src) => {
    if (level >= 2) console.log(`[R:${level}] ${msg.slice(0, 500)}`)
  })

  await new Promise(r => setTimeout(r, 2000))

  // 注入：捕获完整 stack
  await wc.executeJavaScript(`
    window.__FULL_ERRORS = [];
    window.onerror = function(msg, src, line, col, error) {
      window.__FULL_ERRORS.push({
        msg, src, line, col,
        stack: error ? error.stack : 'no-stack'
      });
      return false; // 不阻止默认行为
    };
    window.addEventListener('unhandledrejection', e => {
      window.__FULL_ERRORS.push({ msg: 'rejection', stack: e.reason?.stack || String(e.reason) });
    });
    'injected'
  `)

  await new Promise(r => setTimeout(r, 1000))

  // 读取初始化阶段已经发生的错误（在 click 之前）
  const preErrors = await wc.executeJavaScript(`JSON.stringify(window.__FULL_ERRORS)`)
  console.log('初始化阶段错误:', preErrors)

  // 点击后端控制台
  await wc.executeJavaScript(`
    for (const btn of document.querySelectorAll('button')) {
      if ((btn.textContent||'').includes('后端')) { btn.click(); break; }
    }
  `).catch(()=>{})

  await new Promise(r => setTimeout(r, 3000))

  const postErrors = await wc.executeJavaScript(`JSON.stringify(window.__FULL_ERRORS)`).catch(()=>'dead')
  console.log('点击后错误:', postErrors)

  app.exit(0)
})
