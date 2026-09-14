import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'

import { nodeId } from '../shared/db-nodes.js'
import { getDriver } from './drivers/index.js'
import { mayWrite } from './drivers/statements.js'
import { serializeError } from './drivers/values.js'
import { importFile } from './import.js'
import { openTunnel } from './ssh-tunnel.js'

/** Display cap for a single result set; the driver reports what it truncated. */
export const DEFAULT_MAX_ROWS = 5_000

/**
 * Owns every live database session in the app.
 *
 * The renderer never holds a driver handle: it addresses connections by their
 * profile id and this class maps that to an open session, so a reloaded window
 * or a second window finds the same connections still open.
 */
export class ConnectionManager extends EventEmitter {
  #store
  /**
   * @type {Map<string, {
   *   status: string,
   *   session?: object,
   *   tunnel?: { localPort: number, close: () => Promise<void> },
   *   error?: object,
   * }>}
   */
  #live = new Map()
  /** @type {Map<string, Promise<object>>} in-flight connects, to dedupe clicks */
  #pending = new Map()
  /** @type {Map<string, { controller: AbortController, connectionId: string }>} */
  #running = new Map()
  /** @type {Map<string, Promise<object>>} in-flight schema reads, one per database */
  #snapshots = new Map()
  /**
   * Transactions held open by query tabs, each pinning one of its
   * connection's pooled connections until the tab commits or rolls back.
   * @type {Map<string, { connectionId: string, transaction: object }>}
   */
  #transactions = new Map()

  constructor(store) {
    super()
    this.#store = store
  }

  /** Everything the renderer needs to render a connection row. */
  stateOf(id) {
    const live = this.#live.get(id)

    return {
      id,
      status: live?.status ?? 'disconnected',
      error: live?.error,
      serverVersion: live?.session?.serverVersion,
    }
  }

  states() {
    const profiles = this.#store.list()
    return profiles.map((profile) => this.stateOf(profile.id))
  }

