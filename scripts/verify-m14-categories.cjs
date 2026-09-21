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
      const button = document.querySelector('nav button[aria-label="前端启动台"]')
      if (!button) return false
      button.click()
      return true
    })()`)
    check('launchpad navigation is available', navigated === true)
    await waitFor('seed cards', () => js(`document.querySelectorAll('[data-entry-id]').length === 4`))

    console.log('\n=== 1. Edit a category through the real panel ===')
    const opened = await js(`(() => {
      const card = document.querySelector('[data-entry-id="site-service"]')
      const edit = [...(card?.querySelectorAll('button') ?? [])]
        .find((button) => button.getAttribute('aria-label') === '编辑')
      if (!edit) return false
      edit.click()
      return true
    })()`)
    check('entry editor opens', opened === true)
    const categoryInputReady = await waitFor('category input', () =>
      js(`Boolean(document.querySelector('[aria-labelledby="edit-entry-title"] [data-entry-category-input]'))`)
    )
    check('editor exposes a category input', categoryInputReady === true)

    if (categoryInputReady) {
      await js(`(() => {
        const input = document.querySelector('[data-entry-category-input]')
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(input, '网站控制台')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      await js(`(() => {
        const dialog = document.querySelector('[aria-labelledby="edit-entry-title"]')
        const save = [...dialog.querySelectorAll('button')].find((button) => button.textContent.trim() === '保存')
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

    console.log('\n=== 2. Group services and tasks in collapsible category panels ===')
    const panels = await js(`(() => [...document.querySelectorAll('[data-category-panel]')].map((panel) => ({
      name: panel.getAttribute('data-category-name'),
      expanded: panel.querySelector('[data-category-toggle]')?.getAttribute('aria-expanded'),
      ids: [...panel.querySelectorAll('[data-entry-id]')].map((card) => card.getAttribute('data-entry-id'))
    })))()`)
    const admin = panels.find((panel) => panel.name === '后台管理系统')
    const uncategorized = panels.find((panel) => panel.name === '未分类')
    const site = panels.find((panel) => panel.name === '网站控制台')
    check('admin category contains its service and task',
      admin && admin.ids.includes('admin-service') && admin.ids.includes('admin-task'), JSON.stringify(admin))
    check('blank category falls back to 未分类',
      uncategorized && uncategorized.ids.includes('unclassified-task'), JSON.stringify(uncategorized))
    check('edited service moves to its chosen category',
      site && site.ids.includes('site-service'), JSON.stringify(site))

    const categoryState = () => js(`(() => {
      const panel = [...document.querySelectorAll('[data-category-panel]')]
        .find((item) => item.getAttribute('data-category-name') === '后台管理系统')
      const toggle = panel?.querySelector('[data-category-toggle]')
      const content = panel?.querySelector('[data-category-content]')
      return toggle ? {
        expanded: toggle.getAttribute('aria-expanded'),
        hidden: content?.hidden === true,
        ids: [...(panel?.querySelectorAll('[data-entry-id]') ?? [])]
          .map((card) => card.getAttribute('data-entry-id'))
      } : null
    })()`)
    const clickCategoryToggle = () => js(`(() => {
      const panel = [...document.querySelectorAll('[data-category-panel]')]
        .find((item) => item.getAttribute('data-category-name') === '后台管理系统')
      const toggle = panel?.querySelector('[data-category-toggle]')
      if (!toggle) return false
      toggle.click()
      return true
    })()`)

    const collapseClicked = await clickCategoryToggle()
    const collapsedReady = collapseClicked
      ? await waitFor('collapsed category', async () => {
        const state = await categoryState()
        return state?.expanded === 'false' && state.hidden === true
      })
      : false
    const collapsed = await categoryState()
    check('category panel can be collapsed',
      collapsedReady && collapsed?.expanded === 'false' && collapsed?.hidden === true, JSON.stringify(collapsed))

    const expandClicked = await clickCategoryToggle()
    const expandedReady = expandClicked
      ? await waitFor('expanded category', async () => {
        const state = await categoryState()
        return state?.expanded === 'true' && state.hidden === false
      })
      : false
    const expandedAgain = await categoryState()
    check('collapsed category can be expanded again',
      expandedReady && expandedAgain?.expanded === 'true' && expandedAgain?.hidden === false &&
        expandedAgain.ids.includes('admin-service') && expandedAgain.ids.includes('admin-task'),
      JSON.stringify(expandedAgain))
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
