/**
 * The vocabulary both sides of the IPC bridge speak. The main process is plain
 * JavaScript, so these types are the renderer's view of a contract that
 * `electron/` upholds by construction rather than by compilation.
 */

export type DriverId = 'postgres' | 'mysql' | 'mariadb' | 'sqlite'

export interface DriverMeta {
  id: DriverId
  label: string
  /** Whether the profile dials a host or opens a file on disk. */
  target: 'server' | 'file'
  defaultPort?: number
  badge: string
  color: string
  /**
   * The object levels that sit between the server and a table, outermost
   * first. Postgres has both, MySQL calls its one level a database, SQLite has
   * neither. It is what decides how many pickers a query tab shows.
   */
  levels: ('database' | 'schema')[]
  /**
   * How the engine quotes an identifier that needs it. The editor completes
   * names the driver will accept, so it has to know which character to use.
   */
  quote: string
  /** The dialect underneath: MariaDB is its own driver in the list, MySQL on the wire. */
  engine?: 'postgres' | 'mysql' | 'sqlite'
  /** What the structure view and the backup dialog may offer on this engine. */
  capabilities?: {
    /** Whether a column's type, nullability or default can be changed in place. */
    alterColumn: boolean
    /** Whether tables and columns carry comments the app can write. */
    comments: boolean
    dump: CliTool | null
    restore: CliTool | null
  }
}

/** A saved connection, as the renderer sees it: never carries a password. */
export interface ConnectionProfile {
  id: string
  name: string
  driver: DriverId
  host?: string
  port?: number
  database?: string
  username?: string
  file?: string
  ssl?: boolean
  /**
   * Check the server's certificate against a CA. Off by default, which is
   * encrypt-only: the historical behaviour, and what a self-signed dev
   * server needs. With it on, `sslCa` names the CA to trust; without one the
   * system's roots are used.
   */
  sslVerify?: boolean
  /** Paths on disk; the main process reads them when the pool is opened. */
  sslCa?: string
  sslCert?: string
  sslKey?: string
  /**
   * Reach the server through an SSH host first. The database host and port
   * above are then what the tunnel's far end dials; the driver itself talks to
   * a local port the main process opens for the session.
   */
  ssh?: {
    enabled: boolean
    host?: string
    port?: number
    username?: string
    /** A private key file on disk; empty means password authentication. */
    keyPath?: string
  }
  /** Whether an SSH password or key passphrase is stored, encrypted. */
  hasStoredSshSecret?: boolean
  /**
   * Keep statements run here out of the history file: for a connection whose
   * statements carry literal secrets, or that simply is not anyone's business.
   */
  noHistory?: boolean
  /**
   * A tint for everything that says which server a tab is on. Production is
   * red on most teams; the app does not decide, it only shows.
   */
  color?: string
  /**
   * A heading the connection is listed under: "Production", "Client X".
   * Free text, so a team's own grouping needs no vocabulary of the app's.
   */
  folder?: string
  /**
   * Ask before anything is written through this connection. A guard against
   * the wrong tab, not against the user: the write still goes through once
   * they have said so.
   */
  readOnly?: boolean
  hasStoredPassword: boolean
}

