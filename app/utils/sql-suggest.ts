import type { CompletionSeed, ScopedTable, SchemaIndex } from './schema-index'
import type { SqlCursorContext } from './sql-parse'
import { aliasSeeds, aliasSlotSeeds, joinConditionSeeds, joinTargetSeeds, starSeeds } from './schema-suggest'
import {
  SQL_CLAUSE_KEYWORDS,
  SQL_EXPRESSION_KEYWORDS,
  SQL_FUNCTIONS,
  SQL_STATEMENT_KEYWORDS,
} from './sql-keywords'

/**
 * What to offer at the caret, and in what order.
 *
 * Kept apart from the Monaco provider that calls it: this is the half worth
 * reasoning about, and it is a pure function of "what the statement says" and
 * "what the database holds". Nothing here touches an editor, a model or a
 * connection.
 */

/** Built once: the same for every connection, and none of it is free to redo. */
let staticSeeds: Record<'statement' | 'expression' | 'clause' | 'functions', CompletionSeed[]> | null = null

function keywordSeeds(words: string[], rank: string): CompletionSeed[] {
  return words.map((word) => ({
    label: word,
    kind: 'keyword' as const,
    insertText: word,
    sortText: `${rank}${word}`,
  }))
}

export function vocabulary() {
  staticSeeds ??= {
    statement: keywordSeeds(SQL_STATEMENT_KEYWORDS, '8'),
    expression: keywordSeeds(SQL_EXPRESSION_KEYWORDS, '8'),
    // A clause keyword ends what is being written and starts the next thing, so
    // it sits below the words that continue the current expression.
    clause: keywordSeeds(SQL_CLAUSE_KEYWORDS, '9'),
    functions: SQL_FUNCTIONS.map((name) => ({
      label: name,
      kind: 'function' as const,
      insertText: `${name}($0)`,
      snippet: true,
      sortText: `7${name}`,
    })),
  }

  return staticSeeds
}

function scopeColumns(index: SchemaIndex, scope: ScopedTable[]): CompletionSeed[] {
  // The common case is one table, where the index's own list can be handed
  // straight through without copying it.
  if (scope.length === 1) return index.columns(scope[0]!.object)

  return scope.flatMap((table) => index.columns(table.object))
}

/**
 * Everything worth offering at the caret, ranked.
 *
 * The lists themselves come from the index, already built; this only decides
 * which of them apply, which is what makes it cheap enough to run per
 * keystroke.
 */
export function seedsAt(
  analysis: SqlCursorContext,
  index: SchemaIndex,
  defaultSchema: string,
): CompletionSeed[] {
  const scope = index.scope(analysis.tables, defaultSchema)
  const words = vocabulary()

  // `alias.|`, `schema.|`, `schema.table.|` — a qualified position means one
  // specific thing, and anything else offered there is noise.
  if (analysis.qualifier.length) {
    const last = analysis.qualifier.at(-1)!

    if (analysis.qualifier.length === 1) {
      const aliased = scope.find((table) => table.as.toLowerCase() === last.toLowerCase())
      if (aliased) return index.columns(aliased.object)
    }

    const object = index.resolve(analysis.qualifier, defaultSchema)
    if (object) return index.columns(object)

    // Not a table, so a schema: `public.|` lists what is in it.
    return analysis.qualifier.length === 1 ? index.tablesIn(last) : []
  }

  switch (analysis.clause) {
    // Only a table belongs after FROM or JOIN, so only tables are offered —
    // with the ones a foreign key already connects to the statement first.
    case 'from':
    case 'join': {
      // `from users |`: the caret is in the alias slot. The user is naming this
      // table, not looking for another one, and what follows an alias is the
      // next clause rather than another name.
      if (analysis.atAlias) return [...aliasSlotSeeds(analysis), ...words.clause]

      return [
        ...(analysis.clause === 'join' ? joinTargetSeeds(index, scope, defaultSchema) : []),
        ...index.tables(defaultSchema),
        ...index.schemas(),
      ]
    }

    case 'on':
      return [
        ...joinConditionSeeds(index, scope),
        ...aliasSeeds(index, scope),
        ...scopeColumns(index, scope),
        ...words.expression,
      ]

    // A select list, a WHERE, a GROUP BY, a SET — everywhere an expression can
    // go. What belongs here is the columns of the tables the statement has
    // already named; everything else is a distant second.
    case 'select': {
      if (scope.length) {
        return [
          ...starSeeds(index, scope),
          ...scopeColumns(index, scope),
          ...aliasSeeds(index, scope),
          ...words.functions,
          ...words.expression,
          ...words.clause,
          // Last: a table name here is only ever a qualifier for a column, and
          // the alias above is the better way to write one.
          ...index.tables(defaultSchema),
        ]
      }

      // No FROM yet, so no columns are knowable. The useful next move is the
      // clause that would make them knowable.
      return [...words.functions, ...words.clause, ...words.expression, ...index.tables(defaultSchema)]
    }

    default:
      return [...words.statement, ...index.tables(defaultSchema)]
  }
}
