// Captures the connection switcher with one profile per engine, so all four
// Devicon logos are seen side by side in both themes.
// Run: APP_URL=http://[::1]:3113 node_modules/electron/dist/electron.exe smoke-drivericons.mjs
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'

import { registerDatabaseIpc } from './electron/ipc.js'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const URL = process.env.APP_URL ?? 'http://127.0.0.1:3113'
const OUT = process.env.SHOT_DIR ?? path.join(ROOT, 'shots')

app.setPath('userData', path.join(app.getPath('temp'), 'dbison-smoke-drivericons'))

const errors = []

app.whenReady().then(async () => {
  await registerDatabaseIpc()
  await fs.mkdir(OUT, { recursive: true })

  const win = new BrowserWindow({
    show: true, width: 1400, height: 900,
    webPreferences: {
      preload: path.join(ROOT, 'electron', 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      backgroundThrottling: false,
    },
  })
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') errors.push(String(e.message).slice(0, 300))
  })

  const run = (js) => win.webContents.executeJavaScript(js).catch((e) => `ERR: ${e.message}`)
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  win.loadURL(URL).catch((e) => console.log('loadURL rejected:', e.message))
  await wait(12000)
  console.log('loaded:', await run('document.title'))

  const profiles = [
    { name: 'Warehouse', driver: 'postgres', host: 'db.internal', port: 5432, database: 'warehouse', username: 'app' },
    { name: 'Shop', driver: 'mysql', host: 'mysql.internal', port: 3306, database: 'shop', username: 'app' },
    { name: 'Legacy', driver: 'mariadb', host: 'maria.internal', port: 3306, database: 'legacy', username: 'app' },
    { name: 'Local notes', driver: 'sqlite', file: path.join(process.env.TEMP, 'dbison-notes.sqlite') },
  ]
  for (const p of profiles) console.log('save:', JSON.stringify(await run(`window.dbison.profiles.save(${JSON.stringify(p)})`)))

  win.webContents.reload()
  await wait(12000)
  console.log('buttons:', await run(`JSON.stringify([...document.querySelectorAll('button')].map((b) => b.title || b.textContent.trim().slice(0, 30)).filter(Boolean).slice(0, 40))`))
  console.log('text:', await run(`document.body.innerText.slice(0, 400)`))

  console.log('open:', await run(`(function () {
    var b = document.querySelector('button[title*="Choose a connection"], button[title*=" — "]')
    if (!b) return 'not found'
    b.click(); return b.title
  })()`))
  await wait(1200)
  console.log('svgs:', await run(`JSON.stringify([...document.querySelectorAll('svg.driver-icon')].map((s) => s.getBoundingClientRect().width))`))

  for (const theme of ['dark', 'light']) {
    await run(`document.documentElement.dataset.theme = '${theme}'; localStorage.setItem('dbison.theme','${theme}')`)
    await wait(1000)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await wait(800)
      try {
        const image = await win.webContents.capturePage({ x: 0, y: 0, width: 420, height: 360 })
        await fs.writeFile(path.join(OUT, `drivericons-${theme}.png`), image.toPNG())
        console.log('shot:', theme); break
      } catch (e) { console.log('shot failed:', theme, e.message) }
    }
  }

  console.log('errors:', JSON.stringify(errors))
  app.quit()
})
