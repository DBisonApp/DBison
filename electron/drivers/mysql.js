import mysql from 'mysql2/promise'

import { assertOneRow, buildStatements, literalFactory, previewOf } from './changes.js'
import { buildSnapshot, groupRelations, SCHEMA_COLUMN_LIMIT } from './introspection.js'
import {
  describeMysqlError,
  describeMysqlQueryError,
  explainConnectionError,
  explainQueryError,
} from './errors.js'
import { buildDdl } from './ddl.js'
import { isRowProducing } from './statements.js'
import { tlsOptions } from './tls.js'
import { createRowSink } from './values.js'

/** Reverses mysql2's numeric field types into the names shown in headers. */
const TYPE_NAMES = Object.fromEntries(
  Object.entries(mysql.Types ?? {})
    .filter(([, value]) => typeof value === 'number')
    .map(([name, value]) => [value, name.toLowerCase()]),
)

function quoteIdent(name) {
  return `\`${String(name).replace(/`/g, '``')}\``
}

/**
 * The labels of an `enum('a','b')` column, as MySQL writes them in the catalog.
 *
 * A label may contain a quote, which MySQL escapes by doubling; the same rule
 * that reads a string literal reads these.
 */
function enumValues(declaredType) {
  if (!/^enum\(/i.test(declaredType ?? '')) return undefined

  return [...declaredType.matchAll(/'((?:[^']|'')*)'/g)].map((match) => match[1].replace(/''/g, "'"))
}

/**
 * Reads a catalog column whose case the server does not promise. SHOW INDEX
 * names its columns `Key_name`, `Seq_in_index` and so on, but a MariaDB or a
 * differently configured server may hand them back in another case.
 */
function field(row, name) {
  return row[name] ?? row[name.toUpperCase()] ?? row[name.toLowerCase()]
}

/**
 * Groups information_schema.parameters rows into one argument list per routine,
 * written the way the CREATE would have: `in x int, out y varchar(10)`. The
 * rows arrive ordered by position; position 0 is a function's return value,
 * which is not an argument and is reported through DTD_IDENTIFIER instead.
 */
function groupParameters(rows) {
  const byRoutine = new Map()

  for (const row of rows) {
    if (Number(field(row, 'ordinal_position')) === 0) continue

    const routine = field(row, 'specific_name')
    const mode = field(row, 'parameter_mode')
    const part = [mode ? String(mode).toLowerCase() : '', field(row, 'parameter_name'), field(row, 'dtd_type')]
      .filter(Boolean)
      .join(' ')

    if (!byRoutine.has(routine)) byRoutine.set(routine, [])
    byRoutine.get(routine).push(part)
  }

  return new Map([...byRoutine].map(([routine, parts]) => [routine, parts.join(', ')]))
}

function toColumns(fields) {
  return (fields ?? []).map((field) => ({
    name: field.name,
    type: TYPE_NAMES[field.columnType ?? field.type] ?? 'unknown',
  }))
}

/**
 * Runs a statement the plain way: the whole reply is fetched, then cut to the
 * cap. This is the path for everything that is not a plain read — DML and DDL
 * answer with a header rather than rows, and its affected count lives there.
 */
async function fetchStatement(connection, sql, maxRows, sink) {
  const started = performance.now()
  const [raw, fields] = await connection.query({ sql, rowsAsArray: true })
  const durationMs = Math.round(performance.now() - started)

  // DML returns a ResultSetHeader rather than an array of rows.
  if (!Array.isArray(raw)) {
    return { ...sink.finish(), truncated: false, affectedRows: raw.affectedRows ?? 0, durationMs }
  }

  // The reply is already whole, so a streaming caller gets its rows in one
  // go: what the contract promises is the shape, not the pacing.
  sink.describe(fields)
  for (const row of raw.slice(0, maxRows)) sink.push(row)

  return {
    ...sink.finish(),
    truncated: raw.length > maxRows,
    durationMs,
  }
}

