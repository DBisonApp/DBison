/**
 * The vocabulary the editor offers when the schema has nothing better to say.
 *
 * Split by where each word can legally go, because a completion list is ranked
 * by what the user plausibly wants next: `create table` has no business
 * appearing between two column names, and a list that offers it there is one
 * the user learns to dismiss.
 */

/** Words that open a statement. Offered on an empty line, and nowhere else. */
export const SQL_STATEMENT_KEYWORDS = [
  'select', 'insert into', 'update', 'delete from', 'with', 'explain', 'analyze',
  'create table', 'create view', 'create index', 'alter table', 'drop table',
  'truncate table', 'begin', 'commit', 'rollback',
]

/** Words that go inside an expression: a select list, a WHERE, a join condition. */
export const SQL_EXPRESSION_KEYWORDS = [
  'and', 'or', 'not', 'in', 'exists', 'between', 'like', 'ilike', 'is null',
  'is not null', 'case', 'when', 'then', 'else', 'end', 'distinct', 'as', 'null',
  'true', 'false', 'asc', 'desc',
]

/** Words that continue a statement once it has a FROM: the clauses after it. */
export const SQL_CLAUSE_KEYWORDS = [
  'from', 'where', 'group by', 'order by', 'having', 'limit', 'offset',
  'inner join', 'left join', 'right join', 'full join', 'cross join',
  'union', 'union all', 'except', 'intersect', 'returning',
]

/** Offered where an expression goes; the parentheses come with them. */
export const SQL_FUNCTIONS = [
  'count', 'sum', 'avg', 'min', 'max', 'coalesce', 'nullif', 'greatest', 'least',
  'lower', 'upper', 'trim', 'length', 'substring', 'replace', 'concat', 'round',
  'abs', 'floor', 'ceil', 'cast', 'now', 'date_trunc', 'extract', 'to_char',
  'string_agg', 'array_agg', 'json_agg', 'row_number', 'rank', 'dense_rank',
  'lag', 'lead',
]

/**
 * Words that cannot stand as a bare identifier. Not the full reserved list of
 * any one engine — the union of the ones a table or column is plausibly named
 * after, which is where the quoting actually matters.
 */
const RESERVED = new Set([
  'select', 'from', 'where', 'table', 'column', 'order', 'group', 'by', 'join',
  'left', 'right', 'inner', 'outer', 'full', 'cross', 'on', 'using', 'as', 'and',
  'or', 'not', 'null', 'true', 'false', 'default', 'primary', 'foreign', 'key',
  'references', 'index', 'view', 'create', 'drop', 'alter', 'insert', 'update',
  'delete', 'into', 'values', 'set', 'case', 'when', 'then', 'else', 'end', 'all',
  'any', 'union', 'except', 'intersect', 'distinct', 'having', 'limit', 'offset',
  'with', 'user', 'grant', 'check', 'constraint', 'unique', 'desc', 'asc', 'in',
  'is', 'like', 'between', 'exists', 'to', 'for', 'if', 'of', 'add', 'range',
])

/** A name an engine reads back as itself, unquoted. */
const PLAIN = /^[a-z_][a-z0-9_$]*$/

/**
 * Quotes an identifier only where leaving it bare would change it.
 *
 * Postgres folds an unquoted name to lower case, so anything with a capital in
 * it has to be quoted to survive; so does anything with a space, a hyphen, a
 * leading digit, or a name the parser has other plans for. Everything else is
 * left alone, because `select "id" from "users"` is not what anyone wants to
 * find in their editor.
 */
export function quoteIdentifier(name: string, quote: string): string {
  if (PLAIN.test(name) && !RESERVED.has(name)) return name

  const closer = quote === '[' ? ']' : quote
  return quote + name.replaceAll(closer, closer + closer) + closer
}

/** Joins the parts of a qualified name, quoting each on its own merits. */
export function qualify(parts: (string | undefined)[], quote: string): string {
  return parts.filter(Boolean).map((part) => quoteIdentifier(part!, quote)).join('.')
}

/**
 * An alias for a table that has none: the initials of a snake_cased name, or
 * its first letters. `order_items` becomes `oi`, `customers` becomes `cu`.
 */
export function suggestAlias(table: string, taken: Set<string>): string {
  const parts = table.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

  const initials = parts.length > 1 ? parts.map((part) => part[0]).join('') : parts[0]?.slice(0, 2)
  const base = (initials || 't').replace(/^[0-9]/, 't')

  if (!taken.has(base)) return base

  for (let n = 2; ; n++) {
    const candidate = `${base}${n}`
    if (!taken.has(candidate)) return candidate
  }
}
