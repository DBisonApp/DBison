// Exercises View > Reset Layout: it must put the explorer back on the left
// with a Welcome tab beside it, rather than leaving an empty window. Also
// checks that a layout saved with everything closed does not restore blank.
// Run: npm run dev -- --port 3113   then   node_modules/electron/dist/electron.exe smoke/resetlayout.mjs
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'

import { registerDatabaseIpc } from '../electron/ipc.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const URL = process.env.APP_URL ?? 'http://127.0.0.1:3113'
const OUT = process.env.SHOT_DIR ?? path.join(ROOT, 'shots')

const USER_DATA = path.join(app.getPath('temp'), 'dbison-smoke-resetlayout')
await fs.rm(USER_DATA, { recursive: true, force: true })
app.setPath('userData', USER_DATA)

const errors = []

app.whenReady().then(async () => {
  await registerDatabaseIpc()
  await fs.mkdir(OUT, { recursive: true })

  const win = new BrowserWindow({
    show: true,
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(ROOT, 'electron', 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  })

  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') errors.push(String(e.message).slice(0, 300))
  })

  const run = (js) => win.webContents.executeJavaScript(js).catch((e) => `ERR: ${e.message}`)
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  const shot = async (name) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const image = await win.webContents.capturePage()
        await fs.writeFile(path.join(OUT, `${name}.png`), image.toPNG())
        console.log('shot:', name)
        return
      }
      catch (e) {
        if (attempt === 2) console.log('shot failed:', name, e.message)
        await wait(800)
      }
    }
  }

  const key = (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  }

  const clickAt = (at) => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y })
    win.webContents.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 })
  }

  const clickMatch = async (selector, text) => {
    const at = await run(`(function () {
      var b = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((x) => x.textContent.trim() === ${JSON.stringify(text)})
      if (!b) return null
      var r = b.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })()`)

    if (!at || typeof at.x !== 'number') return `not found: ${text}`
    clickAt(at)
    return `clicked ${text}`
  }

  /** What the workbench is showing: the tab strip and where the explorer sits. */
  const layout = () => run(`(function () {
    var tabs = [...document.querySelectorAll('.dv-tab')].map((t) => t.textContent.trim())
    var explorer = document.querySelector('.dv-view [data-testid="explorer-panel"], .dv-view')
    var panel = [...document.querySelectorAll('.dv-groupview')].find((g) =>
      [...g.querySelectorAll('.dv-tab')].some((t) => t.textContent.trim().startsWith('Database')))
    var rect = panel ? panel.getBoundingClientRect() : null
    return JSON.stringify({
      tabs: tabs,
      groups: document.querySelectorAll('.dv-groupview').length,
      watermark: !!document.querySelector('.dv-watermark-container'),
      explorerBox: rect ? { x: Math.round(rect.x), width: Math.round(rect.width) } : null,
      newQueryButtons: [...document.querySelectorAll('button')]
        .filter((b) => b.textContent.trim() === 'New query').length,
    })
  })()`)

  /** Waits for the workbench to actually be on screen; a cold Vite is slow. */
  const untilReady = async (label) => {
    for (let i = 0; i < 60; i++) {
      const ready = await run(`document.querySelectorAll('.dv-groupview').length > 0`)
      if (ready === true) return `${label}: ready after ~${i}s`
      await wait(1000)
    }
    return `${label}: TIMED OUT waiting for the workbench`
  }

  win.loadURL(URL).catch((e) => console.log('loadURL rejected:', e.message))
  await wait(6000)
  console.log('loaded:', await run('document.title'))
  console.log(await untilReady('first paint'))
  await run(`document.documentElement.dataset.theme = 'dark'`)
  await wait(800)
  console.log('early console errors:', JSON.stringify(errors.slice(0, 6), null, 2))

  console.log('1. first run:', await layout())
  await shot('reset-1-firstrun')

  // Make the mess the user complained about: no tabs, no explorer. Closing the
  // documents first, so Ctrl+W never lands on the explorer itself.
  key('W', ['control'])
  await wait(900)
  key('1', ['control'])
  await wait(900)
  console.log('2. after Ctrl+W and Ctrl+1:', await layout())
  await shot('reset-2-empty')

  // View > Reset Layout.
  console.log('open View:', await clickMatch('[role="menubar"] [role="menuitem"]', 'View'))
  await wait(700)
  console.log('click Reset Layout:', await clickMatch('[role="menu"] [role="menuitem"]', 'Reset Layout'))
  await wait(1500)
  console.log('3. after Reset Layout:', await layout())
  await shot('reset-3-after')

  // A layout saved with everything closed must not restore blank either.
  key('W', ['control'])
  await wait(700)
  key('1', ['control'])
  await wait(900)
  console.log('4. emptied again:', await layout())
  console.log('   saved layout panels:', await run(
    `Object.keys(JSON.parse(localStorage.getItem('dbison.layout.v1') || '{}').panels || {}).length`,
  ))

  win.webContents.reload()
  await wait(5000)
  console.log(await untilReady('after reload'))
  await wait(800)
  console.log('5. after reload:', await layout())
  await shot('reset-4-reload')

  console.log('console errors:', JSON.stringify(errors.slice(0, 8), null, 2))
  app.quit()
})