/**
 * Runs a row-producing statement as a stream, reading only as far as the
 * display cap.
 *
 * The promise wrapper has no stream of its own, so the query goes to the
 * callback connection underneath it. Rows arrive one packet at a time and the
 * loop stops one past the cap: that row proves the result was longer without
 * keeping the rest of it in memory.
 *
 * What it cannot do is stop the server: the rows past the cap are still on
 * the wire, and a connection with a half-read reply cannot be handed back to
 * the pool. A pooled connection is destroyed by the caller instead, which is
 * cheaper than the read it avoids. A pinned one — a transaction's — has to
 * survive, so with `drain` the rest is read and thrown away.
 */
async function streamStatement(connection, sql, maxRows, sink, { drain }) {
  const started = performance.now()
  const command = connection.connection.query({ sql, rowsAsArray: true })
  const stream = command.stream()

  // The stream detaches its listeners when it is destroyed, but the command
  // keeps parsing whatever the server still sends. An error packet arriving
  // then — a kill, a dropped connection — would be an 'error' with nobody
  // listening, which brings the whole process down.
  command.on('error', () => {})

  // A connection lost mid-result is reported on the connection, never on a
  // command that was run without a callback, so left alone the stream would
  // wait for rows that are never coming. Forwarded, it fails like any other
  // error; the pool has already let the connection go by then.
  const base = connection.connection
  const onLost = (error) => stream.destroy(error)
  base.on('error', onLost)

  let affectedRows
  let truncated = false
  let durationMs

  // The column packets precede the first row, so a streaming caller's first
  // batch can carry the headers.
  stream.on('fields', (described) => sink.describe(described))

  try {
    for await (const row of stream) {
      // A statement that opened with a read keyword but produced no rows — a
      // `with ... update` — comes through as its OK packet rather than a row.
      if (!Array.isArray(row)) {
        affectedRows = row.affectedRows ?? 0
        continue
      }

      // Past the cap, draining reads the rest so the connection ends up clean.
      if (truncated) continue

      if (sink.count === maxRows) {
        truncated = true
        durationMs = Math.round(performance.now() - started)
        if (!drain) break
        continue
      }

      sink.push(row)
    }
  }
  finally {
    base.off('error', onLost)
  }

  return {
    ...sink.finish(),
    truncated,
    affectedRows,
    durationMs: durationMs ?? Math.round(performance.now() - started),
  }
}

/** Shapes what either statement path produced into what the grid expects. */
function toResult(outcome) {
  return {
    columns: outcome.columns,
    // Empty when the rows went out in batches instead; `rowCount` is then
    // how many did. Either way it is what the grid received, not what the
    // statement produced, and `truncated` says whether more existed. See
    // shared/db-types.ts.
    rows: outcome.rows,
    rowCount: outcome.rowCount,
    streamed: outcome.streamed,
    truncated: outcome.truncated,
    affectedRows: outcome.affectedRows,
    durationMs: outcome.durationMs,
  }
}

