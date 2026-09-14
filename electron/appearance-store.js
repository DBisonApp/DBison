import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { app } from 'electron'

const FILE_NAME = 'appearance.json'

// The dark palette from main.css: the theme a first run opens on. `color` and
// `symbolColor` are the title bar's (surface and text); `background` is the
// page behind it, which is what an empty window paints.
const DEFAULTS = {
  theme: 'dark',
  color: '#141a2c',
  symbolColor: '#e8ecf6',
  background: '#0d1120',
}

const HEX = /^#[0-9a-f]{6}$/i

let current = { ...DEFAULTS }
let file

/**
 * Remembers which palette the window should open on.
 *
 * The theme lives in the renderer's localStorage, which the main process
 * cannot read until there is a renderer — and by then the window has been
 * painted once already, in whatever colours it was created with. So every
 * theme switch echoes its palette here (`useAppTheme` -> the title-bar IPC)
 * and the next cold start opens on it: the native window buttons, the window's
 * own background and the load screen all start out right, instead of flipping
 * a second or thirty after the shell mounts.
 *
 * Losing this file costs a first frame in the wrong theme, so it is written
 * without ceremony and read behind a catch-all.
 */
export async function loadAppearance() {
  file = path.join(app.getPath('userData'), FILE_NAME)

  try {
    current = sanitise(JSON.parse(await readFile(file, 'utf8')))
  }
  catch { /* missing, corrupt or unreadable — the defaults stand */ }

  return current
}

export function appearance() {
  return current
}

/** Fire-and-forget: the caller is recolouring a window, not saving data. */
export function saveAppearance(next) {
  current = sanitise(next)

  if (!file) return

  mkdir(path.dirname(file), { recursive: true })
    .then(() => writeFile(file, JSON.stringify(current), 'utf8'))
    .catch(() => {})
}

// The values reach `setTitleBarOverlay`, which throws on anything that is not
// a hex colour, and a `data-splash-theme` attribute. Neither is worth crashing
// a window over, so whatever does not fit falls back to the default.
function sanitise(value) {
  const { theme, color, symbolColor, background } = value ?? {}

  return {
    theme: theme === 'light' || theme === 'dark' ? theme : DEFAULTS.theme,
    color: HEX.test(color) ? color : DEFAULTS.color,
    symbolColor: HEX.test(symbolColor) ? symbolColor : DEFAULTS.symbolColor,
    background: HEX.test(background) ? background : DEFAULTS.background,
  }
}
