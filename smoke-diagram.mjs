// Captures the ER diagram against a file with enough keys to make a picture:
// a chain (order_items → orders → customers), a fan-in (orders and shipments
// both reach addresses), a self-reference (categories.parent_id) and a table
// with no keys at all, which should sit on its own at the edge.
// Run: npm run dev -- --port 3113   then   node_modules/electron/dist/electron.exe smoke-diagram.mjs
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { app, BrowserWindow } from 'electron'

import { registerDatabaseIpc } from './electron/ipc.js'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const URL = process.env.APP_URL ?? 'http://127.0.0.1:3113'
const OUT = process.env.SHOT_DIR ?? path.join(ROOT, 'shots')
const DB_FILE = path.join(process.env.TEMP, 'dbison-diagram.sqlite')

function seed() {
  const db = new DatabaseSync(DB_FILE)

  db.exec(`
    pragma foreign_keys = on;

    drop table if exists order_items;
    drop table if exists shipments;
    drop table if exists orders;
    drop table if exists products;
    drop table if exists categories;
    drop table if exists addresses;
    drop table if exists customers;
    drop table if exists audit_log;
    drop table if exists settings;
    drop table if exists migrations;
    drop table if exists sessions;
    drop table if exists tags;
    drop table if exists jobs;
    drop table if exists job_runs;
    drop view if exists open_orders;

    create table customers (
      id integer primary key,
      name text not null,
      email text not null,
      created_at text not null
    );
    create table addresses (
      id integer primary key,
      customer_id integer not null references customers(id),
      line1 text not null,
      city text not null,
      country text not null
    );
    create table categories (
      id integer primary key,
      parent_id integer references categories(id),
      name text not null
    );
    create table products (
      id integer primary key,
      category_id integer references categories(id),
      sku text not null,
      name text not null,
      price real not null
    );
    create table orders (
      id integer primary key,
      customer_id integer not null references customers(id),
      ship_to integer references addresses(id),
      status text not null,
      placed_at text not null
    );
    create table order_items (
      id integer primary key,
      order_id integer not null references orders(id),
      product_id integer not null references products(id),
      qty integer not null,
      unit_price real not null
    );
    create table shipments (
      id integer primary key,
      order_id integer not null references orders(id),
      address_id integer not null references addresses(id),
      carrier text,
      shipped_at text
    );
    create table audit_log (
      id integer primary key,
      at text not null,
      actor text,
      message text
    );
    -- Standalone tables, which dagre would otherwise stack in one column.
    create table settings (key text primary key, value text);
    create table migrations (id integer primary key, name text not null, applied_at text not null);
    create table sessions (token text primary key, user_id integer, expires_at text not null);
    create table tags (id integer primary key, name text not null);
    -- A second, smaller joined-up group.
    create table jobs (id integer primary key, name text not null, cron text);
    create table job_runs (id integer primary key, job_id integer not null references jobs(id), started_at text, ok integer);
    create view open_orders as select * from orders where status = 'open';
  `)

  db.close()
}

app.setPath('userData', path.join(app.getPath('temp'), 'dbison-smoke-diagram'))

const errors = []

