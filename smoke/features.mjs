// Exercises the features added together on 2026-09-14, on SQLite: the
// read-only and no-history guards enforced in main, the log file, saved
// queries, connection folders, structure editing from the Structure view,
// the import/export dialogs, the visual EXPLAIN, the record view, and the
// diagram's export menu. Run with `npm run smoke features`.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { app, BrowserWindow } from 'electron'

import { registerDatabaseIpc } from '../electron/ipc.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const APP_URL = process.env.APP_URL ?? 'http://[::1]:3113'
const DB_FILE = path.join(process.env.TEMP, 'dbison-features.sqlite')

const USER_DATA = path.join(app.getPath('temp'), 'dbison-smoke-features')
await rm(USER_DATA, { recursive: true, force: true })
app.setPath('userData', USER_DATA)

function seed() {
  const db = new DatabaseSync(DB_FILE)
  db.exec(`
    drop table if exists orders;
    drop table if exists users;
    create table users (id integer primary key, name text not null, age integer);
    create table orders (id integer primary key, user_id integer references users(id), total real);
    insert into users (name, age) values ('ada', 36), ('grace', 45);
    insert into orders (user_id, total) values (1, 9.5), (2, 12);
  `)
  db.close()
}

function columnsOf(table) {
  const db = new DatabaseSync(DB_FILE)
  const names = db.prepare(`pragma table_info(${table})`).all().map((row) => row.name)
  db.close()
  return names
}

const failures = []
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${String(detail).slice(0, 300)}` : ''}`)
  if (!ok) failures.push(label)
}

