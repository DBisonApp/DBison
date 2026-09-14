import type { DbisonBridge, DriverError } from '#shared/db-types'
import { IPC } from '#shared/ipc-channels'

/**
 * Thrown when a database call is made outside Electron — running `nuxt dev` in
 * a plain browser, for instance. Callers surface it instead of silently
 * pretending there is no data.
 */
export class BridgeUnavailableError extends Error {
  constructor() {
    super('The database bridge is only available in the DBison desktop app.')
    this.name = 'BridgeUnavailableError'
  }
}

let channelsChecked = false
let wrapped: DbisonBridge | null = null

/**
 * `electron/preload.cjs` has to repeat the channel names because a sandboxed
 * preload cannot import a shared module. This is where that copy is checked
 * against the real list, once, so drift shows up immediately rather than as a
 * call that hangs forever.
 */
function assertChannelsMatch(bridge: DbisonBridge) {
  if (channelsChecked) return
  channelsChecked = true

  const missing = Object.entries(IPC)
    .filter(([key, channel]) => bridge.channels?.[key] !== channel)
    .map(([key]) => key)

  if (missing.length) {
    console.error(
      `[dbison] preload channel mismatch for: ${missing.join(', ')}. `
      + 'electron/preload.cjs is out of sync with shared/ipc-channels.js.',
    )
  }
}

/**
 * Rebuilds a real Error in this world from what the preload rejected with.
 *
 * Electron's context bridge copies only `message` and `stack` off an Error, so
 * `electron/preload.cjs` rejects with the plain payload instead and the Error
 * is constructed here — where its own properties survive, and where the code,
 * position and line of a failed statement are actually read.
 */
function asError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  if (!reason || typeof reason !== 'object') return new Error(String(reason))

  const detail = reason as DriverError
  return Object.assign(new Error(detail.message ?? 'The database bridge failed.'), detail)
}

function rethrowing<A extends unknown[], R>(call: (...args: A) => Promise<R>) {
  return (...args: A) => call(...args).catch((reason: unknown) => { throw asError(reason) })
}

/**
 * Re-wraps the raw preload bridge so every object argument is flattened on the
 * way out and every rejection arrives as an Error on the way back. Doing it
 * here means no call site has to remember that its node or profile came out of
 * reactive state, nor that the bridge speaks in plain objects.
 */
function sanitized(raw: DbisonBridge): DbisonBridge {
  return {
    channels: raw.channels,
    drivers: rethrowing(() => raw.drivers()),
    profiles: {
      list: rethrowing(() => raw.profiles.list()),
      save: rethrowing((profile) => raw.profiles.save(toPlain(profile))),
      remove: rethrowing((id: string) => raw.profiles.remove(id)),
    },
    connect: rethrowing((id: string, password?: string) => raw.connect(id, password)),
    disconnect: rethrowing((id: string) => raw.disconnect(id)),
    test: rethrowing((profile) => raw.test(toPlain(profile))),
    children: rethrowing((id, node) => raw.children(id, toPlain(node))),
    preview: rethrowing((id, node, options) => raw.preview(id, toPlain(node), toPlain(options))),
    schema: rethrowing((id, scope) => raw.schema(id, toPlain(scope))),
    query: rethrowing((id, sql, options) => raw.query(id, sql, toPlain(options))),
    applyChanges: rethrowing(
      (id, node, changes, options) => raw.applyChanges(id, toPlain(node), toPlain(changes), toPlain(options)),
    ),
    cancel: rethrowing((queryId: string) => raw.cancel(queryId)),
    structure: rethrowing((id, node) => raw.structure(id, toPlain(node))),
    objects: rethrowing((id, scope) => raw.objects(id, toPlain(scope))),
    countRows: rethrowing((id, node, options) => raw.countRows(id, toPlain(node), toPlain(options))),
    transaction: {
      begin: rethrowing((id, scope) => raw.transaction.begin(id, toPlain(scope))),
      end: rethrowing((transactionId, action) => raw.transaction.end(transactionId, action)),
    },
    saveFile: rethrowing((request) => raw.saveFile(toPlain(request))),
    openFile: rethrowing((request) => raw.openFile(toPlain(request))),
    history: {
      list: rethrowing(() => raw.history.list()),
      add: rethrowing((entry) => raw.history.add(toPlain(entry))),
      clear: rethrowing(() => raw.history.clear()),
      remove: rethrowing((id: string) => raw.history.remove(id)),
    },
    saved: {
      list: rethrowing(() => raw.saved.list()),
      save: rethrowing((query) => raw.saved.save(toPlain(query))),
      remove: rethrowing((id: string) => raw.saved.remove(id)),
    },
    log: rethrowing((entry) => raw.log(toPlain(entry))),
    logPath: rethrowing(() => raw.logPath()),
    reveal: rethrowing((path: string) => raw.reveal(path)),
    exportRows: rethrowing((id, request) => raw.exportRows(id, toPlain(request))),
    importPreview: rethrowing((request) => raw.importPreview(toPlain(request))),
    importRows: rethrowing((id, node, request) => raw.importRows(id, toPlain(node), toPlain(request))),
    ddl: rethrowing((id, node, operation, options) => raw.ddl(id, toPlain(node), toPlain(operation), toPlain(options))),
    locateTool: rethrowing((tool) => raw.locateTool(tool)),
    dump: rethrowing((id, request) => raw.dump(id, toPlain(request))),
    restore: rethrowing((id, request) => raw.restore(id, toPlain(request))),
    onProgress: raw.onProgress,
    setTitleBar: rethrowing((palette) => raw.setTitleBar(toPlain(palette))),
    setZoom: rethrowing((factor: number) => raw.setZoom(factor)),
    editAction: rethrowing((role) => raw.editAction(role)),
    setDirty: rethrowing((dirty: boolean) => raw.setDirty(dirty)),
    readClipboard: rethrowing(() => raw.readClipboard()),
    onStatusChanged: raw.onStatusChanged,
    onQueryRows: raw.onQueryRows,
  }
}

export function useDatabaseBridge() {
  /** True in the desktop app, false in a browser tab. */
  const isAvailable = computed(() => import.meta.client && Boolean(window.dbison))

  function bridge(): DbisonBridge {
    if (!import.meta.client || !window.dbison) throw new BridgeUnavailableError()

    assertChannelsMatch(window.dbison)

    wrapped ??= sanitized(window.dbison)
    return wrapped
  }

  return { isAvailable, bridge }
}
