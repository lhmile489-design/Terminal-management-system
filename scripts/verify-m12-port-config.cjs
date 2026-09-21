/**
 * M12 regression: changing a port must change the listener configuration, not
 * just the expectedPort bookkeeping field. This harness drives the real
 * renderer and Electron main process.
 */
const { app, BrowserWindow } = require('electron')
const { spawn, execFileSync } = require('node:child_process')
const { mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const FIXTURE = join(__dirname, 'fixture')
const SERVER = join(FIXTURE, 'env-port-server.cjs')
const SANDBOX = join(tmpdir(), `mile-m12-port-${process.pid}`)
const CONFIG = join(SANDBOX, 'mile-terminal', 'config.json')
const SECRET = 'm12-secret-do-not-log'

const [BLOCKER_PORT, MANUAL_PORT, NEXT_PORT] = freePorts(3)

mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
app.setPath('appData', SANDBOX)

const PKG = join(FIXTURE, 'package.json')
const PKG_ORIGINAL = readFileSync(PKG, 'utf8')
const pkg = JSON.parse(PKG_ORIGINAL)
pkg.scripts = { ...pkg.scripts, envport: 'node env-port-server.cjs' }
writeFileSync(PKG, JSON.stringify(pkg, null, 2), 'utf8')

const entry = (id, framework, expectedPort) => ({
  id,
  kind: 'service',
  name: id,
  path: FIXTURE,
  framework,
  packageManager: 'npm',
  script: 'envport',
  scripts: { envport: 'node env-port-server.cjs' },
  env: {},
  ...(expectedPort ? { expectedPort } : {}),
  registerOnly: false,
  pinned: false,
  order: id === 'manual' ? 0 : id === 'next' ? 1 : 2,
  createdAt: Date.now()
})

writeFileSync(
  CONFIG,
  JSON.stringify(
    {
      version: 1,
      entries: [
        entry('manual', 'node'),
        entry('next', 'next', BLOCKER_PORT),
        entry('vite', 'vue-vite', BLOCKER_PORT)
      ],
      ignoredListeners: [],
      settings: { scanIntervalMs: 2000 }
    },
    null,
    2
  ),
  'utf8'
)

const blocker = spawn(process.execPath, [SERVER], {
  env: { ...process.env, MILE_TEST_PORT: String(BLOCKER_PORT) },
  stdio: 'ignore',
  windowsHide: true
})

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

async function waitFor(label, predicate, attempts = 80, delay = 150) {
  for (let index = 0; index < attempts; index++) {
    const value = await predicate()
    if (value) return value
    await sleep(delay)
  }
  check(`waited for ${label}`, false)
  return null
}

function listeningPorts() {
  const text = execFileSync('netstat.exe', ['-ano'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  })
  const ports = new Set()
  for (const line of text.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue
    const fields = line.trim().split(/\s+/)
    const port = Number(fields[1]?.slice(fields[1].lastIndexOf(':') + 1))
    if (Number.isInteger(port)) ports.add(port)
  }
  return ports
}

function freePorts(count) {
  const used = listeningPorts()
  const picked = []
  const start = 42000 + (process.pid % 6000)
  for (let candidate = start; candidate <= 65000 && picked.length < count; candidate++) {
    if (!used.has(candidate)) picked.push(candidate)
  }
  if (picked.length !== count) throw new Error('could not find free fixture ports')
  return picked
}

function inputValueScript(selector, value) {
  return `(() => {
    const input = document.querySelector(${JSON.stringify(selector)})
    if (!input) return false
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(input, ${JSON.stringify(String(value))})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`
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
    js(`window.mile.entry.runtimes().then(list => list.find(item => item.entryId === ${JSON.stringify(id)}) ?? null)`)

  try {
    await new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
    win.setBounds({ width: 1500, height: 940 })

    check(
      'external blocker listens on its configured port',
      Boolean(await waitFor('blocker listener', () => Promise.resolve(listeningPorts().has(BLOCKER_PORT)))),
      String(BLOCKER_PORT)
    )

    await js(`document.querySelector('nav button[aria-label="前端启动台"]')?.click()`)
    check(
      'launchpad rendered its entries',
      Boolean(await waitFor('manual entry card', () => js(`Boolean(document.querySelector('article[data-entry-id="manual"]'))`)))
    )

    await js(`document.querySelector('article[data-entry-id="manual"] button[aria-label="编辑"]')?.click()`)
    const editor = await waitFor('environment editor', () =>
      js(`Boolean(document.querySelector('[data-env-editor]'))`)
    )
    check('edit dialog exposes an environment editor', editor === true)
    if (!editor) throw new Error('environment editor is missing')

    await js(`(() => {
      const root = document.querySelector('[data-env-editor]')
      const add = root?.querySelector('button[aria-label="添加环境变量"]')
      add?.click()
      add?.click()
      return true
    })()`)
    const rowsReady = await waitFor('two environment rows', () =>
      js(`document.querySelectorAll('[data-env-row]').length === 2`)
    )
    check('environment editor adds two rows', rowsReady === true)
    if (!rowsReady) throw new Error('environment rows did not render')

    const inserted = await js(`(() => {
      const root = document.querySelector('[data-env-editor]')
      const rows = [...(root?.querySelectorAll('[data-env-row]') ?? [])]
      const set = (input, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const first = rows[0]
      const second = rows[1]
      const firstKey = first?.querySelector('input[data-env-key]')
      const firstValue = first?.querySelector('input[data-env-value]')
      const secondKey = second?.querySelector('input[data-env-key]')
      const secondValue = second?.querySelector('input[data-env-value]')
      if (!firstKey || !firstValue || !secondKey || !secondValue) return false
      set(firstKey, 'MILE_TEST_PORT')
      set(firstValue, ${JSON.stringify(String(MANUAL_PORT))})
      set(secondKey, 'MILE_TEST_SECRET')
      set(secondValue, ${JSON.stringify(SECRET)})
      return firstValue.type === 'password' && secondValue.type === 'password'
    })()`)
    check('environment key/value rows accept masked values', inserted === true)
    await sleep(80)
    await js(`(() => [...document.querySelectorAll('[role="dialog"] button')]
      .find(button => button.textContent.trim() === '保存')?.click())()`)

    const savedManual = await waitFor('manual environment persistence', () =>
      js(`window.mile.entry.list().then(entries => {
        const item = entries.find(entry => entry.id === 'manual')
        return item?.env?.MILE_TEST_PORT === ${JSON.stringify(String(MANUAL_PORT))} &&
          item?.env?.MILE_TEST_SECRET === ${JSON.stringify(SECRET)}
      })`)
    )
    check('edited environment persists on the entry', savedManual === true)

    await js(`window.mile.entry.start('manual')`)
    const manualRuntime = await waitFor('manual listener on injected port', async () => {
      const item = await runtime('manual')
      return item?.port === MANUAL_PORT ? item : null
    }, 100, 200)
    check('manual environment changes the actual listener port', Boolean(manualRuntime), String(MANUAL_PORT))

    const [diagnosis, logs] = await Promise.all([
      js(`window.mile.entry.diagnose('manual')`),
      js(`window.mile.log.query({ limit: 500 })`)
    ])
    const diagnosticText = JSON.stringify(diagnosis)
    const logText = JSON.stringify(logs)
    check('diagnosis includes the environment key', diagnosis.envKeys.includes('MILE_TEST_SECRET'))
    check('diagnosis does not expose the secret value', !diagnosticText.includes(SECRET))
    check('logs do not expose the secret value', !logText.includes(SECRET))

    await js(`document.querySelector('article[data-entry-id="manual"] button[aria-label="编辑"]')?.click()`)
    const locked = await waitFor('environment controls to lock while live', () =>
      js(`(() => {
        const root = document.querySelector('[data-env-editor]')
        if (!root) return null
        const controls = [...root.querySelectorAll('input, button')]
        return controls.length > 0 && controls.every(control => control.disabled)
      })()`)
    )
    check('environment variables are locked while the service runs', locked === true)
    await js(`document.querySelector('[role="dialog"] button[aria-label="关闭"]')?.click()`)
    await js(`window.mile.entry.stop('manual')`)
    await waitFor('manual service to stop', async () => {
      const item = await runtime('manual')
      return item && ['stopped', 'crashed'].includes(item.status)
    })

    await js(`window.mile.scanner.refresh()`)
    check(
      'scanner sees the external blocker',
      Boolean(await waitFor('blocker in snapshot', () =>
        js(`window.mile.scanner.snapshot().then(snapshot => Boolean(snapshot?.listeners
          .some(listener => listener.ports.includes(${BLOCKER_PORT}))))`), 80, 300
      ))
    )

    await resolvePortFromCard(js, 'next', NEXT_PORT)
    const nextEntry = await waitFor('Next port fix persistence', () =>
      js(`window.mile.entry.list().then(entries => {
        const item = entries.find(entry => entry.id === 'next')
        return item?.expectedPort === ${NEXT_PORT} && item?.env?.PORT === ${JSON.stringify(String(NEXT_PORT))}
      })`)
    )
    check('Next repair updates PORT and expectedPort together', nextEntry === true)
    await js(`window.mile.entry.start('next')`)
    const nextRuntime = await waitFor('Next listener on repaired port', async () => {
      const item = await runtime('next')
      return item?.port === NEXT_PORT ? item : null
    }, 100, 200)
    check('Next repair changes the actual listener port', Boolean(nextRuntime), String(NEXT_PORT))
    await js(`window.mile.entry.stop('next')`)
    await waitFor('Next service to stop', async () => {
      const item = await runtime('next')
      return item && ['stopped', 'crashed'].includes(item.status)
    })

    await js(`document.querySelector('article[data-entry-id="vite"] button[aria-label="诊断"]')?.click()`)
    const manualDialog = await waitFor('manual port guidance', () =>
      js(`(() => {
        const button = [...document.querySelectorAll('button')]
          .find(item => item.textContent.includes('改用其他端口'))
        button?.click()
        const dialog = document.querySelector('[data-port-fix-mode="manual"]')
        return dialog ? !dialog.querySelector('input[type="number"]') : null
      })()`)
    )
    check('unknown frameworks receive guidance instead of a guessed port key', manualDialog === true)
    const vite = await js(`window.mile.entry.list().then(entries => entries.find(entry => entry.id === 'vite'))`)
    check(
      'manual guidance leaves the bookkeeping port unchanged',
      vite.expectedPort === BLOCKER_PORT && vite.env.PORT === undefined
    )
  } catch (error) {
    console.log('HARNESS ERROR', error)
    fail++
  }

  try {
    await js(`Promise.all(['manual', 'next', 'vite'].map(id => window.mile.entry.stop(id).catch(() => null)))`)
  } catch {
    // The app may have failed before the preload bridge was ready.
  }
  blocker.kill()
  writeFileSync(PKG, PKG_ORIGINAL, 'utf8')
  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    console.log(`sandbox retained: ${SANDBOX}`)
  }

  console.log(`\nResult: ${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
})

async function resolvePortFromCard(js, id, port) {
  await js(`document.querySelector('article[data-entry-id=${JSON.stringify(id)}] button[aria-label="诊断"]')?.click()`)
  const clicked = await waitFor('port repair button', () =>
    js(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find(item => item.textContent.includes('改用其他端口'))
      if (!button) return false
      button.click()
      return true
    })()`)
  )
  check(`${id} exposes a port repair action`, clicked === true)
  if (!clicked) throw new Error(`${id} has no port repair action`)

  const dialog = await waitFor('Next port repair dialog', () =>
    js(`(() => {
      const root = document.querySelector('[data-port-fix-mode="next"]')
      return root ? Boolean(root.querySelector('input[type="number"]')) : false
    })()`)
  )
  check('Next port repair uses the known PORT environment key', dialog === true)
  if (!dialog) throw new Error('Next port repair dialog is missing')

  const set = await js(inputValueScript('[data-port-fix-mode="next"] input[type="number"]', port))
  check('Next port repair accepts a new port', set === true)
  await js(`(() => [...document.querySelectorAll('[data-port-fix-mode="next"] button')]
    .find(button => button.textContent.trim() === '保存')?.click())()`)
}