/** The fields the connection dialog submits; the secrets are write-only. */
export type ConnectionProfileInput = Omit<ConnectionProfile, 'id' | 'hasStoredPassword' | 'hasStoredSshSecret'> & {
  id?: string
  password?: string
  /** The SSH password, or the key's passphrase; empty string clears it. */
  sshPassword?: string
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface DriverError {
  message: string
  code?: string
  /** 1-based character offset of the fault within the statement, when it has one. */
  position?: number
  /** How many characters the fault spans, for underlining it. */
  length?: number
  /** `position` again, as an editor counts: both 1-based. */
  line?: number
  column?: number
  detail?: string
  hint?: string
  /** The engine's own wording, when `message` above was rewritten to be clearer. */
  raw?: string
  /**
   * The connection itself went away — the server restarted, the network
   * dropped — rather than the statement being wrong. The renderer offers a
   * reconnect for these and nothing else.
   */
  lost?: boolean
}

export interface ConnectionState {
  id: string
  status: ConnectionStatus
  error?: DriverError
  serverVersion?: string
}

export type DbNodeKind = 'connection' | 'database' | 'schema' | 'table' | 'view' | 'column'

/** Identifies an object within a server, one level at a time. */
export interface DbPath {
  database?: string
  schema?: string
  table?: string
  column?: string
}

export interface DbNode {
  id: string
  connectionId: string
  kind: DbNodeKind
  name: string
  /** Dimmed suffix: row estimates, column types, sizes. */
  detail?: string
  primaryKey?: boolean
  /** Columns only. What a new row may leave out, and what it must not. */
  nullable?: boolean
  /** Columns only: the server fills this in — a DEFAULT, a sequence, identity. */
  hasDefault?: boolean
  /**
   * Columns only: the type as the table declares it, which is more than a
   * result set knows. MySQL reports `tinyint(1)` where the wire type is only
   * `tiny`, and an enum's labels live here rather than in any result.
   */
  declaredType?: string
  enumValues?: string[]
  expandable: boolean
  path: DbPath
}

/**
 * Where a statement runs. A connection reaches a whole server, so the database
 * and schema are the query tab's to choose, not the profile's — the drivers
 * apply them per statement.
 */
export interface QueryContext {
  connectionId: string | null
  database?: string
  schema?: string
  /**
   * An open transaction the statement should join, from `transaction.begin`.
   * Absent, the statement runs on a pooled connection and commits by itself.
   */
  transactionId?: string
}

export interface ResultColumn {
  name: string
  type: string
}

/**
 * One column's ordering, as the grid's headers express it.
 *
 * A table preview hands this back to its driver and re-reads the table through
 * an ORDER BY, so the sort covers every row rather than the page on screen. A
 * result the app cannot re-run — anything the query editor produced — is sorted
 * by the grid itself instead.
 */
export interface SortOrder {
  column: string
  dir: 'asc' | 'desc'
}

/** One column of a row's primary key, with the value that identifies the row. */
export interface RowKeyPart {
  column: string
  value: CellValue
}

/**
 * One row's worth of pending change, as the grid staged it.
 *
 * Edits are collected rather than written as they are typed, and applied
 * together in a transaction: a screen of corrections is one intent, and half of
 * it landing is worse than none of it. `key` is the row's primary key — without
 * one there is no way to name a single row, and the write is refused rather
 * than aimed at whatever else happens to match.
 */
export type RowChange =
  | { kind: 'update', key: RowKeyPart[], set: { column: string, value: CellValue }[] }
  | { kind: 'delete', key: RowKeyPart[] }
  /**
   * A new row. Only the columns the user actually filled in are listed: a
   * column left alone is left to the server, so a sequence, an identity or a
   * DEFAULT still does its job instead of being overwritten with NULL.
   */
  | { kind: 'insert', values: { column: string, value: CellValue }[] }

/** What a batch did, or — for a dry run — what it would have done. */
export interface ChangeOutcome {
  /** Each statement, parameterized as it ran and as it reads with its values. */
  statements: { sql: string, preview: string }[]
  /** Rows actually touched; zero for a dry run. */
  applied: number
}

/** The window of a table a preview should read. */
export interface PreviewOptions {
  /** `null` asks for every row: the statement is built without a LIMIT. */
  limit?: number | null
  /** Rows to skip. Only meaningful alongside a limit — MySQL and SQLite read
   *  OFFSET as part of LIMIT, and a page has no meaning without one anyway. */
  offset?: number
  order?: SortOrder | null
  /**
   * A WHERE clause, as the user typed it, without the keyword. It is the one
   * part of a preview the app does not author: filtering a table means saying
   * something only SQL can say, so the text goes to the engine as written and
   * the engine's own error comes back if it is wrong.
   */
  where?: string
}

export type CellValue = string | number | boolean | null

export interface QueryResult {
  columns: ResultColumn[]
  /**
   * Empty when the rows were streamed: they arrived through `onQueryRows`
   * batches instead, and the caller has assembled them by the time this
   * result lands. `rowCount` and `truncated` describe the whole stream.
   */
  rows: CellValue[][]
  streamed?: boolean
  /** Rows handed to the grid; always equal to `rows.length`. */
  rowCount: number
  /**
   * More rows existed than the display cap allowed. No total is reported:
   * counting past the cap would mean scanning a result nobody asked to see.
   */
  truncated: boolean
  affectedRows?: number
  durationMs: number
  command?: string
  statements?: number
}

/**
 * What the query editor completes from.
 *
 * The navigator walks the tree one node at a time, which is right for browsing
 * and wrong for completion: a suggestion list cannot wait on a round trip per
 * table. A snapshot is instead the whole of one database — every table, view
 * and column, plus the foreign keys that make a JOIN writable — read in a
 * handful of statements and then answered from memory.
 */
export interface SchemaColumn {
  name: string
  type: string
  primaryKey?: boolean
  nullable?: boolean
}

export interface SchemaObject {
  /** Empty for engines with no schema level; never undefined, so it is a map key. */
  schema: string
  name: string
  kind: 'table' | 'view'
  /**
   * How the driver addresses this object, exactly as `children` would have
   * reported it. The explorer opens a table straight off a snapshot, so the
   * path has to travel with it — the shape is the driver's, not the schema's.
   */
  path: DbPath
  columns: SchemaColumn[]
  /**
   * The planner's row estimate, not a count. Every engine that keeps one keeps
   * it as a by-product of its own statistics, so reading it costs nothing and
   * it is stale by exactly as much as the last ANALYZE. Absent rather than -1
   * where there is no estimate to give: a view, or a table never analysed.
   */
  rowEstimate?: number
  /** On-disk bytes, indexes included, where the engine tracks them. */
  bytes?: number
  /** What the schema says the table is for, when someone wrote it down. */
  comment?: string
}

/** One foreign key, as the join it implies. */
export interface SchemaRelation {
  schema: string
  table: string
  columns: string[]
  refSchema: string
  refTable: string
  refColumns: string[]
}

export interface SchemaSnapshot {
  /** The database it describes, as the query context names it. */
  database: string
  /** Schema names, including empty ones the object list cannot imply. */
  schemas: string[]
  objects: SchemaObject[]
  relations: SchemaRelation[]
  /**
   * The column budget ran out: the objects listed are described in full, but
   * tables past the cap are missing. Completion still works, on less.
   */
  truncated: boolean
}

/** A function or procedure, as the explorer lists it. */
export interface SchemaRoutine {
  /** Empty for engines with no schema level. */
  schema: string
  name: string
  kind: 'function' | 'procedure'
  /** The argument list as the engine prints it, for the row's detail. */
  args?: string
  returns?: string
  language?: string
  /** The CREATE statement, where the engine can produce one. */
  definition?: string
}

export interface SchemaSequence {
  schema: string
  name: string
  dataType?: string
  /** The value most recently handed out, when the engine tracks one. */
  lastValue?: number | null
}

export interface SchemaTrigger {
  schema: string
  name: string
  table: string
  /** `before insert`, `after update` and the like, as the engine words it. */
  when?: string
  definition?: string
}

/**
 * Everything in a database that is not a table or view. Read on demand by the
 * explorer, in one call, rather than folded into the snapshot the editor's
 * completions depend on: a completion list has no use for a trigger.
 */
export interface SchemaObjects {
  routines: SchemaRoutine[]
  sequences: SchemaSequence[]
  triggers: SchemaTrigger[]
}

/** One index on a table, as the structure view lists it. */
export interface IndexInfo {
  name: string
  columns: string[]
  unique: boolean
  primary: boolean
  /** The engine's own CREATE INDEX text, where it keeps one. */
  definition?: string
}

/** What the structure view shows beyond the columns it already has. */
export interface TableStructure {
  indexes: IndexInfo[]
  /**
   * The CREATE statement. MySQL and SQLite store one and hand it back
   * verbatim; Postgres keeps no such text, so its driver rebuilds one from
   * the catalog, and says so in `ddlNote`.
   */
  ddl: string | null
  ddlNote?: string
}

/** One run of the query editor, as the history remembers it. */
export interface QueryHistoryEntry {
  id: string
  /** Epoch milliseconds of the latest run. */
  at: number
  connectionId: string
  database?: string
  schema?: string
  sql: string
  outcome: 'ok' | 'error' | 'cancelled'
  durationMs?: number
  rowCount?: number
  affectedRows?: number
  error?: string
  /** How many times in a row this exact statement was run on this connection. */
  runs: number
}

export type QueryHistoryInput = Omit<QueryHistoryEntry, 'id' | 'at' | 'runs'>

/**
 * A statement kept on purpose, under a name. History remembers what ran;
 * this is the shelf for what is worth running again.
 */
export interface SavedQuery {
  id: string
  name: string
  sql: string
  /** Where it was written for, when it belongs to one connection. */
  connectionId?: string
  database?: string
  schema?: string
  /** Free words, for the search box. */
  tags?: string[]
  createdAt: number
  updatedAt: number
}

export type SavedQueryInput = Omit<SavedQuery, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }

