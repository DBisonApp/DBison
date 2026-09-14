import type { DriverMeta } from '#shared/db-types'

/**
 * What the structure dialogs know about a column type before the user types
 * one: the handful of types each engine is asked for nine times out of ten.
 *
 * The lists feed a datalist, not a select. A type is free text — `numeric(12,2)`
 * and `varchar(80)` are the same type with different arguments, and an enum or
 * a domain is whatever the schema calls it — so the list saves the typing for
 * the common case and gets out of the way for the rest.
 */

export type DdlEngine = NonNullable<DriverMeta['engine']>

const COMMON_TYPES: Record<DdlEngine, string[]> = {
  postgres: ['integer', 'bigint', 'text', 'varchar(255)', 'boolean', 'numeric(12,2)', 'timestamptz', 'date', 'jsonb', 'uuid'],
  mysql: ['int', 'bigint', 'varchar(255)', 'text', 'tinyint(1)', 'decimal(12,2)', 'datetime', 'date', 'json'],
  sqlite: ['integer', 'text', 'real', 'blob', 'numeric'],
}

/** The dialect a driver speaks; MariaDB is its own driver and MySQL's dialect. */
export function engineOf(driver: Pick<DriverMeta, 'id' | 'engine'> | null | undefined): DdlEngine {
  if (driver?.engine) return driver.engine
  return driver?.id === 'mariadb' ? 'mysql' : (driver?.id ?? 'postgres')
}

export function commonTypes(engine: DdlEngine): string[] {
  return COMMON_TYPES[engine]
}

/**
 * The type an auto-increment column should have, when the user has not said.
 * Postgres identity columns and MySQL AUTO_INCREMENT want an integer type;
 * SQLite's rowid alias is `integer` and nothing else.
 */
export function autoIncrementType(engine: DdlEngine): string {
  return engine === 'mysql' ? 'int' : 'integer'
}

/**
 * The name `CREATE INDEX` is given when the user has not chosen one: the
 * table, the columns and `_idx`, which is what most conventions and Postgres
 * itself arrive at. Trimmed so a wide composite key does not run past the
 * engine's identifier limit (63 on Postgres, 64 on MySQL).
 */
export function suggestIndexName(table: string, columns: string[], unique = false): string {
  const suffix = unique ? '_key' : '_idx'
  const body = [table, ...columns].join('_').replace(/[^A-Za-z0-9_]+/g, '_')

  return body.slice(0, 63 - suffix.length) + suffix
}