app.whenReady().then(async () => {
  seed()
  await registerDatabaseIpc()

  const win = new BrowserWindow({
    show: false, width: 1600, height: 1000,
    webPreferences: {
      preload: path.join(ROOT, 'electron', 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      backgroundThrottling: false,
    },
  })

  const rendererErrors = []
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') {
      rendererErrors.push(event.message.slice(0, 300))
      console.log('RENDERER:', event.message.slice(0, 300))
    }
  })

  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const run = async (label, js) => {
    try { return await win.webContents.executeJavaScript(js) }
    catch (error) { console.log('!! failed:', label, String(error).slice(0, 200)); return null }
  }
  const clickText = (text, scope = 'body') => run(`click ${text}`, `(function () {
    var root = document.querySelector(${JSON.stringify(scope)}) || document.body
    var b = [].slice.call(root.querySelectorAll('button')).filter(function (x) { return x.textContent.trim() === ${JSON.stringify(text)} })[0]
    if (b) b.click(); return !!b
  })()`)
  const clickTitled = (title, scope = 'body') => run(`click ${title}`, `(function () {
    var root = document.querySelector(${JSON.stringify(scope)}) || document.body
    var b = root.querySelector('button[title^=' + ${JSON.stringify(JSON.stringify(title))} + ']')
    if (b) b.click(); return !!b
  })()`)
  const menuItems = () => run('menu items', `JSON.stringify([...document.querySelectorAll('[role="menuitem"]')].map((x) => x.textContent.trim()))`)
  const menuItem = (text) => run(`menu ${text}`, `(function () {
    var item = [...document.querySelectorAll('[role="menuitem"]')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)}))
    if (!item) return 'not found: ' + [...document.querySelectorAll('[role="menuitem"]')].map((x) => x.textContent.trim()).join(' | ')
    item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
    item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }))
    item.click()
    return 'selected'
  })()`)
  const contextMenuOn = (selector) => run(`contextmenu ${selector}`, `(function () {
    var el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false
    var r = el.getBoundingClientRect()
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2, pointerType: 'mouse', clientX: r.x + 10, clientY: r.y + 5 }))
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: r.x + 10, clientY: r.y + 5 }))
    return true
  })()`)
  const key = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await wait(250)
  }
  const bodyText = async () => (await run('text', `document.body.innerText`) ?? '').replace(/\u00a0/g, ' ')
  // The last open card: a dismissed one lingers with data-state="closed" while it fades.
  const dialogText = () => run('dialog', `(function () { var all = document.querySelectorAll('.app-dialog-card:not([data-state="closed"])'); var d = all[all.length - 1]; return d ? d.innerText : '' })()`)
  const setDialogInput = (index, value) => run(`input ${index}`, `(function () {
    var all = document.querySelectorAll('.app-dialog-card:not([data-state="closed"])'); var d = all[all.length - 1]; if (!d) return 'no dialog'
    var inputs = [...d.querySelectorAll('input:not([type=checkbox]):not([disabled])')]
    var el = inputs[${index}]; if (!el) return 'no input ' + ${index} + ' of ' + inputs.length
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return 'set'
  })()`)
  const closeDialog = async () => {
    await run('close dialog', `(function () {
      var all = document.querySelectorAll('.app-dialog-card:not([data-state="closed"])'); var d = all[all.length - 1]; if (!d) return 'none'
      var b = d.querySelector('button[aria-label="Close"]') || [...d.querySelectorAll('button')].find((x) => /^(Cancel|Close)$/.test(x.textContent.trim()))
      if (b) b.click(); return b ? 'closed' : 'no button'
    })()`)
    await wait(600)
  }
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

  await win.loadURL(APP_URL)
  await wait(8000)

  // Profiles first, through the bridge, then a reload so the explorer sees them.
  const profile = await run('save', `window.dbison.profiles.save({ name: 'Feat', driver: 'sqlite', file: ${JSON.stringify(DB_FILE)}, folder: 'Team' })`)
  const locked = await run('save ro', `window.dbison.profiles.save({ name: 'Locked', driver: 'sqlite', file: ${JSON.stringify(DB_FILE)}, readOnly: true, noHistory: true })`)
  check('profile stores the folder', profile?.folder === 'Team', JSON.stringify(profile))

  // --- main-process guards, straight over the bridge
  await run('connect locked', `window.dbison.connect(${JSON.stringify(locked.id)})`)
  const refused = await run('ro delete', `window.dbison.query(${JSON.stringify(locked.id)}, 'delete from orders').then(() => 'ran', (e) => e.code || e.message)`)
  check('read-only connection refuses a write in main', refused === 'READ_ONLY', refused)
  const allowed = await run('ro select', `window.dbison.query(${JSON.stringify(locked.id)}, 'select count(*) from orders').then((r) => r.rows[0][0], (e) => e.message)`)
  check('read-only connection still reads', allowed === 2, allowed)
  const consented = await run('ro consent', `window.dbison.query(${JSON.stringify(locked.id)}, 'delete from orders where id = 999', { allowWrite: true }).then(() => 'ran', (e) => e.code || e.message)`)
  check('read-only write runs with consent', consented === 'ran', consented)
  const remembered = await run('nohistory', `window.dbison.history.add({ connectionId: ${JSON.stringify(locked.id)}, sql: 'select 1', outcome: 'ok' })`)
  check('no-history connection is kept out of history by main', remembered === null, JSON.stringify(remembered))
  await run('disconnect locked', `window.dbison.disconnect(${JSON.stringify(locked.id)})`)

  const logPath = await run('log path', `window.dbison.logPath().then((r) => r.path)`)
  await run('log line', `window.dbison.log({ level: 'info', message: 'smoke-features wrote this' })`)
  await wait(500)
  const logText = await readFile(logPath, 'utf8').catch(() => '')
  check('renderer log line lands in the log file', logText.includes('smoke-features wrote this'), logPath)

  const savedQuery = await run('saved save', `window.dbison.saved.save({ name: 'Adults', sql: 'select * from users where age >= 18', connectionId: ${JSON.stringify(profile.id)}, tags: ['people'] })`)
  check('saved query stored', savedQuery?.id && savedQuery.name === 'Adults', JSON.stringify(savedQuery))

  await win.webContents.reload()
  await wait(9000)
  check('page loaded', (await bodyText()).indexOf('An error has occurred') === -1)

  // --- the explorer: pick Feat, connect
  const switcherText = await bodyText()
  check('connection switcher shows the folder', /Team/.test(switcherText), switcherText.slice(0, 200))
  await clickText('Connect')
  await wait(3000)
  check('connected', /users/.test(await bodyText()))

  // --- explorer context menus
  await contextMenuOn('button[title^="Open users"]')
  await wait(600)
  const tableMenu = await menuItems()
  check('table context menu offers import and export', /Import CSV/.test(tableMenu ?? '') && /Export Table/.test(tableMenu ?? ''), tableMenu)
  await key('Escape')
  await wait(300)

  // --- table tab: Structure view, add a column through the dialog
  await run('open users', `(function () { var el = document.querySelector('button[title^="Open users"]'); if (el) el.click(); return !!el })()`)
  await wait(3000)
  check('table toolbar has Export and Import', Boolean(await run('btns', `!!document.querySelector('button[title^="Write every matching row"]') && !!document.querySelector('button[title^="Read a CSV"]')`)))

  await clickText('Structure')
  await wait(1500)
  check('structure view offers Add column', /Add column/.test(await bodyText()))
  await clickText('Add column…')
  await wait(800)
  await setDialogInput(0, 'nickname')
  await setDialogInput(1, 'text')
  await wait(900)
  const preview = await dialogText()
  check('add column dialog previews the ALTER', /alter table "users" add column "nickname" text/i.test(preview ?? ''), preview)
  await shot('features-add-column')
  await run('apply add column', `(function () { var all = document.querySelectorAll('.app-dialog-card:not([data-state="closed"])'); var d = all[all.length - 1]; var b = d && [...d.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Add column'); if (b) b.click(); return !!b })()`)
  await wait(2500)
  check('column was added to the table', columnsOf('users').includes('nickname'), columnsOf('users').join(','))
  check('structure view lists the new column', /nickname/.test(await bodyText()))

  // --- the breadcrumb's table crumb switches tables
  await run('crumb', `(function () { var b = document.querySelector('button[aria-label="Switch table"]'); if (b) { b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); b.click(); return true } return false })()`)
  await wait(800)
  const crumbList = await run('crumb list', `(function () { var l = document.querySelector('[role="listbox"]'); return l ? l.innerText : '' })()`)
  check('table crumb opens a picker listing the other tables', /orders/.test(crumbList ?? ''), crumbList?.slice(0, 120))
  await run('pick orders', `(function () { var item = [...document.querySelectorAll('[role="option"]')].find((x) => /orders/.test(x.textContent)); if (!item) return false; item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' })); item.click(); return true })()`)
  await wait(2500)
  check('picking a table opens its tab', /orders · Feat/.test(await bodyText()) && Boolean(await run('orders tab', `!![...document.querySelectorAll('.dv-tab, [role="tab"]')].find((t) => /orders/.test(t.textContent))`)))
  await run('back to users', `(function () { var t = [...document.querySelectorAll('.dv-tab')].find((x) => /users · Feat/.test(x.textContent)); if (t) t.click(); return !!t })()`)
  await wait(1200)


  // --- export dialog opens (the OS save dialog is never reached here)
  await clickText('Data')
  await wait(800)
  await clickTitled('Write every matching row')
  await wait(800)
  const exportDialog = await dialogText()
  check('export dialog opens with the formats', /CSV/.test(exportDialog ?? '') && /JSON/.test(exportDialog ?? ''), exportDialog?.slice(0, 200))
  await shot('features-export')
  await closeDialog()

  await clickTitled('Read a CSV')
  await wait(800)
  const importDialog = await dialogText()
  check('import dialog opens', /Choose file|file/i.test(importDialog ?? '') && !/^Export/.test(importDialog ?? ''), importDialog?.slice(0, 200))
  await closeDialog()
  check('no dialog left open', (await dialogText()) === '', await dialogText())

  // --- a query tab: visual explain, record view, saved queries popover.
  // Opened from the explorer so the SELECT is already in the editor: typing
  // into Monaco from a hidden window is the flakiest thing a smoke can do.
  await contextMenuOn('button[title^="Open users"]')
  await wait(600)
  await menuItem('New Query Here')
  await wait(4000)
  const editorState = await run('editor state', `(function () {
    var lines = [...document.querySelectorAll('.monaco-editor .view-lines')].filter((el) => el.getBoundingClientRect().width > 0)
    return JSON.stringify({ editors: lines.length, text: (lines[lines.length - 1] || {}).innerText })
  })()`)
  console.log('DIAG editor:', editorState)
  await shot('features-before-plan')
  await run('run menu', `(function () { var b = document.querySelector('button[aria-label="More ways to run"]'); b && b.click(); return !!b })()`)
  await wait(600)
  check('run menu offers Visual Explain', /Visual Explain/.test(await menuItems() ?? ''), await menuItems())
  await menuItem('Visual Explain')
  await wait(3000)
  const planText = await run('tree text', `(function () { var t = document.querySelector('[role="tree"]'); return t ? t.innerText : 'NO TREE; grid: ' + ([...document.querySelectorAll('.result-grid tbody td')].map((c) => c.textContent.trim()).slice(0, 8).join(' | ')) })()`)
  check('visual explain renders a plan tree', /SCAN|SEARCH/.test(planText ?? '') && !/NO TREE/.test(planText ?? ''), planText)
  await shot('features-plan')

  await clickText('Run')
  await wait(3000)
  await run('focus cell', `(function () {
    var cell = document.querySelector('.result-grid tbody td'); if (!cell) return false
    var r = cell.getBoundingClientRect()
    cell.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.x + 5, clientY: r.y + 5, button: 0, pointerType: 'mouse', isPrimary: true }))
    cell.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: r.x + 5, clientY: r.y + 5, button: 0, pointerType: 'mouse', isPrimary: true }))
    return true
  })()`)
  await wait(300)
  await clickTitled('Record view')
  await wait(800)
  const record = await run('record', `(function () { var r = document.querySelector('.record-view'); return r ? r.innerText : '' })()`)
  check('record view shows the focused row', /Row 1 of/.test(record ?? '') && /name/.test(record ?? ''), record?.slice(0, 200))
  await shot('features-record')
  await clickTitled('Record view')
  await wait(300)

  await run('open saved', `(function () { var b = document.querySelector('button[aria-label^="Saved queries"]'); b && b.click(); return !!b })()`)
  await wait(1000)
  check('saved queries popover lists the saved query', /Adults/.test(await bodyText()))
  await shot('features-saved')
  await key('Escape')
  await wait(300)

  // --- diagram export menu
  // The diagram button sits on the row when the explorer is wide enough and
  // in the overflow menu when it is not; either way is a pass.
  const inlineDiagram = await clickTitled('Show the relationship diagram')
  if (!inlineDiagram) {
    await run('more menu', `(function () { var b = document.querySelector('button[aria-label="More actions for this database"]'); if (b) b.click(); return !!b })()`)
    await wait(500)
    await menuItem('Show relationship diagram')
  }
  console.log('DIAG diagram opened from', inlineDiagram ? 'the row' : 'the menu')
  await wait(5000)
  check('diagram has an Export menu', Boolean(await clickText('Export')))
  await wait(500)
  check('diagram export offers SVG and PNG', /SVG/.test(await menuItems() ?? '') && /PNG/.test(await menuItems() ?? ''), await menuItems())
  await key('Escape')

  check('no renderer errors', rendererErrors.length === 0, rendererErrors.join(' || '))

  console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join('; ')}` : '\nAll checks passed')
  app.exit(failures.length ? 1 : 0)
})
