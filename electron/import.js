import { stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'

import { createCsvParser, guessDelimiter, looksLikeHeader, readCsvRows } from './csv.js'

/** Rows shown before the mapping is decided. */
const PREVIEW_ROWS = 50
/** Bytes read to guess the delimiter and fill the preview. */
const PREVIEW_BYTES = 256 * 1024

const DEFAULT_BATCH = 500
const MAX_BATCH = 5_000

/**
 * Reads the head of a delimited file: its columns, a few rows, and the
 * delimiter it appears to use. Only the first chunk is read — a preview of
 * a large export must not cost the export.
 */
export async function previewFile(path, { delimiter, hasHeader } = {}) {
  const info = await stat(path)

  const head = await new Promise((resolve, reject) => {
    const chunks = []
    let seen = 0
    const stream = createReadStream(path, { encoding: 'utf8', start: 0, end: PREVIEW_BYTES - 1 })
    stream.on('data', (chunk) => {
      chunks.push(chunk)
      seen += chunk.length
    })
    stream.on('end', () => resolve(chunks.join('')))
    stream.on('error', reject)
    stream.on('close', () => { if (!seen && !chunks.length) resolve('') })
  })

  const used = delimiter || guessDelimiter(head)
  const parser = createCsvParser({ delimiter: used })
  const rows = parser.write(head)
  // The head may have been cut mid-row; the parser's tail is only trusted
  // when the whole file fit in the chunk.
  if (info.size <= PREVIEW_BYTES) rows.push(...parser.end())
  else rows.pop()

  const headed = hasHeader ?? looksLikeHeader(rows)
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0)

  const columns = headed && rows[0]
    ? rows[0].map((name, index) => name.trim() || `column ${index + 1}`)
    : Array.from({ length: width }, (_, index) => `column ${index + 1}`)

  return {
    path,
    bytes: info.size,
    delimiter: used,
    hasHeader: headed,
    columns,
    rows: (headed ? rows.slice(1) : rows).slice(0, PREVIEW_ROWS),
  }
}

/**
 * How one text field becomes a value the driver can bind. Everything stays
 * a string — the server casts it to the column's type, and says so when it
 * cannot — except the spellings the user said mean NULL.
 */
function createConverter({ nullText, emptyIsNull, trim }) {
  const nullMark = typeof nullText === 'string' && nullText !== '' ? nullText : null

  return (cell) => {
    if (cell === undefined) return null
    const text = trim ? cell.trim() : cell
    if (nullMark !== null && text === nullMark) return null
    if (emptyIsNull && text === '') return null
    return text
  }
}

/**
 * The file's rows, mapped to the table's columns and grouped into batches.
 * Rows shorter than the mapping needs are padded with NULL rather than
 * refused: a trailing empty field is the commonest thing a spreadsheet drops.
 */
async function* batchesOf(request, signal) {
  const convert = createConverter(request)
  const sources = request.mapping.map((entry) => entry.source)
  const size = Math.min(MAX_BATCH, Math.max(1, Math.floor(Number(request.batchSize) || DEFAULT_BATCH)))

  let batch = []
  let skippedHeader = !request.hasHeader

  for await (const row of readCsvRows(request.path, { delimiter: request.delimiter, signal })) {
    if (!skippedHeader) {
      skippedHeader = true
      continue
    }

    batch.push(sources.map((source) => convert(row[source])))

    if (batch.length >= size) {
      yield batch
      batch = []
    }
  }

  if (batch.length) yield batch
}

/**
 * Loads a file into a table, in one transaction.
 *
 * The driver owns the statement and the transaction; this owns the file,
 * the mapping and the batching, so the three engines share one reading of
 * what a CSV means. Nothing is written if anything fails.
 *
 * @param {object} session  The driver session, which must implement `importRows`.
 * @param {object} node  The table.
 * @param {object} request  An `ImportRequest`; see shared/db-types.ts.
 * @param {{ signal?: AbortSignal, onProgress?: (rows: number) => void }} options
 */
export async function importFile(session, node, request, { signal, onProgress } = {}) {
  if (!session.importRows) throw new Error('This driver cannot import files.')

  const mapping = (Array.isArray(request.mapping) ? request.mapping : [])
    .filter((entry) => Number.isInteger(entry?.source) && entry.source >= 0 && typeof entry?.column === 'string' && entry.column)

  if (!mapping.length) throw new Error('Map at least one file column to a table column.')

  const seen = new Set()
  for (const entry of mapping) {
    if (seen.has(entry.column)) throw new Error(`The column ${entry.column} is mapped twice.`)
    seen.add(entry.column)
  }

  const started = performance.now()
  let inserted = 0
  let lastReport = 0

  const outcome = await session.importRows(node, {
    columns: mapping.map((entry) => entry.column),
    truncate: Boolean(request.truncate),
    signal,
    batches: (async function* () {
      for await (const batch of batchesOf({ ...request, mapping }, signal)) {
        yield batch
        inserted += batch.length

        const now = performance.now()
        if (onProgress && now - lastReport > 200) {
          lastReport = now
          onProgress(inserted)
        }
      }
    })(),
  })

  onProgress?.(outcome?.inserted ?? inserted)

  return { inserted: outcome?.inserted ?? inserted, durationMs: Math.round(performance.now() - started) }
}
