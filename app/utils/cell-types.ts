import type { CellValue } from '#shared/db-types'

/**
 * What a column is, as far as editing it is concerned.
 *
 * Not the engine's type — a grid does not need to tell `int4` from `int8` — but
 * the kind of control the value deserves. A boolean is a checkbox everywhere,
 * whether the engine calls it `bool`, `tinyint(1)` or stores it as 0 and 1.
 */
export type CellKind
  = | 'boolean'
    | 'number'
    | 'enum'
    | 'date'
    | 'time'
    | 'datetime'
    | 'json'
    | 'binary'
    | 'text'

/**
 * Where a foreign key points, as far as the grid needs to know.
 *
 * Only the far end: which table, and which of its columns this one matches.
 * The composite case — a key spanning two columns — is resolved by whoever
 * owns the schema, because following one column of a pair would land on a set
 * of rows rather than on the row the cell is talking about.
 */
export interface ColumnRef {
  /** Empty on engines with no schema level, so it is dropped from labels. */
  schema?: string
  table: string
  column: string
}

/** What the table says about a column, beyond what a result set reveals. */
export interface ColumnFacts {
  declaredType?: string
  enumValues?: string[]
  nullable: boolean
  hasDefault: boolean
  primaryKey: boolean
  /** The table this column names a row of, when it names one. */
  references?: ColumnRef
}

/**
 * The one glyph a grid header wears for a column's type.
 *
 * A header that spells `character varying(255)` out spends more width on the
 * type than on the name it is there to show. The exact type is a tooltip and a
 * footer away; what the eye scans a header row for — which of these is a date,
 * which is a number — is a shape.
 */
export const CELL_KIND_ICON = {
  boolean: 'typeBoolean',
  number: 'typeNumber',
  enum: 'typeEnum',
  date: 'typeDate',
  time: 'typeTime',
  datetime: 'typeDateTime',
  json: 'typeJson',
  binary: 'typeBinary',
  text: 'typeText',
} as const satisfies Record<CellKind, string>

/** `public.customers.id`, or `customers.id` where there are no schemas. */
export function describeRef(ref: ColumnRef): string {
  return [ref.schema, ref.table, ref.column].filter(Boolean).join('.')
}

const NUMERIC = /^(small|big|tiny|medium)?(int|serial)|^num|^dec|^float|^double|^real|^money|^fixed/i
const BINARY = /^(bytea|blob|binary|varbinary|image)/i

/**
 * Which control a column's values want.
 *
 * The declared type wins where there is one: MySQL sends `tiny` on the wire for
 * what the table declares as `tinyint(1)`, and only the table knows which of
 * those is a boolean. A result set from an arbitrary query has no table behind
 * it, so it falls back to what the wire said.
 */
export function classifyCell(resultType: string, facts?: ColumnFacts): CellKind {
  if (facts?.enumValues?.length) return 'enum'

  const type = (facts?.declaredType ?? resultType ?? '').toLowerCase().trim()

  if (type.startsWith('bool') || type.startsWith('tinyint(1)') || type === 'bit(1)') return 'boolean'
  if (BINARY.test(type)) return 'binary'
  if (type.startsWith('json')) return 'json'

  // A zoned timestamp keeps its offset, and no browser picker can express one:
  // editing it as text is what keeps `+02` from silently becoming `Z`.
  if (type.includes('with time zone') || type.endsWith('tz')) return 'text'

  if (type.startsWith('timestamp') || type.startsWith('datetime')) return 'datetime'
  if (type.startsWith('date')) return 'date'
  if (type.startsWith('time')) return 'time'

  if (NUMERIC.test(type)) return 'number'

  return 'text'
}

/**
 * A value as a checkbox understands it.
 *
 * SQLite has no boolean and MySQL's is an integer, so `true` arrives as `1`,
 * `'1'`, `'t'` or `'true'` depending on which of the three answered.
 */
export function toBoolean(value: CellValue): boolean | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0

  const text = String(value).trim().toLowerCase()
  if (['true', 't', 'yes', 'y', '1'].includes(text)) return true
  if (['false', 'f', 'no', 'n', '0'].includes(text)) return false

  return null
}

/**
 * A boolean written the way the column already writes them.
 *
 * A MySQL `tinyint(1)` holds 1 and 0, SQLite the same, Postgres a real boolean.
 * Following what is already in the column keeps a table from ending up with
 * both `1` and `true` in it.
 */
export function fromBoolean(next: boolean, previous: CellValue): CellValue {
  if (typeof previous === 'number') return next ? 1 : 0

  if (typeof previous === 'string') {
    const text = previous.trim().toLowerCase()
    if (text === '1' || text === '0') return next ? '1' : '0'
    if (text === 't' || text === 'f') return next ? 't' : 'f'
    if (text === 'yes' || text === 'no') return next ? 'yes' : 'no'
    return next ? 'true' : 'false'
  }

  return next
}

/** The `<input type="date|time|datetime-local">` value for a stored value. */
export function toInputValue(kind: CellKind, value: CellValue): string {
  if (value === null || value === undefined) return ''

  const text = String(value)

  switch (kind) {
    case 'date':
      // Both `2024-05-01` and a full ISO instant start with the date itself.
      return text.slice(0, 10)

    case 'time':
      return text.slice(0, 8)

    case 'datetime': {
      // The engines differ only in the separator: a space, or the ISO `T`.
      const [date, clock = ''] = text.replace('T', ' ').split(' ')
      const trimmed = clock.replace('Z', '').slice(0, 8)
      return trimmed ? `${date}T${trimmed}` : (date ?? '')
    }

    default:
      return text
  }
}

/**
 * What a picker's value should be written back as.
 *
 * `datetime-local` always says `T`; every engine here reads a space, and only
 * some read the `T`, so the space is what goes back.
 */
export function fromInputValue(kind: CellKind, text: string): CellValue {
  if (kind === 'datetime') return text.replace('T', ' ')
  return text
}

/** Whether a value is too big for a one-line editor to be honest about. */
export function needsFullEditor(kind: CellKind, value: CellValue) {
  if (kind === 'json') return true
  return typeof value === 'string' && (value.length > 200 || value.includes('\n'))
}
