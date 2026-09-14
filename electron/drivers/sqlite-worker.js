import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'

import { assertOneRow } from './changes.js'
import { describeSqliteQueryError, explainQueryError } from './errors.js'
import { buildSnapshot, groupRelations, SCHEMA_COLUMN_LIMIT } from './introspection.js'
import { createRowSink, serializeError } from './values.js'

/**
 * Owns one SQLite file on a thread of its own.
 *
 * node:sqlite is synchronous, so running it on the main process would freeze
 * the whole app — including its ability to receive a cancel request — for the
 * length of every query. Here a blocked thread costs nothing.
 *
 * Cancellation cannot arrive as a message, because a blocked thread never
 * reaches its event loop to read one. It arrives through shared memory instead:
 * the host writes to `cancelFlag` and the row loop below reads it directly.
 */

const cancelFlag = new Int32Array(workerData.cancelBuffer)
const ROWS_PER_CANCEL_CHECK = 512

const db = new DatabaseSync(workerData.file)

/** Sentinel that tells the host this was a deliberate stop, not a failure. */
const CANCELLED = 'DBISON_CANCELLED'

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`
}

function isCancelled() {
  return Atomics.load(cancelFlag, 0) === 1
}

/**
 * SQLite says where nothing is: `prepare` reports only the token it choked on.
 * The statement is matched back against that here, before the error is
 * serialized and loses the context.
 *
 * With `stream` the rows go back to the host as interim `rows` messages
 * while the statement is still running, the first of them naming the
 * columns, and the reply at the end carries the count in their place.
 */
function runQuery({ id, sql, maxRows, binary, stream }) {
  const sink = createRowSink({
    binary,
    onRows: stream
      ? (rows, columns) => parentPort.postMessage({ id, type: 'rows', rows, columns })
      : undefined,
    columnsOf: (columnMeta) => columnMeta.map((column) => ({
      name: column.name,
      // A computed column has no declared type.
      type: (column.type ?? 'any').toLowerCase(),
    })),
  })

  try {
    return executeQuery(sql, maxRows, sink)
  }
  catch (error) {
    if (error?.code === CANCELLED) throw error
    throw explainQueryError(error, sql, describeSqliteQueryError)
  }
}

function executeQuery(sql, maxRows, sink) {
  const started = performance.now()
  const statement = db.prepare(sql)
  const columnMeta = statement.columns()

  if (columnMeta.length === 0) {
    const outcome = statement.run()

    return {
      ...sink.finish(),
      truncated: false,
      affectedRows: Number(outcome.changes ?? 0),
      durationMs: Math.round(performance.now() - started),
    }
  }

  // Without this an INTEGER past 2^53 throws instead of returning; the
  // normalizer narrows the BigInts that do fit back to numbers.
  statement.setReadBigInts(true)
  statement.setReturnArrays(true)
  sink.describe(columnMeta)

  let truncated = false

  // Streaming rather than `.all()`, for two reasons: the scan can be cancelled
  // part-way through, and it stops at the display cap instead of walking the
  // whole result. Counting every row past the cap would make `select * from`
  // over a huge join run to completion for a number nobody asked for.
  for (const row of statement.iterate()) {
    if (sink.count === maxRows) {
      truncated = true
      break
    }

    sink.push(row)

    if (sink.count % ROWS_PER_CANCEL_CHECK === 0 && isCancelled()) {
      const error = new Error('Query cancelled.')
      error.code = CANCELLED
      throw error
    }
  }

  return {
    ...sink.finish(),
    truncated,
    durationMs: Math.round(performance.now() - started),
  }
}

function listChildren(node) {
  switch (node.kind) {
    case 'connection':
      // A SQLite file is one database; the tree skips a level that would always
      // hold exactly one child.
      return listChildren({ kind: 'database', path: { database: 'main' } })

    case 'database':
      return db.prepare(
        `select name, type
           from sqlite_master
          where type in ('table', 'view') and substr(name, 1, 7) <> 'sqlite_'
          order by type, name`,
      ).all().map((row) => ({
        kind: row.type === 'view' ? 'view' : 'table',
        name: row.name,
        expandable: true,
        path: { database: 'main', table: row.name },
      }))

    case 'table':
    case 'view':
      return db.prepare(`pragma table_info(${quoteIdent(node.path.table)})`).all().map((row) => ({
        kind: 'column',
        name: row.name,
        detail: `${(row.type || 'any').toLowerCase()}${row.notnull ? ' not null' : ''}`,
        primaryKey: Boolean(row.pk),
        nullable: !row.notnull,
        declaredType: (row.type || 'any').toLowerCase(),
        // A single-column INTEGER PRIMARY KEY is the rowid alias, which SQLite
        // fills in itself — the closest thing it has to auto-increment.
        hasDefault: row.dflt_value !== null
          || (Boolean(row.pk) && String(row.type ?? '').toLowerCase() === 'integer'),
        expandable: false,
        path: { ...node.path, column: row.name },
      }))

    default:
      return []
  }
}

/**
 * Reads the whole file in three statements, for the editor's completions.
 *
 * The pragmas are joined as table-valued functions rather than run once per
 * table: the file is local and synchronous, but a query tab that opened a
 * hundred prepared statements to fill a suggestion list would still be a
 * hundred statements.
 */
function schemaSnapshot() {
  const columns = db.prepare(
    `select m.name as "table",
            m.type as "kind",
            info.name as "column",
            info.type as "type",
            not info."notnull" as "nullable",
            info.pk > 0 as "primaryKey"
       from sqlite_master m
       left join pragma_table_info(m.name) info
      where m.type in ('table', 'view') and substr(m.name, 1, 7) <> 'sqlite_'
      order by m.name, info.cid
      limit ?`,
  ).all(SCHEMA_COLUMN_LIMIT + 1)

  const keys = db.prepare(
    `select m.name || '.' || fk.id as "key",
            m.name as "table",
            fk."from" as "column",
            fk."table" as "refTable",
            fk."to" as "refColumn"
       from sqlite_master m
       join pragma_foreign_key_list(m.name) fk
      where m.type = 'table' and substr(m.name, 1, 7) <> 'sqlite_'
      order by m.name, fk.id, fk.seq`,
  ).all()

  // SQLite stores no row count of its own; sqlite_stat1 is what ANALYZE
  // leaves behind, and its first whitespace-separated token is the table's
  // row count as of that run. A file nobody has analysed simply has no table
  // here, and no numbers show — better than a COUNT(*) per table, which is a
  // full scan of the file every time the sidebar is drawn.
  const analysed = db
    .prepare(`select name from sqlite_master where type = 'table' and name = 'sqlite_stat1'`)
    .get()

  // ANALYZE writes no sqlite_stat1 row for a table it found empty, so once the
  // file has been analysed at all, a table missing from there has no rows —
  // which is the one count most worth showing. Every table starts at zero and
  // is corrected by the rows below; a file never analysed keeps this empty and
  // shows no numbers rather than claiming everything is empty.
  const stats = analysed
    ? db.prepare(
      `select name as "table", 0 as "rowEstimate"
         from sqlite_master
        where type = 'table' and substr(name, 1, 7) <> 'sqlite_'`,
    ).all()
    : []

  if (analysed) {
    // Every row for a table — its own and one per index — starts with the same
    // count, so which one wins does not matter.
    stats.push(...db.prepare(`select tbl as "table", stat as "stat" from sqlite_stat1`).all())
  }

  const truncated = columns.length > SCHEMA_COLUMN_LIMIT

  const snapshot = buildSnapshot({
    database: 'main',
    // The file has no object levels above a table, but the navigator still
    // addresses one under `main`, and an id has to match either way.
    pathOf: (_schema, table) => ({ database: 'main', table }),
    columns: truncated ? columns.slice(0, SCHEMA_COLUMN_LIMIT) : columns,
    stats: stats.map((row) => ({
      table: row.table,
      rowEstimate: row.stat == null
        ? row.rowEstimate
        : Number.parseInt(String(row.stat).split(' ')[0], 10),
    })),
    relations: groupRelations(keys),
    truncated,
  })

  // A key written without a target column points at the other table's primary
  // key. SQLite leaves that implicit; the editor cannot, so it is filled in
  // here from the columns just read.
  for (const relation of snapshot.relations) {
    if (relation.refColumns.every(Boolean)) continue

    const target = snapshot.objects.find((object) => object.name === relation.refTable)
    const primaryKey = target?.columns.filter((column) => column.primaryKey) ?? []

    if (primaryKey.length === relation.columns.length) {
      relation.refColumns = primaryKey.map((column) => column.name)
    }
  }

  snapshot.relations = snapshot.relations.filter((relation) => relation.refColumns.every(Boolean))

  return snapshot
}

/**
 * A table's indexes and its CREATE statement, both as the file keeps them.
 *
 * sqlite_master holds every CREATE verbatim, so the DDL is the table's own text
 * followed by each index that was created by hand. An index SQLite made for
 * itself — behind a PRIMARY KEY or UNIQUE clause — has no text there, which is
 * right: the clause that made it is already in the table's statement.
 */
function structure(node) {
  const table = node.path.table

  const created = db
    .prepare(`select sql from sqlite_master where type in ('table', 'view') and name = ?`)
    .get(table)

  // One read for every index rather than one per index; sqlite_master lists
  // them in creation order, which is the order the DDL below repeats them in.
  const indexSql = db
    .prepare(`select name, sql from sqlite_master where type = 'index' and tbl_name = ? order by rowid`)
    .all(table)

  const sqlByName = new Map(indexSql.map((row) => [row.name, row.sql]))

  const indexes = db.prepare(`pragma index_list(${quoteIdent(table)})`).all()
    .map((index) => ({
      name: index.name,
      columns: db.prepare(`pragma index_info(${quoteIdent(index.name)})`).all()
        .sort((a, b) => a.seqno - b.seqno)
        // A column indexed by expression has no name, only a position.
        .map((column) => column.name ?? '(expression)'),
      unique: Boolean(index.unique),
      primary: index.origin === 'pk',
      definition: sqlByName.get(index.name) ?? undefined,
    }))
    .sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name))

  const lines = created?.sql ? [`${created.sql};`] : []
  for (const row of indexSql) if (row.sql) lines.push(`${row.sql};`)

  return { indexes, ddl: lines.length ? lines.join('\n') : null }
}

/**
 * The sequences and triggers in the file, for the explorer's object lists.
 * Routines are always empty: SQLite has no stored procedures or user-defined
 * SQL functions — its functions are registered by the host program.
 */
function objects() {
  // sqlite_sequence is where AUTOINCREMENT keeps the last rowid it handed
  // out, one row per table declared with the keyword. It is the nearest
  // thing the file has to a sequence, and it only exists once a table has
  // asked for one.
  const hasSequences = db
    .prepare(`select name from sqlite_master where type = 'table' and name = 'sqlite_sequence'`)
    .get()

  const sequences = hasSequences
    ? db.prepare('select name, seq from sqlite_sequence order by name').all().map((row) => ({
      schema: '',
      name: row.name,
      lastValue: row.seq == null ? null : Number(row.seq),
    }))
    : []

  // The CREATE text is all sqlite_master keeps of a trigger, so its timing is
  // read back out of that text. The match is loose on purpose: the keyword
  // order is fixed by the grammar, but comments and line breaks are not.
  const triggers = db
    .prepare(`select name, tbl_name, sql from sqlite_master where type = 'trigger' order by name`)
    .all()
    .map((row) => {
      const timing = /\b(before|after|instead\s+of)\s+(insert|update|delete)\b/i.exec(row.sql ?? '')

      return {
        schema: '',
        name: row.name,
        table: row.tbl_name,
        when: timing ? `${timing[1].replace(/\s+/g, ' ')} ${timing[2]}`.toLowerCase() : undefined,
        definition: row.sql ?? undefined,
      }
    })

  return { routines: [], sequences, triggers }
}

/**
 * The staged row changes, applied as one transaction.
 *
 * Kept apart from `query`: nothing here is cancellable or capped, because these
 * are single-row writes addressed by a primary key. Any statement that fails —
 * including one that matched the wrong number of rows — rolls the whole batch
 * back, so the grid's "save" is all or nothing.
 */
function runBatch({ statements }) {
  db.exec('begin')

  try {
    let applied = 0

    for (const [position, statement] of statements.entries()) {
      const outcome = db.prepare(statement.sql).run(...statement.params)
      assertOneRow(Number(outcome.changes ?? 0), position)
      applied += 1
    }

    db.exec('commit')
    return { applied }
  }
  catch (error) {
    // The rollback's own failure would replace the error that caused it, which
    // is the one worth reporting.
    try {
      db.exec('rollback')
    }
    catch {
      // Already rolled back, or the transaction never opened.
    }

    throw explainQueryError(
      error,
      statements.map((statement) => statement.sql).join('\n'),
      describeSqliteQueryError,
    )
  }
}

/**
 * Runs a statement for its effect alone: `begin`, `commit`, `rollback`. The
 * file is one connection, so a transaction opened here holds until the
 * matching `exec` ends it, and every statement in between runs inside it.
 */
function runExec({ sql }) {
  try {
    db.exec(sql)
    return {}
  }
  catch (error) {
    throw explainQueryError(error, sql, describeSqliteQueryError)
  }
}

/**
 * One prepared INSERT run once per row of a batch. Part of a transaction the
 * host opened with `exec`; nothing here begins or commits.
 */
function runInsert({ sql, rows }) {
  try {
    const statement = db.prepare(sql)
    let changes = 0

    for (const row of rows) {
      const outcome = statement.run(...row.map((value) => (typeof value === 'boolean' ? Number(value) : value)))
      changes += Number(outcome.changes ?? 0)
    }

    return { changes }
  }
  catch (error) {
    throw explainQueryError(error, sql, describeSqliteQueryError)
  }
}

const HANDLERS = {
  query: runQuery,
  exec: runExec,
  batch: runBatch,
  insert: runInsert,
  children: ({ node }) => listChildren(node),
  schema: () => schemaSnapshot(),
  structure: ({ node }) => structure(node),
  objects: () => objects(),
}

parentPort.on('message', (message) => {
  if (message.type === 'close') {
    db.close()
    parentPort.close()
    return
  }

  try {
    parentPort.postMessage({ id: message.id, ok: true, data: HANDLERS[message.type](message) })
  }
  catch (error) {
    parentPort.postMessage({
      id: message.id,
      ok: false,
      cancelled: error?.code === CANCELLED,
      error: serializeError(error),
    })
  }
})

const [{ version }] = db.prepare('select sqlite_version() as version').all()
parentPort.postMessage({ type: 'ready', version })
