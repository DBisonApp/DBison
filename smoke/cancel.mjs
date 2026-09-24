import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { app, BrowserWindow } from 'electron'

import { registerDatabaseIpc } from '../electron/ipc.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const URL = 'http://127.0.0.1:3113'
const DB_FILE = path.join(process.env.TEMP, 'dbison-cancel-ui.sqlite')

function seed() {
  const db = new DatabaseSync(DB_FILE)
  db.exec('drop table if exists big')
  db.exec('create table big (id integer primary key, v text)')
  db.exec(`insert into big (v) select 'x' from (with recursive c(x) as (select 1 union all select x+1 from c where x < 150000) select x from c)`)
  db.close()
}

const errors = []

app.whenReady().then(async () => {
  seed()
  await registerDatabaseIpc()

  const win = new BrowserWindow({
    show: false, width: 1400, height: 900,
    webPreferences: {
      preload: path.join(ROOT, 'electron', 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
    },
  })
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') errors.push(String(e.message).slice(0, 200))
  })

  await win.loadURL(URL)
  await new Promise((r) => setTimeout(r, 7000))

  const step = (m) => console.log('STEP:', m)
  const run = (js) => win.webContents.executeJavaScript(js)
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  step('saving profile')
  const profile = await run(`window.dbison.profiles.save({ name: 'Cancel Test', driver: 'sqlite', file: ${JSON.stringify(DB_FILE)} })`)
  step('reloading')
  await win.webContents.reload()
  await wait(7000)

  // Connect, then open a query tab from the navigator toolbar.
  step('clicking connection')
  await run(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Cancel Test'))?.click()`)
  await wait(1500)
  step('opening query tab')
  const btn = await run(`(function () {
    var b = document.querySelector('button[title="New query"]')
    if (!b) return { found: false }
    var info = { found: true, disabled: b.disabled, title: b.title }
    b.click()
    return info
  })()`)
  console.log('NEWQUERY BUTTON:', JSON.stringify(btn))
  await wait(2000)

  console.log('AFTER CLICK:', JSON.stringify(await run(`(function () {
    return {
      textareas: document.querySelectorAll('textarea').length,
      tabs: Array.prototype.map.call(document.querySelectorAll('.dv-default-tab-content'), function (e) { return e.textContent.trim() }),
      buttons: Array.prototype.map.call(document.querySelectorAll('button'), function (b) { return b.textContent.trim() }).filter(Boolean).slice(0, 20),
    }
  })()`)))

  const before = await run(`[...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean)`)

  step('clicking run')
  await run(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Run')?.click()`)
  await wait(1200)

  const during = await run(`(() => ({
    stopVisible: [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Stop'),
    runVisible: [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Run'),
    summary: document.body.innerText.match(/Executing…[^\n]*/)?.[0] ?? null,
  }))()`)

  const t0 = Date.now()
  await run(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Stop')?.click()`)

  // Poll until the panel reports the outcome.
  let after = null
  for (let i = 0; i < 40; i++) {
    await wait(250)
    after = await run(`(function () {
      var labels = Array.prototype.map.call(document.querySelectorAll('button'), function (b) { return b.textContent.trim() })
      return {
        cancelled: document.body.innerText.indexOf('Cancelled') !== -1,
        stillRunning: labels.indexOf('Stop') !== -1,
      }
    })()`)
    if (after.cancelled) break
  }
  const stoppedInMs = Date.now() - t0

  console.log('RUN button before:', JSON.stringify(before.filter((t) => t === 'Run' || t === 'Stop')))
  console.log('DURING:', JSON.stringify(during))
  console.log('AFTER:', JSON.stringify(after), 'stopped in', stoppedInMs, 'ms')

  // The connection must survive a cancel.
  await run(`(() => {
    const ta = document.querySelector('textarea')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, 'select count(*) from big')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await wait(300)
  await run(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Run')?.click()`)
  await wait(2500)

  console.log('AFTER CANCEL, next query:', JSON.stringify(await run(`(function () {
    var th = Array.prototype.map.call(document.querySelectorAll('table thead th'), function (e) { return e.textContent.trim() })
    var cell = document.querySelector('table tbody tr td:nth-child(2)')
    return { headers: th, firstCell: cell ? cell.textContent.trim() : null }
  })()`)))

  console.log('CONSOLE ERRORS:', JSON.stringify(errors))

  const image = await win.webContents.capturePage()
  await (await import('node:fs/promises')).writeFile(path.join(ROOT, 'cancel.png'), image.toPNG())

  await run(`window.dbison.profiles.remove(${JSON.stringify(profile.id)})`)
  app.quit()
})
