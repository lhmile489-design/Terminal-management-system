/**
 * M14 regression: launch entries can share a persisted category across service
 * and task cards, and each category can be collapsed without losing its cards.
 */
const { app, BrowserWindow } = require('electron')
const { mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const FIXTURE = join(__dirname, 'fixture')
const SANDBOX = join(tmpdir(), `mile-m14-categories-${process.pid}`)
const CONFIG = join(SANDBOX, 'mile-terminal', 'config.json')

mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
app.setPath('appData', SANDBOX)

const now = Date.now()
const entry = (id, kind, order, category) => ({
  id,
  kind,
  name: id,
  ...(category ? { category } : {}),
  path: FIXTURE,
  framework: 'node',
  packageManager: 'npm',
  script: 'dev',
  scripts: { dev: 'node server.cjs' },
  env: {},
  registerOnly: false,
  pinned: false,
  order,
  createdAt: now
})

writeFileSync(
  CONFIG,
  JSON.stringify(
    {
      version: 4,
      entries: [
        entry('admin-service', 'service', 0, '后台管理系统'),
        entry('admin-task', 'task', 1, '后台管理系统'),
        entry('site-service', 'service', 2),
        entry('unclassified-task', 'task', 3)
      ],
      ignoredListeners: [],
      groupOverrides: [],
      watchedKeywords: [],
      settings: { scanIntervalMs: 2000, theme: 'dark' }
    },
    null,
    2
  ),
  'utf8'
)

require(join(ROOT, 'out', 'main', 'index.js'))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let pass = 0
let fail = 0

function check(label, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  PASS  ${label}${detail ? ` - ${detail}` : ''}`)
  } else {
    fail++
    console.log(`  FAIL  ${label}${detail ? ` - ${detail}` : ''}`)
  }
}

async function waitFor(label, predicate, attempts = 60, delay = 150) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await predicate()) return true
    await sleep(delay)
  }
  check(`waited for ${label}`, false)
  return false
}

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  const js = (code) => win.webContents.executeJavaScript(code, true)

  try {
    if (win.webContents.isLoading()) {
      await new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
    }
    win.setBounds({ width: 1500, height: 940 })

    const navigated = await js(`(() => {
      const button = document.querySelector('nav button[aria-label="服务"]')
      if (!button) return false
      button.click()
      return true
    })()`)
    check('services navigation is available', navigated === true)
    await waitFor('seed rows', () => js(`document.querySelectorAll('.svc-row[data-entry-id]').length === 4`))

    console.log('\n=== 1. Edit a category through the config tab ===')
    const opened = await js(`(async () => {
      const row = document.querySelector('.svc-row[data-entry-id="site-service"]')
      if (!row) return false
      row.click()
      await new Promise((r) => setTimeout(r, 300))
      const tab = [...document.querySelectorAll('.svc-detail [role="tab"]')].find((t) => t.textContent.includes('配置'))
      if (!tab) return false
      tab.click()
      return true
    })()`)
    check('entry editor opens', opened === true)
    const categoryInputReady = await waitFor('category input', () =>
      js(`Boolean(document.querySelector('.svc-detail [data-entry-category-input]'))`)
    )
    check('editor exposes a category input', categoryInputReady === true)

    if (categoryInputReady) {
      await js(`(() => {
        const input = document.querySelector('.svc-detail [data-entry-category-input]')
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(input, '网站控制台')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      await waitFor('save bar', () => js(`Boolean(document.querySelector('.svc-savebar'))`))
      await js(`(() => {
        const save = [...document.querySelectorAll('.svc-savebar button')].find((b) => b.textContent.trim() === '保存')
        if (!save) return false
        save.click()
        return true
      })()`)
    }

    const categorySaved = await waitFor('category persistence', () =>
      js(`window.mile.entry.list().then((items) =>
        items.find((item) => item.id === 'site-service')?.category === '网站控制台')`)
    )
    check('edited category persists through IPC', categorySaved === true)
    const diskSite = JSON.parse(readFileSync(CONFIG, 'utf8')).entries.find((item) => item.id === 'site-service')
    check('edited category persists in config.json', diskSite?.category === '网站控制台')

    console.log('\n=== 2. Category shows as a row tag and is searchable ===')
    await js(`(() => { const b = document.querySelector('.svc-detail [aria-label="关闭详情"]'); b && b.click(); return true })()`)
    await waitFor('detail closed', () => js(`!document.querySelector('.svc-detail')`))
    const tagOf = (id) => js(`(document.querySelector('.svc-row[data-entry-id="${id}"] .svc-cat') || {}).textContent || null`)
    check('categorized service shows its category tag', (await tagOf('admin-service')) === '后台管理系统', String(await tagOf('admin-service')))
    check('categorized task shows its category tag', (await tagOf('admin-task')) === '后台管理系统', String(await tagOf('admin-task')))
    check('edited service shows the new category', await waitFor('new tag', async () => (await tagOf('site-service')) === '网站控制台'))
    check('blank category shows no tag', (await tagOf('unclassified-task')) === null)

    const search = (v) => js(`(() => {
      const i = document.querySelector('input[aria-label="搜索服务"]')
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      set.call(i, ${JSON.stringify(v)})
      i.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    const rowIds = () => js(`[...document.querySelectorAll('.svc-row[data-entry-id]')].map((r) => r.dataset.entryId).sort().join(',')`)
    await search('后台管理')
    const hits = await waitFor('category search', async () => (await rowIds()) === 'admin-service,admin-task')
    check('search matches category name', hits, await rowIds())
    await search('')
    check('clearing search restores all rows', await waitFor('all rows', async () => (await rowIds()).split(',').length === 4), await rowIds())
  } catch (error) {
    console.log('HARNESS ERROR', error)
    fail++
  }

  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    console.log(`sandbox retained: ${SANDBOX}`)
  }
  console.log(`\nResult: ${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
})
