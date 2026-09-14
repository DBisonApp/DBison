// Captures the explorer's table list against a file with a deliberate spread
// of sizes: empty, tiny, and large enough that the compact figure has to
// abbreviate. ANALYZE is what puts the counts in sqlite_stat1 — without it the
// slot is correctly blank, which is the other case worth seeing.
// Run: npm run dev -- --port 3113   then   node_modules/electron/dist/electron.exe smoke-sidebar.mjs
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { app, BrowserWindow } from 'electron'

import { registerDatabaseIpc } from './electron/ipc.js'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const URL = process.env.APP_URL ?? 'http://127.0.0.1:3113'
const OUT = process.env.SHOT_DIR ?? path.join(ROOT, 'shots')
const DB_FILE = path.join(process.env.TEMP, 'dbison-sidebar.sqlite')

function seed() {
  const db = new DatabaseSync(DB_FILE)

  db.exec(`
    drop table if exists order_items;
    drop table if exists orders;
    drop table if exists customers;
    drop table if exists shipping_zones;
    drop table if exists legacy_import;
    drop view if exists active_customers;

    create table customers (id integer primary key, name text, email text, active integer);
    create table orders (id integer primary key, customer_id integer references customers(id), total real, placed_at text);
    create table order_items (id integer primary key, order_id integer references orders(id), sku text, qty integer);
    create table shipping_zones (id integer primary key, code text, country text);
    create table legacy_import (id integer primary key, payload text);
    create view active_customers as select * from customers where active = 1;
  `)

  const insert = (sql, count, row) => {
    const statement = db.prepare(sql)
    db.exec('begin')
    for (let i = 0; i < count; i += 1) statement.run(...row(i))
    db.exec('commit')
  }

  insert('insert into customers (name, email, active) values (?, ?, ?)', 4200,
    (i) => [`Customer ${i}`, `c${i}@example.com`, i % 3 ? 1 : 0])
  insert('insert into orders (customer_id, total, placed_at) values (?, ?, ?)', 31000,
    (i) => [(i % 4200) + 1, (i % 900) + 0.5, '2026-01-01'])
  insert('insert into order_items (order_id, sku, qty) values (?, ?, ?)', 128000,
    (i) => [(i % 31000) + 1, `SKU-${i % 700}`, (i % 5) + 1])
  insert('insert into shipping_zones (code, country) values (?, ?)', 14,
    (i) => [`Z${i}`, 'DE'])
  // legacy_import stays empty on purpose: the case the sidebar should call out.

  db.exec('analyze')
  db.close()
}

app.setPath('userData', path.join(app.getPath('temp'), 'dbison-smoke-sidebar'))

const errors = []

app.whenReady().then(async () => {
  seed()
  await registerDatabaseIpc()
  await fs.mkdir(OUT, { recursive: true })

  const win = new BrowserWindow({
    show: true, width: 1400, height: 900,
    webPreferences: {
      preload: path.join(ROOT, 'electron', 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
    },
  })
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') errors.push(String(e.message).slice(0, 300))
  })

  const run = (js) => win.webContents.executeJavaScript(js).catch((e) => `ERR: ${e.message}`)
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  const shot = async (name, rect) => {
    const image = await win.webContents.capturePage(rect)
    await fs.writeFile(path.join(OUT, `${name}.png`), image.toPNG())
    console.log('shot:', name)
  }

  win.loadURL(URL).catch((e) => console.log('loadURL rejected:', e.message))
  await wait(12000)
  console.log('loaded:', await run('document.title'))

  const profile = await run(
    `window.dbison.profiles.save({ name: 'Shop', driver: 'sqlite', file: ${JSON.stringify(DB_FILE)} })`,
  )
  console.log('profile:', JSON.stringify(profile))
  await wait(1500)

  console.log('connect:', await run(`(function () {
    var b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Connect')
    if (!b) return 'not found'
    b.click()
    return 'clicked'
  })()`))
  await wait(6000)

  // What the rows actually say, so a wrong number is visible in the log and
  // not only in a picture someone has to squint at.
  console.log('rows:', await run(`JSON.stringify(
    [...document.querySelectorAll('button[title^="Open "]')]
      .map((b) => b.innerText.split(String.fromCharCode(10)).join(' ').trim()),
  )`))
  console.log('titles:', await run(`JSON.stringify(
    [...document.querySelectorAll('button[title^="Open "]')].map((b) => b.title),
  )`))

  // Measured rather than guessed: the panel is resizable, and a rect narrower
  // than it is crops off the right-hand column this capture exists to show.
  const panel = await run(`(function () {
    var el = document.querySelector('input[placeholder^="Filter tables"]')
    if (!el) return null
    var p = el.closest('.flex.h-full.flex-col') || el.parentElement.parentElement
    var r = p.getBoundingClientRect()
    return { x: Math.round(r.x), y: 0, width: Math.round(r.width), height: Math.round(r.bottom) }
  })()`)
  console.log('panel:', JSON.stringify(panel))

  for (const theme of ['dark', 'light']) {
    await run(`document.documentElement.dataset.theme = '${theme}'; localStorage.setItem('dbison.theme','${theme}')`)
    await wait(1200)

    // Read back rather than trust the write: a capture of the wrong theme is
    // indistinguishable from a palette that did not change, and the difference
    // is the whole point of taking two.
    console.log(`theme ${theme}:`, await run(
      `document.documentElement.dataset.theme + ' bg=' + getComputedStyle(document.body).backgroundColor`,
    ))

    await shot(`sidebar-${theme}`, panel && panel.width ? panel : { x: 0, y: 0, width: 420, height: 700 })
  }

  console.log('console errors:', JSON.stringify(errors.slice(0, 8), null, 2))
  await run(`window.dbison.profiles.remove(${JSON.stringify(profile?.id ?? '')})`)
  app.quit()
})
