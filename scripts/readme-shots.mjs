// Takes the screenshots the README shows, against a demo shop database, and
// writes them to docs/screenshots/. Needs the dev server, like the smoke
// scripts:
//
//   npm run dev -- --port 3113
//   env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe scripts/readme-shots.mjs
//
// The database lives at C:\data\shop.sqlite (DEMO_DB overrides it) because
// its path is on screen, and a temp folder would put a user name there. The
// Nuxt devtools button is hidden before each capture.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { app, BrowserWindow } from 'electron'

import { registerDatabaseIpc } from '../electron/ipc.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const APP_URL = process.env.APP_URL ?? 'http://[::1]:3113'
const OUT = path.join(ROOT, 'docs', 'screenshots')
const DB_FILE = process.env.DEMO_DB ?? (process.platform === 'win32' ? 'C:\\data\\shop.sqlite' : '/tmp/shop.sqlite')
const USER_DATA = path.join(app.getPath('temp'), 'dbison-readme-shots')

// --- Demo data ---------------------------------------------------------------

/** A small deterministic generator, so every run draws the same shop. */
function random(seed) {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

const FIRST = ['Ada', 'Grace', 'Linus', 'Margaret', 'Alan', 'Barbara', 'Dennis', 'Frances', 'Ken', 'Radia', 'Edsger', 'Hedy', 'Donald', 'Katherine', 'Tim', 'Sophie', 'John', 'Annie', 'Niklaus', 'Karen']
const LAST = ['Lovelace', 'Hopper', 'Torvalds', 'Hamilton', 'Turing', 'Liskov', 'Ritchie', 'Allen', 'Thompson', 'Perlman', 'Dijkstra', 'Lamarr', 'Knuth', 'Johnson', 'Berners-Lee', 'Wilson', 'McCarthy', 'Easley', 'Wirth', 'Spärck Jones']
const COUNTRIES = ['United States', 'Germany', 'United Kingdom', 'Czechia', 'France', 'Netherlands', 'Canada', 'Japan', 'Sweden', 'Spain']
const CATEGORIES = ['Keyboards', 'Mice', 'Monitors', 'Audio', 'Cables', 'Desks']
const PRODUCTS = [
  ['Mechanical Keyboard TKL', 0, 129], ['Low-Profile Keyboard', 0, 89], ['Split Ergonomic Keyboard', 0, 249],
  ['Wireless Mouse', 1, 49], ['Vertical Mouse', 1, 69], ['Trackball Pro', 1, 99],
  ['27" 4K Monitor', 2, 399], ['34" Ultrawide Monitor', 2, 649], ['Portable 15" Monitor', 2, 219],
  ['Studio Headphones', 3, 179], ['USB Microphone', 3, 129], ['Desk Speakers', 3, 149],
  ['USB-C Cable 2 m', 4, 19], ['HDMI 2.1 Cable', 4, 24], ['Thunderbolt Dock', 4, 279],
  ['Standing Desk', 5, 549], ['Monitor Arm', 5, 119], ['Desk Mat XL', 5, 35],
]
const STATUSES = ['delivered', 'delivered', 'delivered', 'shipped', 'paid', 'pending', 'refunded']

function seed() {
  const db = new DatabaseSync(DB_FILE)
  const rand = random(42)
  const pick = (list) => list[Math.floor(rand() * list.length)]

  db.exec(`
    drop view if exists customer_revenue;
    drop table if exists order_items;
    drop table if exists orders;
    drop table if exists products;
    drop table if exists categories;
    drop table if exists customers;

    create table customers (
      id integer primary key,
      name text not null,
      email text not null unique,
      country text not null,
      signed_up date not null
    );
    create table categories (id integer primary key, name text not null unique);
    create table products (
      id integer primary key,
      category_id integer not null references categories(id),
      name text not null,
      price numeric(10,2) not null,
      in_stock integer not null default 1
    );
    create table orders (
      id integer primary key,
      customer_id integer not null references customers(id),
      status text not null,
      placed_at datetime not null,
      total numeric(10,2) not null default 0
    );
    create table order_items (
      id integer primary key,
      order_id integer not null references orders(id),
      product_id integer not null references products(id),
      quantity integer not null,
      unit_price numeric(10,2) not null
    );
    create index orders_customer_idx on orders (customer_id);
    create index order_items_order_idx on order_items (order_id);
    create view customer_revenue as
      select c.id, c.name, sum(o.total) as revenue
      from customers c join orders o on o.customer_id = c.id
      where o.status <> 'refunded'
      group by c.id;
  `)

  const insertCustomer = db.prepare('insert into customers (name, email, country, signed_up) values (?, ?, ?, ?)')
  FIRST.forEach((first, index) => {
    const last = LAST[index]
    const email = `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '') + '@example.com'
    const day = String(1 + Math.floor(rand() * 28)).padStart(2, '0')
    const month = String(1 + Math.floor(rand() * 12)).padStart(2, '0')
    insertCustomer.run(`${first} ${last}`, email, pick(COUNTRIES), `2025-${month}-${day}`)
  })

  const insertCategory = db.prepare('insert into categories (name) values (?)')
  for (const name of CATEGORIES) insertCategory.run(name)

  const insertProduct = db.prepare('insert into products (category_id, name, price, in_stock) values (?, ?, ?, ?)')
  for (const [name, category, price] of PRODUCTS) insertProduct.run(category + 1, name, price, rand() > 0.15 ? 1 : 0)

  const insertOrder = db.prepare('insert into orders (customer_id, status, placed_at) values (?, ?, ?)')
  const insertItem = db.prepare('insert into order_items (order_id, product_id, quantity, unit_price) values (?, ?, ?, ?)')
  for (let index = 0; index < 240; index++) {
    // Weighted towards the first customers, so the revenue ranking has a shape.
    const customer = 1 + Math.floor(rand() ** 1.6 * FIRST.length)
    const month = String(1 + Math.floor(rand() * 9)).padStart(2, '0')
    const day = String(1 + Math.floor(rand() * 28)).padStart(2, '0')
    const hour = String(8 + Math.floor(rand() * 12)).padStart(2, '0')
    const minute = String(Math.floor(rand() * 60)).padStart(2, '0')
    const { lastInsertRowid } = insertOrder.run(customer, pick(STATUSES), `2026-${month}-${day} ${hour}:${minute}`)
    const lines = 1 + Math.floor(rand() * 3)
    for (let line = 0; line < lines; line++) {
      const product = Math.floor(rand() * PRODUCTS.length)
      insertItem.run(lastInsertRowid, product + 1, 1 + Math.floor(rand() ** 3 * 3), PRODUCTS[product][2])
    }
  }
  db.exec('update orders set total = (select sum(quantity * unit_price) from order_items where order_id = orders.id)')
  db.close()
}

// --- Capture -----------------------------------------------------------------

// Unindented: Monaco carries each line's indent onto the next as it is typed,
// so indentation here would pile up.
const HERO_QUERY = `-- Best customers this year, refunds left out
select c.name, c.country, count(o.id) as orders, sum(o.total) as revenue
from customers c
join orders o on o.customer_id = c.id
where o.status <> 'refunded'
group by c.id
order by revenue desc;`

app.whenReady().then(async () => {
  await fs.mkdir(path.dirname(DB_FILE), { recursive: true })
  await fs.mkdir(OUT, { recursive: true })
  await fs.rm(USER_DATA, { recursive: true, force: true })
  app.setPath('userData', USER_DATA)
  seed()
  await registerDatabaseIpc()

  const win = new BrowserWindow({
    show: true,
    width: 1440,
    height: 860,
    webPreferences: {
      preload: path.join(ROOT, 'electron', 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  })
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') console.log('RENDERER:', String(event.message).slice(0, 300))
  })

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const run = (js) => win.webContents.executeJavaScript(js).catch((error) => `ERR: ${error.message}`)
  const clickText = (text) => run(`(function () {
    var b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)})
    if (b) b.click(); return !!b
  })()`)
  const clickTitled = (title) => run(`(function () {
    var b = document.querySelector('button[title^=' + JSON.stringify(${JSON.stringify(title)}) + ']')
    if (b) b.click(); return !!b
  })()`)
  const menuItem = (text) => run(`(function () {
    var item = [...document.querySelectorAll('[role="menuitem"]')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)}))
    if (!item) return false
    item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
    item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }))
    item.click()
    return true
  })()`)
  const key = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await wait(250)
  }
  const click = async (x, y) => {
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    await wait(300)
  }
  const setEditor = async (text) => {
    const box = await run(`(function () {
      var e = document.querySelector('.monaco-editor .view-lines'); if (!e) return null
      var r = e.getBoundingClientRect(); return { x: Math.round(r.x + 20), y: Math.round(r.y + 10) }
    })()`)
    if (!box || typeof box !== 'object') return false
    await click(box.x, box.y)
    await key('A', ['control'])
    await key('Delete')
    await win.webContents.insertText(text)
    await key('Home', ['control'])
    await wait(400)
    return true
  }
  /** Drags the sash between the explorer and the documents to `x`. */
  const moveSash = async (x) => {
    const sash = await run(`(function () {
      var s = [...document.querySelectorAll('.dv-sash')].map((e) => e.getBoundingClientRect()).find((r) => r.height > 300 && r.width < 20)
      return s ? { x: Math.round(s.x + s.width / 2), y: Math.round(s.y + s.height / 2) } : null
    })()`)
    if (!sash || typeof sash !== 'object') return false
    win.webContents.sendInputEvent({ type: 'mouseDown', x: sash.x, y: sash.y, button: 'left', clickCount: 1 })
    for (let step = 1; step <= 10; step++) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(sash.x + (x - sash.x) * step / 10), y: sash.y, button: 'left' })
      await wait(30)
    }
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y: sash.y, button: 'left', clickCount: 1 })
    await wait(600)
    return true
  }
  /** A real click on an element, for triggers that open on pointerdown. */
  const clickOn = async (selector) => {
    const box = await run(`(function () {
      var e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null
      var r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })()`)
    if (!box || typeof box !== 'object') return false
    await click(box.x, box.y)
    return true
  }
  const focusFirstCell = () => run(`(function () {
    var cell = document.querySelector('.result-grid tbody td:nth-child(2)'); if (!cell) return false
    var r = cell.getBoundingClientRect()
    for (var type of ['pointerdown', 'pointerup']) cell.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: r.x + 5, clientY: r.y + 5, button: 0, pointerType: 'mouse', isPrimary: true }))
    return true
  })()`)
  const shot = async (name) => {
    await win.webContents.insertCSS('#nuxt-devtools-container, nuxt-devtools-frame, .nuxt-devtools-anchor { display: none !important; }')
    await wait(500)
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const image = await win.webContents.capturePage()
        await fs.writeFile(path.join(OUT, `${name}.png`), image.toPNG())
        console.log('shot:', name, image.getSize())
        return
      }
      catch (error) {
        console.log('shot failed:', name, error.message)
        await wait(800)
      }
    }
  }

  try {
    await win.loadURL(APP_URL).catch((error) => console.log('loadURL:', error.message))
    await wait(10000)
    console.log('profile:', JSON.stringify(await run(`window.dbison.profiles.save({ name: 'Shop', driver: 'sqlite', file: ${JSON.stringify(DB_FILE)}, color: '#a855f7' })`)))
    win.webContents.reload()
    await wait(9000)

    console.log('connect:', await clickText('Connect'))
    await wait(4000)
    console.log('sash:', await moveSash(380))

    // A query with results: the hero, in both themes.
    console.log('new query:', await clickTitled('New query'))
    await wait(4000)
    // Monaco loads on its own schedule; retype until the query is really there.
    for (let attempt = 1; attempt <= 5; attempt++) {
      await setEditor(HERO_QUERY)
      const lines = String(await run(`(document.querySelector('.monaco-editor .view-lines') || {}).innerText || ''`)).replace(/\u00a0/g, ' ')
      console.log('editor attempt', attempt, /from customers c/.test(lines))
      if (/from customers c/.test(lines)) break
      await wait(2000)
    }
    await key('Return', ['control', 'shift'])
    await wait(3000)
    await run(`document.activeElement && document.activeElement.blur()`)
    await shot('query-dark')
    await clickTitled('Switch to light theme')
    await wait(1200)
    await shot('query-light')
    await clickTitled('Switch to dark theme')
    await wait(1200)

    // A table tab with the record view open beside the grid.
    console.log('open orders:', await run(`(function () { var b = document.querySelector('button[title^="Open orders"]'); if (b) b.click(); return !!b })()`))
    await wait(4000)
    console.log('cell:', await focusFirstCell())
    await wait(300)
    console.log('record view:', await clickTitled('Record view'))
    await wait(1200)
    await shot('table')

    // The relationship diagram.
    // The explorer is narrow enough that the diagram button sits in its menu.
    console.log('more actions:', await clickOn('button[aria-label="More actions for this database"]'))
    await wait(600)
    console.log('diagram:', await menuItem('Show relationship diagram'))
    await wait(4000)
    await shot('diagram')
  }
  catch (error) {
    console.error('FAILED:', error)
  }
  app.quit()
})
