import { readFile, writeFile } from 'node:fs/promises'

import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'

import { IPC } from '../shared/ipc-channels.js'
import { saveAppearance } from './appearance-store.js'
import { ConnectionManager } from './connection-manager.js'
import { ConnectionStore } from './connection-store.js'
import { driverCatalog } from './drivers/index.js'
import { exportFilters, exportToFile } from './export.js'
import { HistoryStore } from './history-store.js'
import { previewFile } from './import.js'
import { describeError, log, logPath } from './log.js'
import { SavedQueriesStore } from './saved-queries-store.js'
import { cancelTool, commandFor, locateTool, runTool } from './tools.js'
import { serializeError } from './drivers/values.js'

/**
 * Packaged builds answer only the app's own top-level page (app://dbison, see
 * main.js). Anything else that ends up in the window, a page the navigation
 * guard missed or an iframe, must not reach drivers, files or tools. From
 * source the renderer is whichever dev server the developer or a smoke script
 * points at, so the check is left to packaged builds.
 */
function isTrustedSender(event) {
  if (!app.isPackaged) return true
  const frame = event.senderFrame
  return Boolean(frame) && frame === event.sender.mainFrame && frame.url.startsWith('app://dbison/')
}

/**
 * Every handler answers with `{ ok: true, data }` or `{ ok: false, error }`
 * instead of letting the rejection cross IPC. A rejected `invoke` reaches the
 * renderer as a string with an "Error invoking remote method" prefix, which
 * throws away the driver's error code and position.
 */
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedSender(event)) {
      log('warn', `${channel} refused: sent from ${event.senderFrame?.url || 'an unknown frame'}`)
      return { ok: false, error: serializeError(new Error('Refused: the request did not come from DBison.')) }
    }
    try {
      return { ok: true, data: await fn(...args, event) }
    }
    catch (error) {
      // A cancel is the user's own doing and a SQL error is the statement's;
      // neither is news. Anything else is what the log file is for.
      if (!error?.cancelled && !error?.position && !error?.code) {
        log('warn', `${channel} failed: ${error?.message ?? error}`, describeError(error))
      }
      return { ok: false, error: serializeError(error) }
    }
  })
}

/** The window a dialog should sit on: the one asking, else whichever is up. */
function parentOf(event) {
  return (event?.sender && BrowserWindow.fromWebContents(event.sender))
    ?? BrowserWindow.getFocusedWindow()
    ?? BrowserWindow.getAllWindows()[0]
    ?? null
}

async function askSavePath(event, options) {
  const parent = parentOf(event)
  const { canceled, filePath } = parent
    ? await dialog.showSaveDialog(parent, options)
    : await dialog.showSaveDialog(options)
  return canceled || !filePath ? null : filePath
}

async function askOpenPath(event, options) {
  const parent = parentOf(event)
  const { canceled, filePaths } = parent
    ? await dialog.showOpenDialog(parent, { ...options, properties: ['openFile'] })
    : await dialog.showOpenDialog({ ...options, properties: ['openFile'] })
  const filePath = filePaths?.[0]
  return canceled || !filePath ? null : filePath
}

/** A progress push to the window that started a job, if it is still there. */
function progressTo(event, update) {
  const sender = event?.sender
  if (!sender || sender.isDestroyed()) return
  sender.send(IPC.progress, update)
}

const DELIMITED_FILTERS = [
  { name: 'Delimited text', extensions: ['csv', 'tsv', 'txt'] },
  { name: 'All files', extensions: ['*'] },
]

const DUMP_FILTERS = [{ name: 'SQL', extensions: ['sql'] }, { name: 'All files', extensions: ['*'] }]

function broadcast(channel, payload) {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload)
  }
}

/**
 * Wires the connection services to the renderer and returns the manager so the
 * app lifecycle can shut it down.
 */