  #setStatus(id, status, error) {
    const live = this.#live.get(id) ?? {}
    this.#live.set(id, { ...live, status, error })
    this.emit('status', this.stateOf(id))
  }

  /**
   * Opens a driver session for a profile, through an SSH tunnel when the
   * profile asks for one.
   *
   * The driver is handed the tunnel's local end in place of the host and
   * port it would have dialled; those become the tunnel's far end instead.
   * A file-based driver never tunnels, whatever the profile says: there is
   * no socket to forward. A driver that fails to open takes the tunnel down
   * with it, so a wrong database password does not leave an SSH session
   * behind.
   */
  async #openSession(profile, secret, sshSecret) {
    const driver = getDriver(profile.driver)

    if (!profile.ssh?.enabled || driver.meta.target !== 'server') {
      return { session: await driver.open(profile, secret) }
    }

    // A tunnel with no database host means the database is on the SSH host
    // itself, which is the usual reason for a tunnel in the first place.
    const targetHost = profile.host || '127.0.0.1'
    const targetPort = profile.port ?? driver.meta.defaultPort

    const tunnel = await openTunnel({
      host: profile.ssh.host,
      port: profile.ssh.port ?? 22,
      username: profile.ssh.username,
      keyPath: profile.ssh.keyPath,
      secret: sshSecret,
      targetHost,
      targetPort,
    })

    try {
      const session = await driver.open({ ...profile, host: '127.0.0.1', port: tunnel.localPort }, secret)
      return { session, tunnel }
    }
    catch (error) {
      await tunnel.close().catch(() => {})

      // The driver explains its failure in terms of what it dialled, which
      // was the tunnel; the user needs to hear about the server behind it.
      if (typeof error?.message === 'string') {
        error.message = error.message.replaceAll(
          `127.0.0.1:${tunnel.localPort}`,
          `${targetHost}:${targetPort} (through SSH to ${profile.ssh.host})`,
        )
      }

      throw error
    }
  }

  /** Closes a session and the tunnel under it, in that order, swallowing both. */
  async #teardown(live) {
    // A driver that fails to close cleanly must not leave the UI stuck in
    // "connected"; the session is dropped either way.
    if (live?.session) await live.session.close().catch(() => {})
    if (live?.tunnel) await live.tunnel.close().catch(() => {})
  }

  async connect(id, passwordOverride) {
    const existing = this.#live.get(id)
    if (existing?.status === 'connected') return this.stateOf(id)

    // Two rapid clicks on the same connection must not open two pools.
    const inFlight = this.#pending.get(id)
    if (inFlight) return inFlight

    const attempt = (async () => {
      const profile = this.#store.get(id)
      if (!profile) throw new Error(`No connection profile with id "${id}".`)

      this.#setStatus(id, 'connecting')

      const secret = passwordOverride ?? this.#store.secretFor(id)
      const { session, tunnel } = await this.#openSession(profile, secret, this.#store.sshSecretFor(id))

      this.#live.set(id, { status: 'connected', session, tunnel })
      this.emit('status', this.stateOf(id))

      return this.stateOf(id)
    })()
      .catch((error) => {
        this.#setStatus(id, 'error', serializeError(error))
        throw error
      })
      .finally(() => this.#pending.delete(id))

    this.#pending.set(id, attempt)
    return attempt
  }

  async disconnect(id) {
    // Closing the pool out from under a running statement would surface as a
    // driver error rather than as the deliberate stop it is.
    this.#cancelAllFor(id)

    // Whatever a tab still had open is rolled back, and its connection given
    // back, before the pool is closed: a pool that waits for every checked-out
    // connection to return would otherwise wait for one that never will.
    await this.#rollbackAllFor(id)

    await this.#teardown(this.#live.get(id))

    this.#live.delete(id)
    this.#setStatus(id, 'disconnected')

    return this.stateOf(id)
  }

  /**
   * Dials a profile that may not be saved yet and closes it again, tunnel
   * included. A secret the dialog did not send is the stored one, when the
   * profile has been saved before: testing an edit to a name must not
   * demand the password again.
   */
  async test(profile) {
    const secret = profile.password ?? (profile.id ? this.#store.secretFor(profile.id) : undefined)
    const sshSecret = profile.sshPassword || (profile.id ? this.#store.sshSecretFor(profile.id) : undefined)

    const opened = await this.#openSession(profile, secret, sshSecret)

    try {
      return { ok: true, serverVersion: opened.session.serverVersion }
    }
    finally {
      await this.#teardown(opened)
    }
  }

  #sessionFor(id) {
    const session = this.#live.get(id)?.session
    if (!session) throw new Error('That connection is not open. Connect to it first.')
    return session
  }

  /**
   * The read-only guard, enforced where it cannot be skipped.
   *
   * The renderer asks before a write on a connection marked read-only and
   * sends `allowWrite` once the user has said yes. Without that word a
   * statement that may write is refused here: the mark has to hold against
   * a renderer bug, a stale tab or a paste that went to the wrong window,
   * not only against the dialog being dismissed.
   */
  #assertWritable(id, sql, allowWrite) {
    if (allowWrite) return

    const profile = this.#store.get(id)
    if (!profile?.readOnly || !mayWrite(sql)) return

    throw Object.assign(
      new Error(`${profile.name} is marked read-only. Confirm the write in the app to run it.`),
      { code: 'READ_ONLY' },
    )
  }

  /**
   * How a command-line tool should reach a connection: the tunnel's local
   * end when there is one, the profile's own host and port otherwise.
   */
  dialInfo(id) {
    const profile = this.#store.get(id)
    if (!profile) throw new Error(`No connection profile with id "${id}".`)

    const driver = getDriver(profile.driver)
    const live = this.#live.get(id)

    if (profile.ssh?.enabled && driver.meta.target === 'server' && !live?.tunnel) {
      throw new Error('Connect first: the tool reaches this server through the connection\'s SSH tunnel.')
    }

    const dial = live?.tunnel
      ? { host: '127.0.0.1', port: live.tunnel.localPort }
      : { host: profile.host || '127.0.0.1', port: profile.port ?? driver.meta.defaultPort }

    return { profile, dial, secret: this.#store.secretFor(id), engine: driver.meta.engine, meta: driver.meta }
  }

  /**
   * The transaction a statement asked to join. An id nobody holds any more
   * — its connection was closed, which rolled it back — is refused rather
   * than quietly run outside the transaction the tab believes it is in.
   */
  #transactionFor(transactionId, connectionId) {
    const open = this.#transactions.get(transactionId)
    if (!open) throw new Error('That transaction is no longer open.')
    if (open.connectionId !== connectionId) throw new Error('That transaction belongs to another connection.')
    return open.transaction
  }

  /**
   * The renderer supplies `queryId` so it can cancel a statement before the
   * result — or even the acknowledgement — has come back to it.
   *
   * `onRows`, when given, receives the rows in batches as the driver reads
   * them, and the result comes back with `rows: []` and `streamed: true`;
   * ipc.js builds it from the `stream` option so the batches reach the
   * window that asked. `binary` says how binary values travel; see
   * values.js.
   */
  async query(id, sql, options = {}) {
    const controller = new AbortController()
    const queryId = options.queryId
    const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS
    const onRows = typeof options.onRows === 'function' ? options.onRows : undefined
    const binary = options.binary === 'base64' ? 'base64' : 'digest'

    this.#assertWritable(id, sql, options.allowWrite)

    if (queryId) this.#running.set(queryId, { controller, connectionId: id })

    try {
      // A statement in a transaction runs on the connection the transaction
      // pinned, where the database and schema were settled at `begin`.
      if (options.transactionId) {
        return await this.#transactionFor(options.transactionId, id).query(sql, {
          maxRows,
          signal: controller.signal,
          onRows,
          binary,
        })
      }

      return await this.#sessionFor(id).query(sql, {
        maxRows,
        // Where the statement runs, chosen per query tab. A driver that has no
        // such level ignores them.
        database: options.database,
        schema: options.schema,
        signal: controller.signal,
        onRows,
        binary,
      })
    }
    catch (error) {
      // The connection went, not the statement: the session is dropped so
      // the row shows it, and the renderer can offer a reconnect.
      if (error?.lost) await this.#dropLost(id, error)
      throw error
    }
    finally {
      if (queryId) this.#running.delete(queryId)
    }
  }

  /**
   * Forgets a session whose connection was lost under a statement.
   *
   * The status goes to `error` — with the error that revealed the loss, so
   * the row can say why — rather than to `disconnected`, which would read as
   * something the user did. Everything the session held is then let go the
   * way a disconnect lets it go, and nothing that fails on the way is
   * reported: the transactions are rolled back on a server that has already
   * forgotten them, and the pool is closed over a socket that is gone.
   */
  async #dropLost(id, error) {
    const live = this.#live.get(id)
    // A second statement failing on the same lost connection finds it gone.
    if (!live?.session) return

    this.#live.delete(id)
    this.#setStatus(id, 'error', serializeError(error))

    this.#cancelAllFor(id)
    await this.#rollbackAllFor(id)
    await this.#teardown(live)
  }

  /**
   * Opens a transaction for a query tab and hands back the id its statements
   * should carry. The connection it pins stays out of the pool until
   * `endTransaction` — or a disconnect — lets it go.
   */
  async beginTransaction(id, scope = {}) {
    const session = this.#sessionFor(id)
    if (!session.beginTransaction) throw new Error('This driver cannot hold a transaction open.')

    const transaction = await session.beginTransaction({ database: scope.database, schema: scope.schema })
    const transactionId = randomUUID()

    this.#transactions.set(transactionId, { connectionId: id, transaction })
    return { transactionId }
  }

  /**
   * Commits or rolls back, and releases the pinned connection either way.
   * Returns whether there was anything to end: a tab that asks after its
   * connection was closed is told so, not handed an error.
   */
  async endTransaction(transactionId, action) {
    const open = this.#transactions.get(transactionId)
    if (!open) return { ended: false }

    // Forgotten before the statement runs: whatever it does, the driver has
    // let the connection go, and there is nothing left to address.
    this.#transactions.delete(transactionId)

    await (action === 'commit' ? open.transaction.commit() : open.transaction.rollback())
    return { ended: true }
  }

  /** Rolls back and forgets every transaction held on one connection. */
  async #rollbackAllFor(connectionId) {
    const ending = []

    for (const [transactionId, open] of this.#transactions) {
      if (open.connectionId !== connectionId) continue

      this.#transactions.delete(transactionId)
      // A rollback that fails on a connection being closed is not news.
      ending.push(open.transaction.rollback().catch(() => {}))
    }

    await Promise.all(ending)
  }

  /**
   * Asks a running statement to stop. Returns whether there was one: a cancel
   * that arrives just after the result is not an error, just too late.
   */
  cancel(queryId) {
    const running = this.#running.get(queryId)
    running?.controller.abort()

    return { cancelled: Boolean(running) }
  }

  /** Stops every statement running on one connection. */
  #cancelAllFor(connectionId) {
    for (const [queryId, running] of this.#running) {
      if (running.connectionId !== connectionId) continue

      running.controller.abort()
      this.#running.delete(queryId)
    }
  }

  async listChildren(id, node) {
    const children = await this.#sessionFor(id).listChildren(node)

    // Ids are assigned centrally so every node is addressable from the
    // renderer without each driver reinventing the scheme.
    return children.map((child) => ({
      ...child,
      connectionId: id,
      id: nodeId(id, child.kind, child.path),
    }))
  }

  /**
   * The SELECT behind "open table", ordered by one of its columns when the
   * grid asked for it.
   *
   * The order is normalized here rather than trusted: `dir` becomes one of two
   * literals, and a column name that is not a string is dropped. The drivers
   * quote the name themselves, as they do a table's, so what reaches the server
   * is an identifier either way — this keeps a malformed request from getting
   * that far.
   */
  previewStatement(id, node, options = {}) {
    const column = typeof options.order?.column === 'string' && options.order.column
      ? options.order.column
      : null

    const sort = column
      ? { column, dir: options.order.dir === 'desc' ? 'desc' : 'asc' }
      : null

    // `limit` is deliberately nullable: "All" asks for a statement with no
    // LIMIT at all, and the row cap on the query itself is what stops a runaway
    // table. Both numbers are floored to integers before they become SQL.
    const limit = options.limit === null ? null : Math.max(1, Math.floor(Number(options.limit) || 200))
    const offset = Math.max(0, Math.floor(Number(options.offset) || 0))

    const where = typeof options.where === 'string' && options.where.trim()
      ? options.where.trim()
      : null

    return this.#sessionFor(id).previewStatement(node, { limit, offset, order: sort, where })
  }

  /**
   * Applies the grid's staged row changes, in one transaction.
   *
   * Every change is checked here rather than trusted: an UPDATE whose WHERE
   * clause went missing would rewrite the whole table, and the renderer is one
   * bug away from sending an empty key. A driver only ever receives column
   * names it can quote and values it can bind.
   */
  applyChanges(id, node, changes, options = {}) {
    if (!node?.path?.table) throw new Error('Only a table can be edited.')
    if (!Array.isArray(changes) || !changes.length) throw new Error('There is nothing to save.')

    const clean = changes.map((change) => {
      if (change?.kind === 'insert') {
        // An insert addresses no existing row, so it needs no key — the check
        // below would reject one. What it does need is columns the driver can
        // quote and values it can bind.
        const values = (Array.isArray(change.values) ? change.values : [])
          .filter((cell) => typeof cell?.column === 'string' && cell.column)
          .map((cell) => ({ column: cell.column, value: cell.value ?? null }))

        return { kind: 'insert', values }
      }

      const key = (Array.isArray(change?.key) ? change.key : [])
        .filter((part) => typeof part?.column === 'string' && part.column)
        .map((part) => ({ column: part.column, value: part.value ?? null }))

      if (!key.length) {
        throw new Error(
          'A row could not be identified: the table has no primary key, so a change could not be limited to one row.',
        )
      }

      if (change.kind === 'delete') return { kind: 'delete', key }

      const set = (Array.isArray(change?.set) ? change.set : [])
        .filter((cell) => typeof cell?.column === 'string' && cell.column)
        .map((cell) => ({ column: cell.column, value: cell.value ?? null }))

      if (!set.length) throw new Error('An update names no columns.')

      return { kind: 'update', key, set }
    })

    const session = this.#sessionFor(id)
    if (!session.applyChanges) throw new Error('This driver cannot write yet.')

    // A dry run builds statements and touches nothing; the real run is a
    // write like any other, and the read-only mark has its say.
    if (!options.dryRun) this.#assertWritable(id, 'update', options.allowWrite)

    return session.applyChanges(node, clean, { dryRun: Boolean(options.dryRun) })
  }

  /**
   * One structure change, spelled by the driver and run statement by
   * statement. A dry run returns the SQL and stops: the structure view shows
   * it before anything is applied, the way the grid shows its batch.
   */
  async ddl(id, node, operation, options = {}) {
    if (!node?.path) throw new Error('A structure change needs a table to change.')
    if (!operation?.kind) throw new Error('No structure change was given.')

    const session = this.#sessionFor(id)
    if (!session.ddlStatements) throw new Error('This driver cannot change table structure.')

    const statements = session.ddlStatements(node, operation)
    if (options.dryRun) return { statements, applied: false }

    this.#assertWritable(id, 'alter', options.allowWrite)

    const started = performance.now()

    for (const [position, sql] of statements.entries()) {
      try {
        await this.query(id, sql, {
          maxRows: 1,
          database: node.path.database,
          schema: node.path.schema,
          allowWrite: true,
        })
      }
      catch (error) {
        if (statements.length > 1 && error && typeof error === 'object') {
          error.message = `Statement ${position + 1} of ${statements.length} failed: ${error.message}`
        }
        throw error
      }
    }

    return { statements, applied: true, durationMs: Math.round(performance.now() - started) }
  }

  /**
   * Loads a delimited file into a table, in one transaction. Cancellable
   * through the ordinary `cancel`, by the job id the renderer minted.
   */
  async importRows(id, node, request, { onProgress } = {}) {
    if (!node?.path?.table) throw new Error('Only a table can be imported into.')

    this.#assertWritable(id, 'insert', request?.allowWrite)

    const session = this.#sessionFor(id)
    const controller = new AbortController()
    const jobId = request?.jobId

    if (jobId) this.#running.set(jobId, { controller, connectionId: id })

    try {
      return await importFile(session, node, request, { signal: controller.signal, onProgress })
    }
    catch (error) {
      if (controller.signal.aborted) throw Object.assign(new Error('Import cancelled.'), { cancelled: true })
      if (error?.lost) await this.#dropLost(id, error)
      throw error
    }
    finally {
      if (jobId) this.#running.delete(jobId)
    }
  }

  /**
   * Reads one database whole, for the editor's completions.
   *
   * Every query tab on a connection wants the same snapshot, and they all ask
   * the moment they are opened, so identical reads in flight share one trip to
   * the server. Nothing is kept afterwards: the renderer holds the snapshot and
   * decides when it has gone stale, which is where the user's own "refresh"
   * belongs too.
   */
  async schemaSnapshot(id, scope = {}) {
    const session = this.#sessionFor(id)
    const key = `${id}::${scope.database ?? ''}`

    const inFlight = this.#snapshots.get(key)
    if (inFlight) return inFlight

    const read = session.schemaSnapshot(scope).finally(() => this.#snapshots.delete(key))

    this.#snapshots.set(key, read)
    return read
  }

  /** A table's indexes and CREATE statement, read by the driver its own way. */
  structure(id, node) {
    if (!node?.path?.table) throw new Error('Only a table or view has a structure to show.')
    return this.#sessionFor(id).structure(node)
  }

  /**
   * The routines, sequences and triggers of one database, read on demand for
   * the explorer. Not deduplicated the way a snapshot is: one explorer asks,
   * when its node is opened, rather than every tab at once.
   */
  objects(id, scope = {}) {
    return this.#sessionFor(id).objects({ database: scope.database })
  }

  /**
   * An exact count, under the preview's own WHERE clause.
   *
   * Runs through `query` so it is cancellable like any other statement: on a
   * big table a count is a scan, and the user who asked for it is the one who
   * gets to change their mind.
   */
  async countRows(id, node, options = {}) {
    if (!node?.path?.table) throw new Error('Only a table or view can be counted.')

    const where = typeof options.where === 'string' && options.where.trim()
      ? options.where.trim()
      : null

    const session = this.#sessionFor(id)
    const sql = session.countStatement(node, { where })

    const result = await this.query(id, sql, {
      queryId: options.queryId,
      maxRows: 1,
      database: node.path.database,
      schema: node.path.schema,
    })

    return { count: Number(result.rows[0]?.[0] ?? 0), durationMs: result.durationMs }
  }

  /** Closes everything; called when the app is quitting. */
  async shutdown() {
    this.emit('shutdown')
    for (const running of this.#running.values()) running.controller.abort()
    this.#running.clear()

    await Promise.allSettled(
      [...this.#live.keys()].map((id) => this.disconnect(id)),
    )
  }
}
