// Exercises the tier-1 additions against a seeded SQLite file: statement-at-
// cursor runs, the row limit, history, format, the table's Structure and DDL
// views, the exact count, save-to-path and open-file over IPC.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { app, BrowserWindow } from 'electron'

import { registerDatabaseIpc } from './electron/ipc.js'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const APP_URL = process.env.APP_URL ?? 'http://[::1]:3113'
const DB_FILE = path.join(process.env.TEMP, 'dbison-tier1.sqlite')
const SQL_FILE = path.join(process.env.TEMP, 'dbison-tier1.sql')

const USER_DATA = path.join(app.getPath('temp'), 'dbison-smoke-tier1')
// A fresh profile every run: a restored layout would bring back last run's
// tabs, and the script would type into whichever editor it found first.
await rm(USER_DATA, { recursive: true, force: true })
app.setPath('userData', USER_DATA)

function seed() {
  const db = new DatabaseSync(DB_FILE)
  db.exec(`
    drop view if exists adults;
    drop table if exists users;
    create table users (
      id integer primary key,
      name text not null,
      email text unique,
      age integer,
      note text default 'n/a'
    );
    create index users_age on users (age);
    create view adults as select * from users where age >= 18;
    insert into users (name, email, age) values ('ada', 'ada@x', 36), ('grace', 'grace@x', 45), ('kid', null, 9);
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
    if (event.level === 'error' || event.level === 'warning') console.log('RENDERER:', event.message.slice(0, 300))
  })
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const run = async (label, js) => {
    try { return await win.webContents.executeJavaScript(js) }
    catch (error) { console.log('!! failed:', label, String(error).slice(0, 200)); return null }
  }
  const clickText = (text, tag = 'button') => run(`click ${text}`, `(function () {
    var b = [].slice.call(document.querySelectorAll('${tag}')).filter(function (x) { return x.textContent.trim() === ${JSON.stringify(text)} })[0]
    if (b) b.click(); return !!b
  })()`)
  const clickTitled = (title) => run(`click ${title}`, `(function () {
    var b = document.querySelector('button[title^=' + ${JSON.stringify(JSON.stringify(title))} + ']')
    if (b) b.click(); return !!b
  })()`)
  /**
   * Types through Electron's input pipeline: Monaco on this Chromium reads
   * the EditContext API, so a value poked into its textarea never arrives.
   */
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
  const key = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await wait(200)
  }
  const setEditor = async (text) => {
    if (!await focusEditor()) return 'NO EDITOR'
    await key('A', ['control'])
    await key('Delete')
    await win.webContents.insertText(text)
    await wait(400)
    return 'ok'
  }
  const chord = (keyCode, shift = false) => key(keyCode, shift ? ['control', 'shift'] : ['control'])
  const bodyText = async () => (await run('text', `document.body.innerText`) ?? '').replace(/\u00a0/g, ' ')
  const lastLines = () => run('lines', `(function () { var v = document.querySelectorAll('.view-lines'); return v.length ? v[v.length - 1].innerText : '' })()`).then((t) => (t ?? '').replace(/\u00a0/g, ' '))

  await win.loadURL(APP_URL)
  await wait(8000)

  const profile = await run('save', `window.dbison.profiles.save({ name: 'Tier1', driver: 'sqlite', file: ${JSON.stringify(DB_FILE)} })`)
  await win.webContents.reload()
  await wait(9000)

  check('page loaded', (await bodyText() ?? '').indexOf('An error has occurred') === -1)

  check('connect clicked', await clickText('Connect'))
  await wait(3000)
  console.log('new query:', await clickTitled('New query'))
  await wait(5000)
  console.log('tabs:', await run('tabs', `JSON.stringify([...document.querySelectorAll('.dv-tab')].map((t) => t.textContent.trim()))`), 'textareas:', await run('ta', `document.querySelectorAll('textarea').length`), 'status:', await run('st', `document.querySelector('.app-statusbar, footer') ? document.querySelector('footer').innerText.slice(0, 80) : 'n/a'`))

  {
    const img = await win.webContents.capturePage().catch(() => null)
    if (img) await writeFile(path.join(ROOT, 'shots', 'tier1-query.png'), img.toPNG())
    console.log('PANEL TEXT:', JSON.stringify((await bodyText()).slice(0, 600)))
  }
  // --- statement at cursor: the caret lands at the end, in the 2nd statement.
  await setEditor(`select 'first' as which, count(*) as n from users;\n\nselect id, name from users where id = 2`)
  await wait(1200)
  await chord('Return')
  await wait(3500)
  let text = await bodyText()
  console.log('SUMMARY:', (text.match(/(Executing|Cancelled|rows? · |runs the statement)[^\n]*/) || [])[0], '| editor:', JSON.stringify(await lastLines()).slice(0, 80))
  const headers = await run('th', `JSON.stringify([...document.querySelectorAll('th')].map((t) => t.textContent.trim()))`)
  check('Ctrl+Enter ran the statement at the cursor', /grace/.test(text) && /"name"/.test(headers) && !/which/.test(headers), headers)
  check('ran-statement gutter mark present', Boolean(await run('mark', `document.querySelectorAll('.sql-ran-line').length`)))

  // --- whole script: SQLite runs the first statement only, so 'first' shows.
  await chord('Return', true)
  await wait(3500)
  const headers2 = await run('th', `JSON.stringify([...document.querySelectorAll('th')].map((t) => t.textContent.trim()))`)
  const resultTabs = await run('rtabs', `document.querySelectorAll('[aria-label="Statement results"] [role="tab"]').length`)
  check('Ctrl+Shift+Enter ran the whole script, one tab per statement', resultTabs === 2 && /"name"/.test(headers2), `${resultTabs} tabs / ${headers2}`)

  // --- limit picker persisted
  await run('limit', `(function () {
    var s = document.querySelector('select[aria-label="Row limit"]'); if (!s) return 'no select'
    s.value = '200'; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value
  })()`)
  await wait(300)
  check('row limit picker applies to the tab', (await run('sel', `document.querySelector('select[aria-label="Row limit"]').value`)) === '200')

  // --- history popover lists both runs
  await clickText('History')
  await wait(1200)
  text = await bodyText()
  { const img = await win.webContents.capturePage().catch(() => null); if (img) await writeFile(path.join(ROOT, 'shots', 'tier1-history.png'), img.toPNG()) }
  check('history lists the statement', /select id, name from users where id = 2/.test(text))
  check('history shows run count for the rerun', /×2|1 row/.test(text))
  const stored = JSON.parse(await readFile(path.join(app.getPath('userData'), 'history.json'), 'utf8').catch(() => '{"entries":[]}'))
  await run('esc', `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await wait(500)

  // --- format
  await setEditor(`select id,name from users where id=2 and age>1 order by name`)
  await wait(800)
  await clickTitled('Format the selection')
  await wait(2500)
  const formatted = await lastLines()
  check('format rewrote the statement onto several lines', (formatted ?? '').split('\n').length >= 3, JSON.stringify(formatted).slice(0, 120))

  // --- save to a known path over IPC (the dialog path is native and untestable here)
  await rm(SQL_FILE, { force: true })
  const saved = await run('saveFile', `window.dbison.saveFile({ suggestedName: 'x.sql', content: 'select 42;', path: ${JSON.stringify(SQL_FILE)} })`)
  check('saveFile writes to a given path without a dialog', saved?.saved && (await readFile(SQL_FILE, 'utf8')) === 'select 42;')

  // --- table tab: structure, ddl, count
  await run('open users', `(function () {
    var b = [...document.querySelectorAll('button[title^="Open "]')].find((x) => x.title.startsWith('Open users'))
    if (b) b.click(); return !!b
  })()`)
  await wait(4000)

  await clickText('Structure')
  await wait(3000)
  text = await bodyText()
  console.log('TAB STYLES:', await run('styles', `JSON.stringify([...document.querySelectorAll('[role="tab"][data-active]')].map((t) => t.textContent.trim() + ':' + getComputedStyle(t).backgroundColor + '/' + getComputedStyle(t).color))`))
  console.log('ACTIVE TAB:', await run('tab', `JSON.stringify([...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent.trim() + '=' + t.getAttribute('data-active') + '/' + t.getAttribute('aria-selected')))`))
  { const img = await win.webContents.capturePage().catch(() => null); if (img) await writeFile(path.join(ROOT, 'shots', 'tier1-structure.png'), img.toPNG()) }
  check('structure lists columns', /Columns[\s\S]*email[\s\S]*age/.test(text))
  check('structure lists the index', /users_age/.test(text) && /sqlite_autoindex_users_1|unique/.test(text))
  check('structure marks the primary key', await run('pk', `!!document.querySelector('[title^="Primary key: id"]')`))

  await clickText('DDL')
  await wait(3000)
  const ddl = await lastLines()
  check('DDL shows create table', /create table users/i.test(ddl ?? ''), JSON.stringify(ddl).slice(0, 100))
  check('DDL includes the index', /create index users_age/i.test(ddl ?? ''))

  await clickText('Data')
  await wait(500)
  await clickTitled('Count every row')
  await wait(3000)
  text = await bodyText()
  check('exact count shown', /of 3\b/.test(text), (text.match(/3 rows[^\n]*/) || [])[0])

  // --- count under a filter
  await run('where', `(function () {
    var i = document.querySelector('input[placeholder^="status ="]'); if (!i) return 'no where'
    var s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    s.call(i, 'age >= 18'); i.dispatchEvent(new Event('input', { bubbles: true }))
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    return 'ok'
  })()`)
  await wait(3000)
  text = await bodyText()
  check('count forgotten after the filter changed', !/of 3\b/.test(text))
  await clickTitled('Count every row')
  await wait(3000)
  text = await bodyText()
  check('filtered count shown', /of 2\b/.test(text))

  // --- F5 re-reads the rows, filter included
  {
    const db = new DatabaseSync(DB_FILE)
    db.exec("insert into users (name, email, age) values ('late', 'late@x', 50)")
    db.close()
  }
  await run('focus where', `document.querySelector('input[aria-label="WHERE clause"]').focus()`)
  await key('F5')
  await wait(2500)
  text = await bodyText()
  check('F5 reloads the table, even from inside the filter box', /3 rows/.test(text) && /of 2/.test(text) === false, (text.match(/\d+ rows[^\n]*/) || [])[0])

  // --- view structure (no key, still has columns)
  await run('open adults', `(function () {
    var b = [...document.querySelectorAll('button[title^="Open "]')].find((x) => x.title.startsWith('Open adults'))
    if (b) b.click(); return !!b
  })()`)
  await wait(3500)
  await clickText('DDL')
  await wait(3000)
  const viewDdl = await lastLines()
  check('view DDL shows create view', /create view adults/i.test(viewDdl ?? ''), JSON.stringify(viewDdl).slice(0, 100))

  // --- history persisted to disk
  check('history file written', stored.entries?.length >= 2, `${stored.entries?.length} entries`)

  const img = await win.webContents.capturePage().catch(() => null)
  if (img) await writeFile(path.join(ROOT, 'shots', 'tier1.png'), img.toPNG())

  await run('cleanup', `window.dbison.profiles.remove(${JSON.stringify(profile.id)})`)
  console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(' | ')}` : '\nALL PASSED')
  app.quit()
}).catch((e) => { console.error('SMOKE FAILED:', e); app.exit(1) })
