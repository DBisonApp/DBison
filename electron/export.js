import { createWriteStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { once } from 'node:events'

import { csvLine, quoteIdentifier, sqlLiteral } from './csv.js'

/** Rows per INSERT in a SQL export: long enough to load fast, short enough to read. */
const SQL_ROWS_PER_INSERT = 100
/** How often the renderer hears about progress, at most. */
const PROGRESS_EVERY_MS = 200

const FILTERS = {
  csv: [{ name: 'CSV', extensions: ['csv'] }],
  tsv: [{ name: 'TSV', extensions: ['tsv', 'txt'] }],
  json: [{ name: 'JSON', extensions: ['json'] }],
  sql: [{ name: 'SQL', extensions: ['sql'] }],
}

export function exportFilters(format) {
  return FILTERS[format] ?? [{ name: 'All files', extensions: ['*'] }]
}

/**
 * Turns a result's rows into the lines of one file format, a batch at a
 * time. Each writer is given the columns once and then rows; `end` closes
 * whatever the format leaves open.
 */
function createWriter(request) {
  const format = request.format

  if (format === 'csv' || format === 'tsv') {
    const options = {
      delimiter: format === 'tsv' ? '\t' : (request.delimiter || ','),
      nullText: request.nullText ?? '',
    }
    const header = request.header !== false

    return {
      start: (columns) => (header ? csvLine(columns.map((column) => column.name), options) : ''),
      rows: (rows) => rows.map((row) => csvLine(row, options)).join(''),
      end: () => '',
    }
  }

  if (format === 'json') {
    let names = []
    let first = true

    return {
      start: (columns) => {
        names = columns.map((column) => column.name)
        return '[\n'
      },
      rows: (rows) => {
        let out = ''
        for (const row of rows) {
          const object = {}
          names.forEach((name, index) => { object[name] = row[index] ?? null })
          out += `${first ? '' : ',\n'}  ${JSON.stringify(object)}`
          first = false
        }
        return out
      },
      end: () => '\n]\n',
    }
  }

  if (format === 'sql') {
    const quote = request.quote ?? '"'
    const table = request.table || quoteIdentifier('table_name', quote)
    const literal = (value) => sqlLiteral(value, { escapeBackslashes: Boolean(request.escapeBackslashes) })
    let columnList = ''

    return {
      start: (columns) => {
        columnList = columns.map((column) => quoteIdentifier(column.name, quote)).join(', ')
        return ''
      },
      rows: (rows) => {
        let out = ''
        for (let at = 0; at < rows.length; at += SQL_ROWS_PER_INSERT) {
          const slice = rows.slice(at, at + SQL_ROWS_PER_INSERT)
          const values = slice.map((row) => `  (${row.map(literal).join(', ')})`).join(',\n')
          out += `insert into ${table} (${columnList})\nvalues\n${values};\n`
        }
        return out
      },
      end: () => '',
    }
  }

  throw new Error(`Unknown export format "${format}".`)
}

/**
 * Runs a statement again and writes every row it produces to a file.
 *
 * The grid holds at most a few thousand rows; an export is for the rest of
 * them. The statement is streamed with no cap, each batch is written as it
 * arrives, and a cancel through the ordinary query path stops the server and
 * removes the half-written file. The writer's own buffering is the only
 * memory an export costs.
 *
 * @param {import('./connection-manager.js').ConnectionManager} manager
 * @param {string} id  The connection.
 * @param {object} request  An `ExportRequest`; see shared/db-types.ts.
 * @param {{ path: string, onProgress?: (rows: number, bytes: number) => void }} options
 */
export async function exportToFile(manager, id, request, { path, onProgress }) {
  const writer = createWriter(request)
  const stream = createWriteStream(path, { encoding: 'utf8' })
  const started = performance.now()

  let rows = 0
  let bytes = 0
  let lastReport = 0
  let failed = null

  // Writes are chained rather than awaited inside the row callback, which
  // the drivers call synchronously; the chain is what `end` waits on.
  let chain = Promise.resolve()

  function write(text) {
    if (!text) return
    bytes += Buffer.byteLength(text)
    chain = chain.then(async () => {
      if (failed) return
      if (!stream.write(text)) await once(stream, 'drain')
    })
  }

  stream.on('error', (error) => { failed = error })

  const onRows = (batch, columns) => {
    if (columns) write(writer.start(columns))
    rows += batch.length
    write(writer.rows(batch))

    const now = performance.now()
    if (onProgress && now - lastReport > PROGRESS_EVERY_MS) {
      lastReport = now
      onProgress(rows, bytes)
    }
  }

  try {
    const result = await manager.query(id, request.sql, {
      queryId: request.jobId,
      maxRows: Infinity,
      database: request.database,
      schema: request.schema,
      onRows,
      binary: 'base64',
    })

    // A statement that produced columns but no rows never called `onRows`;
    // the header still belongs in the file.
    if (rows === 0 && result.columns?.length) write(writer.start(result.columns))
    write(writer.end())

    await chain
    if (failed) throw failed

    stream.end()
    await once(stream, 'finish')
  }
  catch (error) {
    stream.destroy()
    await unlink(path).catch(() => {})
    throw error
  }

  onProgress?.(rows, bytes)

  return { saved: true, path, rows, bytes, durationMs: Math.round(performance.now() - started) }
}
