// The dialog frame against a short window: the connection dialog must stay
// inside the viewport with its buttons in view, and lay its fields out in
// two columns. Run with `npm run smoke dialog-layout`.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rm, writeFile } from 'node:fs/promises'
import { app, BrowserWindow } from 'electron'

import { registerDatabaseIpc } from '../electron/ipc.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const APP_URL = process.env.APP_URL ?? 'http://[::1]:3113'

const USER_DATA = path.join(app.getPath('temp'), 'dbison-smoke-dialog')
await rm(USER_DATA, { recursive: true, force: true })
app.setPath('userData', USER_DATA)

const failures = []
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${String(detail).slice(0, 300)}` : ''}`)
  if (!ok) failures.push(label)
}

app.whenReady().then(async () => {
  await registerDatabaseIpc()

  // Deliberately short: the height the dialog used to overflow at.
  const win = new BrowserWindow({
    show: false, width: 1100, height: 560,
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

  await run('open dialog', `[...document.querySelectorAll('button')].find((b) => /New connection/.test(b.textContent)).click()`)
  await wait(1200)

  const geometry = await run('geometry', `(function () {
    var card = document.querySelector('.app-dialog-card'); if (!card) return null
    var r = card.getBoundingClientRect()
    var footer = card.querySelector('footer'); var f = footer && footer.getBoundingClientRect()
    var name = [...card.querySelectorAll('label')].find((l) => l.textContent.trim().startsWith('Name'))
    var folder = [...card.querySelectorAll('label')].find((l) => l.textContent.trim().startsWith('Folder'))
    return {
      viewport: { w: innerWidth, h: innerHeight },
      card: { top: r.top, bottom: r.bottom, width: r.width },
      footerBottom: f ? f.bottom : null,
      nameLeft: name ? name.getBoundingClientRect().left : null,
      folderLeft: folder ? folder.getBoundingClientRect().left : null,
      nameTop: name ? name.getBoundingClientRect().top : null,
      folderTop: folder ? folder.getBoundingClientRect().top : null,
    }
  })()`)

  check('dialog opened', Boolean(geometry), 'no card')
  if (geometry) {
    check('card fits inside the window', geometry.card.top >= 0 && geometry.card.bottom <= geometry.viewport.h, JSON.stringify(geometry))
    check('footer with Save stays visible', geometry.footerBottom !== null && geometry.footerBottom <= geometry.viewport.h, `footer bottom ${geometry.footerBottom} of ${geometry.viewport.h}`)
    check('card is wide', geometry.card.width >= 700, `width ${geometry.card.width}`)
    check('fields sit in two columns', geometry.folderLeft > geometry.nameLeft + 200 && Math.abs(geometry.folderTop - geometry.nameTop) < 40, `name at ${geometry.nameLeft}, folder at ${geometry.folderLeft}`)
  }
  await shot('dialog-short-window')

  // The SSH section opened: the body gets longer, the footer must still be there.
  // SSL and the SSH tunnel are both plain checkboxes; ticking them grows the body.
  await run('ssl and ssh on', `(function () {
    var boxes = [...document.querySelectorAll('.app-dialog-card label')].filter((l) => /Use SSL|SSH tunnel/.test(l.textContent)).map((l) => l.querySelector('input[type=checkbox]'))
    boxes.forEach((cb) => { if (cb && !cb.checked) cb.click() }); return boxes.length
  })()`)
  await wait(600)
  const after = await run('after', `(function () {
    var card = document.querySelector('.app-dialog-card'); var f = card.querySelector('footer').getBoundingClientRect()
    var body = card.querySelector('form > div'); return { footerBottom: f.bottom, h: innerHeight, scrollable: body.scrollHeight > body.clientHeight }
  })()`)
  check('footer still visible with SSH and SSL ticked', after && after.footerBottom <= after.h, JSON.stringify(after))
  check('body scrolls instead of the card growing', Boolean(after?.scrollable), JSON.stringify(after))
  await shot('dialog-short-window-expanded')

  console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join('; ')}` : '\nAll checks passed')
  app.exit(failures.length ? 1 : 0)
})
