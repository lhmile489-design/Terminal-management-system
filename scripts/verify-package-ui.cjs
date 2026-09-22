/**
 * 验证「带环境打包」区渲染
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const fs = require('node:fs')

app.whenReady().then(async () => {
  require(join(__dirname, '../out/main/index.js'))
  await new Promise(r => setTimeout(r, 4000))

  const wins = BrowserWindow.getAllWindows()
  if (!wins.length) { app.exit(1); return }
  const wc = wins[0].webContents

  wc.on('console-message', (e, level, msg) => {
    if (level >= 2) console.log(`[R:${level}]`, msg.slice(0,200))
  })

  await new Promise(r => setTimeout(r, 2000))

  // 点击后端控制台
  await wc.executeJavaScript(`
    for (const btn of document.querySelectorAll('button')) {
      if ((btn.textContent||'').includes('后端')) { btn.click(); break; }
    }
  `).catch(()=>{})

  await new Promise(r => setTimeout(r, 2000))

  // 检查「带环境打包」区
  const result = await wc.executeJavaScript(`
    (() => {
      const main = document.querySelector('main');
      if (!main) return 'no-main';

      // 找「带环境打包」文字
      const allText = main.innerHTML;
      const hasPackageSection = allText.includes('带环境打包');

      // 找所有 PackageButton（含「默认」文字的按钮）
      const pkgButtons = Array.from(main.querySelectorAll('button')).filter(
        btn => (btn.textContent||'').includes('默认') ||
               (btn.textContent||'').includes('· 生产') ||
               (btn.textContent||'').includes('· 沙箱') ||
               (btn.textContent||'').includes('· 开发') ||
               (btn.textContent||'').includes('mvnw package') ||
               (btn.textContent||'').includes('mvn package') ||
               (btn.textContent||'').includes('gradlew build')
      );

      // 收集命令提示
      const cmdHints = pkgButtons.map(btn => btn.title).filter(Boolean);

      return JSON.stringify({
        hasPackageSection,
        pkgButtonCount: pkgButtons.length,
        pkgButtonLabels: pkgButtons.map(btn => (btn.textContent||'').trim().slice(0,30)),
        cmdHints
      });
    })()
  `).catch(e => 'dead:' + e.message)
  console.log('=== 带环境打包区检测 ===')
  console.log(result)

  app.exit(0)
})
