// Exercises the right-click menus: the explorer's table menu, the result
// grid's header menu and its cell menu, plus the short menu the explorer's
// blank space gets.
// Run: npm run dev -- --port 3113   then   node_modules/electron/dist/electron.exe smoke/context.mjs
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { app, BrowserWindow } from 'electron'

import { registerDatabaseIpc } from '../electron/ipc.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const URL = process.env.APP_URL ?? 'http://localhost:3113'
const DB_FILE = path.join(process.env.TEMP, 'dbison-context.sqlite')

function seed() {
  const db = new DatabaseSync(DB_FILE)
  db.exec('drop table if exists customers')
  db.exec('create table customers (id integer primary key, name text, email text, active integer)')
  db.exec(`insert into customers (name, email, active) values ('Ada','ada@example.com',1),('Grace','grace@example.com',0),('Alan','alan@example.com',1)`)
  db.close()
}

/*
 * A fresh profile directory per run.
 *
 * A fixed one is only clean the first time: the workbench saves its dockview
 * layout to localStorage, so the next run starts with the tabs the last one
 * opened, the explorer pointed somewhere else, and a "Connect" button that
 * belongs to a restored panel rather than to the explorer. Two runs of this
 * file then disagree about the same code, which is worse than no test.
 */
app.setPath('userData', path.join(app.getPath('temp'), `dbison-smoke-context-${Date.now()}`))

const errors = []

app.whenReady().then(async () => {
  seed()
  await registerDatabaseIpc()

  const win = new BrowserWindow({
    show: true, width: 1400, height: 900,
    webPreferences: {
      preload: path.join(ROOT, 'electron', 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
    },
  })
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') errors.push(String(e.message).slice(0, 200))
  })

  const run = (js) => win.webContents.executeJavaScript(js).catch((e) => `ERR: ${e.message}`)
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const step = (m) => console.log('\n— ' + m)

  /**
   * Right-clicks an element by dispatching a real bubbling `contextmenu` event.
   *
   * Electron's `sendInputEvent` does not synthesize one from a right button
   * press, and the menu listens for the DOM event, so this is what the menu
   * actually reacts to in the browser.
   */
  const rightClick = (expr) => run(`(function () {
    var el = ${expr}
    if (!el) return 'no target'
    var r = el.getBoundingClientRect()
    el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2,
      clientX: Math.round(r.x + r.width / 2), clientY: Math.round(r.y + r.height / 2),
    }))
    return 'right-clicked'
  })()`)

  // Matched loosely on purpose. The row's title is "Open customers — 4 columns",
  // not "Open customers": it carries the column count, and the label carries the
  // schema too when the explorer is showing schemas side by side. Two earlier
  // versions of this locator asserted an exact shape and silently found nothing,
  // which reads exactly like a broken menu.
  const ROW = `[...document.querySelectorAll('button[title^="Open "]')].find(function (b) {
    return b.title.indexOf('customers') !== -1
  })`

  /** Polls until `expr` is truthy, so a slow cold compile is not a failure. */
  const until = async (label, expr, ms = 25000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (await run(`!!(${expr})`) === true) return `${label}: ready`
      await wait(1000)
    }
    return `${label}: TIMED OUT`
  }

  const menu = () => run(
    `JSON.stringify([...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((n) => n.textContent.trim()))`,
  )

  const openMenus = () => run(`document.querySelectorAll('[role="menu"]').length`)

  /**
   * Closes the open menu and reports whether it also unmounted.
   *
   * Escape goes in as a DOM event rather than through `sendInputEvent`: the
   * dismiss layer listens on `document`, and OS-level key delivery only lands
   * when the window happens to hold keyboard focus, which it does not reliably
   * here — that flakiness produced two contradictory readings before this.
   *
   * The counts are sampled over time because closing and unmounting are two
   * separate moments: the panel flips to `data-state="closed"` at once, then
   * Reka waits for the exit animation before taking it out of the DOM.
   */
  const closeMenu = async () => {
    await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)

    const samples = []
    for (const ms of [150, 500, 1500]) {
      await wait(ms)
      samples.push(`${ms}ms:${await openMenus()}`)
    }

    const state = await run(`JSON.stringify([...document.querySelectorAll('[role="menu"]')].map((n) => n.getAttribute('data-state')))`)
    return `${samples.join(' ')} leftover=${state}`
  }

  win.loadURL(URL).catch((e) => console.log('loadURL rejected:', e.message))
  await wait(14000)
  win.focus()
  win.webContents.focus()
  console.log('loaded:', await run('document.title'))

  step('saving profile + reloading')
  const profile = await run(`window.dbison.profiles.save({ name: 'Ctx Test', driver: 'sqlite', file: ${JSON.stringify(DB_FILE)} })`)
  await win.webContents.reload()
  await wait(12000)

  step('connecting')
  console.log('connect:', await run(`(function(){
    var b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Connect')
    if(!b) return 'no Connect button'; b.click(); return 'clicked'
  })()`))
  console.log('bridge connect:', await run(`(async () => {
    try {
      const r = await window.dbison.connect(${JSON.stringify(profile.id)})
      return 'ok ' + JSON.stringify(r).slice(0, 200)
    }
    catch (e) { return 'ERR ' + (e && (e.message || JSON.stringify(e))) }
  })()`))
  console.log(await until('customers row', ROW))
  console.log('row title:', await run(`(${ROW})?.title ?? 'none'`))

  step('explorer: right-click the customers row')
  console.log(await rightClick(ROW))
  await wait(700)
  console.log('menu:', await menu())
  console.log('close:', await closeMenu())

  step('explorer: right-click blank space below the list')
  console.log(await rightClick(`document.querySelector('.min-h-0.flex-1.overflow-auto')`))
  await wait(700)
  console.log('menu:', await menu())
  console.log('close:', await closeMenu())

  step('opening the table')
  await run(`(${ROW})?.click()`)
  console.log(await until('grid', `document.querySelectorAll('table tbody tr').length`))
  console.log('grid rows:', await run(`document.querySelectorAll('table tbody tr').length`))

  step('grid: right-click a column header')
  console.log(await rightClick(`document.querySelectorAll('table thead th')[2]`))
  await wait(700)
  console.log('menu:', await menu())
  console.log('close:', await closeMenu())

  step('grid: right-click a cell')
  console.log(await rightClick(`document.querySelectorAll('table tbody tr')[1]?.querySelectorAll('td')[2]`))
  await wait(700)
  console.log('menu:', await menu())
  console.log('close:', await closeMenu())

  step('cleanup')
  await run(`window.dbison.profiles.remove(${JSON.stringify(profile.id)})`)
  console.log('console errors:', JSON.stringify(errors.slice(0, 6), null, 2))
  app.quit()
})
