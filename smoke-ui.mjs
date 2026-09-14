// Captures the shell in both themes, for eyeballing a visual change.
// Run: npm run dev -- --port 3113   then   node_modules/electron/dist/electron.exe smoke-ui.mjs
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'

import { registerDatabaseIpc } from './electron/ipc.js'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const URL = process.env.APP_URL ?? 'http://127.0.0.1:3113'
const OUT = process.env.SHOT_DIR ?? path.join(ROOT, 'shots')

// Its own profile directory, so a capture can run alongside the real app
// instead of fighting it for the shared one. It also means a fresh window:
// no saved layout, no stored connections.
app.setPath('userData', path.join(app.getPath('temp'), 'dbison-smoke-ui'))

const errors = []

app.whenReady().then(async () => {
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
  win.webContents.on('did-fail-load', (_e, code, desc) => console.log('did-fail-load', code, desc))

  const run = (js) => win.webContents.executeJavaScript(js).catch((e) => `ERR: ${e.message}`)
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  const shot = async (name, rect) => {
    const image = await win.webContents.capturePage(rect)
    await fs.writeFile(path.join(OUT, `${name}.png`), image.toPNG())
    console.log('shot:', name)
  }

  const setTheme = (t) =>
    run(`document.documentElement.dataset.theme = '${t}'; localStorage.setItem('dbison.theme','${t}')`)

  /** Clicks the first button whose visible text contains `text`. */
  const click = (text) => run(`(function () {
    var b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes(${JSON.stringify(text)}))
    if (!b) return 'not found'
    b.click()
    return 'clicked'
  })()`)

  // Not awaited: loadURL only settles once every subresource has, and a dev
  // build keeps an HMR socket open — the fixed wait below is the real signal.
  win.loadURL(URL).catch((e) => console.log('loadURL rejected:', e.message))
  await wait(12000)
  console.log('loaded:', await run('document.title'))

  await setTheme('dark')
  await wait(500)

  // The mark at menu-bar size, captured at the device pixel ratio.
  await shot('01-mark-chrome', { x: 0, y: 0, width: 200, height: 44 })

  console.log('connect:', await click('Connect'))
  await wait(7000)
  await shot('02-grid-dark')

  // Park the pointer over a cell so the crosshair and row hover are visible.
  const cell = await run(`(function () {
    var tr = document.querySelectorAll('table tbody tr')[4]
    if (!tr) return null
    var c = tr.querySelectorAll('td')[3] || tr.querySelectorAll('td')[1]
    if (!c) return null
    var r = c.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`)
  console.log('cell:', JSON.stringify(cell))

  if (cell && cell.x) {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: cell.x, y: cell.y })
    await wait(500)
    win.webContents.sendInputEvent({ type: 'mouseDown', x: cell.x, y: cell.y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: cell.x, y: cell.y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseMove', x: cell.x, y: cell.y })
    await wait(600)
    await shot('03-grid-hover-dark')
  }

  await setTheme('light')
  await wait(700)
  await shot('04-grid-light')

  console.log('console errors:', JSON.stringify(errors.slice(0, 8), null, 2))
  app.quit()
})
