// Exercises the tier-3 additions on SQLite: scripts as one tab per
// statement, the missing-WHERE guard, EXPLAIN, manual transactions, the
// close guard, quick filters, selection statistics, and URL paste.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { rm, writeFile } from 'node:fs/promises'
import { app, BrowserWindow } from 'electron'

import { registerDatabaseIpc } from '../electron/ipc.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const APP_URL = process.env.APP_URL ?? 'http://[::1]:3113'
const DB_FILE = path.join(process.env.TEMP, 'dbison-tier3.sqlite')

const USER_DATA = path.join(app.getPath('temp'), 'dbison-smoke-tier3')
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
    drop table if exists audit;
    create table audit (id integer primary key autoincrement, note text);
    insert into audit (note) values ('seeded');
    create trigger orders_audit after insert on orders begin insert into audit (note) values ('order'); end;
  `)
  db.close()
}

function countRows(table) {
  const db = new DatabaseSync(DB_FILE)
  const [{ n }] = db.prepare(`select count(*) as n from ${table}`).all()
  db.close()
  return Number(n)
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
  const gridCells = () => run('cells', `JSON.stringify([...document.querySelectorAll('.result-grid tbody td')].map((c) => c.textContent.trim()).slice(0, 40))`)
  const shot = async (name) => {
    const img = await win.webContents.capturePage().catch(() => null)
    if (img) await writeFile(path.join(ROOT, 'shots', `${name}.png`), img.toPNG())
  }

  await win.loadURL(APP_URL)
  await wait(8000)

  const profile = await run('save', `window.dbison.profiles.save({ name: 'T3', driver: 'sqlite', file: ${JSON.stringify(DB_FILE)} })`)
  await win.webContents.reload()
  await wait(9000)
  check('page loaded', (await bodyText()).indexOf('An error has occurred') === -1)

  await clickText('Connect')
  await wait(3000)
  await clickTitled('New query')
  await wait(5000)

  // --- a script: three statements, three result tabs
  await setEditor(`insert into orders (user_id, total) values (1, 3);\nselect count(*) as n from orders;\nselect * from users`)
  await key('Return', ['control', 'shift'])
  await wait(4000)
  const tabs = await run('tabs', `JSON.stringify([...document.querySelectorAll('[aria-label="Statement results"] [role="tab"]')].map((t) => t.textContent.trim().replace(/\\s+/g, ' ')))`)
  check('script produced one result tab per statement', /^\[.*,.*,.*\]$/.test(tabs ?? '') && (tabs ?? '').split('","').length === 3, tabs)
  check('last statement result is showing', /grace/.test(await gridCells() ?? ''), await gridCells())
  await run('tab3', `[...document.querySelectorAll('[aria-label="Statement results"] [role="tab"]')][2].click()`)
  await wait(500)
  await run('tab2', `[...document.querySelectorAll('[aria-label="Statement results"] [role="tab"]')][1].click()`)
  await wait(500)
  check('clicking a result tab shows that statement', /"3"/.test(await gridCells() ?? ''), await gridCells())
  await shot('tier3-script')

  // --- missing WHERE guard
  await setEditor('delete from orders')
  await key('Return', ['control'])
  await wait(1200)
  let dialog = await dialogText()
  check('DELETE without WHERE asks first', /No WHERE clause/.test(dialog), dialog.slice(0, 60))
  await clickText('Cancel', '.app-dialog-card')
  await wait(2500)
  check('cancelling left the rows alone', countRows('orders') === 3, String(countRows('orders')))

  await setEditor('delete from orders where total = 3')
  await key('Return', ['control'])
  await wait(1500)
  check('DELETE with WHERE does not ask', !/No WHERE clause/.test(await dialogText()) && countRows('orders') === 2)

  // --- explain
  await setEditor('select * from users where id = 1')
  await clickTitled('More ways to run')
  await wait(600)
  await menuItem('Explain Statement')
  await wait(2500)
  const headers = await run('th', `JSON.stringify([...document.querySelectorAll('th')].map((t) => t.textContent.trim()))`)
  check('Explain shows the plan', /detail/.test(headers ?? ''), headers)

  // --- manual transaction
  await run('autocommit off', `(function () { var c = [...document.querySelectorAll('input[type="checkbox"]')].find((i) => i.closest('label') && i.closest('label').textContent.includes('Auto-commit')); if (!c) return 'no box'; c.click(); return c.checked })()`)
  await wait(300)
  await setEditor(`insert into users (name, age) values ('tx', 1)`)
  await key('Return', ['control'])
  await wait(2500)
  let text = await bodyText()
  check('statement ran inside a transaction', /1 statement not committed/.test(text) && /in transaction/.test(text), (text.match(/\d+ pending/) || [])[0])
  check('uncommitted row is not on disk', countRows('users') === 2, String(countRows('users')))
  await setEditor('select count(*) as n from users')
  await key('Return', ['control'])
  await wait(2500)
  check('the transaction sees its own insert', /"3"/.test(await gridCells() ?? ''), await gridCells())
  await shot('tier3-transaction')

  // --- close guard while the transaction is open
  await run('close x', `(function () { var t = [...document.querySelectorAll('.dv-tab')].find((x) => x.textContent.includes('Query 1')); var a = t && t.querySelector('.dv-default-tab-action'); if (a) a.click(); return !!a })()`)
  await wait(1000)
  dialog = await dialogText()
  check('closing a tab with an open transaction asks', /Close this tab\?[\s\S]*rolled back/.test(dialog), dialog.slice(0, 80))
  await clickText('Cancel', '.app-dialog-card')
  await wait(600)
  check('cancel kept the tab', await run('tab', `!![...document.querySelectorAll('.dv-tab')].find((x) => x.textContent.includes('Query 1'))`))

  await clickText('Rollback')
  await wait(1500)
  await setEditor('select count(*) as n from users')
  await key('Return', ['control'])
  await wait(2500)
  check('rollback discarded the insert', /"2"/.test(await gridCells() ?? '') && countRows('users') === 2, await gridCells())
  await clickText('Rollback')
  await wait(800)
  check('auto-commit toggle is usable again', await run('box', `(function () { var c = [...document.querySelectorAll('input[type="checkbox"]')].find((i) => i.closest('label') && i.closest('label').textContent.includes('Auto-commit')); return c && !c.disabled })()`))

  // --- quick filters and selection statistics on the table tab
  await run('open users', `(function () {
    var b = [...document.querySelectorAll('button[title^="Open "]')].find((x) => x.title.startsWith('Open users'))
    if (b) b.click(); return !!b
  })()`)
  await wait(4000)
  await run('context on 36', `(function () {
    var cell = [...document.querySelectorAll('.result-grid tbody td')].find((c) => c.textContent.trim() === '36')
    if (!cell) return 'no cell'
    var r = cell.getBoundingClientRect()
    cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.x + 5, clientY: r.y + 5, button: 0 }))
    cell.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: r.x + 5, clientY: r.y + 5, button: 0 }))
    cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + 5, clientY: r.y + 5, button: 2 }))
    return 'ok'
  })()`)
  await wait(800)
  const picked = await menuItem('Filter to age = 36')
  await wait(3000)
  const whereValue = await run('where', `document.querySelector('input[aria-label="WHERE clause"]').value`)
  check('quick filter fills the WHERE box', /age.*= 36/.test(whereValue ?? ''), `${picked} / ${whereValue}`)
  check('quick filter narrowed the rows', /1 rows/.test(await bodyText()))

  await run('focus grid', `document.querySelector('.result-grid [tabindex="0"]').focus()`)
  await key('A', ['control'])
  await wait(600)
  text = await bodyText()
  check('selection statistics shown', /count \d/.test(text) && /sum/.test(text), (text.match(/count[^\n]*/) || [])[0])
  await shot('tier3-stats')

  // --- explorer: triggers and sequences beyond the tables
  const sections = await run('sections', `JSON.stringify([...document.querySelectorAll('.section-head')].map((h) => h.textContent.trim().replace(/\\s+/g, ' ')))`)
  check('explorer lists the trigger', /Triggers/.test(sections ?? '') && await run('t', `!!document.querySelector('[data-entity-id="trigger:orders_audit"]')`), sections)
  check('explorer lists the sequence', /Sequences/.test(sections ?? '') && await run('s', `!!document.querySelector('[data-entity-id="sequence:audit"]')`), sections)
  await run('open trigger', `(function () { var b = [...document.querySelectorAll('[data-entity-id^="trigger:"]')][0]; if (b) b.click(); return !!b })()`)
  await wait(3000)
  check('a trigger opens as its definition', /create trigger orders_audit/i.test((await run('vl', `(function () { var v = document.querySelectorAll('.view-lines'); return v.length ? v[v.length - 1].innerText : '' })()`) ?? '').replace(/\u00a0/g, ' ')))

  // --- URL paste in the connection dialog
  await key('N', ['control', 'shift'])
  await wait(1200)
  await run('url', `(function () {
    var i = document.querySelector('input[placeholder^="postgres://"]'); if (!i) return 'no input'
    var s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    s.call(i, 'postgres://alice:s3cret@db.example.com:5433/shop?sslmode=verify-full'); i.dispatchEvent(new Event('input', { bubbles: true }))
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    return 'ok'
  })()`)
  await wait(600)
  const form = await run('form', `JSON.stringify([...document.querySelectorAll('.app-dialog-card input')].map((i) => i.type === 'checkbox' ? i.checked : i.value))`)
  check('URL paste fills host, port, user, database and SSL', /db\.example\.com/.test(form ?? '') && /5433/.test(form ?? '') && /alice/.test(form ?? '') && /shop/.test(form ?? '') && /true/.test(form ?? ''), form)
  await key('Escape')
  await wait(500)

  await run('cleanup', `window.dbison.profiles.remove(${JSON.stringify(profile.id)})`)
  console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(' | ')}` : '\nALL PASSED')
  app.quit()
}).catch((e) => { console.error('SMOKE FAILED:', e); app.exit(1) })