async function open(profile, secret) {
  const pool = mysql.createPool({
    host: profile.host,
    port: profile.port ?? 3306,
    user: profile.username,
    password: secret,
    // Left unset so the tree can reach every schema on the server; statements
    // that need a default database qualify their names instead.
    database: profile.database || undefined,
    // Read before the pool exists, so a certificate path that cannot be read
    // fails the open — and the connection dialog's Test — with a clear message.
    ssl: tlsOptions(profile),
    connectionLimit: 4,
    connectTimeout: 10_000,
    // Timestamps stay strings: the driver's local-time parsing would silently
    // shift values that the server stores without a zone.
    dateStrings: true,
    // Off by default: it turns a stray semicolon in a WHERE clause into a
    // second executable statement.
    multipleStatements: false,
  })

  let versionRows

  try {
    [versionRows] = await pool.query('select version() as version')
  }
  catch (error) {
    await pool.end().catch(() => {})

    throw explainConnectionError(
      error,
      { ...profile, hasPassword: Boolean(secret) },
      describeMysqlError,
    )
  }

  /**
   * MySQL kills a running statement from a second connection, addressed by the
   * thread id of the first. `KILL QUERY` stops the statement but leaves the
   * connection usable, unlike a bare `KILL`.
   */
  async function killQuery(threadId) {
    // Interpolated rather than bound: MySQL does not accept a placeholder here.
    // `threadId` comes from the driver as a number, and is re-checked anyway.
    if (!Number.isInteger(threadId)) return
    await pool.query(`KILL QUERY ${threadId}`)
  }

  /**
   * Selects the database a statement should run in. A pooled connection
   * remembers the database the last tab selected on it, so this is issued on
   * every checkout rather than only on a change.
   */
  async function useDatabase(connection, database) {
    const target = database ?? profile.database
    if (target) await connection.query(`use ${quoteIdent(target)}`)
  }

  /**
   * Runs one statement on a connection somebody else checked out — a pooled
   * one for the length of a query, or the one a transaction keeps. Which path
   * the statement takes is decided by its first keyword; see statements.js.
   *
   * `pinned` says the connection has to outlive this statement, which changes
   * what a truncated stream does with the rows it did not want. `onRows`,
   * when given, receives the rows in batches as they arrive instead of their
   * coming back on the result.
   */
  async function runOnConnection(connection, sql, { maxRows, signal, pinned, onRows, binary }) {
    const onAbort = () => { killQuery(connection.threadId).catch(() => {}) }
    signal?.addEventListener('abort', onAbort, { once: true })

    const sink = createRowSink({ onRows, binary, columnsOf: toColumns })

    try {
      const outcome = isRowProducing(sql)
        ? await streamStatement(connection, sql, maxRows, sink, { drain: pinned })
        : await fetchStatement(connection, sql, maxRows, sink)

      return toResult(outcome)
    }
    catch (error) {
      if (error?.code === 'ER_QUERY_INTERRUPTED') {
        throw Object.assign(new Error('Query cancelled.'), { cancelled: true })
      }
      throw explainQueryError(error, sql, describeMysqlQueryError)
    }
    finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Runs a statement in the database the query tab is pointed at. MySQL has no
   * level above its schemas, so `schema` never arrives here.
   */
  async function query(sql, { maxRows, signal, database, onRows, binary }) {
    // An explicit connection rather than `pool.query`, so its thread id is
    // known while the statement is still running.
    const connection = await pool.getConnection()
    let result

    try {
      await useDatabase(connection, database).catch((error) => {
        throw explainQueryError(error, sql, describeMysqlQueryError)
      })

      result = await runOnConnection(connection, sql, { maxRows, signal, onRows, binary })
    }
    finally {
      // A truncated stream leaves the rest of the reply unread on the socket,
      // and a connection in that state cannot go back to the pool: the next
      // statement on it would read someone else's rows. Destroying it closes
      // the socket, the server stops sending, and the pool opens a fresh one.
      if (result?.truncated) connection.destroy()
      else connection.release()
    }

    return result
  }

  /**
   * Opens a transaction on one connection and keeps it checked out until the
   * transaction ends, so every statement sent with it sees the others' work.
   *
   * A commit or rollback that fails itself destroys the connection rather
   * than releasing it: the pool does not reset what it takes back, and the
   * next tab must not inherit a transaction in an unknown state.
   */
  async function beginTransaction({ database } = {}) {
    const connection = await pool.getConnection()

    try {
      await useDatabase(connection, database)
      await connection.beginTransaction()
    }
    catch (error) {
      connection.destroy()
      throw explainQueryError(error, 'begin', describeMysqlQueryError)
    }

    let ended = false

    async function end(action) {
      if (ended) return
      ended = true

      try {
        await (action === 'commit' ? connection.commit() : connection.rollback())
        connection.release()
      }
      catch (error) {
        connection.destroy()
        throw explainQueryError(error, action, describeMysqlQueryError)
      }
    }

    return {
      query: (sql, { maxRows, signal, onRows, binary }) =>
        runOnConnection(connection, sql, { maxRows, signal, pinned: true, onRows, binary }),
      commit: () => end('commit'),
      rollback: () => end('rollback'),
    }
  }

  /**
   * Applies a batch of staged row changes in one transaction.
   *
   * All of it or none of it: a screen of corrections is one intent, and half of
   * it landing is worse than none. Values are bound, never built into the
   * statement — a string that happens to contain a quote is a string.
   */
  async function applyChanges(node, changes, { dryRun } = {}) {
    const built = buildStatements(changes, {
      table: `${quoteIdent(node.path.database)}.${quoteIdent(node.path.table)}`,
      quoteIdent,
      placeholder: () => '?',
      // MySQL reads a backslash inside a string as an escape unless the server
      // runs with NO_BACKSLASH_ESCAPES, so the preview has to double them.
      literal: literalFactory({ escapeBackslashes: true }),
      emptyInsert: '() values ()',
    })

    const script = built.map(({ sql, preview }) => ({ sql, preview }))
    if (dryRun) return { statements: script, applied: 0 }

    const connection = await pool.getConnection()
    let applied = 0

    try {
      await connection.beginTransaction()

      for (const [position, statement] of built.entries()) {
        const [outcome] = await connection.execute(statement.sql, statement.params)
        assertOneRow(outcome.affectedRows ?? 0, position)
        applied += 1
      }

      await connection.commit()
    }
    catch (error) {
      // The rollback's own failure would replace the error that caused it,
      // which is the one worth reporting.
      await connection.rollback().catch(() => {})
      throw explainQueryError(error, previewOf(built), describeMysqlQueryError)
    }
    finally {
      connection.release()
    }

    return { statements: script, applied }
  }

  /**
   * Loads batches of rows into a table, in one transaction. mysql2's bulk
   * form binds a whole batch behind one `?`, and the server casts the text
   * values to each column's type.
   */
  async function importRows(node, { columns, batches, truncate, signal }) {
    const table = `${quoteIdent(node.path.database)}.${quoteIdent(node.path.table)}`
    const names = columns.map(quoteIdent).join(', ')

    const connection = await pool.getConnection()
    const onAbort = () => { killQuery(connection.threadId).catch(() => {}) }
    signal?.addEventListener('abort', onAbort, { once: true })

    let inserted = 0

    try {
      await useDatabase(connection, node.path.database)
      await connection.beginTransaction()
      if (truncate) await connection.query(`delete from ${table}`)

      for await (const batch of batches) {
        if (signal?.aborted) throw Object.assign(new Error('Import cancelled.'), { cancelled: true })
        if (!batch.length) continue

        await connection.query(`insert into ${table} (${names}) values ?`, [batch])
        inserted += batch.length
      }

      await connection.commit()
    }
    catch (error) {
      await connection.rollback().catch(() => {})
      if (error?.cancelled) throw error
      if (error?.code === 'ER_QUERY_INTERRUPTED') throw Object.assign(new Error('Import cancelled.'), { cancelled: true })
      throw explainQueryError(error, `insert into ${table} (${names}) values (…)`, describeMysqlQueryError)
    }
    finally {
      signal?.removeEventListener('abort', onAbort)
      connection.release()
    }

    return { inserted }
  }

  async function listChildren(node) {
    switch (node.kind) {
      case 'connection': {
        const [rows] = await pool.query(
          `select schema_name
             from information_schema.schemata
            where schema_name not in ('information_schema', 'performance_schema', 'mysql', 'sys')
            order by schema_name`,
        )

        return rows.map((row) => ({
          kind: 'database',
          name: row.schema_name ?? row.SCHEMA_NAME,
          expandable: true,
          path: { database: row.schema_name ?? row.SCHEMA_NAME },
        }))
      }

      case 'database': {
        const [rows] = await pool.query(
          `select table_name, table_type, table_rows, table_comment
             from information_schema.tables
            where table_schema = ?
            order by table_name`,
          [node.path.database],
        )

        return rows.map((row) => {
          const name = row.table_name ?? row.TABLE_NAME
          const type = row.table_type ?? row.TABLE_TYPE
          const estimate = Number(row.table_rows ?? row.TABLE_ROWS ?? 0)

          return {
            kind: type === 'VIEW' ? 'view' : 'table',
            name,
            // InnoDB reports a sampled estimate here, never an exact count.
            detail: type === 'VIEW' ? undefined : `~${estimate.toLocaleString()} rows`,
            expandable: true,
            path: { ...node.path, table: name },
          }
        })
      }

      case 'table':
      case 'view': {
        const [rows] = await pool.query(
          `select column_name, column_type, is_nullable, column_key, column_default, extra
             from information_schema.columns
            where table_schema = ? and table_name = ?
            order by ordinal_position`,
          [node.path.database, node.path.table],
        )

        return rows.map((row) => {
          const nullable = (row.is_nullable ?? row.IS_NULLABLE) === 'YES'

          return {
            kind: 'column',
            name: row.column_name ?? row.COLUMN_NAME,
            detail: `${row.column_type ?? row.COLUMN_TYPE}${nullable ? '' : ' not null'}`,
            primaryKey: (row.column_key ?? row.COLUMN_KEY) === 'PRI',
            nullable,
            declaredType: row.column_type ?? row.COLUMN_TYPE,
            enumValues: enumValues(row.column_type ?? row.COLUMN_TYPE),
            // An AUTO_INCREMENT column has no default in the catalog but is
            // filled in by the server all the same, which is what a new row
            // needs to know.
            hasDefault: (row.column_default ?? row.COLUMN_DEFAULT) !== null
              || String(row.extra ?? row.EXTRA ?? '').includes('auto_increment'),
            expandable: false,
            path: { ...node.path, column: row.column_name ?? row.COLUMN_NAME },
          }
        })
      }

      default:
        return []
    }
  }

  /**
   * Reads a whole database in two statements, for the editor's completions.
   *
   * Both are scoped to one schema, which is what keeps them off the whole-server
   * scan that an unqualified information_schema query degrades into. The aliases
   * are quoted because the shape they build is fixed, while whether MySQL names
   * its own catalog columns in upper or lower case is not.
   */
  async function schemaSnapshot({ database } = {}) {
    const target = database ?? profile.database

    // Nothing is reachable without one: MySQL has no level above its schemas,
    // so an unpointed tab has no database to describe.
    if (!target) return buildSnapshot({ database: '', columns: [] })

    const [[columns], [relations], [stats]] = await Promise.all([
      // Left joined so a table with no readable columns still contributes its
      // name, and ordered by table so the cap cuts whole tables off the end.
      pool.query(
        `select t.table_name as \`table\`,
                case when t.table_type = 'VIEW' then 'view' else 'table' end as \`kind\`,
                c.column_name as \`column\`,
                c.column_type as \`type\`,
                c.is_nullable = 'YES' as \`nullable\`,
                c.column_key = 'PRI' as \`primaryKey\`
           from information_schema.tables t
           left join information_schema.columns c
                  on c.table_schema = t.table_schema
                 and c.table_name = t.table_name
          where t.table_schema = ?
          order by t.table_name, c.ordinal_position
          limit ?`,
        [target, SCHEMA_COLUMN_LIMIT + 1],
      ),

      // Only keys that stay inside this schema: a join the editor offers has to
      // be one the tab, which reaches a single database, could actually run.
      pool.query(
        `select concat(k.table_name, '.', k.constraint_name) as \`key\`,
                k.table_name as \`table\`,
                k.column_name as \`column\`,
                k.referenced_table_name as \`refTable\`,
                k.referenced_column_name as \`refColumn\`
           from information_schema.key_column_usage k
          where k.table_schema = ?
            and k.referenced_table_schema = k.table_schema
            and k.referenced_table_name is not null
          order by k.table_name, k.constraint_name, k.ordinal_position`,
        [target],
      ),

      // Read separately from the column query above rather than joined onto
      // it: these are one value per table, and the cap that trims the column
      // rows would otherwise take a table's size off with its last column.
      pool.query(
        `select t.table_name as \`table\`,
                t.table_rows as \`rowEstimate\`,
                t.data_length + t.index_length as \`bytes\`,
                t.table_comment as \`comment\`
           from information_schema.tables t
          where t.table_schema = ?
            and t.table_type <> 'VIEW'`,
        [target],
      ),
    ])

    const truncated = columns.length > SCHEMA_COLUMN_LIMIT

    return buildSnapshot({
      database: target,
      // MySQL's one level is the database, so a table is addressed without a
      // schema even though the catalog calls the same thing `table_schema`.
      pathOf: (_schema, table) => ({ database: target, table }),
      columns: truncated ? columns.slice(0, SCHEMA_COLUMN_LIMIT) : columns,
      // InnoDB samples a few index pages for table_rows, so it is an estimate
      // and can be out by a wide margin on a small table; MyISAM's is exact.
      stats: stats.map((row) => ({
        table: row.table ?? row.TABLE_NAME,
        rowEstimate: Number(row.rowEstimate ?? row.ROW_ESTIMATE ?? row.TABLE_ROWS ?? NaN),
        bytes: Number(row.bytes ?? row.BYTES ?? NaN),
        comment: row.comment ?? row.COMMENT ?? row.TABLE_COMMENT,
      })),
      relations: groupRelations(relations),
      truncated,
    })
  }

  /**
   * A table's indexes and its CREATE statement, both as the server keeps them.
   *
   * SHOW INDEX reports one row per column of every index, so the rows are
   * grouped back into indexes here; SHOW CREATE TABLE hands the definition back
   * verbatim, under a column named for what the object is.
   */
  async function structure(node) {
    const target = `${quoteIdent(node.path.database)}.${quoteIdent(node.path.table)}`

    const [[indexRows], [createRows]] = await Promise.all([
      // A view has no indexes, and the statement is only meant for tables.
      node.kind === 'view' ? [[]] : pool.query(`show index from ${target}`),
      pool.query(`show create table ${target}`),
    ])

    const byName = new Map()

    for (const row of indexRows) {
      const name = field(row, 'Key_name')

      if (!byName.has(name)) {
        byName.set(name, {
          name,
          parts: [],
          unique: Number(field(row, 'Non_unique')) === 0,
          primary: name === 'PRIMARY',
        })
      }

      byName.get(name).parts.push({
        seq: Number(field(row, 'Seq_in_index')),
        // A functional index has no column name; the expression is shown instead.
        column: field(row, 'Column_name') ?? field(row, 'Expression') ?? '',
      })
    }

    const indexes = [...byName.values()].map(({ parts, ...index }) => ({
      ...index,
      columns: parts.sort((a, b) => a.seq - b.seq).map((part) => part.column),
    }))

    const created = createRows[0]?.['Create Table'] ?? createRows[0]?.['Create View'] ?? null

    return { indexes, ddl: created == null ? null : `${created};` }
  }

  /**
   * The routines and triggers of one database, for the explorer's object
   * lists. Scoped to the one schema like schemaSnapshot, and for the same
   * reason: unqualified, information_schema reads the whole server.
   *
   * The aliases are quoted so the shape is ours, and the rows are still read
   * through `field`: whether MySQL honours an alias's case is not promised
   * across versions and MariaDB.
   */
  async function objects({ database } = {}) {
    const target = database ?? profile.database

    // Nothing is reachable without one: MySQL has no level above its schemas,
    // so an unpointed tab has no database to describe.
    if (!target) return { routines: [], sequences: [], triggers: [] }

    const [[routineRows], [parameterRows], [triggerRows]] = await Promise.all([
      // ROUTINE_DEFINITION is the body alone — what sits between BEGIN and
      // END, or the single statement — not a CREATE. The full statement
      // would take a SHOW CREATE per routine; the body is enough to read.
      pool.query(
        `select routine_name as \`name\`,
                routine_type as \`type\`,
                dtd_identifier as \`returns\`,
                routine_definition as \`definition\`
           from information_schema.routines
          where routine_schema = ?
          order by routine_name`,
        [target],
      ),

      pool.query(
        `select specific_name as \`specific_name\`,
                ordinal_position as \`ordinal_position\`,
                parameter_mode as \`parameter_mode\`,
                parameter_name as \`parameter_name\`,
                dtd_identifier as \`dtd_type\`
           from information_schema.parameters
          where specific_schema = ?
          order by specific_name, ordinal_position`,
        [target],
      ),

      pool.query(
        `select trigger_name as \`name\`,
                event_object_table as \`table\`,
                action_timing as \`timing\`,
                event_manipulation as \`event\`,
                action_statement as \`definition\`
           from information_schema.triggers
          where trigger_schema = ?
          order by trigger_name`,
        [target],
      ),
    ])

    const args = groupParameters(parameterRows)

    return {
      routines: routineRows.map((row) => {
        const name = field(row, 'name')
        const isFunction = String(field(row, 'type')).toUpperCase() === 'FUNCTION'

        return {
          schema: '',
          name,
          kind: isFunction ? 'function' : 'procedure',
          args: args.get(name) ?? '',
          // A procedure returns nothing; the catalog leaves the column null.
          returns: isFunction ? (field(row, 'returns') ?? undefined) : undefined,
          language: 'sql',
          definition: field(row, 'definition') ?? undefined,
        }
      }),
      // MySQL has no sequences: AUTO_INCREMENT is a column property, not an
      // object. MariaDB does have them, but it speaks through this same driver
      // and they would need a MariaDB-only catalog read, so it is not attempted.
      sequences: [],
      triggers: triggerRows.map((row) => ({
        schema: '',
        name: field(row, 'name'),
        table: field(row, 'table'),
        when: `${field(row, 'timing')} ${field(row, 'event')}`.toLowerCase(),
        definition: field(row, 'definition') ?? undefined,
      })),
    }
  }

  function countStatement(node, { where }) {
    return `select count(*) from ${quoteIdent(node.path.database)}.${quoteIdent(node.path.table)}`
      + (where ? `\nwhere ${where}` : '')
      + ';'
  }

  function previewStatement(node, { limit, offset, order, where }) {
    // MySQL has no `nulls last` and sorts NULL below every value, so the
    // leading `is null` term is what sinks them in both directions — the same
    // shape the other drivers get from the keyword.
    const column = order ? quoteIdent(order.column) : ''
    const orderBy = order ? `\norder by ${column} is null, ${column} ${order.dir}` : ''

    // MySQL has no bare OFFSET: it is a second argument to LIMIT, so a page
    // beyond the first only exists when a limit was asked for.
    const window = limit ? `\nlimit ${limit}${offset ? ` offset ${offset}` : ''}` : ''

    return `select *\nfrom ${quoteIdent(node.path.database)}.${quoteIdent(node.path.table)}`
      + (where ? `\nwhere ${where}` : '')
      + orderBy
      + window
      + ';'
  }

  return {
    serverVersion: `MySQL ${versionRows[0].version}`,
    defaultDatabase: profile.database || null,
    query,
    beginTransaction,
    listChildren,
    schemaSnapshot,
    previewStatement,
    countStatement,
    structure,
    objects,
    applyChanges,
    importRows,
    ddlStatements: (node, operation) => buildDdl('mysql', quoteIdent, node, operation),
    close: () => pool.end(),
  }
}

export default {
  meta: {
    id: 'mysql',
    label: 'MySQL',
    target: 'server',
    defaultPort: 3306,
    badge: 'MY',
    color: '#e48e00',
    levels: ['database'],
    quote: '`',
    engine: 'mysql',
    capabilities: { alterColumn: true, comments: true, dump: 'mysqldump', restore: 'mysql' },
  },
  open,
}
