/**
 * 验证「带环境打包」区渲染——等待 profiles 异步加载完成
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')

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

  // 先在左侧找到有 profile 的项目（第三个：lhmile_blog_backend）
  await wc.executeJavaScript(`
    (() => {
      // 后端控制台
      for (const btn of document.querySelectorAll('button')) {
        if ((btn.textContent||'').includes('后端')) { btn.click(); break; }
      }
    })()
  `).catch(()=>{})

  await new Promise(r => setTimeout(r, 1000))

  // 点击第三个条目（有 profiles 的那个）
  const clicked = await wc.executeJavaScript(`
    (() => {
      // 找左侧的项目列表按钮
      const projectBtns = Array.from(document.querySelectorAll('button[aria-current]')).concat(
        Array.from(document.querySelectorAll('button')).filter(btn => {
          const rect = btn.getBoundingClientRect();
          return rect.x < 200 && rect.width > 100 && rect.width < 300;
        })
      );
      // 找所有左侧条目按钮（宽度在 150-300 范围内，x 在左侧）
      const allBtns = Array.from(document.querySelectorAll('button')).filter(btn => {
        const rect = btn.getBoundingClientRect();
        return rect.x >= 56 && rect.x < 200 && rect.width > 100;
      });
      console.log('找到', allBtns.length, '个左侧按钮');
      allBtns.forEach((btn, i) => console.log(i, btn.textContent.trim().slice(0,30)));
      // 点击最后一个（lhmile_blog_backend 有 profiles）
      if (allBtns.length > 0) {
        allBtns[allBtns.length - 1].click();
        return 'clicked: ' + allBtns[allBtns.length - 1].textContent.trim().slice(0,30);
      }
      return 'no-buttons';
    })()
  `).catch(e => 'dead:'+e.message)
  console.log('点击结果:', clicked)

  // 等待 detectProfiles IPC 返回（最多 3 秒）
  let profileResult = null
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 500))
    const r = await wc.executeJavaScript(`
      (() => {
        const main = document.querySelector('main');
        if (!main) return null;
        const hasSection = main.innerHTML.includes('带环境打包');
        const pkgBtns = Array.from(main.querySelectorAll('button')).filter(
          btn => btn.title && (btn.title.includes('package') || btn.title.includes('build'))
        );
        return JSON.stringify({
          tick: ${i},
          hasSection,
          pkgBtnCount: pkgBtns.length,
          pkgBtnTitles: pkgBtns.map(b => b.title),
          pkgBtnLabels: pkgBtns.map(b => b.textContent.trim().slice(0, 30))
        });
      })()
    `).catch(e => null)
    if (r && JSON.parse(r).hasSection) { profileResult = r; break; }
    if (r) console.log(`t+${i}:`, r)
  }

  console.log('=== 最终结果 ===')
  console.log(profileResult || '未找到带环境打包区')

  app.exit(0)
})
