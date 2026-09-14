/**
 * Renders the bison mark into the icon files packaging needs:
 *
 *   assets/icon.ico     Windows exe, Setup.exe, shortcuts and Apps & features
 *   assets/icon.icns    the macOS app bundle
 *   assets/icon.png     Linux packages and the Linux window
 *   public/favicon.ico  the browser tab when the UI is opened outside Electron
 *
 * The mark is the one in AppLogo.vue (and splash.html), in the dark theme's
 * colours from main.css, on a tile so it holds up on light and dark desktops
 * alike. Nothing here draws the mark itself: Chromium renders the SVG, so the
 * icon cannot drift from the logo in anything but these literals.
 *
 * Run it with Electron after changing the logo, with ELECTRON_RUN_AS_NODE
 * unset, and commit the results:
 *
 *   npx electron scripts/make-icons.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow } from 'electron'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = 1024

const MARK_HEAD = 'M5.8 8.8C5.5 6.8 6.7 5.4 8.1 5.2C8.5 4 9.7 3.6 10.3 4.5C10.8 3.6 11.6 3.4 12 4.2C12.4 3.4 13.2 3.6 13.7 4.5C14.3 3.6 15.5 4 15.9 5.2C17.3 5.4 18.5 6.8 18.2 8.8C18 10.5 17.2 11.8 16.2 12.5L15.7 15C15.7 16.9 14.2 18.8 12 18.8C9.8 18.8 8.3 16.9 8.3 15L7.8 12.5C6.8 11.8 6 10.5 5.8 8.8ZM8.18 10.5A0.62 0.62 0 1 0 9.42 10.5A0.62 0.62 0 1 0 8.18 10.5ZM14.58 10.5A0.62 0.62 0 1 0 15.82 10.5A0.62 0.62 0 1 0 14.58 10.5Z'

// The mark spans roughly y 3.6–18.8 in its 24-unit box, so it is centred on
// 11.2 rather than 12 to sit optically in the middle of the tile.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SOURCE}" height="${SOURCE}" viewBox="0 0 24 24">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#1c2442"/>
      <stop offset="100%" stop-color="#0d1120"/>
    </linearGradient>
    <linearGradient id="fill" x1="4" y1="3" x2="20" y2="21" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#a78bfa"/>
      <stop offset="100%" stop-color="#e879f9"/>
    </linearGradient>
  </defs>
  <rect x="1" y="1" width="22" height="22" rx="5" fill="url(#tile)"/>
  <g transform="translate(12 12) scale(0.8) translate(-12 -11.2)">
    <g stroke="#e8a33d" stroke-width="2.1" stroke-linecap="round" fill="none">
      <path d="M7.6 8.4C4.6 9.2 2.4 7.9 2.1 4.7"/>
      <path d="M16.4 8.4C19.4 9.2 21.6 7.9 21.9 4.7"/>
    </g>
    <path fill="url(#fill)" fill-rule="evenodd" d="${MARK_HEAD}"/>
  </g>
</svg>`

// An .ico is a directory of images; every entry here is a PNG, which Windows
// has read since Vista and which keeps the alpha edge of the tile intact.
function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngs.length, 4)

  let offset = header.length
  pngs.forEach(({ size, data }, index) => {
    const entry = 6 + 16 * index
    header.writeUInt8(size >= 256 ? 0 : size, entry)
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1)
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(data.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += data.length
  })

  return Buffer.concat([header, ...pngs.map((png) => png.data)])
}

// An .icns is a big-endian list of typed chunks; these types all hold PNGs.
function icns(chunks) {
  const parts = chunks.map(({ type, data }) => {
    const head = Buffer.alloc(8)
    head.write(type, 0, 'ascii')
    head.writeUInt32BE(data.length + 8, 4)
    return Buffer.concat([head, data])
  })

  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(8 + parts.reduce((sum, part) => sum + part.length, 0), 4)
  return Buffer.concat([head, ...parts])
}

async function render() {
  const window = new BrowserWindow({
    width: SOURCE,
    height: SOURCE,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  })

  // The SVG fills the viewport rather than claiming 1024px, so a window that
  // ends up a different size still captures the whole tile.
  const html = `<style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block;width:100vw;height:100vh}</style>${svg}`
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  // One frame for the offscreen compositor to paint before capturing.
  await new Promise((resolve) => setTimeout(resolve, 500))

  const image = await window.webContents.capturePage()
  window.destroy()
  return image
}

// On a scaled display (150% and so on) the capture comes back in device pixels
// and shows only part of the page; one CSS pixel per image pixel keeps the
// whole mark in frame whatever this machine's scaling is.
app.commandLine.appendSwitch('force-device-scale-factor', '1')

// Closing the capture window would otherwise quit the app while the files are
// still being written; the script quits on its own once they are.
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  try {
    const source = await render()
    const { width, height } = source.getSize()
    if (width === 0 || height === 0) throw new Error('The offscreen capture came back empty')

    const png = (size) => source.resize({ width: size, height: size, quality: 'best' }).toPNG()
    const sizes = (list) => list.map((size) => ({ size, data: png(size) }))

    await mkdir(path.join(root, 'assets'), { recursive: true })

    const outputs = {
      'assets/icon.png': png(512),
      'assets/icon.ico': ico(sizes([16, 24, 32, 48, 64, 128, 256])),
      'assets/icon.icns': icns([
        { type: 'ic11', data: png(32) },
        { type: 'ic12', data: png(64) },
        { type: 'ic07', data: png(128) },
        { type: 'ic08', data: png(256) },
        { type: 'ic13', data: png(512) },
        { type: 'ic09', data: png(512) },
        { type: 'ic14', data: png(1024) },
        { type: 'ic10', data: png(1024) },
      ]),
      'public/favicon.ico': ico(sizes([16, 32, 48])),
    }

    for (const [file, data] of Object.entries(outputs)) {
      await writeFile(path.join(root, file), data)
      console.log(`${file} (${data.length} bytes, source ${width}x${height})`)
    }
  }
  catch (error) {
    console.error(error)
    process.exitCode = 1
  }
  finally {
    app.quit()
  }
})
