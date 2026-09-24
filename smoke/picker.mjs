// Captures the connection picker with a realistic set of profiles — including a
// managed-host name long enough to test the truncation — with the row menu open.
//
// Run: npm run dev -- --port 3113   then
//      node_modules/electron/dist/electron.exe smoke/picker.mjs
//
// If that exits with "electron does not provide an export named 'app'", the
// shell has ELECTRON_RUN_AS_NODE=1 set (VS Code's terminal does): unset it, or
// the binary runs as plain Node and `electron` resolves to the npm shim.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'

import { registerDatabaseIpc } from '../electron/ipc.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const URL = process.env.APP_URL ?? 'http://127.0.0.1:3113'
const OUT = process.env.SHOT_DIR ?? path.join(ROOT, 'shots')

const DATA = path.join(app.getPath('temp'), 'dbison-smoke-picker')
app.setPath('userData', DATA)

const PROFILES = [
  {
    id: 'p1',
    name: 'Production cluster',
    driver: 'postgres',
    host: 'db-postgresql-fra1-51234-do-user-9876543-0.m.db.ondigitalocean.com',
    port: 25060,
    database: 'defaultdb',
    username: 'doadmin',
    ssl: true,
  },
  { id: 'p2', name: 'Local dev', driver: 'postgres', host: 'localhost', port: 5432, database: 'app_dev', username: 'postgres' },
  { id: 'p3', name: 'Analytics replica', driver: 'mysql', host: 'analytics-replica-eu-west-1.cluster-ro-cxyz123abc.eu-west-1.rds.amazonaws.com', port: 3306, database: 'warehouse', username: 'reader' },
  { id: 'p4', name: 'Scratch', driver: 'sqlite', file: 'C:/Users/alice/Documents/notes/scratchpad-experiments.sqlite3' },
  { id: 'p5', name: 'Staging', driver: 'mariadb', host: 'staging.internal', port: 3306, database: 'shop', username: 'root' },
  { id: 'p6', name: 'Legacy billing', driver: 'mysql', host: '10.0.14.221', port: 3306, database: 'billing_legacy_2019', username: 'svc_billing' },
]

const errors = []

app.whenReady().then(async () => {
  await fs.mkdir(DATA, { recursive: true })
  await fs.writeFile(
    path.join(DATA, 'connections.json'),
    JSON.stringify({ version: 1, profiles: PROFILES }, null, 2),
    'utf8',
  )

  await registerDatabaseIpc()
  await fs.mkdir(OUT, { recursive: true })

  const win = new BrowserWindow({
    show: true,
    width: 1440,
    height: 900,
    webPreferences: {
      preload: path.join(ROOT, 'electron', 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })

  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') errors.push(String(e.message).slice(0, 300))
  })

  const run = (js) => win.webContents.executeJavaScript(js).catch((e) => `ERR: ${e.message}`)
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  const shot = async (name, rect) => {
    const image = await win.webContents.capturePage(rect)
    await fs.writeFile(path.join(OUT, `${name}.png`), image.toPNG())
    console.log('shot:', name)
  }

  const move = async (x, y) => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
    await wait(200)
  }

  const clickAt = async (x, y) => {
    await move(x, y)
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    await wait(500)
  }

  /** Centre of the first element matching `selector`, in window coordinates. */
  const centre = (selector) => run(`(function () {
    var el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    var r = el.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`)

  win.loadURL(URL).catch((e) => console.log('loadURL rejected:', e.message))
  await wait(12000)
  console.log('loaded:', await run('document.title'))

  // A fresh window opens with the explorer at whatever dockview gives it; drag
  // the sash so the panel is the ~300px width the app actually starts at.
  const sash = await centre('.dv-sash, .sash, .dv-resize-container')
  const WANT = Number(process.env.SIDEBAR ?? 300)
  if (sash && sash.x) {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: sash.x, y: sash.y })
    win.webContents.sendInputEvent({ type: 'mouseDown', x: sash.x, y: sash.y, button: 'left', clickCount: 1 })
    for (let x = sash.x; x > WANT; x -= 40) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y: sash.y })
      await wait(16)
    }
    win.webContents.sendInputEvent({ type: 'mouseMove', x: WANT, y: sash.y })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: WANT, y: sash.y, button: 'left', clickCount: 1 })
    await wait(600)
  }
  console.log('sash:', JSON.stringify(sash))

  for (const theme of ['dark', 'light']) {
    await run(`document.documentElement.dataset.theme = '${theme}'; localStorage.setItem('dbison.theme','${theme}')`)
    await wait(400)

    // The switcher is the first button in the explorer panel.
    const trigger = await centre('[data-testid="connection-switcher"]')
      ?? await centre('.dv-view button')
    console.log('trigger:', JSON.stringify(trigger))
    if (!trigger || !trigger.x) break

    await clickAt(trigger.x, trigger.y)
    await wait(500)

    // Park the pointer over the second row so its overflow button shows.
    const row = await run(`(function () {
      var rows = document.querySelectorAll('[role="option"]')
      if (rows.length < 2) return { count: rows.length }
      var r = rows[1].getBoundingClientRect()
      var b = rows[1].querySelector('button')
      var panel = rows[1].closest('.popover').getBoundingClientRect()
      return {
        x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
        bx: b && Math.round(b.getBoundingClientRect().x + b.getBoundingClientRect().width / 2),
        by: b && Math.round(b.getBoundingClientRect().y + b.getBoundingClientRect().height / 2),
        panel: { x: Math.round(panel.x), y: Math.round(panel.y), w: Math.round(panel.width), h: Math.round(panel.height) },
        count: rows.length,
      }
    })()`)
    console.log('row:', JSON.stringify(row))

    if (row && row.x) {
      await move(row.x, row.y)
      await wait(400)
    }

    await shot(`picker-${theme}-full`)

    // The overflow menu, opened from the row that is hovered.
    if (row && row.bx) {
      await clickAt(row.bx, row.by)
      await wait(500)
      console.log('menus open:', await run(`document.querySelectorAll('[role="menu"]').length`))
      console.log('list still open:', await run(`document.querySelectorAll('[role="listbox"]').length`))
      await shot(`picker-${theme}-menu`)
      await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
      await wait(300)
    }

    await run(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await run(`document.querySelector('[role="option"]') && document.activeElement.blur()`)
    await clickAt(900, 500)
    await wait(400)
  }

  console.log('console errors:', JSON.stringify(errors.slice(0, 8), null, 2))
  app.quit()
})
