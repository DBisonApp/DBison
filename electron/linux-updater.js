import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { promisify } from 'node:util'

import { app, clipboard, dialog } from 'electron'

import { log } from './log.js'

const require = createRequire(import.meta.url)
const run = promisify(execFile)

const CHECK_INTERVAL_MS = 60 * 60 * 1000

/**
 * Auto-update for the .deb and .rpm builds.
 *
 * Electron's own updater has no Linux side, so this uses electron-updater: it
 * reads latest-linux.yml from the release bucket, downloads the package that
 * matches how this copy was installed, and installs it through the system
 * password prompt (pkexec) once the user chooses to restart. A system package
 * cannot be replaced without that prompt, so nothing installs silently.
 */
export async function startLinuxAutoUpdate(baseUrl, logger) {
  const kind = await installedAs()
  if (!kind) {
    log('info', 'Auto-update disabled: this copy was not installed from a .deb or .rpm package')
    return
  }

  const { DebUpdater, RpmUpdater } = require('electron-updater')
  const updater = kind === 'deb' ? new DebUpdater() : new RpmUpdater()

  // electron-updater takes its feed and its download cache folder from the
  // app-update.yml that electron-builder would have packaged. Forge does not,
  // so it is written here; JSON strings are valid YAML scalars.
  const configPath = path.join(app.getPath('userData'), 'app-update.yml')
  await writeFile(configPath, `provider: generic\nurl: ${JSON.stringify(baseUrl)}\nupdaterCacheDirName: dbison-updater\n`, 'utf8')
  updater.updateConfigPath = configPath

  // The manifest request already carries a cache-busting query: electron-updater
  // adds one whenever no authorization header is set.
  updater.logger = logger
  // Installing asks for the system password, which must not appear out of
  // nowhere while the app is closing.
  updater.autoInstallOnAppQuit = false

  const prompted = new Set()
  let installing = null

  // electron-updater has already logged the error; the only one that needs
  // more is a failed install, which leaves the user a command to finish with.
  updater.on('error', () => {
    if (installing) showManualInstall(installing, kind)
  })

  updater.on('update-downloaded', async (info) => {
    // The hourly check reports the same download again; asking once per run
    // is enough, and the next start asks again after a "Later".
    if (prompted.has(info.version)) return
    prompted.add(info.version)

    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Application Update',
      message: `DBison ${info.version} has been downloaded.`,
      detail: 'Restart to install it. Your system will ask for your password, because the package is installed for all users.',
    })
    if (response !== 0) return

    // quitAndInstall runs the package manager synchronously and reports a
    // failure through the 'error' event before it returns.
    installing = info.downloadedFile
    updater.quitAndInstall()
    installing = null
  })

  // A failed check has been logged through the 'error' event; the rejection
  // carries nothing more.
  const check = () => updater.checkForUpdates().catch(() => {})
  check()
  setInterval(check, CHECK_INTERVAL_MS)
}

// Which package manager owns the running binary: 'deb', 'rpm', or null for a
// copy run from an unpacked folder, which the updater has no way to replace.
async function installedAs() {
  const owners = [
    ['deb', 'dpkg', ['-S', process.execPath]],
    ['rpm', 'rpm', ['-qf', process.execPath]],
  ]

  for (const [kind, command, args] of owners) {
    try {
      await run(command, args)
      return kind
    }
    catch {
      // Not owned by this package manager, or it is not installed at all.
    }
  }

  return null
}

// Without a graphical password prompt (WSL, a bare window manager) pkexec
// cannot ask, so the downloaded package is handed over as a command instead.
async function showManualInstall(file, kind) {
  const command = kind === 'deb' ? `sudo apt install '${file}'` : `sudo rpm -U '${file}'`

  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Copy Command', 'Close'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update Not Installed',
    message: 'The update could not be installed automatically.',
    detail: `Run this in a terminal, then restart DBison:\n\n${command}`,
  })

  if (response === 0) clipboard.writeText(command)
}
