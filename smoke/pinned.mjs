// A wide table with a pinned column, scrolled sideways: the pinned cells must
// cover what passes under them.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { rm, writeFile } from 'node:fs/promises'
import { app, BrowserWindow } from 'electron'

import { registerDatabaseIpc } from '../electron/ipc.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const APP_URL = process.env.APP_URL ?? 'http://[::1]:3113'
const DB_FILE = path.join(process.env.TEMP, 'dbison-pinned.sqlite')

const USER_DATA = path.join(app.getPath('temp'), 'dbison-smoke-pinned')
await rm(USER_DATA, { recursive: true, force: true })
app.setPath('userData', USER_DATA)

function seed() {
  const db = new DatabaseSync(DB_FILE)
  const columns = Array.from({ length: 14 }, (_, i) => `col_${i} text`).join(', ')
  db.exec(`drop table if exists wide; create table wide (id integer primary key, name text not null, ${columns});`)
  const insert = db.prepare(`insert into wide (name, ${Array.from({ length: 14 }, (_, i) => `col_${i}`).join(', ')}) values (?, ${Array(14).fill('?').join(', ')})`)
  for (let row = 0; row < 12; row++) insert.run(`row ${row}`, ...Array.from({ length: 14 }, (_, i) => `value ${row}.${i} some longer text`))
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
    show: false, width: 1100, height: 700,
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
  const clickText = (text) => run(`click ${text}`, `(function () {
    var b = [].slice.call(document.querySelectorAll('button')).filter(function (x) { return x.textContent.trim() === ${JSON.stringify(text)} })[0]
    if (b) b.click(); return !!b
  })()`)

  await win.loadURL(APP_URL)
  await wait(8000)
  const profile = await run('save', `window.dbison.profiles.save({ name: 'Pinned', driver: 'sqlite', file: ${JSON.stringify(DB_FILE)} })`)
  await win.webContents.reload()
  await wait(9000)
  await clickText('Connect')
  await wait(3000)
  await run('open wide', `(function () { var b = [...document.querySelectorAll('button[title^="Open wide"]')][0]; if (b) b.click(); return !!b })()`)
  await wait(4000)

  // Pin through the second column via the header menu, then scroll sideways.
  await run('context header', `(function () {
    var th = [...document.querySelectorAll('th')].find((t) => t.textContent.trim() === 'name')
    var r = th.getBoundingClientRect()
    th.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + 10, clientY: r.y + 10, button: 2 }))
    return !!th
  })()`)
  await wait(800)
  const pinned = await run('pin', `(function () {
    var item = [...document.querySelectorAll('[role="menuitem"]')].find((x) => /Pin|Freeze/i.test(x.textContent))
    if (!item) return 'not found: ' + [...document.querySelectorAll('[role="menuitem"]')].map((x) => x.textContent.trim()).join(' | ')
    item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
    item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }))
    item.click()
    return item.textContent.trim()
  })()`)
  console.log('pin item:', pinned)
  await wait(800)

  await run('scroll', `(function () { var s = document.querySelector('.result-grid [tabindex="0"]'); s.scrollLeft = 600; return s.scrollLeft })()`)
  await wait(800)

  const styles = await run('styles', `JSON.stringify([...document.querySelectorAll('.result-grid tbody td.sticky')].slice(0, 4).map((td) => getComputedStyle(td).backgroundColor))`)
  check('pinned body cells are opaque', !/rgba\\(.*, 0\\)|transparent/.test(styles ?? '') && /rgb/.test(styles ?? ''), styles)
  check('a pinned body cell exists', (await run('n', `document.querySelectorAll('.result-grid tbody td.sticky').length`)) > 0)

  const headers = await run('hdr', `JSON.stringify([...document.querySelectorAll('th.sticky')].map((th) => ({ text: th.textContent.trim(), w: Math.round(th.getBoundingClientRect().width), overflow: th.querySelector('span') ? th.querySelector('span').scrollWidth > th.querySelector('span').clientWidth : null })))`)
  check('pinned headers still show their names', /"text":"id"/.test(headers ?? '') && /"text":"name"/.test(headers ?? ''), headers)

  const seam = await run('seam', `JSON.stringify([...document.querySelectorAll('.dv-split-view-container.dv-separator-border > .dv-view-container > .dv-view:not(:first-child)')].map((v) => { var s = getComputedStyle(v, '::before'); return { z: s.zIndex, w: s.width, bg: s.backgroundColor } }))`)
  check('split seams sit above panel content', /"z":"40"/.test(seam ?? '') && !/"z":"5"/.test(seam ?? ''), seam)

  const img = await win.webContents.capturePage().catch(() => null)
  if (img) await writeFile(path.join(ROOT, 'shots', 'pinned-scroll.png'), img.toPNG())

  await run('cleanup', `window.dbison.profiles.remove(${JSON.stringify(profile.id)})`)
  console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(' | ')}` : '\nALL PASSED')
  app.quit()
}).catch((e) => { console.error('SMOKE FAILED:', e); app.exit(1) })
