/**
 * Turns the flat rows an engine's catalog returns into the snapshot the query
 * editor completes from. See `SchemaSnapshot` in shared/db-types.ts.
 *
 * Every driver reads its own catalog, but they all end up with the same thing:
 * one row per column, ordered by table and then by position. Grouping that is
 * identical work, so it happens once, here.
 */

/**
 * How many columns a snapshot may describe.
 *
 * A snapshot is read in one go and held in memory, so it needs a ceiling. This
 * one is generous — a schema of 400 wide tables fits — and the queries below
 * order by table so that what falls off the end is whole tables rather than
 * half of every one of them.
 */
export const SCHEMA_COLUMN_LIMIT = 20_000

/**
 * @param {object} input
 * @param {string} input.database
 * @param {string[]} [input.schemas]     Schema names, including empty ones.
 * @param {object[]} input.columns       Flat rows, ordered by table then position.
 * @param {object[]} [input.relations]   Foreign keys, already grouped.
 * @param {object[]} [input.stats]       One row per object, in any order:
 *   `{ schema, table, rowEstimate, bytes, comment }`. Read from the engine's
 *   own statistics rather than counted, so a table missing from here is one
 *   the engine has no estimate for, not one with no rows.
 * @param {(schema: string, table: string) => object} [input.pathOf]
 *   The `DbPath` that addresses one object, levels outermost first. The
 *   explorer opens a table straight off a snapshot, so the path it would have
 *   got from `listChildren` has to be in the snapshot too — and only the driver
 *   knows the shape (SQLite has no object levels yet still names `main`).
 * @param {boolean} [input.truncated]
 */
export function buildSnapshot({
  database,
  schemas = [],
  columns,
  relations = [],
  stats = [],
  pathOf = (schema, table) => (schema ? { schema, table } : { table }),
  truncated = false,
}) {
  /** @type {Map<string, object>} */
  const objects = new Map()

  for (const row of columns) {
    const schema = row.schema ?? ''
    const key = `${schema}\u0000${row.table}`

    let object = objects.get(key)

    if (!object) {
      object = {
        schema,
        name: row.table,
        kind: row.kind === 'view' ? 'view' : 'table',
        path: pathOf(schema, row.table),
        columns: [],
      }
      objects.set(key, object)
    }

    // A table with no columns at all still arrives, as a row with none named:
    // an outer join in the query keeps it from vanishing from the tree.
    if (row.column == null) continue

    object.columns.push({
      name: row.column,
      type: row.type ?? '',
      primaryKey: Boolean(row.primaryKey),
      nullable: Boolean(row.nullable),
    })
  }

  // Merged after the grouping rather than joined into the column query: a
  // size is one number per table, and asking for it once per column would make
  // the engine compute it once per column too.
  for (const row of stats) {
    const object = objects.get(`${row.schema ?? ''}\u0000${row.table}`)
    if (!object) continue

    // A negative estimate is Postgres for "never analysed", and a view's row
    // count is whatever its query returns today. Neither is a number to show.
    if (Number.isFinite(row.rowEstimate) && row.rowEstimate >= 0) {
      object.rowEstimate = Number(row.rowEstimate)
    }
    if (Number.isFinite(row.bytes) && row.bytes > 0) object.bytes = Number(row.bytes)

    const comment = typeof row.comment === 'string' ? row.comment.trim() : ''
    if (comment) object.comment = comment
  }

  const known = new Set(schemas)
  for (const object of objects.values()) {
    if (object.schema) known.add(object.schema)
  }

  return {
    database,
    schemas: [...known].sort(),
    objects: [...objects.values()],
    relations,
    truncated,
  }
}

/**
 * Groups the rows of a multi-column foreign key into one relation.
 *
 * Engines report a composite key as one row per column pair, in order; the key
 * is whatever identifies the constraint on that engine.
 *
 * @param {object[]} rows Ordered by constraint, then by column position.
 */
export function groupRelations(rows) {
  /** @type {Map<string, object>} */
  const relations = new Map()

  for (const row of rows) {
    let relation = relations.get(row.key)

    if (!relation) {
      relation = {
        schema: row.schema ?? '',
        table: row.table,
        columns: [],
        refSchema: row.refSchema ?? '',
        refTable: row.refTable,
        refColumns: [],
      }
      relations.set(row.key, relation)
    }

    relation.columns.push(row.column)
    relation.refColumns.push(row.refColumn)
  }

  // A key whose halves do not line up cannot be written as a join condition,
  // and a half-written one is worse than none.
  return [...relations.values()].filter(
    (relation) => relation.columns.length === relation.refColumns.length
      && relation.columns.every(Boolean)
      && relation.refColumns.every(Boolean),
  )
}
