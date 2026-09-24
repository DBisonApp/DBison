import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { app, BrowserWindow } from 'electron'

import { registerDatabaseIpc } from '../electron/ipc.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const APP_URL = 'http://127.0.0.1:3113'
const DB_FILE = path.join(process.env.TEMP, 'dbison-sqlerror.sqlite')
const TYPO = 'select id, name\n  from userz\n where id = 1'

function seed() {
  const db = new DatabaseSync(DB_FILE)
  db.exec('drop table if exists users')
  db.exec('create table users (id integer primary key, name text)')
  db.exec("insert into users (name) values ('ada'), ('grace')")
  db.close()
}

app.whenReady().then(async () => {
  seed()
  await registerDatabaseIpc()

  const win = new BrowserWindow({
    show: false, width: 1400, height: 900,
    webPreferences: {
      preload: path.join(ROOT, 'electron', 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
    },
  })

  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const run = async (label, js) => {
    try { return await win.webContents.executeJavaScript(js) }
    catch (error) { console.log('!! failed:', label, String(error).slice(0, 120)); return null }
  }

  await win.loadURL(APP_URL)
  await wait(10000)

  const profile = await run('save', `window.dbison.profiles.save({ name: 'Err Test', driver: 'sqlite', file: ${JSON.stringify(DB_FILE)} })`)
  await win.webContents.reload()
  await wait(10000)

  console.log('OVERLAY:', await run('overlay', `document.body.innerText.indexOf('An error has occurred') !== -1 ? document.body.innerText.slice(0, 200) : 'none'`))

  await run('connect', `(function () {
    var b = [].slice.call(document.querySelectorAll('button')).filter(function (x) { return x.textContent.indexOf('Err Test') !== -1 })[0]
    if (b) b.click(); return !!b
  })()`)
  await wait(2500)
  await run('newquery', `(function () { var b = document.querySelector('button[title="New query"]'); if (b) b.click(); return !!b })()`)
  await wait(5000)

  await run('type', `(function () {
    var ta = document.querySelector('textarea')
    if (!ta) return 'NO TEXTAREA'
    var s = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    s.call(ta, ${JSON.stringify(TYPO)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  })()`)
  await wait(1200)

  await run('run', `(function () {
    var b = [].slice.call(document.querySelectorAll('button')).filter(function (x) { return x.textContent.trim() === 'Run' })[0]
    if (b) b.click(); return !!b
  })()`)
  await wait(4500)

  console.log('RESULT:', await run('check', `(function () {
    var t = document.body.innerText
    return JSON.stringify({
      modelUri: String(document.querySelector('.monaco-editor') ? 'editor present' : 'no editor'),
      panelMessage: (t.match(/no such table[^\n]*/) || [null])[0],
      location: (t.match(/Line \\d+, column \\d+/) || [null])[0],
      squigglyError: document.querySelectorAll('.squiggly-error').length,
      squigglyText: (function () { var e = document.querySelector('.squiggly-error'); return e ? e.textContent : null })()
    })
  })()`))

  await run('edit', `(function () {
    var ta = document.querySelector('textarea')
    var s = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    s.call(ta, 'select id, name\n  from users\n where id = 1')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await wait(1500)
  console.log('AFTER EDIT:', await run('after', `JSON.stringify({ squigglyError: document.querySelectorAll('.squiggly-error').length })`))

  const img = await win.webContents.capturePage()
  await (await import('node:fs/promises')).writeFile(path.join(ROOT, 'shots', 'sqlerror.png'), img.toPNG())

  await run('cleanup', `window.dbison.profiles.remove(${JSON.stringify(profile.id)})`)
  app.quit()
}).catch((e) => { console.error('SMOKE FAILED:', e); app.exit(1) })
