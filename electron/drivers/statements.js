/**
 * Leading whitespace and comments, which say nothing about what a statement
 * does. Postgres nests block comments; a nested one here is misread, which
 * only sends the statement down the unstreamed path.
 */
const LEADING_NOISE = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/

/**
 * The first keyword of a statement, lower-cased, or an empty string when the
 * text opens with something else — a parenthesis, say.
 */
export function leadingKeyword(sql) {
  const match = /^[a-z_]+/i.exec(String(sql).replace(LEADING_NOISE, ''))
  return match ? match[0].toLowerCase() : ''
}

/**
 * The statements the server drivers stream rather than fetch whole.
 *
 * A cursor — which is what streaming is, on both engines — can read a result
 * set a batch at a time and stop at the display cap, but it is the wrong tool
 * for a statement that produces none: a Postgres portal reports no row count
 * for a plain INSERT, and a script of several statements cannot be prepared
 * as one at all. So the choice is made per statement, on its first keyword:
 * one that opens a result set is streamed, and everything else — DML, DDL,
 * `set`, `begin`, a multi-statement script — keeps the path that fetches the
 * whole reply and reads the command tag off it.
 */
const STREAMED = new Set(['select', 'with', 'values', 'table', 'show', 'explain'])

export function isRowProducing(sql) {
  return STREAMED.has(leadingKeyword(sql))
}

/** Statements that only read, as their first word says. */
const READ_ONLY = new Set(['select', 'with', 'show', 'explain', 'describe', 'desc', 'pragma', 'values', 'table'])

/**
 * Whether a statement could change anything, judged by its first keyword.
 *
 * A guess on purpose, and one that errs towards "yes": `with … as (delete …)`
 * writes and is counted as a read here, but the guard this feeds asks the
 * user rather than refusing, so the cost of the miss is one dialog not shown.
 * The renderer makes the same guess before it asks; this is the copy the
 * main process checks, so a renderer that forgot to ask still cannot write.
 */
export function mayWrite(sql) {
  const keyword = leadingKeyword(sql)
  return !keyword || !READ_ONLY.has(keyword)
}