/** A line for the log the main process keeps under the user's data directory. */
export interface LogEntry {
  level: 'error' | 'warn' | 'info'
  message: string
  detail?: string
}

export type ExportFormat = 'csv' | 'tsv' | 'json' | 'sql'

/**
 * A result streamed to a file. The statement is run again on the server, so
 * the file holds every row rather than the ones the grid happened to hold.
 */
export interface ExportRequest {
  sql: string
  database?: string
  schema?: string
  format: ExportFormat
  /** Where to write; absent, the system's save dialog asks. */
  path?: string
  suggestedName?: string
  /** For the export's cancel and progress; minted by the renderer. */
  jobId?: string
  /** CSV and TSV: whether the first line names the columns. */
  header?: boolean
  /** CSV only; a tab for TSV, a comma otherwise. */
  delimiter?: string
  /** How a NULL is written in CSV; empty by default. */
  nullText?: string
  /** SQL only: the table the INSERT statements name, already quoted. */
  table?: string
  /** SQL only: how the engine quotes an identifier. */
  quote?: string
  /** SQL only: double backslashes in strings, as MySQL wants. */
  escapeBackslashes?: boolean
}

export interface ExportOutcome {
  saved: boolean
  path?: string
  rows: number
  bytes: number
  durationMs: number
}

