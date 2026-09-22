/**
 * 用真实 AppData（含用户实际的 spring-boot 条目）复现黑屏
 * 不替换 appData，直接读用户的 config.json
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const fs = require('node:fs')

// ★ 使用真实 AppData，不替换
// app.setPath('appData', ...)  // 不设置 = 用真实的

app.whenReady().then(async () => {
  const mainPath = join(__dirname, '../out/main/index.js')
  if (!fs.existsSync(mainPath)) { console.error('no build'); app.exit(1); return }

  process.on('uncaughtException', e => console.error('[main]', e.message))
  process.on('unhandledRejection', r => console.error('[main-rej]', r))

  require(mainPath)
  await new Promise(r => setTimeout(r, 4000))

  const wins = BrowserWindow.getAllWindows()
  if (!wins.length) { console.error('no window'); app.exit(1); return }
  const win = wins[0]
  const wc = win.webContents

  wc.on('render-process-gone', (e, d) => console.log('💥 render-process-gone:', JSON.stringify(d)))
  wc.on('console-message', (e, level, msg) => {
    if (level >= 2 || msg.includes('Error') || msg.includes('Cannot') || msg.includes('undefined')) {
      console.log(`[R:${level}]`, msg.slice(0, 300))
    }
  })

  await new Promise(r => setTimeout(r, 2000))

  await wc.executeJavaScript(`
    window.__E=[]; window.__R=[];
    window.addEventListener('error',e=>{window.__E.push({m:e.message,s:e.error?.stack?.slice(0,400)});console.error('[ERR]',e.message)});
    window.addEventListener('unhandledrejection',e=>{window.__R.push(String(e.reason));console.error('[REJ]',String(e.reason))});
  `).catch(()=>{})

  // 先看一下有几个 spring-boot 条目被 entries store 加载了
  const entryCount = await wc.executeJavaScript(`
    (() => {
      // 通过 zustand store 读取
      try {
        const stores = window.__zustand_stores__ || [];
        return 'check-dom';
      } catch(e) { return 'err:'+e.message; }
    })()
  `).catch(e => 'dead:'+e.message)
  console.log('entry check:', entryCount)

  // 点击后端控制台
  const click = await wc.executeJavaScript(`
    (() => {
      for (const btn of document.querySelectorAll('button,[role=button]')) {
        if ((btn.textContent||'').includes('后端')) { btn.click(); return 'ok:'+btn.textContent.trim().slice(0,20); }
      }
      return 'not-found';
    })()
  `).catch(e => 'dead:'+e.message)
  console.log('click:', click)

  // 监控 8 秒
  for (let i = 1; i <= 8; i++) {
    await new Promise(r => setTimeout(r, 1000))
    const s = await wc.executeJavaScript(`
      (() => {
        const bc = document.querySelector('.-mx-7.-my-6');
        if (!bc) return JSON.stringify({tick:${i}, bcFound:false, bodyBg: getComputedStyle(document.body).backgroundColor});
        const rect = bc.getBoundingClientRect();
        // 检查所有子元素可见性
        const left = bc.querySelector('.w-64');
        const right = bc.querySelector('.flex-1.flex-col.overflow-hidden') || bc.querySelector('.flex-1.overflow-hidden');
        const items = bc.querySelectorAll('button');
        return JSON.stringify({
          tick:${i},
          bcRect:{w:rect.width,h:rect.height},
          leftFound:!!left,
          leftH: left ? left.getBoundingClientRect().height : 0,
          rightFound:!!right,
          itemCount:items.length,
          errors:window.__E.length,
          firstErr:window.__E[0]?.m,
          firstErrStack:window.__E[0]?.s?.slice(0,200)
        });
      })()
    `).catch(e => 'dead:'+e.message)
    console.log(`t+${i}:`, s)
    if (s.startsWith('dead')) break
  }

  const final = await wc.executeJavaScript(`JSON.stringify({e:window.__E,r:window.__R})`).catch(()=>'dead')
  console.log('final errors:', final)

  app.exit(0)
})
