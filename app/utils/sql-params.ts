import { sqlLiteral } from './serialize'
import { tokenize } from './sql-parse'

/**
 * Bind parameters a statement asks for, found the way the engines find them:
 * `:name` and `$1` outside strings, comments and quoted identifiers.
 *
 * `::` is a Postgres cast, not a parameter, and `:` inside a JSON path or a
 * time literal is inside a string and never reaches here. `$1`-style names
 * are numbers; `:name` ones are words. Each is listed once, in first-seen
 * order, which is the order a prompt should ask in.
 */
export interface SqlParameter {
  /** `name` for `:name`, `1` for `$1`. */
  name: string
  /** The text as written, for replacing it. */
  token: string
}

export function findParameters(text: string): SqlParameter[] {
  const found = new Map<string, SqlParameter>()
  const tokens = tokenize(text)

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.kind !== 'punct' || (token.text !== ':' && token.text !== '$')) continue

    const previous = tokens[i - 1]
    const next = tokens[i + 1]

    // `::type` is a cast; the second colon is skipped along with the first.
    if (token.text === ':' && (previous?.text === ':' || next?.text === ':')) continue
    // Only a name (or number, for $) glued straight onto the marker counts.
    if (!next || next.start !== token.end) continue
    if (token.text === ':' && next.kind !== 'word') continue
    if (token.text === '$' && next.kind !== 'number' && next.kind !== 'word') continue
    // `$1` is a parameter; `$$` and `$tag$` were consumed as a dollar-quoted
    // string by the tokenizer already, so they never arrive here.
    if (token.text === '$' && next.kind === 'word') continue

    const name = next.text
    if (!found.has(name)) found.set(name, { name, token: `${token.text}${name}` })
  }

  return [...found.values()]
}

/**
 * Writes the values in, as literals, in place of the markers.
 *
 * Substituted as text rather than bound: the app's query path sends a
 * statement, not a statement plus parameters, and every engine here reads a
 * quoted literal the same way. A value typed as `NULL` is null; a number
 * that looks like one is a number; everything else is a string.
 */
export function substituteParameters(
  text: string,
  values: Record<string, string>,
  escapeBackslashes = false,
): string {
  const tokens = tokenize(text)
  let out = ''
  let cursor = 0

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    const next = tokens[i + 1]
    if (token.kind !== 'punct' || (token.text !== ':' && token.text !== '$') || !next) continue
    if (next.start !== token.end || !(next.text in values)) continue
    if (token.text === ':' && (tokens[i - 1]?.text === ':' || next.kind !== 'word')) continue
    if (token.text === '$' && next.kind !== 'number') continue

    out += text.slice(cursor, token.start) + literalOf(values[next.text]!, escapeBackslashes)
    cursor = next.end
    i += 1
  }

  return out + text.slice(cursor)
}

function literalOf(value: string, escapeBackslashes: boolean): string {
  if (value.trim().toUpperCase() === 'NULL') return 'null'
  if (/^-?\d+(\.\d+)?$/.test(value.trim())) return value.trim()
  if (/^(true|false)$/i.test(value.trim())) return value.trim().toLowerCase()

  return sqlLiteral(value, escapeBackslashes)
}
