/**
 * Driver rows travel to the renderer over Electron's structured clone, which
 * rejects some of what database clients hand back (class instances, cyclic
 * objects) and passes others through in shapes a grid cannot render.
 *
 * Everything is flattened here, once, so the renderer never has to know which
 * driver produced a cell.
 */

const MAX_INLINE_BINARY = 24

/**
 * How binary values travel, per query. The digest is a short hex prefix and
 * the size, which is all a grid cell can show; base64 is the whole value, for
 * a viewer that asked for one cell and means to decode it.
 *
 * @typedef {object} ValueOptions
 * @property {'digest' | 'base64'} [binary]
 */

/**
 * @param {unknown} value
 * @param {ValueOptions} [options]
 * @returns {string | number | boolean | null}
 */
export function normalizeValue(value, options = {}) {
  if (value === null || value === undefined) return null

  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return value
    case 'bigint':
      // Stay a number while that is lossless, so the grid can right-align it;
      // past the safe range only the string keeps every digit.
      return value >= -9007199254740991n && value <= 9007199254740991n
        ? Number(value)
        : value.toString()
    default:
      break
  }

  if (value instanceof Date) return value.toISOString()

  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    if (options.binary === 'base64') return Buffer.from(value).toString('base64')

    const head = Buffer.from(value.subarray(0, MAX_INLINE_BINARY)).toString('hex')
    return value.length > MAX_INLINE_BINARY
      ? `0x${head}… (${value.length} bytes)`
      : `0x${head}`
  }

  // Arrays, json/jsonb, postgres composite types, geometry, ...
  try {
    return JSON.stringify(value)
  }
  catch {
    return String(value)
  }
}

/**
 * @param {unknown[]} row
 * @param {ValueOptions} [options]  Absent, binary values become digests, as they always have.
 */
export function normalizeRow(row, options = {}) {
  return row.map((value) => normalizeValue(value, options))
}

/**
 * The first batch of a streamed result is small so the first screen paints
 * before the server has finished; every batch after it is a round trip's
 * worth. The renderer draws whatever it has, so the sizes are a trade
 * between paint latency and IPC overhead rather than anything it depends on.
 */
export const FIRST_BATCH_ROWS = 50
export const BATCH_ROWS = 500

/**
 * Collects a statement's columns and rows, normalized, for the result the
 * driver returns.
 *
 * With `onRows` the rows are not collected at all: they go out in batches as
 * they are pushed, the first batch carrying the columns because a grid cannot
 * draw rows without headers and the result they would otherwise arrive on
 * comes last. `finish` then reports the count in the rows' place — the shape
 * `QueryResult` describes as `streamed` in shared/db-types.ts. Without
 * `onRows` the rows are kept and returned whole, exactly as they always were.
 * Every driver runs its rows through one of these so the two shapes cannot
 * drift apart.
 *
 * `columnsOf` is the driver's own reading of what its engine describes a
 * result with; `describe` hands that description in, before the first row.
 *
 * @template Field
 * @param {{
 *   onRows?: (rows: unknown[][], columns?: { name: string, type: string }[]) => void,
 *   binary?: 'digest' | 'base64',
 *   columnsOf: (fields: Field[]) => { name: string, type: string }[],
 * }} options
 */
export function createRowSink({ onRows, binary, columnsOf }) {
  const valueOptions = { binary }
  const rows = []
  let columns = []
  let batch = []
  let sent = 0

  function flush() {
    if (!batch.length) return

    const out = batch
    batch = []
    // Only the first batch names the columns; the renderer keeps them.
    const first = sent === 0
    sent += out.length
    onRows(out, first ? columns : undefined)
  }

  return {
    /** Rows accepted so far, sent or not: what the display cap is measured against. */
    get count() {
      return onRows ? sent + batch.length : rows.length
    },

    /** @param {Field[]} fields  What the engine said the result's columns are. */
    describe(fields) {
      columns = columnsOf(fields ?? [])
    },

    push(row) {
      const normalized = normalizeRow(row, valueOptions)

      if (!onRows) {
        rows.push(normalized)
        return
      }

      batch.push(normalized)
      if (batch.length >= (sent ? BATCH_ROWS : FIRST_BATCH_ROWS)) flush()
    },

    /**
     * Sends what is buffered before its batch is full. A driver that reads
     * from the server in batches of its own calls this after each one, so a
     * pause between server replies never leaves rows sitting here.
     */
    flush() {
      if (onRows) flush()
    },

    /** Sends the last batch and returns the column and row fields of the result. */
    finish() {
      if (onRows) flush()

      return onRows
        ? { columns, rows: [], rowCount: sent, streamed: true }
        : { columns, rows, rowCount: rows.length }
    },
  }
}

/**
 * Errors cross IPC as plain objects; Error instances lose everything but the
 * message. Driver-specific fields (`code`, `position`, ...) are what make a
 * SQL error actionable, so they are kept.
 */
export function serializeError(error) {
  return {
    message: error?.message ? String(error.message) : String(error),
    code: error?.code ? String(error.code) : undefined,
    // A deliberate stop, which the renderer reports as an outcome rather than
    // as a failure. Without it here, every cancel arrives looking like one.
    cancelled: error?.cancelled ? true : undefined,
    // The connection itself went, not the statement; see `isConnectionLost`.
    // The renderer offers a reconnect for these and nothing else.
    lost: error?.lost ? true : undefined,
    // Where the fault is in the statement, normalized by `explainQueryError`:
    // a 1-based character offset, how far it runs, and the same point as a
    // line and column so the editor can put a marker on it.
    position: error?.position ? Number(error.position) : undefined,
    length: error?.length ? Number(error.length) : undefined,
    line: error?.line ? Number(error.line) : undefined,
    column: error?.column ? Number(error.column) : undefined,
    detail: error?.detail ? String(error.detail) : undefined,
    hint: error?.hint ? String(error.hint) : undefined,
    // The engine's own wording, kept when the message above was rewritten.
    raw: error?.raw ? String(error.raw) : undefined,
  }
}
