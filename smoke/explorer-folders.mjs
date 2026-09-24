// Folders in the connection switcher can be renamed and removed, and the
// explorer's sections fold shut and stay shut. Run with
// `npm run smoke explorer-folders`.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { rm, writeFile } from 'node:fs/promises'
import { app, BrowserWindow } from 'electron'

import { registerDatabaseIpc } from '../electron/ipc.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const APP_URL = process.env.APP_URL ?? 'http://[::1]:3113'
const DB_FILE = path.join(process.env.TEMP, 'dbison-folders.sqlite')

const USER_DATA = path.join(app.getPath('temp'), 'dbison-smoke-folders')
await rm(USER_DATA, { recursive: true, force: true })
app.setPath('userData', USER_DATA)

const failures = []
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${String(detail).slice(0, 300)}` : ''}`)
  if (!ok) failures.push(label)
}

app.whenReady().then(async () => {
  const db = new DatabaseSync(DB_FILE)
  db.exec(`
    drop table if exists audit; drop table if exists users;
    create table users (id integer primary key, name text);
    create table audit (id integer primary key autoincrement, note text);
    create trigger if not exists users_audit after insert on users begin insert into audit (note) values ('x'); end;
  `)
  db.close()
  await registerDatabaseIpc()

  const win = new BrowserWindow({
    show: false, width: 1400, height: 900,
    webPreferences: {
      preload: path.join(ROOT, 'electron', 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      backgroundThrottling: false,
    },
  })

  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const run = async (label, js) => {
    try { return await win.webContents.executeJavaScript(js) }
    catch (error) { console.log('!! failed:', label, String(error).slice(0, 200)); return null }
  }
  const menuItem = (text) => run(`menu ${text}`, `(function () {
    var item = [...document.querySelectorAll('[role="menuitem"]')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)}))
    if (!item) return 'not found: ' + [...document.querySelectorAll('[role="menuitem"]')].map((x) => x.textContent.trim()).join(' | ')
    item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
    item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }))
    item.click(); return 'selected'
  })()`)
  const dialogText = () => run('dialog', `(function () { var all = document.querySelectorAll('.app-dialog-card:not([data-state="closed"])'); var d = all[all.length - 1]; return d ? d.innerText : '' })()`)
  const setDialogInput = (value) => run('input', `(function () {
    var all = document.querySelectorAll('.app-dialog-card:not([data-state="closed"])'); var d = all[all.length - 1]; if (!d) return 'no dialog'
    var el = d.querySelector('input:not([type=checkbox])'); if (!el) return 'no input'
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true })); return 'set'
  })()`)
  const clickDialogButton = (text) => run(`dialog ${text}`, `(function () {
    var all = document.querySelectorAll('.app-dialog-card:not([data-state="closed"])'); var d = all[all.length - 1]; if (!d) return 'no dialog'
    var b = [...d.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (b) b.click(); return b ? 'clicked' : 'no button'
  })()`)

  const shot = async (name) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const img = await win.webContents.capturePage()
        await writeFile(path.join(ROOT, 'shots', `${name}.png`), img.toPNG())
        return
      }
      catch { await wait(800) }
    }
  }

  /** Waits, up to a few seconds, for the stored profiles to read a certain way. */
  const settled = async (done) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const text = await run('profiles poll', `window.dbison.profiles.list().then((r) => JSON.stringify(r.profiles.map((p) => [p.name, p.folder || ''])))`)
      if (done(text ?? '')) return
      await wait(300)
    }
  }

  await win.loadURL(APP_URL)
  await wait(8000)

  await run('save a', `window.dbison.profiles.save({ name: 'Alpha', driver: 'sqlite', file: ${JSON.stringify(DB_FILE)}, folder: 'Clients' })`)
  await run('save b', `window.dbison.profiles.save({ name: 'Beta', driver: 'sqlite', file: ${JSON.stringify(DB_FILE)}, folder: 'Clients' })`)
  await run('save c', `window.dbison.profiles.save({ name: 'Solo', driver: 'sqlite', file: ${JSON.stringify(DB_FILE)} })`)
  await win.webContents.reload()
  await wait(9000)

  // --- open the switcher, find the folder heading and its menu
  // The switcher trigger is the first button in the explorer panel, opened
  // with a real click at its centre: Reka listens for the pointer, not click().
  const openSwitcher = async () => {
    const box = await run('trigger', `(function () { var b = document.querySelector('.dv-view button'); if (!b) return null; var r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`)
    if (!box) return
    win.webContents.sendInputEvent({ type: 'mouseDown', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await wait(800)
  }
  await openSwitcher()
  const headings = await run('headings', `JSON.stringify([...document.querySelectorAll('[role="listbox"] [role="group"] > :first-child, [role="listbox"] div[id*="label"], [role="listbox"] [data-reka-combobox-label]')].map((x) => x.textContent.trim()))`)
  const listText = await run('list', `(function () { var l = document.querySelector('[role="listbox"]'); return l ? l.innerText : '' })()`)
  console.log('DIAG list:', JSON.stringify(listText), 'headings:', headings)
  await shot('folders-switcher')
  check('switcher lists the folder heading', Boolean(await run('label', `!!document.querySelector('button[aria-label^="Folder Clients"]')`)), listText?.slice(0, 200))

  const menuOpened = await run('folder menu', `(function () { var b = document.querySelector('button[aria-label^="Folder Clients"]'); if (b) { b.click(); return true } return false })()`)
  await wait(500)
  check('folder heading has a menu', Boolean(menuOpened) && /Rename folder/.test(await run('items', `[...document.querySelectorAll('[role="menuitem"]')].map((x) => x.textContent.trim()).join('|')`) ?? ''))

  // --- rename
  await menuItem('Rename folder')
  await wait(800)
  check('rename asks for a name', /Rename folder/.test(await dialogText() ?? ''), await dialogText())
  await setDialogInput('Customers')
  await clickDialogButton('Rename')
  await settled((text) => /Customers/.test(text))
  const renamed = await run('profiles', `window.dbison.profiles.list().then((r) => JSON.stringify(r.profiles.map((p) => [p.name, p.folder || ''])))`)
  check('rename moved every member', /\["Alpha","Customers"\]/.test(renamed ?? '') && /\["Beta","Customers"\]/.test(renamed ?? '') && /\["Solo",""\]/.test(renamed ?? ''), renamed)

  // --- remove
  await openSwitcher()
  await run('folder menu 2', `(function () { var b = document.querySelector('button[aria-label^="Folder Customers"]'); if (b) b.click(); return !!b })()`)
  await wait(500)
  await menuItem('Remove folder')
  await wait(800)
  check('remove asks first and keeps the connections', /stay/.test(await dialogText() ?? ''), await dialogText())
  await clickDialogButton('Remove folder')
  await settled((text) => !/Customers/.test(text))
  const removed = await run('profiles 2', `window.dbison.profiles.list().then((r) => JSON.stringify(r.profiles.map((p) => [p.name, p.folder || ''])))`)
  check('folder removed, connections kept', /\["Alpha",""\]/.test(removed ?? '') && /\["Beta",""\]/.test(removed ?? '') && (removed ?? '').split('],[').length === 3, removed)

  // --- explorer sections fold
  await run('connect', `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Connect').click()`)
  await wait(3000)
  const before = await run('rows', `document.querySelectorAll('button[title^="Open users"]').length`)
  check('tables listed before folding', before === 1, before)

  await run('fold tables', `(function () { var h = [...document.querySelectorAll('h2.section-head')].find((x) => /Tables/.test(x.textContent)); h.click(); return h.getAttribute('aria-expanded') })()`)
  await wait(400)
  const after = await run('rows 2', `document.querySelectorAll('button[title^="Open users"]').length`)
  check('folded section hides its rows but keeps the heading', after === 0 && Boolean(await run('head', `!![...document.querySelectorAll('h2.section-head')].find((x) => /Tables/.test(x.textContent))`)), after)

  await run('filter', `(function () { var i = document.querySelector('input[placeholder^="Filter tables"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'use'); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await wait(600)
  check('a search opens folded sections', (await run('rows 3', `document.querySelectorAll('button[title^="Open users"]').length`)) === 1)
  await run('clear filter', `(function () { var i = document.querySelector('input[placeholder^="Filter tables"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await wait(600)

  await win.webContents.reload()
  await wait(9000)
  await run('connect 2', `(function () { var b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Connect'); if (b) b.click(); return !!b })()`)
  await wait(3000)
  const persisted = await run('rows 4', `document.querySelectorAll('button[title^="Open users"]').length`)
  check('fold survives a reload', persisted === 0, persisted)
  await run('unfold', `(function () { var h = [...document.querySelectorAll('h2.section-head')].find((x) => /Tables/.test(x.textContent)); h.click(); return true })()`)
  await wait(400)
  check('unfolding brings the rows back', (await run('rows 5', `document.querySelectorAll('button[title^="Open users"]').length`)) === 1)

  console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join('; ')}` : '\nAll checks passed')
  app.exit(failures.length ? 1 : 0)
})
