// CommonJS on purpose: preload scripts run before the ESM loader is available
// in a sandboxed renderer, and the sandbox is what keeps this bridge honest.
const { contextBridge, ipcRenderer } = require('electron')

// Duplicated rather than imported: a sandboxed preload can only require the
// electron module and a few Node built-ins, never a relative file. The list is
// re-exported as `channels` below so the renderer can diff it against
// shared/ipc-channels.js and fail loudly if the two ever drift.
const IPC = {
  profilesList: 'db:profiles:list',
  profileSave: 'db:profiles:save',
  profileDelete: 'db:profiles:delete',
  connect: 'db:connect',
  disconnect: 'db:disconnect',
  test: 'db:test',
  children: 'db:children',
  preview: 'db:preview',
  schema: 'db:schema',
  query: 'db:query',
  applyChanges: 'db:apply-changes',
  cancel: 'db:cancel',
  structure: 'db:structure',
  count: 'db:count',
  objects: 'db:objects',
  txBegin: 'db:tx:begin',
  txEnd: 'db:tx:end',
  statusChanged: 'db:status-changed',
  queryRows: 'db:query-rows',
  drivers: 'db:drivers',
  saveFile: 'app:save-file',
  openFile: 'app:open-file',
  historyList: 'app:history:list',
  historyAdd: 'app:history:add',
  historyClear: 'app:history:clear',
  historyRemove: 'app:history:remove',
  savedList: 'app:saved:list',
  savedSave: 'app:saved:save',
  savedDelete: 'app:saved:delete',
  log: 'app:log',
  logPath: 'app:log-path',
  reveal: 'app:reveal',
  exportRows: 'db:export',
  importPreview: 'db:import-preview',
  importRows: 'db:import',
  ddl: 'db:ddl',
  toolLocate: 'app:tool-locate',
  dump: 'db:dump',
  restore: 'db:restore',
  progress: 'db:progress',
  titleBar: 'app:title-bar',
  zoom: 'app:zoom',
  edit: 'app:edit',
  dirty: 'app:dirty',
  clipboardRead: 'app:clipboard-read',
}

/**
 * Unwraps the `{ ok, data | error }` envelope from `electron/ipc.js` so the
 * renderer sees a normal promise.
 *
 * A failure is rejected as the plain error object rather than as an Error:
 * contextBridge copies only `message` and `stack` off an Error, so the code,
 * position and line that make a SQL failure actionable would be dropped here
 * and never reach the editor. `useDatabaseBridge` mints the real Error on the
 * other side, in the world that has to read those fields.
 */
async function invoke(channel, ...args) {
  const response = await ipcRenderer.invoke(channel, ...args)

  if (response?.ok) return response.data

  throw response?.error ?? { message: 'The database bridge failed.' }
}

contextBridge.exposeInMainWorld('dbison', {
  channels: IPC,

  drivers: () => invoke(IPC.drivers),

  profiles: {
    list: () => invoke(IPC.profilesList),
    save: (profile) => invoke(IPC.profileSave, profile),
    remove: (id) => invoke(IPC.profileDelete, id),
  },

  connect: (id, password) => invoke(IPC.connect, id, password),
  disconnect: (id) => invoke(IPC.disconnect, id),
  test: (profile) => invoke(IPC.test, profile),

  children: (id, node) => invoke(IPC.children, id, node),
  preview: (id, node, options) => invoke(IPC.preview, id, node, options),
  schema: (id, scope) => invoke(IPC.schema, id, scope),
  query: (id, sql, options) => invoke(IPC.query, id, sql, options),
  applyChanges: (id, node, changes, options) => invoke(IPC.applyChanges, id, node, changes, options),
  cancel: (queryId) => invoke(IPC.cancel, queryId),
  structure: (id, node) => invoke(IPC.structure, id, node),
  countRows: (id, node, options) => invoke(IPC.count, id, node, options),
  objects: (id, scope) => invoke(IPC.objects, id, scope),
  transaction: {
    begin: (id, scope) => invoke(IPC.txBegin, id, scope),
    end: (transactionId, action) => invoke(IPC.txEnd, transactionId, action),
  },
  saveFile: (request) => invoke(IPC.saveFile, request),
  openFile: (request) => invoke(IPC.openFile, request),
  history: {
    list: () => invoke(IPC.historyList),
    add: (entry) => invoke(IPC.historyAdd, entry),
    clear: () => invoke(IPC.historyClear),
    remove: (id) => invoke(IPC.historyRemove, id),
  },
  saved: {
    list: () => invoke(IPC.savedList),
    save: (query) => invoke(IPC.savedSave, query),
    remove: (id) => invoke(IPC.savedDelete, id),
  },
  log: (entry) => invoke(IPC.log, entry),
  logPath: () => invoke(IPC.logPath),
  reveal: (path) => invoke(IPC.reveal, path),
  exportRows: (id, request) => invoke(IPC.exportRows, id, request),
  importPreview: (request) => invoke(IPC.importPreview, request),
  importRows: (id, node, request) => invoke(IPC.importRows, id, node, request),
  ddl: (id, node, operation, options) => invoke(IPC.ddl, id, node, operation, options),
  locateTool: (tool) => invoke(IPC.toolLocate, tool),
  dump: (id, request) => invoke(IPC.dump, id, request),
  restore: (id, request) => invoke(IPC.restore, id, request),
  setTitleBar: (palette) => invoke(IPC.titleBar, palette),
  setZoom: (factor) => invoke(IPC.zoom, factor),
  editAction: (role) => invoke(IPC.edit, role),
  setDirty: (dirty) => invoke(IPC.dirty, dirty),
  readClipboard: () => invoke(IPC.clipboardRead),

  /** Progress of an export, import, dump or restore, keyed by its job id. */
  onProgress: (listener) => {
    const wrapped = (_event, update) => listener(update)
    ipcRenderer.on(IPC.progress, wrapped)
    return () => ipcRenderer.off(IPC.progress, wrapped)
  },

  onQueryRows: (listener) => {
    const wrapped = (_event, batch) => listener(batch)
    ipcRenderer.on(IPC.queryRows, wrapped)
    return () => ipcRenderer.off(IPC.queryRows, wrapped)
  },

  /** Returns an unsubscribe function; the listener never sees the raw event. */
  onStatusChanged: (listener) => {
    const wrapped = (_event, state) => listener(state)
    ipcRenderer.on(IPC.statusChanged, wrapped)
    return () => ipcRenderer.off(IPC.statusChanged, wrapped)
  },
})
