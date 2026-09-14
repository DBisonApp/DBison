import type { CellValue } from '#shared/db-types'
import { quoteIdentifier } from './sql-keywords'

/**
 * What an INSERT needs to know about where it is going.
 *
 * The grid only has column names and values; which database they came from is
 * the owner's business. It hands over the table name already qualified and
 * quoted, since that is the one part that varies per dialect and the grid has
 * no reason to learn how each one spells a schema.
 */
export interface SqlDialect {
  /** The table to insert into, already qualified and quoted. */
  table: string
  /** The identifier quote character: `"` for most databases, `` ` `` for MySQL. */
  quote: string
  /** Whether a backslash inside a string literal needs doubling, as it does in MySQL. */
  escapeBackslashes: boolean
}

/**
 * A value as a SQL literal, following the same rules the save path uses in the
 * main process. They are repeated here rather than shared, because the renderer
 * has no business loading driver code to write text into the clipboard.
 */
export function sqlLiteral(value: CellValue, escapeBackslashes: boolean): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'

  const text = escapeBackslashes ? String(value).replace(/\\/g, '\\\\') : String(value)
  return `'${text.replace(/'/g, "''")}'`
}

/** One INSERT per row, each on its own line, so a partial paste still runs. */
export function toInsertStatements(headers: string[], rows: CellValue[][], dialect: SqlDialect): string {
  const columns = headers.map((name) => quoteIdentifier(name, dialect.quote)).join(', ')

  return rows
    .map((row) => {
      const values = row.map((value) => sqlLiteral(value, dialect.escapeBackslashes)).join(', ')
      return `insert into ${dialect.table} (${columns}) values (${values});`
    })
    .join('\n')
}

/**
 * A cell as it can sit in a Markdown table: pipes would end the cell early and
 * a newline would end the row, so the one is escaped and the other flattened.
 */
function markdownCell(value: CellValue): string {
  if (value === null || value === undefined) return ''

  const text = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value)
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/** A GitHub-flavoured table: header, separator, then one line per row. */
export function toMarkdownTable(headers: string[], rows: CellValue[][]): string {
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`

  return [
    line(headers.map(markdownCell)),
    line(headers.map(() => '---')),
    ...rows.map((row) => line(row.map(markdownCell))),
  ].join('\n')
}
