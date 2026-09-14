// Exercises the tier-2 additions: connection colour and read-only guard, the
// command palette, settings and zoom, explorer keyboard navigation, the live
// region, persisted explorer scope, and the Edit menu roles.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { rm, writeFile } from 'node:fs/promises'
import { app, BrowserWindow } from 'electron'

import { registerDatabaseIpc } from './electron/ipc.js'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const APP_URL = process.env.APP_URL ?? 'http://[::1]:3113'
const DB_FILE = path.join(process.env.TEMP, 'dbison-tier2.sqlite')

const USER_DATA = path.join(app.getPath('temp'), 'dbison-smoke-tier2')
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

const failures = []
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

app.whenReady().then(async () => {
  seed()
  await registerDatabaseIpc()

  const win = new BrowserWindow({
    show: false, width: 1500, height: 950,
    webPreferences: {
      preload: path.join(ROOT, 'electron', 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      backgroundThrottling: false,
    },
  })

  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') console.log('RENDERER:', event.message.slice(0, 300))
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
  const clickTitled = (title) => run(`click ${title}`, `(function () {
    var b = document.querySelector('button[title^=' + ${JSON.stringify(JSON.stringify(title))} + ']')
    if (b) b.click(); return !!b
  })()`)
  const key = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await wait(250)
  }
  const focusEditor = async () => {
    const box = await run('editor box', `(function () {
      var e = document.querySelector('.monaco-editor .view-lines'); if (!e) return null
      var r = e.getBoundingClientRect(); return { x: Math.round(r.x + 20), y: Math.round(r.y + 10) }
    })()`)
    if (!box) return false
    win.webContents.sendInputEvent({ type: 'mouseDown', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await wait(300)
    return true
  }
  const setEditor = async (text) => {
    if (!await focusEditor()) return 'NO EDITOR'
    await key('A', ['control'])
    await key('Delete')
    await win.webContents.insertText(text)
    await wait(400)
    return 'ok'
  }
  const bodyText = async () => (await run('text', `document.body.innerText`) ?? '').replace(/\u00a0/g, ' ')
  const dialogText = () => run('dialog', `(function () { var d = document.querySelector('[role="dialog"], .app-dialog-card'); return d ? d.innerText : '' })()`)
  const shot = async (name) => {
    const img = await win.webContents.capturePage().catch(() => null)
    if (img) await writeFile(path.join(ROOT, 'shots', `${name}.png`), img.toPNG())
  }

  await win.loadURL(APP_URL)
  await wait(8000)

  const profile = await run('save', `window.dbison.profiles.save({ name: 'Prod', driver: 'sqlite', file: ${JSON.stringify(DB_FILE)}, color: '#ef4444', readOnly: true })`)
  check('profile stores colour and read-only', profile?.color === '#ef4444' && profile?.readOnly === true, JSON.stringify(profile))
  await win.webContents.reload()
  await wait(9000)

  check('page loaded', (await bodyText()).indexOf('An error has occurred') === -1)
  check('status bar shows the colour swatch', await run('swatch', `!!document.querySelector('footer [aria-label="Connection colour"]')`))
  check('status bar shows the lock', await run('lock', `!!document.querySelector('footer [aria-label="Read-only connection"]')`))

  await clickText('Connect')
  await wait(3000)
  await clickTitled('New query')
  await wait(5000)

  // --- read-only guard: a write asks, a read does not
  await setEditor('delete from users where id = 99')
  await key('Return', ['control'])
  await wait(1500)
  let dialog = await dialogText()
  check('write on a read-only connection asks first', /marked read-only/.test(dialog), dialog.slice(0, 80))
  await shot('tier2-readonly')
  await clickText('Run', '.app-dialog-card')
  await wait(2500)
  let text = await bodyText()
  check('confirmed write ran', /0 rows affected/.test(text), (text.match(/\d+ rows? affected[^\n]*/) || [])[0])

  await setEditor('select * from users')
  await key('Return', ['control'])
  await wait(2500)
  dialog = await dialogText()
  check('a read does not ask', !/marked read-only/.test(dialog))
  check('live region announced the result', /2 rows/.test(await run('live', `[...document.querySelectorAll('[aria-live]')].map((e) => e.textContent).join(' | ')`)))
  check('query tab carries the connection tint', await run('tint', `!![...document.querySelectorAll('div.h-0\\\\.5')].find((d) => d.style.backgroundColor === 'rgb(239, 68, 68)')`))

  // --- command palette
  await key('K', ['control'])
  await wait(800)
  check('Ctrl+K opens the palette', await run('pal', `!!document.querySelector('[aria-label="Command palette"]')`))
  await win.webContents.insertText('open orders')
  await wait(600)
  const options = await run('opts', `JSON.stringify([...document.querySelectorAll('[role="option"]')].map((o) => o.textContent.trim().replace(/\\s+/g, ' ')).slice(0, 5))`)
  check('palette lists the table', /Open orders/.test(options ?? ''), options)
  await shot('tier2-palette')
  await key('Return')
  await wait(3000)
  const tabs = await run('tabs', `JSON.stringify([...document.querySelectorAll('.dv-tab')].map((t) => t.textContent.trim()))`)
  check('Enter opened the table from the palette', /orders/.test(tabs ?? ''), tabs)
  check('palette closed after running', !(await run('pal2', `!!document.querySelector('[aria-label="Command palette"]')`)))

  await key('P', ['control', 'shift'])
  await wait(600)
  await win.webContents.insertText('zoom in')
  await wait(500)
  const cmd = await run('opts', `JSON.stringify([...document.querySelectorAll('[role="option"]')].map((o) => o.textContent.trim().replace(/\\s+/g, ' ')).slice(0, 3))`)
  check('palette lists menu commands', /Zoom In/.test(cmd ?? ''), cmd)
  await key('Escape')
  await wait(400)

  // --- zoom + settings
  await key('Equal', ['control'])
  await wait(600)
  check('Ctrl+= zooms in', Math.abs(win.webContents.getZoomFactor() - 1.1) < 0.01, String(win.webContents.getZoomFactor()))
  check('zoom persisted in settings', /"zoom":1.1/.test(await run('ls', `localStorage.getItem('dbison.settings.v1')`) ?? ''))
  await key('0', ['control'])
  await wait(600)
  check('Ctrl+0 resets zoom', Math.abs(win.webContents.getZoomFactor() - 1) < 0.01)

  await key(',', ['control'])
  await wait(1000)
  dialog = await dialogText()
  check('Ctrl+, opens Settings', /Settings[\s\S]*Zoom[\s\S]*Default row limit/.test(dialog), dialog.slice(0, 60))
  await shot('tier2-settings')
  await clickText('Done', '.app-dialog-card')
  await wait(500)

  // --- explorer keyboard navigation
  await run('focus filter', `document.querySelector('input[aria-label="Filter tables and columns"]').focus()`)
  await key('Down')
  const first = await run('active', `document.activeElement && document.activeElement.dataset.entityId || ''`)
  check('ArrowDown from the filter focuses the first row', /orders|users/.test(first ?? ''), first)
  await key('Down')
  const second = await run('active', `document.activeElement && document.activeElement.dataset.entityId || ''`)
  check('ArrowDown moves to the next row', second && second !== first, second)
  await key('Right')
  await wait(400)
  check('ArrowRight expands the columns', await run('exp', `document.activeElement.getAttribute('aria-expanded') === 'true'`))
  await key('Left')
  await wait(300)
  check('ArrowLeft collapses again', await run('exp', `document.activeElement.getAttribute('aria-expanded') === 'false'`))
  check('only one explorer row is tabbable', (await run('tabbable', `document.querySelectorAll('[data-explorer-row][tabindex="0"]').length`)) === 1)

  // --- persisted explorer state (SQLite has no scope levels, so the filter is what persists), edit roles
  await run('filter', `(function () {
    var i = document.querySelector('input[aria-label="Filter tables and columns"]')
    var s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    s.call(i, 'ord'); i.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await wait(400)
  check('explorer filter persisted', /"filter":"ord"/.test(await run('scope', `localStorage.getItem('dbison.explorer.v1')`) ?? ''))
  const edit = await run('edit', `window.dbison.editAction('selectAll')`)
  check('edit role reaches the window', edit?.applied === true, JSON.stringify(edit))

  await run('cleanup', `window.dbison.profiles.remove(${JSON.stringify(profile.id)})`)
  console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(' | ')}` : '\nALL PASSED')
  app.quit()
}).catch((e) => { console.error('SMOKE FAILED:', e); app.exit(1) })
