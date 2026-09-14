/**
 * Staged row changes, turned into statements.
 *
 * The shape of an UPDATE or a DELETE addressed by a primary key is the same on
 * every engine; only the quoting, the placeholder syntax and the way a literal
 * is written differ. Those three come from the driver, so the statement itself
 * is written once here rather than three times over.
 */

/**
 * Builds one change into SQL twice: parameterized for the engine, and with its
 * values inlined for the user to read before saving.
 *
 * The preview is never what runs. It exists because "save 14 changes" is a leap
 * of faith otherwise, and because a script the user can paste into the editor
 * is the honest way to show what a grid is about to do.
 */
function render(change, table, quoteIdent, value, emptyInsert) {
  if (change.kind === 'insert') {
    // A row that names no columns is every column left to the server. Postgres
    // and SQLite spell that `default values`; MySQL wants empty parentheses.
    if (!change.values.length) return `insert into ${table} ${emptyInsert};`

    const names = change.values.map((cell) => quoteIdent(cell.column)).join(', ')
    const values = change.values.map((cell) => value(cell.value)).join(', ')

    return `insert into ${table} (${names})\nvalues (${values});`
  }

  const where = change.key
    .map((part) => `${quoteIdent(part.column)} = ${value(part.value)}`)
    .join(' and ')

  if (change.kind === 'delete') return `delete from ${table}\n where ${where};`

  const assignments = change.set
    .map((cell) => `${quoteIdent(cell.column)} = ${value(cell.value)}`)
    .join(',\n       ')

  return `update ${table}\n   set ${assignments}\n where ${where};`
}

/**
 * @param {object[]} changes
 * @param {object} dialect
 * @param {string} dialect.table            The table, already qualified and quoted.
 * @param {(name: string) => string} dialect.quoteIdent
 * @param {(position: number) => string} dialect.placeholder  `$1`, `?`, …
 * @param {(value: unknown) => string} dialect.literal        For the preview only.
 * @param {string} [dialect.emptyInsert]  How the engine writes an all-defaults row.
 * @returns {{ sql: string, params: unknown[], preview: string }[]}
 */
export function buildStatements(
  changes,
  { table, quoteIdent, placeholder, literal, emptyInsert = 'default values' },
) {
  return changes.map((change) => {
    const params = []

    // `push` returns the new length, which is exactly the 1-based position the
    // placeholder needs — and it keeps the parameters in the order they are
    // written into the statement.
    const sql = render(change, table, quoteIdent, (value) => placeholder(params.push(value)), emptyInsert)
    const preview = render(change, table, quoteIdent, literal, emptyInsert)

    return { sql, params, preview }
  })
}

/**
 * A string as SQL writes it, for the preview.
 *
 * Standard quote doubling, which every engine here understands. MySQL also
 * reads a backslash as an escape unless NO_BACKSLASH_ESCAPES is set, so its
 * driver passes `escapeBackslashes`.
 */
export function literalFactory({ escapeBackslashes = false } = {}) {
  return function literal(value) {
    if (value === null || value === undefined) return 'null'
    if (typeof value === 'number') return String(value)
    if (typeof value === 'boolean') return value ? 'true' : 'false'

    const text = escapeBackslashes ? String(value).replace(/\\/g, '\\\\') : String(value)
    return `'${text.replace(/'/g, "''")}'`
  }
}

/** The batch as one readable script, for the error a failed save reports. */
export function previewOf(statements) {
  return statements.map((statement) => statement.preview).join('\n')
}

/**
 * Guards the one assumption the whole batch rests on: a primary key names one
 * row. Anything else means the data moved between reading it and saving, and
 * the transaction is rolled back rather than half-applied on a guess.
 */
export function assertOneRow(affected, position) {
  if (affected === 1) return

  throw new Error(
    `Statement ${position + 1} matched ${affected} rows instead of one — the data changed since it was read. `
    + 'Nothing was saved; reload the table and try again.',
  )
}
