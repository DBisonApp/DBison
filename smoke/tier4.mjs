// Exercises the tier-4 additions on SQLite: streamed results, bind
// parameters, tab gestures, paste into the grid, recent files, drop with a
// typed confirmation, go-to-table, the JSON tree, SSH/history profile fields.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { rm, writeFile } from 'node:fs/promises'
import { app, BrowserWindow } from 'electron'

import { registerDatabaseIpc } from '../electron/ipc.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const APP_URL = process.env.APP_URL ?? 'http://[::1]:3113'
const DB_FILE = path.join(process.env.TEMP, 'dbison-tier4.sqlite')
const SQL_FILE = path.join(process.env.TEMP, 'dbison-tier4-recent.sql')

const USER_DATA = path.join(app.getPath('temp'), 'dbison-smoke-tier4')
await rm(USER_DATA, { recursive: true, force: true })
app.setPath('userData', USER_DATA)

function seed() {
  const db = new DatabaseSync(DB_FILE)
  db.exec(`
    drop table if exists big; drop table if exists orders; drop table if exists users;
    create table users (id integer primary key, name text not null, age integer, meta text);
    create table orders (id integer primary key, user_id integer references users(id), total real);
    create table big (id integer primary key, n integer);
    insert into users (name, age, meta) values ('ada', 36, '{"tags":["a","b"],"nested":{"ok":true}}'), ('grace', 45, null);
    insert into orders (user_id, total) values (1, 9.5), (2, 12);
  `)
  const insert = db.prepare('insert into big (n) values (?)')
  for (let i = 0; i < 3000; i++) insert.run(i)
  db.close()
}

function tableExists(name) {
  const db = new DatabaseSync(DB_FILE)
  const rows = db.prepare(`select name from sqlite_master where type = 'table' and name = ?`).all(name)
  db.close()
  return rows.length === 1
}

const failures = []
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