export interface ImportPreviewRequest {
  /** Absent, the system's open dialog asks. */
  path?: string
  delimiter?: string
  hasHeader?: boolean
}

/** The head of a delimited file, enough to map its columns. */
export interface ImportPreview {
  path: string
  bytes: number
  /** The delimiter used, guessed from the first lines when not given. */
  delimiter: string
  hasHeader: boolean
  /** Column names: the header line, or "column 1", "column 2", and so on. */
  columns: string[]
  /** The first rows, as text, header excluded. */
  rows: string[][]
}

export interface ImportRequest {
  path: string
  delimiter: string
  hasHeader: boolean
  /** Which file column feeds which table column; unmapped ones are skipped. */
  mapping: { source: number, column: string }[]
  /** Text that means NULL; an empty field is NULL when `emptyIsNull`. */
  nullText?: string
  emptyIsNull?: boolean
  trim?: boolean
  /** Rows per INSERT round trip. */
  batchSize?: number
  /** Empty the table first, in the same transaction. */
  truncate?: boolean
  jobId?: string
  /** The read-only guard's consent; see `allowWrite` on `query`. */
  allowWrite?: boolean
}

export interface ImportOutcome {
  inserted: number
  durationMs: number
}

/** Progress of a long job: rows so far, or a line a tool printed. */
export interface ProgressUpdate {
  jobId: string
  kind: 'export' | 'import' | 'dump' | 'restore'
  rows?: number
  bytes?: number
  line?: string
}

/** A column as a CREATE or ALTER writes it. */
export interface ColumnSpec {
  name: string
  type: string
  nullable?: boolean
  /** A default expression, written into the statement as typed. */
  defaultExpression?: string
  primaryKey?: boolean
  /** Auto-increment / identity / serial, in the engine's own spelling. */
  autoIncrement?: boolean
  comment?: string
}

/** One structure change; the driver spells it in its own dialect. */
export type DdlOperation =
  | { kind: 'createTable', name: string, columns: ColumnSpec[] }
  | { kind: 'renameTable', to: string }
  | { kind: 'addColumn', column: ColumnSpec }
  | { kind: 'dropColumn', name: string }
  | { kind: 'renameColumn', name: string, to: string }
  | {
    kind: 'alterColumn'
    name: string
    /** Each present field is changed; an absent one is left alone. */
    type?: string
    nullable?: boolean
    /** `null` drops the default; a string sets it. */
    defaultExpression?: string | null
  }
  | { kind: 'createIndex', name: string, columns: string[], unique?: boolean }
  | { kind: 'dropIndex', name: string }
  | { kind: 'dropTable' }

export interface DdlOutcome {
  /** The statements, as they run or would run. */
  statements: string[]
  applied: boolean
  durationMs?: number
}

