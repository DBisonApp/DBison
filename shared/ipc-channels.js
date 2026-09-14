/**
 * The renderer <-> main contract. Imported by both sides so a renamed channel
 * breaks at import time instead of silently returning undefined.
 *
 * Plain JS (not TS) because the Electron main process runs these files without
 * a build step; the matching types live in `shared/db-types.ts`.
 */
export const IPC = {
  /** Stored connection profiles, without secrets. */
  profilesList: 'db:profiles:list',
  profileSave: 'db:profiles:save',
  profileDelete: 'db:profiles:delete',

  /** Opens/closes a pool for a stored profile. */
  connect: 'db:connect',
  disconnect: 'db:disconnect',
  /** Dials a profile that may not be saved yet and reports the handshake. */
  test: 'db:test',

  /** Lazily expands one navigator node. */
  children: 'db:children',
  /** The SELECT a driver would use to preview a table, quoted its own way. */
  preview: 'db:preview',
  /** One database's tables, columns and foreign keys, for editor completions. */
  schema: 'db:schema',
  query: 'db:query',
  /** Applies the grid's staged row changes, in one transaction. */
  applyChanges: 'db:apply-changes',
  /** Stops a statement that `query` is still running. */
  cancel: 'db:cancel',
  /** A table's indexes and its CREATE statement, for the structure view. */
  structure: 'db:structure',
  /**
   * A transaction the query tab holds open: one pinned connection, so its
   * statements see each other's work until commit or rollback.
   */
  txBegin: 'db:tx:begin',
  txEnd: 'db:tx:end',
  /** An exact `count(*)` over a table, filtered the way the preview is. */
  count: 'db:count',
  /** Functions, procedures, sequences and triggers: the schema beyond tables. */
  objects: 'db:objects',

  /** Main -> renderer push when a connection changes state. */
  statusChanged: 'db:status-changed',
  /**
   * Main -> renderer push of one batch of rows while a query streams, so the
   * first screenful is drawn before the last row has left the server.
   */
  queryRows: 'db:query-rows',

  drivers: 'db:drivers',

  /** Writes a result the user exported, through the system's save dialog. */
  saveFile: 'app:save-file',
  /** Picks a file through the system's open dialog, optionally reading it. */
  openFile: 'app:open-file',

  /** Every statement the editor ran, kept across restarts. */
  historyList: 'app:history:list',
  historyAdd: 'app:history:add',
  historyClear: 'app:history:clear',
  /** Forgets one remembered statement. */
  historyRemove: 'app:history:remove',
  /** Statements kept on purpose, by name: the library the history is not. */
  savedList: 'app:saved:list',
  savedSave: 'app:saved:save',
  savedDelete: 'app:saved:delete',
  /** A line for the log file the main process keeps; see electron/log.js. */
  log: 'app:log',
  logPath: 'app:log-path',
  /** Shows a file in the system's file manager. */
  reveal: 'app:reveal',
  /** Streams a whole result to a file on disk, past the grid's row cap. */
  exportRows: 'db:export',
  /** Reads the head of a delimited file, to map its columns before an import. */
  importPreview: 'db:import-preview',
  /** Loads a delimited file into a table, in one transaction. */
  importRows: 'db:import',
  /** Builds and, when asked, runs one structure change: a column, an index, a rename. */
  ddl: 'db:ddl',
  /** Finds a command-line tool such as pg_dump on this machine. */
  toolLocate: 'app:tool-locate',
  /** Runs the engine's own dump tool against a connection, into a file. */
  dump: 'db:dump',
  /** Feeds a dump file back through the engine's own client. */
  restore: 'db:restore',
  /**
   * Main -> renderer push while a long job runs: rows exported or imported
   * so far, or a line of a tool's output. Keyed by the job's id.
   */
  progress: 'db:progress',
  /** Recolours the native window buttons drawn over the app's title bar. */
  titleBar: 'app:title-bar',
  /** Scales the whole window: chrome, editor and grid together. */
  zoom: 'app:zoom',
  /** Undo, cut, paste and the rest, aimed at whatever has focus. */
  edit: 'app:edit',
  /** Whether the window holds unsaved work, so closing it can ask first. */
  dirty: 'app:dirty',
  /** The clipboard's text, read by main: the renderer's own read needs focus and a permission. */
  clipboardRead: 'app:clipboard-read',
}
