/**
 * M13 regression: service card icons must be selected through the real editor,
 * persisted as approved identifiers, rendered on the card, and remain safe to
 * change while a service is running.
 */
const { app, BrowserWindow } = require('electron')
const { execFileSync } = require('node:child_process')
const { mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const FIXTURE = join(__dirname, 'fixture')
const CONFIG_ROOT = join(tmpdir(), `mile-m13-icons-${process.pid}`)
const CONFIG = join(CONFIG_ROOT, 'mile-terminal', 'config.json')
const PORT = freePort()

mkdirSync(join(CONFIG_ROOT, 'mile-terminal'), { recursive: true })
app.setPath('appData', CONFIG_ROOT)

const pkgPath = join(FIXTURE, 'package.json')
const pkgOriginal = readFileSync(pkgPath, 'utf8')
const pkg = JSON.parse(pkgOriginal)
pkg.scripts = { ...pkg.scripts, envport: 'node env-port-server.cjs' }
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8')

writeFileSync(
  CONFIG,
  JSON.stringify(
    {
      version: 1,
      entries: [
        entry('icons', 'service', 0, { MILE_TEST_PORT: String(PORT) }),
        entry('task', 'task', 1, {})
      ],
      ignoredListeners: [],
      settings: { scanIntervalMs: 2000 }
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

function entry(id, kind, order, env) {
  return {
    id,
    kind,
    name: id,
    path: FIXTURE,
    framework: 'node',
    packageManager: 'npm',
    script: 'envport',
    scripts: { envport: 'node env-port-server.cjs' },
    env,
    registerOnly: false,
    pinned: false,
    order,
    createdAt: Date.now()
  }
}

function check(label, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  PASS  ${label}${detail ? ` - ${detail}` : ''}`)
  } else {
    fail++
    console.log(`  FAIL  ${label}${detail ? ` - ${detail}` : ''}`)
  }
}

async function waitFor(label, predicate, attempts = 80, delay = 120) {
  for (let index = 0; index < attempts; index++) {
    const value = await predicate()
    if (value) return value
    await sleep(delay)
  }
  check(`waited for ${label}`, false)
  return null
}

function freePort() {
  const text = execFileSync('netstat.exe', ['-ano'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  })
  const used = new Set()
  for (const line of text.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue
    const fields = line.trim().split(/\s+/)
    const port = Number(fields[1]?.slice(fields[1].lastIndexOf(':') + 1))
    if (Number.isInteger(port)) used.add(port)
  }

  const start = 46000 + (process.pid % 5000)
  for (let candidate = start; candidate <= 65000; candidate++) {
    if (!used.has(candidate)) return candidate
  }
  throw new Error('could not find a free fixture port')
}

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    console.log('FAIL no browser window')
    app.exit(1)
    return
  }

  const js = (code) => win.webContents.executeJavaScript(code, true)
  const runtime = (id) =>
    js(`window.mile.entry.runtimes().then(items => items.find(item => item.entryId === ${JSON.stringify(id)}) ?? null)`)

  try {
    if (win.webContents.isLoading()) {
      await new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
    }
    win.setBounds({ width: 1500, height: 940 })

    const navigate = await js(`(() => {
      const button = document.querySelector('nav button[aria-label="启动台"]')
      if (!button) return false
      button.click()
      return true
    })()`)
    check('launchpad navigation is available', navigate === true)
    check(
      'launchpad renders the service card',
      Boolean(await waitFor('icons card', () => js(`Boolean(document.querySelector('article[data-entry-id="icons"]'))`)))
    )

    console.log('\n=== 1. Select and persist an approved icon ===')
    await openEditor(js, 'icons')
    const picker = await waitFor('service icon picker', () => js(`Boolean(document.querySelector('[data-icon-picker]'))`))
    check('service editor exposes an icon picker', picker === true)
    const rocketClicked = await js(`(() => {
      const button = document.querySelector('[data-icon-picker] [data-icon-option="rocket"]')
      if (!button) return false
      button.click()
      return true
    })()`)
    const rocketSelected = await waitFor('rocket selection', () =>
      js(`document.querySelector('[data-icon-picker] [data-icon-option="rocket"]')?.getAttribute('aria-pressed') === 'true'`)
    )
    check('rocket can be selected from the picker', rocketClicked === true && rocketSelected === true)
    await saveEditor(js)

    const storedRocket = await waitFor('rocket entry update', () =>
      js(`window.mile.entry.list().then(entries => entries.find(entry => entry.id === 'icons')?.icon === 'rocket')`)
    )
    check('approved icon persists through the IPC edit', storedRocket === true)
    const diskRocket = JSON.parse(readFileSync(CONFIG, 'utf8')).entries.find((item) => item.id === 'icons')
    check('approved icon persists in config.json', diskRocket?.icon === 'rocket')
    const renderedRocket = await waitFor('rocket card glyph', () =>
      js(`Boolean(document.querySelector('article[data-entry-id="icons"] [data-card-icon="rocket"] svg'))`)
    )
    check('service card renders the selected icon', renderedRocket === true)

    const rejected = await js(`window.mile.entry.edit('icons', { icon: 'untrusted' })
      .then(() => false, () => true)`)
    check('main process rejects an unapproved icon identifier', rejected === true)

    console.log('\n=== 2. Restrict selection to service cards ===')
    await openEditor(js, 'task')
    const taskPicker = await js(`Boolean(document.querySelector('[data-icon-picker]'))`)
    check('task editor does not expose the service icon picker', taskPicker === false)
    await closeEditor(js)

    console.log('\n=== 3. Change a live service without restarting it ===')
    await js(`window.mile.entry.start('icons')`)
    const live = await waitFor('running service', async () => {
      const item = await runtime('icons')
      return item?.status === 'running' ? item : null
    }, 100, 180)
    check('fixture service starts before live icon edit', Boolean(live), String(PORT))

    await openEditor(js, 'icons')
    const cloudEnabled = await js(`(() => {
      const button = document.querySelector('[data-icon-picker] [data-icon-option="cloud"]')
      return Boolean(button && !button.disabled)
    })()`)
    check('icon picker remains enabled while the service is live', cloudEnabled === true)
    const cloudClicked = await js(`(() => {
      const button = document.querySelector('[data-icon-picker] [data-icon-option="cloud"]')
      if (!button) return false
      button.click()
      return true
    })()`)
    const cloudSelected = await waitFor('cloud selection', () =>
      js(`document.querySelector('[data-icon-picker] [data-icon-option="cloud"]')?.getAttribute('aria-pressed') === 'true'`)
    )
    check('cloud can be selected while the service is live', cloudClicked === true && cloudSelected === true)
    await saveEditor(js)

    const cloudLive = await waitFor('live cloud icon', () =>
      js(`Promise.all([window.mile.entry.list(), window.mile.entry.runtimes()]).then(([entries, runtimes]) => {
        const entry = entries.find(value => value.id === 'icons')
        const runtime = runtimes.find(value => value.entryId === 'icons')
        return entry?.icon === 'cloud' && runtime?.status === 'running'
      })`)
    )
    check('live icon edit keeps the service running', cloudLive === true)
    const renderedCloud = await js(`Boolean(document.querySelector('article[data-entry-id="icons"] [data-card-icon="cloud"] svg'))`)
    check('card updates to the live selected icon', renderedCloud === true)

    console.log('\n=== 4. Restore automatic framework glyph ===')
    await openEditor(js, 'icons')
    const automaticClicked = await js(`(() => {
      const button = document.querySelector('[data-icon-picker] [data-icon-option="auto"]')
      if (!button) return false
      button.click()
      return true
    })()`)
    const automaticSelected = await waitFor('automatic selection', () =>
      js(`document.querySelector('[data-icon-picker] [data-icon-option="auto"]')?.getAttribute('aria-pressed') === 'true'`)
    )
    check('automatic framework glyph can be selected', automaticClicked === true && automaticSelected === true)
    await saveEditor(js)
    const reset = await waitFor('automatic icon reset', () =>
      js(`window.mile.entry.list().then(entries => entries.find(entry => entry.id === 'icons')?.icon === undefined)`)
    )
    check('automatic selection clears the runtime icon value', reset === true)
    const diskReset = JSON.parse(readFileSync(CONFIG, 'utf8')).entries.find((item) => item.id === 'icons')
    check('automatic selection removes the persisted icon value', !Object.hasOwn(diskReset, 'icon'))
    const renderedAuto = await js(`Boolean(document.querySelector('article[data-entry-id="icons"] [data-card-icon="auto"]'))`)
    check('card returns to its automatic framework glyph', renderedAuto === true)
  } catch (error) {
    console.log('HARNESS ERROR', error)
    fail++
  }

  try {
    await js(`window.mile.entry.stop('icons').catch(() => null)`)
  } catch {
    // The preload bridge may not have loaded if startup failed.
  }
  writeFileSync(pkgPath, pkgOriginal, 'utf8')
  try {
    rmSync(CONFIG_ROOT, { recursive: true, force: true })
  } catch {
    console.log(`sandbox retained: ${CONFIG_ROOT}`)
  }

  console.log(`\nResult: ${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
})

async function openEditor(js, id) {
  const clicked = await js(`(() => {
    const button = document.querySelector('article[data-entry-id=${JSON.stringify(id)}] button[aria-label="编辑"]')
    if (!button) return false
    button.click()
    return true
  })()`)
  check(`${id} edit button is available`, clicked === true)
  const opened = await waitFor(`${id} editor`, () => js(`Boolean(document.querySelector('[role="dialog"]'))`))
  check(`${id} editor opens`, opened === true)
}

async function saveEditor(js) {
  const clicked = await js(`(() => {
    const button = [...document.querySelectorAll('[role="dialog"] button')]
      .find(item => item.textContent.trim() === '保存')
    if (!button) return false
    button.click()
    return true
  })()`)
  check('editor save button is available', clicked === true)
  const closed = await waitFor('editor save', () => js(`!document.querySelector('[role="dialog"]')`))
  check('editor closes after save', closed === true)
}

async function closeEditor(js) {
  const clicked = await js(`(() => {
    const button = document.querySelector('[role="dialog"] button[aria-label="关闭"]')
    if (!button) return false
    button.click()
    return true
  })()`)
  check('editor close button is available', clicked === true)
  const closed = await waitFor('editor close', () => js(`!document.querySelector('[role="dialog"]')`))
  check('editor closes without saving', closed === true)
}