export async function registerDatabaseIpc() {
  const store = new ConnectionStore()
  await store.load()

  const manager = new ConnectionManager(store)
  manager.on('status', (state) => broadcast(IPC.statusChanged, state))

  const history = new HistoryStore()
  await history.load()
  // Whatever is still buffered goes to disk with the connections.
  manager.on('shutdown', () => history.flush())

  const saved = new SavedQueriesStore()
  await saved.load()
  manager.on('shutdown', () => saved.flush())

  handle(IPC.historyList, () => history.list())
  // A connection that asked to stay out of the history stays out of it here
  // too, whatever the tab that ran the statement remembered to check.
  handle(IPC.historyAdd, (entry) => (store.get(entry?.connectionId)?.noHistory ? null : history.add(entry)))
  handle(IPC.historyClear, () => history.clear())
  handle(IPC.historyRemove, (id) => history.remove(id))

  handle(IPC.savedList, () => saved.list())
  handle(IPC.savedSave, (query) => saved.save(query))
  handle(IPC.savedDelete, (id) => saved.remove(id))

  handle(IPC.log, ({ level, message, detail } = {}) => {
    const known = level === 'error' || level === 'warn' ? level : 'info'
    log(known, `[renderer] ${String(message ?? '')}`, detail ? String(detail).slice(0, 20_000) : undefined)
    return { logged: true }
  })
  handle(IPC.logPath, () => ({ path: logPath() }))
  handle(IPC.reveal, (target) => {
    if (typeof target !== 'string' || !target) return { revealed: false }
    shell.showItemInFolder(target)
    return { revealed: true }
  })

  /**
   * Streams a whole result to a file. The statement runs again on the
   * server with no row cap; the path is asked for here when the renderer
   * did not already have one, so the dialog sits on the right window.
   */
  handle(IPC.exportRows, async (id, request, event) => {
    const format = request?.format
    const path = typeof request?.path === 'string' && request.path
      ? request.path
      : await askSavePath(event, { defaultPath: request?.suggestedName ?? `export.${format}`, filters: exportFilters(format) })

    if (!path) return { saved: false, path: undefined, rows: 0, bytes: 0, durationMs: 0 }

    const jobId = request.jobId
    return exportToFile(manager, id, { ...request, path }, {
      path,
      onProgress: jobId ? (rows, bytes) => progressTo(event, { jobId, kind: 'export', rows, bytes }) : undefined,
    })
  })

  handle(IPC.importPreview, async (request, event) => {
    const path = typeof request?.path === 'string' && request.path
      ? request.path
      : await askOpenPath(event, { filters: DELIMITED_FILTERS })

    if (!path) throw Object.assign(new Error('No file was picked.'), { cancelled: true })

    return previewFile(path, { delimiter: request?.delimiter, hasHeader: request?.hasHeader })
  })

  handle(IPC.importRows, (id, node, request, event) => {
    const jobId = request?.jobId
    return manager.importRows(id, node, request, {
      onProgress: jobId ? (rows) => progressTo(event, { jobId, kind: 'import', rows }) : undefined,
    })
  })

  handle(IPC.ddl, (id, node, operation, options) => manager.ddl(id, node, operation, options))

  handle(IPC.toolLocate, (tool) => locateTool(String(tool)))

  /**
   * Runs the engine's own dump or restore tool against a connection. The
   * tool is found on PATH or in the installers' usual places unless the
   * renderer sends one; its stderr streams back as progress, and a failure
   * is reported with the tool's last lines, which are the whole story.
   */
  async function runEngineTool(action, id, request, event) {
    const { profile, dial, secret, engine, meta } = manager.dialInfo(id)
    const toolName = action === 'dump' ? meta.capabilities?.dump : meta.capabilities?.restore
    if (!toolName) throw new Error(`No ${action} tool is known for ${meta.label}.`)

    if (action === 'restore') {
      if (profile.readOnly && !request?.allowWrite) {
        throw Object.assign(new Error(`${profile.name} is marked read-only. Confirm the restore in the app to run it.`), { code: 'READ_ONLY' })
      }
    }

    const toolPath = typeof request?.toolPath === 'string' && request.toolPath
      ? request.toolPath
      : (await locateTool(toolName)).path

    if (!toolPath) {
      throw new Error(`${toolName} was not found on this machine. Install the ${meta.label} client tools, or point the app at ${toolName} in the dialog.`)
    }

    const path = typeof request?.path === 'string' && request.path
      ? request.path
      : action === 'dump'
        ? await askSavePath(event, { defaultPath: request?.suggestedName ?? `${profile.database ?? profile.name}.sql`, filters: DUMP_FILTERS })
        : await askOpenPath(event, { filters: DUMP_FILTERS })

    if (!path) return { ok: false, exitCode: null, durationMs: 0, tail: [], cancelled: true }

    const jobId = request?.jobId
    const spec = commandFor(action, engine, { profile, dial, secret }, { ...request, path }, toolPath)

    log('info', `${spec.tool} ${action} for ${profile.name}: ${spec.args.filter((arg) => !arg.includes('=')).join(' ')}`)

    const outcome = await runTool({
      ...spec,
      jobId,
      onLine: jobId ? (line) => progressTo(event, { jobId, kind: action, line }) : undefined,
    })

    if (!outcome.ok) {
      const cancelled = Boolean(outcome.signal)
      throw Object.assign(
        new Error(cancelled
          ? `${spec.tool} was stopped.`
          : `${spec.tool} exited with code ${outcome.exitCode ?? '?'}.`),
        { cancelled: cancelled || undefined, detail: outcome.tail.join('\n') || undefined },
      )
    }

    return { ...outcome, path }
  }

  handle(IPC.dump, (id, request, event) => runEngineTool('dump', id, request, event))
  handle(IPC.restore, (id, request, event) => runEngineTool('restore', id, request, event))

  handle(IPC.drivers, () => ({
    drivers: driverCatalog(),
    canStoreSecrets: ConnectionStore.canStoreSecrets(),
  }))

  handle(IPC.profilesList, () => ({
    profiles: store.list(),
    states: manager.states(),
  }))

  handle(IPC.profileSave, (input) => store.save(input))

  handle(IPC.profileDelete, async (id) => {
    await manager.disconnect(id)
    await store.delete(id)
    return { id }
  })

  handle(IPC.connect, (id, password) => manager.connect(id, password))
  handle(IPC.disconnect, (id) => manager.disconnect(id))
  handle(IPC.test, (profile) => manager.test(profile))

  handle(IPC.children, (id, node) => manager.listChildren(id, node))
  handle(IPC.preview, (id, node, options) => ({ sql: manager.previewStatement(id, node, options) }))
  handle(IPC.schema, (id, scope) => manager.schemaSnapshot(id, scope))
  /**
   * A query that asked to stream gets its rows pushed to the window that
   * asked, batch by batch, keyed by its own `queryId` — without one the
   * batches could not be told apart on the other side, so such a request
   * gets its rows on the result instead, as it would have without `stream`.
   * The first batch names the columns; see `createRowSink` in values.js.
   */
  handle(IPC.query, (id, sql, options, event) => {
    const { stream, queryId, ...rest } = options ?? {}
    const sender = event?.sender

    const onRows = stream && queryId && sender
      ? (rows, columns) => {
          // A window closed mid-result has nowhere for the rows to go; the
          // statement still runs to its end and the result is thrown away.
          if (sender.isDestroyed()) return
          sender.send(IPC.queryRows, columns ? { queryId, rows, columns } : { queryId, rows })
        }
      : undefined

    return manager.query(id, sql, { ...rest, queryId, onRows })
  })
  handle(IPC.applyChanges, (id, node, changes, options) => manager.applyChanges(id, node, changes, options))
  // A job id names a statement, an import, or a tool process; whichever holds it stops.
  handle(IPC.cancel, (queryId) => {
    const stopped = manager.cancel(queryId)
    return stopped.cancelled ? stopped : { cancelled: cancelTool(queryId) }
  })
  handle(IPC.structure, (id, node) => manager.structure(id, node))
  handle(IPC.objects, (id, scope) => manager.objects(id, scope))
  handle(IPC.count, (id, node, options) => manager.countRows(id, node, options))
  handle(IPC.txBegin, (id, scope) => manager.beginTransaction(id, scope))
  // Anything but an explicit commit rolls back: the safe reading of a garbled
  // request is that nothing was meant to be written.
  handle(IPC.txEnd, (transactionId, action) =>
    manager.endTransaction(transactionId, action === 'commit' ? 'commit' : 'rollback'))

  /**
   * Writes an exported result where the user points.
   *
   * The renderer cannot reach the disk, and a browser download would drop the
   * file wherever Chromium felt like without asking. The dialog is parented to
   * the window that asked, so it opens as a sheet rather than a stray window.
   */
  handle(IPC.saveFile, async ({ suggestedName, content, filters, path: knownPath, encoding }) => {
    // Text unless told otherwise: a PNG arrives as base64, since a string is
    // all the bridge carries.
    const write = (target) => writeFile(target, content, encoding === 'base64' ? 'base64' : 'utf8')

    // A script that was opened from disk, or saved once already, goes back to
    // the same file without a dialog: that is what Save means.
    if (typeof knownPath === 'string' && knownPath) {
      await write(knownPath)
      return { saved: true, path: knownPath }
    }

    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options = { defaultPath: suggestedName, filters }

    const { canceled, filePath } = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options)

    if (canceled || !filePath) return { saved: false }

    await write(filePath)
    return { saved: true, path: filePath }
  })

  /**
   * Picks a file. The SQLite profile wants only the path; the editor wants the
   * text as well, and reads it here rather than through a second round trip.
   * A path the renderer already knows — a recent file — skips the dialog.
   */
  handle(IPC.openFile, async ({ filters, read, path: knownPath } = {}) => {
    if (typeof knownPath === 'string' && knownPath) {
      return {
        opened: true,
        path: knownPath,
        content: read ? await readFile(knownPath, 'utf8') : undefined,
      }
    }

    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options = { filters, properties: ['openFile'] }

    const { canceled, filePaths } = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)

    const filePath = filePaths?.[0]
    if (canceled || !filePath) return { opened: false }

    return {
      opened: true,
      path: filePath,
      content: read ? await readFile(filePath, 'utf8') : undefined,
    }
  })

  /**
   * Recolours the native minimise/maximise/close buttons that Chromium paints
   * over the app's title bar on Windows and Linux, so they follow the theme
   * instead of staying the colour the window was created with. The theme is
   * global, so every window gets it. macOS draws its own traffic lights and has
   * no such call, so it is skipped there rather than thrown from — but the
   * palette is still recorded there, because the load screen uses it too.
   */
  handle(IPC.titleBar, ({ theme, color, symbolColor, background }) => {
    // Remembered whatever the platform does with it, so the next cold start
    // opens its window — and its load screen — on this theme.
    saveAppearance({ theme, color, symbolColor, background })

    if (process.platform === 'darwin') return { applied: false }

    let applied = false

    for (const window of BrowserWindow.getAllWindows()) {
      // A window created without the overlay — a test harness's, a plain
      // frame's — throws here; the palette was still recorded above.
      try {
        window.setTitleBarOverlay({ color, symbolColor })
        applied = true
      }
      catch {
        // Nothing to recolour on this window.
      }
    }

    return { applied }
  })

  /**
   * Zoom is applied through Chromium so every pixel scales together. Clamped
   * here rather than trusted: a stray factor of 0 would leave a blank window
   * with no way to click the menu that fixes it.
   */
  // The renderer's own clipboard read wants a focused document and a
  // permission grant; the main process has neither condition.
  // Awaited: recent Electron versions answer with a promise here.
  handle(IPC.clipboardRead, async () => ({ text: String((await clipboard.readText()) ?? '') }))

  handle(IPC.dirty, (dirty, event) => {
    dirtyWindows.set(event.sender.id, Boolean(dirty))
    return { dirty: Boolean(dirty) }
  })

  handle(IPC.zoom, (factor) => {
    const zoom = Math.min(3, Math.max(0.5, Number(factor) || 1))

    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.setZoomFactor(zoom)
    }

    return { zoom }
  })

  /**
   * The Edit menu's rows, run against whatever has focus in the window that
   * asked — the sender's, not the focused one, which a dialog may hold.
   */
  handle(IPC.edit, (role, event) => {
    const contents = event?.sender
    if (!contents || !EDIT_ROLES.has(role)) return { applied: false }

    contents[role]()
    return { applied: true }
  })

  return manager
}

const EDIT_ROLES = new Set(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'])

/** Which windows hold unsaved work, by webContents id; see `isDirty`. */
const dirtyWindows = new Map()

/**
 * Whether a window's renderer reported unsaved work. Read by the window's
 * close handler in main.js, which is the only place a close can be refused.
 */
export function isDirty(contents) {
  return dirtyWindows.get(contents.id) === true
}
