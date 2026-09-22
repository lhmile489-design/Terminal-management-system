/**
 * 直接截图诊断：用实际 build 产物，切到后端控制台，截图。
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, rmSync, readFileSync } = require('node:fs')
const { tmpdir, homedir } = require('node:os')

const ROOT = join(__dirname, '..')
const SANDBOX = join(tmpdir(), `mile-diag-${process.pid}`)
const SCREENSHOT_BEFORE = join(homedir(), 'Desktop', 'backend-before.png')
const SCREENSHOT_AFTER  = join(homedir(), 'Desktop', 'backend-after.png')
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
app.setPath('appData', SANDBOX)

const TYPES = readFileSync(join(ROOT, 'src', 'shared', 'types.ts'), 'utf8')
const CONFIG_VERSION = Number((TYPES.match(/CONFIG_VERSION\s*=\s*(\d+)/) || [])[1] || 1)
writeFileSync(
  join(SANDBOX, 'mile-terminal', 'config.json'),
  JSON.stringify({ version: CONFIG_VERSION, entries: [], ignoredListeners: [], settings: {} }, null, 2),
  'utf8'
)

require(join(ROOT, 'out', 'main', 'index.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) { app.exit(1); return }

  await new Promise((r) => win.webContents.once('did-finish-load', r))
  win.setBounds({ width: 1400, height: 900 })
  await sleep(800)

  // 截图1：初始状态
  let img = await win.webContents.capturePage()
  require('node:fs').writeFileSync(SCREENSHOT_BEFORE, img.toPNG())
  console.log('截图1 (初始):', SCREENSHOT_BEFORE)

  // 点击后端控制台
  const result = await win.webContents.executeJavaScript(`
    (function() {
      var btns = Array.prototype.slice.call(document.querySelectorAll('button[aria-label]'));
      var found = btns.filter(function(b) { return b.getAttribute('aria-label') === '后端控制台'; });
      if (found.length > 0) { found[0].click(); return 'clicked'; }
      return 'not-found / labels: ' + btns.map(function(b){ return b.getAttribute('aria-label'); }).join('|');
    })()
  `, true)
  console.log('点击结果:', result)

  await sleep(1000)

  // 截图2：切换后
  img = await win.webContents.capturePage()
  require('node:fs').writeFileSync(SCREENSHOT_AFTER, img.toPNG())
  console.log('截图2 (后端控制台):', SCREENSHOT_AFTER)

  // DOM 信息
  const dom = await win.webContents.executeJavaScript(`
    (function() {
      var main = document.querySelector('main');
      if (!main) return 'no main';
      var kids = Array.prototype.slice.call(main.children);
      return JSON.stringify(kids.map(function(el) {
        var r = el.getBoundingClientRect();
        var cs = window.getComputedStyle(el);
        return {
          tag: el.tagName,
          cls: el.className.slice(0, 80),
          w: Math.round(r.width),
          h: Math.round(r.height),
          display: cs.display,
          visibility: cs.visibility,
          overflow: cs.overflow
        };
      }));
    })()
  `, true)
  console.log('main 子元素:', dom)

  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch {}
  app.exit(0)
})
