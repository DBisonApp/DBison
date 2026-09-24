// The app's UI against a real Postgres. Everything lives in a scratch
// database created for the run and dropped at the end; the URL's own
// database sees only the CREATE and DROP DATABASE statements.
//
//   PG_URL=postgres://user:pass@host:5432/db electron smoke/pg-ui.mjs
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rm, writeFile } from 'node:fs/promises'
import { app, BrowserWindow } from 'electron'
import pg from 'pg'

import { registerDatabaseIpc } from '../electron/ipc.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const APP_URL = process.env.APP_URL ?? 'http://[::1]:3113'
const PG_URL = process.env.PG_URL
const SCRATCH = 'dbison_smoke_ui'

const USER_DATA = path.join(app.getPath('temp'), 'dbison-smoke-pg-ui')
await rm(USER_DATA, { recursive: true, force: true })
app.setPath('userData', USER_DATA)

if (!PG_URL) {
  console.error('Set PG_URL')
  app.exit(2)
}

const base = new URL(PG_URL)
const admin = () => new pg.Client({ connectionString: PG_URL })

/** A 1x1 red PNG, for the blob viewer. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64')

async function seed() {
  const root = admin()
  await root.connect()
  await root.query(`drop database if exists ${SCRATCH} with (force)`)
  await root.query(`create database ${SCRATCH}`)
  await root.end()

  const scratch = new pg.Client({ connectionString: PG_URL.replace(/\/[^/?]*(\?|$)/, `/${SCRATCH}$1`) })
  await scratch.connect()
  await scratch.query(`
    create table users (id serial primary key, name text not null, age integer, meta jsonb, avatar bytea);
    comment on table users is 'people';
    create index users_age_idx on users (age);
    create table orders (id serial primary key, user_id integer not null references users(id), total numeric(10,2));
    create table big (id serial primary key, n integer);
    create view adults as select * from users where age >= 18;
    create sequence ticket_seq start 100;
    create function touch() returns trigger language plpgsql as $$ begin return new; end $$;
    create trigger users_touch before insert on users for each row execute function touch();
    insert into users (name, age, meta) values ('ada', 36, '{"tags":["a","b"],"nested":{"ok":true}}'), ('grace', 45, null), ('kid', 9, null);
    insert into orders (user_id, total) values (1, 9.5), (2, 12);
    insert into big (n) select generate_series(1, 3000);
  `)
  // Bound on its own: a parameter cannot ride along with a multi-statement script.
  await scratch.query('update users set avatar = $1 where id = 1', [PNG])
  await scratch.end()
}

async function teardown() {
  const root = admin()
  await root.connect()
  await root.query(`drop database if exists ${SCRATCH} with (force)`)
  await root.end()
}

const failures = []
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

app.whenReady().then(async () => {
  await seed()
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
  const menuItem = (text) => run(`menu ${text}`, `(function () {
    var item = [...document.querySelectorAll('[role="menuitem"]')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)}))
    if (!item) return 'not found: ' + [...document.querySelectorAll('[role="menuitem"]')].map((x) => x.textContent.trim()).join(' | ')
    item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
    item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }))
    item.click()
    return 'selected'
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
  const dialogText = () => run('dialog', `(function () { var d = document.querySelector('.app-dialog-card'); return d ? d.innerText : '' })()`)
  const gridCells = () => run('cells', `JSON.stringify([...document.querySelectorAll('.result-grid tbody td')].map((c) => c.textContent.trim()).slice(0, 30))`)
  const lastLines = () => run('lines', `(function () { var v = document.querySelectorAll('.view-lines'); return v.length ? v[v.length - 1].innerText : '' })()`).then((t) => (t ?? '').replace(/\u00a0/g, ' '))
  const pointerAt = (finder) => run('pointer', `(function () {
    var cell = ${finder}
    if (!cell) return false
    var r = cell.getBoundingClientRect()
    cell.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.x + 5, clientY: r.y + 5, button: 0, pointerType: 'mouse', isPrimary: true }))
    cell.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: r.x + 5, clientY: r.y + 5, button: 0, pointerType: 'mouse', isPrimary: true }))
    return true
  })()`)
  const shot = async (name) => {
    const img = await win.webContents.capturePage().catch(() => null)
    if (img) await writeFile(path.join(ROOT, 'shots', `${name}.png`), img.toPNG())
  }

  try {
    await win.loadURL(APP_URL)
    await wait(8000)

    const profile = await run('save', `window.dbison.profiles.save(${JSON.stringify({
      name: 'PG smoke', driver: 'postgres', host: base.hostname, port: Number(base.port || 5432),
      username: decodeURIComponent(base.username), password: decodeURIComponent(base.password), database: SCRATCH, ssl: false, color: '#3b82f6',
    })})`)
    check('profile saved with a stored password', profile?.hasStoredPassword === true)
    await win.webContents.reload()
    await wait(9000)
    check('page loaded', (await bodyText()).indexOf('An error has occurred') === -1)

    await clickText('Connect')
    await wait(5000)
    let text = await bodyText()
    check('connected to Postgres', /PostgreSQL 1\d/.test(text), (text.match(/PostgreSQL [^\n]*/) || [])[0])

    // --- explorer: every object kind, from the snapshot and the objects read
    await wait(1500)
    text = await bodyText()
    check('explorer lists tables and the view', /users[\s\S]*orders/.test(text) && /adults/.test(text))
    const sections = await run('sections', `JSON.stringify([...document.querySelectorAll('.section-head')].map((h) => h.textContent.trim().replace(/\\s+/g, ' ')))`)
    check('explorer lists functions, sequences and triggers', /Functions/.test(sections ?? '') && /Sequences/.test(sections ?? '') && /Triggers/.test(sections ?? ''), sections)
    check('the function row shows its signature', /touch\s*\(\) → trigger/.test(text))
    await shot('pg-explorer')

    // --- table tab: structure with real indexes, DDL rebuilt from the catalog, count
    await run('open users', `(function () { var b = [...document.querySelectorAll('button[title^="Open users"]')][0]; if (b) b.click(); return !!b })()`)
    await wait(4000)
    await clickText('Structure')
    await wait(3000)
    text = await bodyText()
    check('structure lists the serial default and the index', /id\s+integer\s+not null\s+default/.test(text) && /users_age_idx/.test(text) && /users_pkey/.test(text))
    await clickText('DDL')
    await wait(3000)
    const ddl = await lastLines()
    check('DDL is rebuilt with key, index and comment', /create table "public"\."users"/i.test(ddl) && /constraint "users_pkey" PRIMARY KEY/i.test(ddl) && /create index users_age_idx/i.test(ddl) && /comment on table[^\n]*'people'/i.test(ddl), ddl.slice(0, 120))
    check('DDL carries the rebuilt-from-catalog note', /Rebuilt from the catalog/.test(await bodyText()))
    await shot('pg-ddl')
    await clickText('Data')
    await wait(500)
    await clickTitled('Count every row')
    await wait(3000)
    check('exact count over Postgres', /of 3\b/.test(await bodyText()))

    // --- blob viewer: the bytea is fetched whole by key and shown as an image
    await pointerAt(`[...document.querySelectorAll('.result-grid tbody td')].find((c) => c.textContent.trim().startsWith('0x'))`)
    await wait(300)
    await clickTitled('Open this value')
    await wait(2500)
    check('a bytea opens as an image', await run('img', `!!document.querySelector('.app-dialog-card img')`), (await dialogText()).slice(0, 60))
    await key('Escape')
    await wait(800)

    // --- quick filter, sort, and paging on the server
    await pointerAt(`[...document.querySelectorAll('.result-grid tbody td')].find((c) => c.textContent.trim() === '36')`)
    await run('context', `(function () { var c = [...document.querySelectorAll('.result-grid tbody td')].find((x) => x.textContent.trim() === '36'); var r = c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + 5, clientY: r.y + 5, button: 2 })); return true })()`)
    await wait(800)
    await menuItem('Filter age ≥ 36')
    await wait(3000)
    check('quick range filter reaches the server', /2 rows/.test(await bodyText()) && /age.*>= 36/.test(await run('w', `document.querySelector('input[aria-label="WHERE clause"]').value`) ?? ''))

    // --- query tab: script with several statements, explain analyze, transaction, streaming
    await clickTitled('New query')
    await wait(5000)
    await setEditor(`select count(*) as n from users;\nselect name from users where age > 40;\nselect * from big`)
    await key('Return', ['control', 'shift'])
    await wait(6000)
    const tabs = await run('rtabs', `JSON.stringify([...document.querySelectorAll('[aria-label="Statement results"] [role="tab"]')].map((t) => t.textContent.trim().replace(/\\s+/g, ' ')))`)
    check('a script runs statement by statement on Postgres', (tabs ?? '').split('","').length === 3 && /3000|3,000/.test(tabs ?? ''), tabs)
    text = await bodyText()
    check('streamed 3000 rows arrived', /3,000 rows|3000 rows/.test(text), (text.match(/[\d,]+ rows · [^\n]*/) || [])[0])

    await setEditor('select * from users where id = 1')
    await clickTitled('More ways to run')
    await wait(600)
    await menuItem('Explain Analyze')
    await wait(3000)
    const plan = await gridCells()
    check('Explain Analyze returns a plan', /Index Scan|Seq Scan|actual time/.test(plan ?? ''), (plan ?? '').slice(0, 120))

    await run('autocommit off', `(function () { var c = [...document.querySelectorAll('input[type="checkbox"]')].find((i) => i.closest('label') && i.closest('label').textContent.includes('Auto-commit')); if (c) c.click(); return !!c })()`)
    await wait(300)
    await setEditor(`insert into users (name, age) values ('tx', 1)`)
    await key('Return', ['control'])
    await wait(3000)
    check('a transaction is open', /1 statement not committed/.test(await bodyText()))
    await setEditor('select count(*) as n from users')
    await key('Return', ['control'])
    await wait(3000)
    check('the transaction sees its own insert', /"4"/.test(await gridCells() ?? ''), await gridCells())
    await clickText('Rollback')
    await wait(2000)
    await setEditor('select count(*) as n from users')
    await key('Return', ['control'])
    await wait(3000)
    check('rollback discarded it', /"3"/.test(await gridCells() ?? ''), await gridCells())
    await clickText('Rollback')
    await wait(800)

    // --- history recorded on this connection
    check('history recorded the runs', (await run('h', `window.dbison.history.list().then((l) => l.filter((e) => e.connectionId === ${JSON.stringify(profile.id)}).length)`)) >= 4)

    await run('cleanup', `window.dbison.profiles.remove(${JSON.stringify(profile.id)})`)
  }
  finally {
    await teardown().catch((error) => console.log('!! teardown failed:', error.message))
  }

  console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(' | ')}` : '\nALL PASSED')
  app.quit()
}).catch(async (e) => { console.error('SMOKE FAILED:', e); await teardown().catch(() => {}); app.exit(1) })