app.whenReady().then(async () => {
  seed()
  await writeFile(SQL_FILE, 'select 42 as answer;', 'utf8')
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
  const tabs = () => run('tabs', `JSON.stringify([...document.querySelectorAll('.dv-tab')].map((t) => t.textContent.trim()))`)
  const gridCells = () => run('cells', `JSON.stringify([...document.querySelectorAll('.result-grid tbody td')].map((c) => c.textContent.trim()).slice(0, 30))`)

  await win.loadURL(APP_URL)
  await wait(8000)

  // --- profile fields: ssh secret and history opt-out are stored
  const profile = await run('save', `window.dbison.profiles.save({ name: 'T4', driver: 'sqlite', file: ${JSON.stringify(DB_FILE)}, noHistory: true, ssh: { enabled: true, host: 'bastion', port: 22, username: 'me' }, sshPassword: 'hunter2' })`)
  check('profile stores ssh settings and history opt-out', profile?.ssh?.host === 'bastion' && profile?.hasStoredSshSecret === true && profile?.noHistory === true, JSON.stringify(profile))
  // SQLite never tunnels; the ssh block must not stop it from opening.
  await run('unssh', `window.dbison.profiles.save({ id: ${JSON.stringify(profile.id)}, name: 'T4', driver: 'sqlite', file: ${JSON.stringify(DB_FILE)}, noHistory: true })`)
  await run('recent', `localStorage.setItem('dbison.settings.v1', JSON.stringify({ zoom: 1, queryLimit: 5000, confirmAllWrites: false, recentFiles: [${JSON.stringify(SQL_FILE)}] }))`)
  await win.webContents.reload()
  await wait(9000)
  check('page loaded', (await bodyText()).indexOf('An error has occurred') === -1)

  await clickText('Connect')
  await wait(3000)
  await clickTitled('New query')
  await wait(5000)

  // --- streamed results: a 3000-row query arrives in batches and lands whole
  await setEditor('select * from big')
  await key('Return', ['control'])
  await wait(4000)
  let text = await bodyText()
  check('streamed result shows every row', /3,000 rows|3000 rows/.test(text), (text.match(/[\d,]+ rows · [^\n]*/) || [])[0])
  check('history opt-out kept the statement out', (await run('h', `window.dbison.history.list().then((l) => l.length)`)) === 0)

  // --- bind parameters
  await setEditor('select name from users where id = :id')
  await key('Return', ['control'])
  await wait(1200)
  let dialog = await dialogText()
  check('a :name parameter prompts', /Parameters[\s\S]*:id/.test(dialog), dialog.slice(0, 40))
  await run('focus param', `document.querySelector('.app-dialog-card input').focus()`)
  await win.webContents.insertText('2')
  await wait(400)
  // A synthetic Enter carries no char event, so the form's implicit submit
  // never fires; the button is what a real Enter would press.
  await clickText('Run', '.app-dialog-card')
  await wait(2500)
  check('the parameters dialog closed', !/Parameters/.test(await dialogText()))
  check('the parameter value was bound', /"grace"/.test(await gridCells() ?? ''), await gridCells())

  // --- explain analyze is hidden on an engine without it
  await clickTitled('More ways to run')
  await wait(600)
  const runMenu = await run('menu', `JSON.stringify([...document.querySelectorAll('[role="menuitem"]')].map((x) => x.textContent.trim()))`)
  check('Explain Analyze is absent on SQLite', /Explain Statement/.test(runMenu ?? '') && !/Explain Analyze/.test(runMenu ?? ''), runMenu)
  await key('Escape')
  await wait(400)

  // --- go to table with F12 from the editor
  await setEditor('select * from orders')
  await key('Left')
  await key('F12')
  await wait(3000)
  check('F12 on a table name opens the table', /orders/.test(await tabs() ?? ''), await tabs())

  // --- tab gestures: cycle, close by middle click, reopen
  await key('Tab', ['control'])
  await wait(500)
  const afterCycle = await run('active', `document.querySelector('.dv-tab.dv-active-tab') && document.querySelector('.dv-active-group .dv-tab.dv-active-tab').textContent.trim()`)
  check('Ctrl+Tab moves to another tab', typeof afterCycle === 'string' && afterCycle.length > 0, afterCycle)
  await run('middle', `(function () { var t = [...document.querySelectorAll('.dv-tab')].find((x) => x.textContent.includes('orders')); if (!t) return false; t.querySelector('.dv-default-tab').dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 })); return true })()`)
  await wait(1000)
  check('middle click closed the tab', !/orders/.test(await tabs() ?? ''), await tabs())
  await key('T', ['control', 'shift'])
  await wait(3000)
  check('Ctrl+Shift+T reopened it', /orders/.test(await tabs() ?? ''), await tabs())

  // --- recent files in the File menu
  await run('file menu', `(function () { var t = [...document.querySelectorAll('[role="menubar"] [role="menuitem"]')].find((x) => x.textContent.trim() === 'File'); t.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); t.click(); return !!t })()`)
  await wait(800)
  const fileMenu = await run('items', `JSON.stringify([...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((x) => x.textContent.trim()))`)
  check('File menu lists the recent script', /dbison-tier4-recent\.sql/.test(fileMenu ?? ''), fileMenu)
  await menuItem('dbison-tier4-recent.sql')
  await wait(3000)
  check('a recent file opens in a tab with its text', /dbison-tier4-recent\.sql/.test(await tabs() ?? '') && /select 42/.test((await run('vl', `(function () { var v = document.querySelectorAll('.view-lines'); return v.length ? v[v.length - 1].innerText : '' })()`) ?? '').replace(/\u00a0/g, ' ')))

  // Paste itself cannot be driven here: the harness holds no clipboard the
  // hidden window may read. Its parser is unit-tested; the staging path is
  // the inline editor's, exercised elsewhere.
  await run('open users', `(function () { var b = [...document.querySelectorAll('button[title^="Open users"]')][0]; if (b) b.click(); return !!b })()`)
  await wait(4000)

  // --- JSON tree in the cell viewer
  await run('focus json', `(function () {
    var cell = [...document.querySelectorAll('.result-grid tbody td')].find((c) => c.textContent.trim().startsWith('{"tags"'))
    var r = cell.getBoundingClientRect()
    cell.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.x + 5, clientY: r.y + 5, button: 0, pointerType: 'mouse', isPrimary: true }))
    cell.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: r.x + 5, clientY: r.y + 5, button: 0, pointerType: 'mouse', isPrimary: true }))
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.x + 5, clientY: r.y + 5, button: 0 }))
    return true
  })()`)
  await wait(1500)
  dialog = await dialogText()
  if (!/Tree/.test(dialog)) {
    // An editable table opens the inline editor on double-click; the viewer is the footer button.
    await key('Escape')
    await wait(300)
    await clickTitled('Open this value')
    await wait(1200)
    dialog = await dialogText()
  }
  check('the cell viewer offers a JSON tree', /Tree/.test(dialog), dialog.slice(0, 60))
  await clickText('Tree', '.app-dialog-card')
  await wait(600)
  check('the tree lists keys', /tags[\s\S]*nested/.test(await dialogText()))
  await key('Escape')
  await wait(800)

  // --- drop a table with the typed confirmation
  await run('context orders', `(function () {
    var b = [...document.querySelectorAll('button[title^="Open orders"]')][0]
    var r = b.getBoundingClientRect()
    b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + 40, clientY: r.y + 8, button: 2 }))
    return !!b
  })()`)
  await wait(800)
  await menuItem('Drop Table')
  await wait(1200)
  dialog = await dialogText()
  check('drop asks for the name to be typed', /Type[\s\S]*orders[\s\S]*to confirm/.test(dialog), dialog.slice(0, 80))
  check('the drop button is locked until typed', await run('locked', `!![...document.querySelectorAll('.app-dialog-card button')].find((b) => b.textContent.trim() === 'Drop' && b.disabled)`))
  await win.webContents.insertText('orders')
  await wait(300)
  await clickText('Drop', '.app-dialog-card')
  await wait(3000)
  check('the table is gone', !tableExists('orders'))
  check('the explorer no longer lists it', !(await run('gone', `!![...document.querySelectorAll('button[title^="Open orders"]')].length`)))

  // --- explorer filter is debounced but lands
  await run('filter', `(function () {
    var i = document.querySelector('input[aria-label="Filter tables and columns"]')
    var s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    s.call(i, 'us'); i.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await wait(400)
  check('the filter narrows the explorer', await run('rows', `document.querySelectorAll('[data-explorer-row][data-entity-id*=":table:"]').length`) === 1)

  await run('cleanup', `window.dbison.profiles.remove(${JSON.stringify(profile.id)})`)
  console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(' | ')}` : '\nALL PASSED')
  app.quit()
}).catch((e) => { console.error('SMOKE FAILED:', e); app.exit(1) })