app.whenReady().then(async () => {
  seed()
  await registerDatabaseIpc()
  await fs.mkdir(OUT, { recursive: true })

  const win = new BrowserWindow({
    show: true,
    width: 1440,
    height: 900,
    webPreferences: {
      preload: path.join(ROOT, 'electron', 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // The boxes are measured by a ResizeObserver, which only fires when the
      // window gets a frame; a window that opens behind another gets none
      // while throttled, and the diagram never fits.
      backgroundThrottling: false,
    },
  })

  // A module that fails to compile shows up here as a 500, where the page's
  // own error only says that some import in the chain failed.
  win.webContents.session.webRequest.onCompleted((d) => {
    if (d.statusCode >= 400) console.log('http', d.statusCode, d.url.slice(0, 200))
  })
  win.webContents.session.webRequest.onErrorOccurred((d) => {
    if (d.error !== 'net::ERR_ABORTED') console.log('neterr', d.error, d.url.slice(0, 200))
  })

  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') errors.push(String(e.message).slice(0, 300))
  })

  const run = (js) => win.webContents.executeJavaScript(js).catch((e) => `ERR: ${e.message}`)
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  const shot = async (name, rect) => {
    try {
      const image = await win.webContents.capturePage(rect)
      await fs.writeFile(path.join(OUT, `${name}.png`), image.toPNG())
      console.log('shot:', name)
    }
    catch (error) {
      // A capture can fail while the compositor is busy; the run is still
      // worth finishing for what it logs.
      console.log('shot failed:', name, error.message)
    }
  }

  const clickTitled = (title) => run(`(function () {
    var b = document.querySelector('button[title=' + JSON.stringify(${JSON.stringify(title)}) + ']')
    if (!b) return 'not found'
    b.click()
    return 'clicked'
  })()`)

  win.loadURL(URL).catch((e) => console.log('loadURL rejected:', e.message))
  await wait(12000)
  console.log('loaded:', await run('document.title'))

  const profile = await run(
    `window.dbison.profiles.save({ name: 'Shop', driver: 'sqlite', file: ${JSON.stringify(DB_FILE)} })`,
  )
  console.log('profile:', JSON.stringify(profile))

  // The explorer reads the profile list once, on mount, which happened before
  // the save above; a reload is how the fresh profile reaches it.
  win.webContents.reload()
  await wait(8000)

  console.log('connect:', await run(`(function () {
    var b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Connect')
    if (!b) return 'not found'
    b.click()
    return 'clicked'
  })()`))
  await wait(5000)

  console.log('open diagram:', await clickTitled('Show the relationship diagram'))
  await wait(2500)

  console.log('nodes:', await run(`JSON.stringify(
    [...document.querySelectorAll('.erd-table')].map((n) => n.textContent.trim().split(/\\s+/)[0]),
  )`))
  console.log('edges:', await run(`document.querySelectorAll('.erd-flow .vue-flow__edge').length`))
  console.log('viewport:', await run(`(function () {
    var flow = document.querySelector('.erd-flow')
    var pane = flow.querySelector('.vue-flow__transformationpane')
    var r = flow.getBoundingClientRect()
    var nodes = [...flow.querySelectorAll('.vue-flow__node')].map((n) => n.style.transform + ' ' + n.offsetWidth + 'x' + n.offsetHeight)
    return JSON.stringify({ size: r.width + 'x' + r.height, transform: pane && pane.style.transform, nodes: nodes.slice(0, 3) })
  })()`))
  console.log('fit button:', await clickTitled('Fit the diagram to the window'))
  await wait(600)
  console.log('after fit:', await run(`document.querySelector('.erd-flow .vue-flow__transformationpane').style.transform`))

  console.log('status:', await run(`(function () {
    var s = [...document.querySelectorAll('span')].find((x) => /keys?$/.test(x.textContent.trim()))
    return s ? s.textContent.replace(/\\s+/g, ' ').trim() : 'no status'
  })()`))

  for (const theme of ['dark', 'light']) {
    await run(`document.documentElement.dataset.theme = '${theme}'; localStorage.setItem('dbison.theme','${theme}')`)
    await wait(1200)
    await shot(`diagram-${theme}`)
  }

  await run(`document.documentElement.dataset.theme = 'dark'`)

  // The per-table picture: right-click a row in the explorer, take the item.
  console.log('context:', await run(`(function () {
    var b = [...document.querySelectorAll('button[title^="Open "]')].find((x) => x.title.startsWith('Open orders'))
    if (!b) return 'row not found'
    var r = b.getBoundingClientRect()
    b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + 40, clientY: r.y + 8, button: 2 }))
    return 'dispatched'
  })()`))
  await wait(800)

  console.log('menu item:', await run(`(function () {
    var item = [...document.querySelectorAll('[role="menuitem"]')].find((x) => x.textContent.includes('Show Relationships'))
    if (!item) return 'not found: ' + [...document.querySelectorAll('[role="menuitem"]')].map((x) => x.textContent.trim()).join(' | ')
    item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
    item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }))
    item.click()
    return 'selected'
  })()`))
  await wait(2500)

  console.log('tabs:', await run(`JSON.stringify([...document.querySelectorAll('.dv-tab')].map((t) => t.textContent.trim()))`))
  console.log('related nodes:', await run(`JSON.stringify(
    [...document.querySelectorAll('.erd-table')].map((n) => n.textContent.trim().split(/\\s+/)[0]),
  )`))

  await shot('diagram-related-dark')

  console.log('console errors:', JSON.stringify(errors.slice(0, 8), null, 2))
  await run(`window.dbison.profiles.remove(${JSON.stringify(profile?.id ?? '')})`)
  app.quit()
})
