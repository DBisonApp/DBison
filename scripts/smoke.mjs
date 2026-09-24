// Runs one of the smoke scripts in smoke/ under Electron:
//
//   node scripts/smoke.mjs tier1          -> smoke/tier1.mjs
//   node scripts/smoke.mjs tier1.mjs
//
// The scripts drive the real app against a Nuxt dev server, which has to be
// running already; APP_URL says where (default http://[::1]:3113). The rest of
// the command line is passed through to the script.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const [, , name, ...rest] = process.argv

if (!name) {
  console.error('usage: node scripts/smoke.mjs <tier1|tier1.mjs> [args...]')
  process.exit(2)
}

const file = name.endsWith('.mjs') ? name : `${name}.mjs`
const script = path.join(root, 'smoke', file)

if (!existsSync(script)) {
  console.error(`no such smoke script: ${script}`)
  process.exit(2)
}

// The Electron binary itself, not the npm wrapper: the wrapper prints "Electron
// failed to install correctly" when ELECTRON_RUN_AS_NODE leaks in from an
// outer Electron-hosted shell, and the scripts need the real runtime because
// they open BrowserWindows.
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')

if (!existsSync(electron)) {
  console.error(`Electron binary not found at ${electron}; run npm install first`)
  process.exit(2)
}

// ELECTRON_RUN_AS_NODE would turn the binary into plain node, with no `app`
// or `BrowserWindow` for the script to import.
const env = { ...process.env, APP_URL: process.env.APP_URL ?? 'http://[::1]:3113' }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electron, [script, ...rest], { cwd: root, env, stdio: 'inherit' })

child.on('error', (error) => {
  console.error(`failed to start Electron: ${error.message}`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`smoke script ended by ${signal}`)
    process.exit(1)
  }
  process.exit(code ?? 1)
})
