import { access, constants } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

import { buildStatements, literalFactory } from './changes.js'
import { buildDdl } from './ddl.js'

// Packaged, this module is read from inside app.asar, but a worker has to be
// started from a real file. forge.config.js unpacks the driver directory for
// exactly this reason; unpackaged, the replace is a no-op.
const WORKER_PATH = path
  .join(path.dirname(fileURLToPath(import.meta.url)), 'sqlite-worker.js')
  .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)

/**
 * How long a cooperative cancel is given to take effect before the thread is
 * killed outright. A statement already producing rows notices the flag within a
 * few hundred of them; one still planning or sorting never will.
 */
const CANCEL_GRACE_MS = 750

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`
}

/**
 * SQLite needs no native module — `node:sqlite` ships with the runtime — but it
 * is synchronous, so every query runs on a worker thread. See sqlite-worker.js
 * for how a blocked thread stays cancellable.
 */
async function open(profile) {
  const file = profile.file
  if (!file) throw new Error('SQLite connections need a database file.')

  // A clearer failure than the driver's generic "unable to open database file".
  try {
    await access(file, constants.R_OK)
  }
  catch (error) {
    throw new Error(
      error.code === 'ENOENT' ? `No database file at ${file}.` : `Cannot read ${file}: ${error.code}.`,
      { cause: error },
    )
  }

  // Int32Array over a SharedArrayBuffer: the only channel a blocked worker can
  // still observe. Index 0 is the cancel flag for the request in flight.
  const cancelBuffer = new SharedArrayBuffer(4)
  const cancelFlag = new Int32Array(cancelBuffer)

  let serverVersion

  function cancelledError() {
    return Object.assign(new Error('Query cancelled.'), { cancelled: true })
  }

  /**
   * Each thread owns its own request table. They are per-worker rather than
   * shared because a replaced thread must fail only its own callers, never the
   * ones already talking to its successor.
   */
  function spawn() {
    return new Promise((resolve, reject) => {
      const worker = new Worker(WORKER_PATH, { workerData: { file, cancelBuffer } })
      const handle = { worker, inFlight: new Map(), nextId: 0 }

      worker.on('message', (message) => {
        if (message.type === 'ready') {
          serverVersion = `SQLite ${message.version}`
          resolve(handle)
          return
        }

        const pending = handle.inFlight.get(message.id)
        if (!pending) return

        // A batch of a streamed result, sent while the request is still
        // running; the reply that settles it comes later.
        if (message.type === 'rows') {
          pending.onRows?.(message.rows, message.columns)
          return
        }

        handle.inFlight.delete(message.id)

        if (message.ok) {
          pending.resolve(message.data)
          return
        }

        const error = message.cancelled ? cancelledError() : new Error(message.error.message)
        if (!message.cancelled) Object.assign(error, message.error)
        pending.reject(error)
      })

      worker.on('error', reject)

      worker.on('exit', () => {
        for (const pending of handle.inFlight.values()) pending.reject(cancelledError())
        handle.inFlight.clear()
      })
    })
  }

  // Every request waits on this, so swapping threads is invisible to callers.
  let current = spawn()
  await current

  /**
   * Hands the connection a fresh thread and lets the old one go.
   *
   * `terminate()` is not awaited on purpose: a thread blocked inside SQLite's
   * native code cannot be stopped until the statement it is running finishes,
   * and chaining the new thread behind that would make the caller wait exactly
   * as long as it was trying not to.
   */
  function replaceWorker() {
    const dying = current
    current = spawn()
    dying.then((handle) => handle.worker.terminate()).catch(() => {})
  }

  /**
   * `onRows`, when given, receives the interim batches a streamed query
   * posts; the request's own reply still settles the promise. A request that
   * was given up on — cancelled past its grace — is forgotten before its
   * thread is, so a batch that arrives after that finds nobody to hand it to.
   */
  async function send(type, payload, signal, onRows) {
    const handle = await current
    const id = handle.nextId++

    const settled = new Promise((resolve, reject) => {
      handle.inFlight.set(id, { resolve, reject, onRows })
      handle.worker.postMessage({ ...payload, type, id })
    })

    if (!signal) return settled

    let graceTimer

    const onAbort = () => {
      Atomics.store(cancelFlag, 0, 1)

      // A statement already emitting rows sees the flag within a few hundred of
      // them. One still planning, sorting or aggregating never reaches the row
      // loop, so after a grace period the caller is released and the thread is
      // abandoned rather than waited on.
      graceTimer = setTimeout(() => {
        const pending = handle.inFlight.get(id)
        if (!pending) return

        handle.inFlight.delete(id)
        pending.reject(cancelledError())
        replaceWorker()
      }, CANCEL_GRACE_MS)
    }

    signal.addEventListener('abort', onAbort, { once: true })

    return settled.finally(() => {
      clearTimeout(graceTimer)
      signal.removeEventListener('abort', onAbort)
      Atomics.store(cancelFlag, 0, 0)
    })
  }

  /** The file is one connection, so a transaction's statement is any statement. */
  function query(sql, { maxRows, signal, onRows, binary }) {
    return send('query', { sql, maxRows, binary, stream: Boolean(onRows) }, signal, onRows)
  }

  return {
    get serverVersion() {
      return serverVersion
    },
    defaultDatabase: 'main',
    query,

    /**
     * Opens a transaction on the worker and keeps it open across statements.
     *
     * SQLite is one connection, so there is nothing to pin: the transaction
     * is simply left open on the thread, and every statement sent through it
     * — or, for that matter, through `query` by another tab on this file —
     * runs inside it until commit or rollback. A cancel that outlives its
     * grace period replaces the thread, which takes the open transaction
     * with it; the next commit reports that there is none to commit.
     */
    async beginTransaction() {
      await send('exec', { sql: 'begin' })

      return {
        query,
        commit: async () => { await send('exec', { sql: 'commit' }) },
        rollback: async () => { await send('exec', { sql: 'rollback' }) },
      }
    },
    listChildren: (node) => send('children', { node }),
    schemaSnapshot: () => send('schema', {}),
    structure: (node) => send('structure', { node }),
    // The file is one database, so the scope has nothing to choose.
    objects: () => send('objects', {}),

    /**
     * Applies a batch of staged row changes in one transaction on the worker.
     *
     * Values are bound, never built into the statement. node:sqlite binds null,
     * numbers, bigints, strings and buffers — a boolean has to become the 1 or 0
     * SQLite stores for it anyway.
     */
    async applyChanges(node, changes, { dryRun } = {}) {
      const built = buildStatements(changes, {
        table: quoteIdent(node.path.table),
        quoteIdent,
        placeholder: () => '?',
        literal: literalFactory(),
      })

      const script = built.map(({ sql, preview }) => ({ sql, preview }))
      if (dryRun) return { statements: script, applied: 0 }

      const statements = built.map(({ sql, params }) => ({
        sql,
        params: params.map((value) => (typeof value === 'boolean' ? Number(value) : value)),
      }))

      const { applied } = await send('batch', { statements })
      return { statements: script, applied }
    },
    /**
     * Loads batches of rows into the table, in one transaction on the
     * worker. The transaction spans several messages — begin, one insert
     * per batch, commit — which is safe because the file is one connection
     * and the messages are handled in order.
     */
    async importRows(node, { columns, batches, truncate, signal }) {
      const table = quoteIdent(node.path.table)
      const sql = `insert into ${table} (${columns.map(quoteIdent).join(', ')}) values (${columns.map(() => '?').join(', ')})`
      let inserted = 0

      await send('exec', { sql: 'begin' })

      try {
        if (truncate) await send('exec', { sql: `delete from ${table}` })

        for await (const batch of batches) {
          if (signal?.aborted) throw cancelledError()
          const { changes } = await send('insert', { sql, rows: batch })
          inserted += changes
        }

        await send('exec', { sql: 'commit' })
      }
      catch (error) {
        await send('exec', { sql: 'rollback' }).catch(() => {})
        throw error
      }

      return { inserted }
    },
    ddlStatements: (node, operation) => buildDdl('sqlite', quoteIdent, node, operation),
    // Pure string building: no reason to make the caller wait on the thread.
    previewStatement: (node, { limit, offset, order, where }) =>
      `select *\nfrom ${quoteIdent(node.path.table)}`
      + (where ? `\nwhere ${where}` : '')
      // `nulls last` wants SQLite 3.30; node:sqlite ships well past it. It
      // keeps a descending page from opening on rows with nothing in them.
      + (order ? `\norder by ${quoteIdent(order.column)} ${order.dir} nulls last` : '')
      // SQLite reads OFFSET only as part of a LIMIT, so a page past the first
      // exists only when the rows were capped in the first place.
      + (limit ? `\nlimit ${limit}${offset ? ` offset ${offset}` : ''}` : '')
      + ';',
    countStatement: (node, { where }) =>
      `select count(*) from ${quoteIdent(node.path.table)}`
      + (where ? `\nwhere ${where}` : '')
      + ';',
    close: async () => {
      const handle = await current
      handle.worker.postMessage({ type: 'close' })
      await handle.worker.terminate()
    },
  }
}

export default {
  meta: {
    id: 'sqlite',
    label: 'SQLite',
    target: 'file',
    levels: [],
    quote: '"',
    badge: 'LT',
    color: '#7aa6c2',
    engine: 'sqlite',
    capabilities: { alterColumn: false, comments: false, dump: 'sqlite3', restore: 'sqlite3' },
  },
  open,
}
