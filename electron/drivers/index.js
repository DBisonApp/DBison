import postgres from './postgres.js'
import mysql from './mysql.js'
import sqlite from './sqlite.js'

/**
 * A driver owns everything engine-specific: how to dial the server, how to run
 * a statement, and how the object tree is shaped. Adding an engine means adding
 * a module here that implements the same two-part shape.
 *
 * @typedef {object} DriverMeta
 * @property {string} id
 * @property {string} label
 * @property {'server' | 'file'} target  Whether it dials a host or opens a path.
 * @property {number} [defaultPort]
 * @property {string} [badge]            Two-letter tag used by the navigator.
 * @property {string} [color]
 * @property {('database' | 'schema')[]} levels  Object levels above a table.
 *
 * @typedef {object} Driver
 * @property {DriverMeta} meta
 * @property {(profile: object, secret: string | undefined) => Promise<Session>} open
 *
 * @typedef {object} QueryOptions
 * @property {number} maxRows
 * @property {AbortSignal} [signal]
 * @property {string} [database]  Where to run it; drivers without the level ignore it.
 * @property {string} [schema]
 * @property {(rows: unknown[][], columns?: object[]) => void} [onRows]  Given, rows go out in batches as they arrive — the first with the columns — and the result comes back with `rows: []`, `streamed: true` and `rowCount` for the whole stream.
 * @property {'digest' | 'base64'} [binary]  How binary values travel; see values.js.
 *
 * @typedef {object} SortOrder
 * @property {string} column
 * @property {'asc' | 'desc'} dir
 *
 * @typedef {object} Transaction
 * @property {(sql: string, options: Omit<QueryOptions, 'database' | 'schema'>) => Promise<object>} query  Runs on the pinned connection; the database and schema were settled at begin.
 * @property {() => Promise<void>} commit  Ends the transaction and releases the connection.
 * @property {() => Promise<void>} rollback
 *
 * @typedef {object} Session
 * @property {string} serverVersion
 * @property {(sql: string, options: QueryOptions) => Promise<object>} query
 * @property {(scope: { database?: string, schema?: string }) => Promise<Transaction>} beginTransaction  Pins one connection and opens a transaction on it, held until commit or rollback.
 * @property {(node: object) => Promise<object[]>} listChildren
 * @property {(node: object, limit: number, order: ?SortOrder) => string} previewStatement  SELECT used by "open table", carrying the grid's ORDER BY when it has one.
 * @property {(node: object, options: { where: ?string }) => string} countStatement  SELECT COUNT(*) under the preview's own WHERE; run through `query` so it stays cancellable.
 * @property {(node: object) => Promise<{ indexes: object[], ddl: ?string, ddlNote?: string }>} structure  A table's indexes and CREATE statement, for the structure view.
 * @property {(scope: { database?: string }) => Promise<{ routines: object[], sequences: object[], triggers: object[] }>} objects  Everything in one database that is not a table or view, for the explorer; see SchemaObjects in shared/db-types.ts.
 * @property {() => Promise<void>} close
 */

/** @type {Record<string, Driver>} */
export const DRIVERS = {
  [postgres.meta.id]: postgres,
  [mysql.meta.id]: mysql,
  // MariaDB speaks the MySQL protocol; same driver, its own identity in the UI.
  mariadb: { ...mysql, meta: { ...mysql.meta, id: 'mariadb', label: 'MariaDB', badge: 'MA', color: '#a0763a' } },
  [sqlite.meta.id]: sqlite,
}

export function getDriver(id) {
  const driver = DRIVERS[id]
  if (!driver) throw new Error(`Unknown driver "${id}".`)
  return driver
}

export function driverCatalog() {
  return Object.values(DRIVERS).map((driver) => driver.meta)
}
