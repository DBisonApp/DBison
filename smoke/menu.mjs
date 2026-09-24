// Exercises the menu bar and the shortcut registry, and captures the File and
// View menus open. Checks the things the hand-rolled bar could not do: menu
// ARIA roles, arrow-key navigation, Esc, and Ctrl+1 actually toggling the
// explorer.
// Run: npm run dev -- --port 3113   then   node_modules/electron/dist/electron.exe smoke/menu.mjs
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'

import { registerDatabaseIpc } from '../electron/ipc.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const URL = process.env.APP_URL ?? 'http://127.0.0.1:3113'
const OUT = process.env.SHOT_DIR ?? path.join(ROOT, 'shots')

app.setPath('userData', path.join(app.getPath('temp'), 'dbison-smoke-menu'))

const errors = []

app.whenReady().then(async () => {
  await registerDatabaseIpc()
  await fs.mkdir(OUT, { recursive: true })

  const win = new BrowserWindow({
    show: true,
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(ROOT, 'electron', 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
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
    catch (e) {
      console.log('shot failed:', name, e.message)
    }
  }

  /**
   * Sends a real key through the browser, so app shortcuts see it too.
   *
   * The `char` event is only sent for keys that produce text: emitting one for
   * Escape or an arrow injects a stray character into whatever has focus.
   */
  const key = (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    if (keyCode.length === 1 && !modifiers.length) {
      win.webContents.sendInputEvent({ type: 'char', keyCode, modifiers })
    }
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  }

  /**
   * Arrow keys, dispatched into the DOM rather than through `sendInputEvent`.
   *
   * Electron's input layer names arrows the legacy way — it delivers `key:
   * 'Down'`, and neither 'Down' nor 'ArrowDown' reaches a handler as the
   * standard 'ArrowDown' — so the OS path cannot exercise them at all. These
   * are real bubbling KeyboardEvents on the focused element, which is what the
   * menu's own handlers listen for.
   */
  const arrow = (name) => run(`(function () {
    var e = new KeyboardEvent('keydown', {
      key: ${JSON.stringify('')} + ${JSON.stringify(name)},
      code: ${JSON.stringify(name)},
      bubbles: true,
      cancelable: true,
    })
    document.activeElement.dispatchEvent(e)
    return document.activeElement.getAttribute('role')
  })()`)

  const focused = () => run(
    `(document.activeElement?.getAttribute('role') ?? document.activeElement?.tagName ?? 'none')
      + ' :: ' + (document.activeElement?.textContent ?? '').trim().slice(0, 30)`,
  )

  /**
   * Clicks with real input events rather than `element.click()`.
   *
   * Reka opens a menu on pointerdown, which a synthetic click never produces —
   * driving it any other way tests the harness, not the menu.
   */
  const clickText = async (text) => {
    const at = await run(`(function () {
      var b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)})
      if (!b) return null
      var r = b.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })()`)

    if (!at || !at.x) return 'not found'

    win.webContents.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y })
    win.webContents.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 })
    return 'clicked'
  }

  win.loadURL(URL).catch((e) => console.log('loadURL rejected:', e.message))
  await wait(14000)
  console.log('loaded:', await run('document.title'))
  await run(`document.documentElement.dataset.theme = 'dark'`)
  await wait(400)

  console.log('early console errors:', JSON.stringify(errors.slice(0, 6), null, 2))
  console.log('header html:', await run(`document.querySelector('header')?.outerHTML.slice(0, 700) ?? 'NO HEADER'`))

  // 2. Roles the hand-rolled bar never had.
  console.log('roles:', await run(`JSON.stringify({
    menubar: !!document.querySelector('[role="menubar"]'),
    triggers: document.querySelectorAll('[role="menubar"] [role="menuitem"]').length,
  })`))

  // 3. Open File and capture it.
  console.log('open File:', await clickText('File'))
  await wait(600)
  console.log('open menu:', await run(`JSON.stringify({
    role: document.querySelector('[role="menu"]')?.getAttribute('role') ?? null,
    items: [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((n) => n.textContent.trim()),
    hints: [...document.querySelectorAll('[role="menu"] kbd')].map((n) => n.textContent.trim()),
  })`))
  await shot('menu-file-dark', { x: 0, y: 0, width: 460, height: 260 })

  // 4. Arrow keys must move the highlight — the old bar ignored them entirely.
  console.log('focus after open:', await focused())
  await arrow('ArrowDown')
  await wait(250)
  await arrow('ArrowDown')
  await wait(350)
  console.log('focus after 2x ArrowDown:', await focused())
  console.log('highlighted after 2x ArrowDown:', await run(
    `document.querySelector('[role="menu"] [data-highlighted]')?.textContent.trim() ?? 'none'`,
  ))

  // 5. Right arrow must walk to the next menu in the bar.
  await arrow('ArrowRight')
  await wait(500)
  console.log('after ArrowRight, open menu items:', await run(
    `JSON.stringify([...document.querySelectorAll('[role="menu"] [role="menuitemcheckbox"], [role="menu"] [role="menuitem"]')].map((n) => n.textContent.trim()))`,
  ))
  await shot('menu-view-dark', { x: 0, y: 0, width: 460, height: 260 })

  // 5b. The keyboard-only path: tab to the bar, open with Enter, walk with
  // arrows. This is the flow a keyboard user actually takes, and the one the
  // hand-rolled bar had no code for at all.
  key('Escape')
  await wait(300)
  await run(`[...document.querySelectorAll('[role="menubar"] [role="menuitem"]')][0]?.focus()`)
  await wait(200)
  console.log('focus on bar:', await focused())
  key('Enter')
  await wait(500)
  console.log('after Enter, focus:', await focused())
  await arrow('ArrowDown')
  await wait(250)
  console.log('after ArrowDown, focus:', await focused())
  await arrow('ArrowDown')
  await wait(250)
  console.log('after 2nd ArrowDown, focus:', await focused())
  await arrow('ArrowRight')
  await wait(500)
  console.log('after ArrowRight, open menu:', await run(
    `JSON.stringify([...document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] [role="menuitemcheckbox"]')].map((n) => n.textContent.trim()))`,
  ))

  // 6. Esc must close it.
  key('Escape')
  await wait(400)
  console.log('after Escape, menus open:', await run(`document.querySelectorAll('[role="menu"]').length`))

  // 7. The shortcut the menu advertises must actually do something.
  const before = await run(`!!document.querySelector('.dv-dockview [data-testid], .dv-dockview')`)
  const explorerBefore = await run(`!!document.querySelector('[data-dv-panel-id="navigator"], .dv-tab')`)
  console.log('dockview present:', before, 'tabs present:', explorerBefore)

  const tabsOf = `[...document.querySelectorAll('.dv-tab')].map((n) => n.textContent.trim()).join('|')`
  console.log('tabs before Ctrl+1:', await run(tabsOf))
  key('1', ['control'])
  await wait(900)
  console.log('tabs after  Ctrl+1:', await run(tabsOf))
  key('1', ['control'])
  await wait(900)
  console.log('tabs after  Ctrl+1 again:', await run(tabsOf))

  // 8. Light theme, File menu again.
  await run(`document.documentElement.dataset.theme = 'light'`)
  await wait(400)
  console.log('open File:', await clickText('File'))
  await wait(600)
  await shot('menu-file-light', { x: 0, y: 0, width: 460, height: 260 })

  console.log('console errors:', JSON.stringify(errors.slice(0, 8), null, 2))
  app.quit()
})
