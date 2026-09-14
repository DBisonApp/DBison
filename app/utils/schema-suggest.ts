import type { SchemaObject, SchemaRelation } from '#shared/db-types'
import type { CompletionSeed, ScopedTable, SchemaIndex } from './schema-index'
import type { SqlCursorContext } from './sql-parse'
import { documentObject } from './schema-index'
import { qualify, quoteIdentifier, suggestAlias } from './sql-keywords'

/**
 * The suggestions that are worth more than a name: the ones that write a piece
 * of the statement for you.
 *
 * A foreign key is a join condition the database already knows; making the user
 * look it up, then type it out, then get the direction right, is the busywork a
 * client is supposed to remove. These are built per request rather than cached,
 * because they depend on what the statement already says.
 */

/** Past this the list stops being a list and starts being a haystack. */
const MAX_JOINS = 40

/** `o.user_id = u.id`, both sides quoted as their engine needs. */
function condition(
  left: { as: string, columns: string[] },
  right: { as: string, columns: string[] },
  quote: string,
): string {
  return left.columns
    .map((column, index) => `${left.as}.${quoteIdentifier(column, quote)} = ${right.as}.${quoteIdentifier(right.columns[index]!, quote)}`)
    .join(' and ')
}

/** Which end of a key the table in scope sits on, or null if it sits on neither. */
function orient(relation: SchemaRelation, object: SchemaObject) {
  const isChild = relation.table.toLowerCase() === object.name.toLowerCase()
    && relation.schema.toLowerCase() === object.schema.toLowerCase()

  const isParent = relation.refTable.toLowerCase() === object.name.toLowerCase()
    && relation.refSchema.toLowerCase() === object.schema.toLowerCase()

  // A key pointing at its own table is read from the child end, which gives the
  // new table an alias of its own to sit under.
  if (isChild) {
    return {
      near: relation.columns,
      far: relation.refColumns,
      farSchema: relation.refSchema,
      farTable: relation.refTable,
    }
  }

  if (isParent) {
    return {
      near: relation.refColumns,
      far: relation.columns,
      farSchema: relation.schema,
      farTable: relation.table,
    }
  }

  return null
}

/**
 * Tables that can be joined onto what the statement already has, each carrying
 * the condition that joins it.
 *
 * Offered where the table name goes — `left join |` — so accepting one writes
 * the target, an alias for it, and the ON clause in a single keystroke.
 */
export function joinTargetSeeds(
  index: SchemaIndex,
  scope: ScopedTable[],
  defaultSchema: string,
): CompletionSeed[] {
  if (!scope.length) return []

  const quote = index.quote
  const taken = new Set(scope.map((table) => table.as.toLowerCase()))
  const seen = new Set<string>()
  const seeds: CompletionSeed[] = []

  for (const near of scope) {
    for (const relation of index.relationsFor(near.object)) {
      if (seeds.length >= MAX_JOINS) return seeds

      const ends = orient(relation, near.object)
      if (!ends) continue

      const far = index.resolve([ends.farSchema, ends.farTable], defaultSchema)
      if (!far) continue

      const alias = suggestAlias(far.name, taken)
      const qualified = far.schema && far.schema.toLowerCase() !== defaultSchema.toLowerCase()
      const target = qualify(qualified ? [far.schema, far.name] : [far.name], quote)

      const on = condition(
        { as: alias, columns: ends.far },
        { as: near.as, columns: ends.near },
        quote,
      )

      // Two keys between the same pair of tables on the same columns are one
      // suggestion; different columns are genuinely different joins.
      if (seen.has(on)) continue
      seen.add(on)

      seeds.push({
        label: qualified ? `${far.schema}.${far.name}` : far.name,
        kind: 'join',
        insertText: `${target} ${alias} on ${on}`,
        detail: `join on ${on}`,
        // Only the table name is typed at; the condition is what is read.
        filterText: far.name,
        sortText: `0${far.name.toLowerCase()}`,
        documentation: () => documentObject(far),
      })
    }
  }

  return seeds
}

/**
 * Conditions between tables the statement already has, for an ON clause the
 * user reached without taking the offer above.
 */
export function joinConditionSeeds(index: SchemaIndex, scope: ScopedTable[]): CompletionSeed[] {
  if (scope.length < 2) return []

  const quote = index.quote
  const seen = new Set<string>()
  const seeds: CompletionSeed[] = []

  for (const near of scope) {
    for (const relation of index.relationsFor(near.object)) {
      const ends = orient(relation, near.object)
      if (!ends) continue

      for (const far of scope) {
        if (far === near) continue

        const matches = far.object.name.toLowerCase() === ends.farTable.toLowerCase()
          && far.object.schema.toLowerCase() === ends.farSchema.toLowerCase()

        if (!matches) continue

        const on = condition(
          { as: near.as, columns: ends.near },
          { as: far.as, columns: ends.far },
          quote,
        )

        if (seen.has(on)) continue
        seen.add(on)

        seeds.push({
          label: on,
          kind: 'join',
          insertText: on,
          detail: 'foreign key',
          sortText: `0${on}`,
        })
      }
    }
  }

  return seeds
}

/**
 * `u.*` as the columns it stands for.
 *
 * `select *` is what everyone types and nobody wants in a saved query; this is
 * the one keystroke that turns it into an explicit list.
 */
export function starSeeds(index: SchemaIndex, scope: ScopedTable[]): CompletionSeed[] {
  return scope
    .filter((table) => table.object.columns.length > 0)
    .map((table) => {
      const columns = table.object.columns
        .map((column) => `${table.as}.${quoteIdentifier(column.name, index.quote)}`)
        .join(', ')

      return {
        label: `${table.as}.*`,
        kind: 'column' as const,
        insertText: columns,
        detail: `all ${table.object.columns.length} columns of ${table.object.name}`,
        sortText: `20${table.as}`,
      }
    })
}

/**
 * What to call the table just named: `from order_items |` offers `oi`.
 *
 * The alias slot is the one place in SQL where the editor knows there is
 * nothing to look up and the user still has to type something. Offering the
 * conventional short form is what makes aliasing cheap enough to bother with,
 * which is what makes every column suggestion after it qualifiable.
 */
export function aliasSlotSeeds(analysis: SqlCursorContext): CompletionSeed[] {
  const named = analysis.tables.at(-1)
  if (!named) return []

  const taken = new Set(
    analysis.tables.slice(0, -1).map((table) => (table.alias ?? table.name).toLowerCase()),
  )

  const alias = suggestAlias(named.name, taken)

  return [{
    label: alias,
    kind: 'alias',
    insertText: alias,
    detail: `alias for ${named.name}`,
    sortText: `0${alias}`,
  }]
}

/** The names the statement itself introduced: `from users u` makes `u` a word. */
export function aliasSeeds(index: SchemaIndex, scope: ScopedTable[]): CompletionSeed[] {
  return scope.map((table) => ({
    label: table.as,
    kind: 'alias' as const,
    insertText: table.as,
    detail: table.alias
      ? `${table.object.schema ? `${table.object.schema}.` : ''}${table.object.name}`
      : `${table.object.columns.length} columns`,
    sortText: `2${table.as.toLowerCase()}`,
    documentation: () => documentObject(table.object),
  }))
}