export type CliTool = 'pg_dump' | 'pg_restore' | 'psql' | 'mysqldump' | 'mysql' | 'sqlite3'

export interface DumpRequest {
  database?: string
  /** Where to write; absent, the system's save dialog asks. */
  path?: string
  suggestedName?: string
  /** A tool found somewhere other than PATH. */
  toolPath?: string
  schemaOnly?: boolean
  dataOnly?: boolean
  /** Only these tables, named the way the explorer names them. */
  tables?: string[]
  jobId?: string
}

export interface RestoreRequest {
  database?: string
  /** The dump to read; absent, the system's open dialog asks. */
  path?: string
  toolPath?: string
  jobId?: string
  allowWrite?: boolean
}

export interface ToolOutcome {
  ok: boolean
  /** The user dismissed the file dialog; nothing ran. */
  cancelled?: boolean
  path?: string
  exitCode: number | null
  durationMs: number
  /** The tool's last lines, for the error a failed run reports. */
  tail: string[]
}

/** The surface `electron/preload.cjs` puts on `window`. */
export interface DbisonBridge {
  channels: Record<string, string>
  drivers: () => Promise<{ drivers: DriverMeta[], canStoreSecrets: boolean }>
  profiles: {
    list: () => Promise<{ profiles: ConnectionProfile[], states: ConnectionState[] }>
    save: (profile: ConnectionProfileInput) => Promise<ConnectionProfile>
    remove: (id: string) => Promise<{ id: string }>
  }
  connect: (id: string, password?: string) => Promise<ConnectionState>
  disconnect: (id: string) => Promise<ConnectionState>
  test: (profile: ConnectionProfileInput) => Promise<{ ok: true, serverVersion: string }>
  children: (id: string, node: { kind: DbNodeKind, path?: DbPath }) => Promise<DbNode[]>
  preview: (
    id: string,
    node: { kind: DbNodeKind, path: DbPath },
    options?: PreviewOptions,
  ) => Promise<{ sql: string }>
  /** Everything in one database, in one call, for the editor's completions. */
  schema: (id: string, scope?: { database?: string }) => Promise<SchemaSnapshot>
  query: (
    id: string,
    sql: string,
    options?: {
      maxRows?: number
      queryId?: string
      database?: string
      schema?: string
      transactionId?: string
      /**
       * Push rows through `onQueryRows` as they arrive, keyed by `queryId`,
       * rather than returning them all at once at the end.
       */
      stream?: boolean
      /**
       * How binary values travel. The digest is a short hex prefix and a
       * size, enough for a grid; base64 is the whole value, for a viewer
       * that has asked for one cell.
       */
      binary?: 'digest' | 'base64'
      /**
       * The user has confirmed a write on a connection marked read-only.
       * Without it the main process refuses a statement that may write
       * there, whatever the renderer showed or did not show.
       */
      allowWrite?: boolean
    },
  ) => Promise<QueryResult>
  /** One batch of a streaming query's rows; see `query`'s `stream` option. */
  onQueryRows: (
    listener: (batch: { queryId: string, rows: CellValue[][], columns?: ResultColumn[] }) => void,
  ) => () => void
  /**
   * A transaction held open across statements. `begin` pins one connection
   * to the returned id; statements sent with that id run on it, and `end`
   * commits or rolls back and returns the connection to the pool. A closed
   * tab must end what it began, or the connection stays pinned.
   */
  transaction: {
    begin: (id: string, scope?: { database?: string, schema?: string }) => Promise<{ transactionId: string }>
    end: (transactionId: string, action: 'commit' | 'rollback') => Promise<{ ended: boolean }>
  }
  /**
   * Applies staged row changes in one transaction, or — with `dryRun` — only
   * builds the statements so they can be read before they run.
   */
  applyChanges: (
    id: string,
    node: { kind: DbNodeKind, path: DbPath },
    changes: RowChange[],
    options?: { dryRun?: boolean, allowWrite?: boolean },
  ) => Promise<ChangeOutcome>
  cancel: (queryId: string) => Promise<{ cancelled: boolean }>
  /** A table's indexes and CREATE statement, for the structure view. */
  structure: (id: string, node: { kind: DbNodeKind, path: DbPath }) => Promise<TableStructure>
  /** The routines, sequences and triggers of one database. */
  objects: (id: string, scope?: { database?: string }) => Promise<SchemaObjects>
  /**
   * An exact row count, under the same WHERE the preview uses. Never run
   * unasked: on a large table it is a full scan.
   */
  countRows: (
    id: string,
    node: { kind: DbNodeKind, path: DbPath },
    options?: { where?: string, queryId?: string },
  ) => Promise<{ count: number, durationMs: number }>
  /**
   * Writes a file. With `path` it writes there without asking; without one it
   * shows the system save dialog first and writes where the user pointed.
   */
  saveFile: (request: {
    suggestedName: string
    content: string
    path?: string
    filters?: { name: string, extensions: string[] }[]
    /** How `content` is to be decoded; `base64` carries binary such as a PNG. */
    encoding?: 'utf8' | 'base64'
  }) => Promise<{ saved: boolean, path?: string }>
  /**
   * Shows the system open dialog. With `read` the file's text comes back too;
   * without it only the path does, which is all a SQLite profile needs.
   */
  openFile: (request?: {
    filters?: { name: string, extensions: string[] }[]
    read?: boolean
    /** A path already known — a recent file — skips the dialog. */
    path?: string
  }) => Promise<{ opened: boolean, path?: string, content?: string }>
  history: {
    list: () => Promise<QueryHistoryEntry[]>
    add: (entry: QueryHistoryInput) => Promise<QueryHistoryEntry | null>
    clear: () => Promise<{ cleared: true }>
    remove: (id: string) => Promise<{ removed: boolean }>
  }
  saved: {
    list: () => Promise<SavedQuery[]>
    save: (query: SavedQueryInput) => Promise<SavedQuery>
    remove: (id: string) => Promise<{ removed: boolean }>
  }
  /** Appends a line to the app's log file; never throws to the caller. */
  log: (entry: LogEntry) => Promise<{ logged: boolean }>
  logPath: () => Promise<{ path: string }>
  /** Shows a file in the system's file manager. */
  reveal: (path: string) => Promise<{ revealed: boolean }>
  /** Runs a statement again on the server and streams every row to a file. */
  exportRows: (id: string, request: ExportRequest) => Promise<ExportOutcome>
  importPreview: (request?: ImportPreviewRequest) => Promise<ImportPreview>
  importRows: (
    id: string,
    node: { kind: DbNodeKind, path: DbPath },
    request: ImportRequest,
  ) => Promise<ImportOutcome>
  /** One structure change: built as SQL, and run unless `dryRun`. */
  ddl: (
    id: string,
    node: { kind: DbNodeKind, path: DbPath },
    operation: DdlOperation,
    options?: { dryRun?: boolean, allowWrite?: boolean },
  ) => Promise<DdlOutcome>
  locateTool: (tool: CliTool) => Promise<{ path: string | null, version?: string }>
  dump: (id: string, request: DumpRequest) => Promise<ToolOutcome>
  restore: (id: string, request: RestoreRequest) => Promise<ToolOutcome>
  /** Progress pushes for exports, imports, dumps and restores. */
  onProgress: (listener: (update: ProgressUpdate) => void) => () => void
  /**
   * Recolours the window buttons Electron draws over the app's title bar, so
   * they follow the theme; recolouring is a no-op on macOS, where the traffic
   * lights are system-coloured. Every platform records the palette, so the
   * next cold start's window and load screen open in the same theme.
   */
  setTitleBar: (palette: {
    theme: 'dark' | 'light'
    color: string
    symbolColor: string
    background: string
  }) => Promise<{ applied: boolean }>
  /** Zooms the window by a factor of the default size, clamped by main. */
  setZoom: (factor: number) => Promise<{ zoom: number }>
  /**
   * Runs an edit role against the focused element — the same thing a native
   * Edit menu would do, which this app does not have. The keystrokes for
   * these already work; the menu rows exist for the people who look there.
   */
  editAction: (role: EditRole) => Promise<{ applied: boolean }>
  /**
   * Tells the window whether it holds unsaved work. The main process asks
   * before closing when it does; the renderer cannot show that dialog itself
   * once the close has begun.
   */
  setDirty: (dirty: boolean) => Promise<{ dirty: boolean }>
  /** The clipboard's text, read by the main process. */
  readClipboard: () => Promise<{ text: string }>
  onStatusChanged: (listener: (state: ConnectionState) => void) => () => void
}

export type EditRole = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'

declare global {
  interface Window {
    dbison?: DbisonBridge
  }
}
