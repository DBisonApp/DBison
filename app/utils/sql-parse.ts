/**
 * Just enough SQL parsing to know what the caret is looking at.
 *
 * A real grammar is the wrong tool here: the text under an editing caret is
 * usually not valid SQL, and a parser that fails on it would leave the user
 * without completions exactly while they are typing. This reads the statement
 * as a flat token stream instead, which degrades into "no idea, offer
 * everything" rather than into nothing at all.
 *
 * Everything in this file is pure and offset-based so it can be memoized
 * against a model version; see `useSqlCompletions`.
 */

export type SqlTokenKind = 'word' | 'quoted' | 'string' | 'comment' | 'number' | 'punct'

export interface SqlToken {
  kind: SqlTokenKind
  /** The source text, exactly as written. */
  text: string
  start: number
  end: number
}

/** A table named in the statement, with the alias the rest of it uses. */
export interface SqlTableRef {
  schema?: string
  name: string
  alias?: string
  /** Where the name ends, so "is the caret in the alias slot?" is answerable. */
  nameEnd: number
}

/**
 * The part of a statement the caret sits in. Not every clause of SQL is worth
 * telling apart — only the ones that ask for different names.
 */
export type SqlClause =
  | 'select' // and every other place an expression may go
  | 'from' // and INSERT INTO, UPDATE, DELETE FROM: a table belongs here
  | 'join'
  | 'on'
  | 'none'

export interface SqlCursorContext {
  clause: SqlClause
  /** Dotted prefix before the caret: `s.t.|` is `['s', 't']`. */
  qualifier: string[]
  /** The partial identifier under the caret. */
  word: string
  /** Where that identifier starts, which is what a completion replaces. */
  wordStart: number
  /** Tables the statement has in scope, in the order they were named. */
  tables: SqlTableRef[]
  /** The caret is where a table's alias would go: `from users |`. */
  atAlias: boolean
}

const IDENT_START = /[A-Za-z_\u0080-\uFFFF]/
const IDENT_PART = /[A-Za-z0-9_$\u0080-\uFFFF]/

/** Closing delimiter for each opening one, for the quoted-identifier forms. */
const QUOTES: Record<string, string> = { '"': '"', '`': '`', '[': ']' }

/**
 * Splits SQL into tokens, tolerating anything.
 *
 * The point of tokenizing at all is that a semicolon inside a string is not a
 * statement break and a keyword inside a comment is not a keyword — the two
 * mistakes that make a naive regex approach worse than useless on real scripts.
 */
export function tokenize(text: string): SqlToken[] {
  const tokens: SqlToken[] = []
  const length = text.length
  let i = 0

  while (i < length) {
    const char = text[i]!

    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      i++
      continue
    }

    const start = i

    // -- to end of line
    if (char === '-' && text[i + 1] === '-') {
      while (i < length && text[i] !== '\n') i++
      tokens.push({ kind: 'comment', text: text.slice(start, i), start, end: i })
      continue
    }

    // /* ... */, not nested: neither engine we speak to nests them.
    if (char === '/' && text[i + 1] === '*') {
      i += 2
      while (i < length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i = Math.min(i + 2, length)
      tokens.push({ kind: 'comment', text: text.slice(start, i), start, end: i })
      continue
    }

    if (char === '\'') {
      i++
      while (i < length) {
        // A backslash escape is MySQL's; a doubled quote is everyone's.
        if (text[i] === '\\') { i += 2; continue }
        if (text[i] === '\'') {
          if (text[i + 1] === '\'') { i += 2; continue }
          i++
          break
        }
        i++
      }
      tokens.push({ kind: 'string', text: text.slice(start, i), start, end: i })
      continue
    }

    // Postgres dollar quoting: $$ ... $$ or $tag$ ... $tag$. Function bodies
    // are full of semicolons, and without this every one of them would look
    // like the end of the statement.
    if (char === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(text.slice(i, i + 64))?.[0]

      if (tag) {
        const close = text.indexOf(tag, i + tag.length)
        i = close === -1 ? length : close + tag.length
        tokens.push({ kind: 'string', text: text.slice(start, i), start, end: i })
        continue
      }
    }

    const closer = QUOTES[char]

    if (closer) {
      i++
      while (i < length) {
        if (text[i] === closer) {
          if (text[i + 1] === closer) { i += 2; continue }
          i++
          break
        }
        i++
      }
      tokens.push({ kind: 'quoted', text: text.slice(start, i), start, end: i })
      continue
    }

    if (IDENT_START.test(char)) {
      while (i < length && IDENT_PART.test(text[i]!)) i++
      tokens.push({ kind: 'word', text: text.slice(start, i), start, end: i })
      continue
    }

    if (char >= '0' && char <= '9') {
      while (i < length && /[0-9.eE+-]/.test(text[i]!)) {
        // Only ever part of an exponent, never of the next token.
        if ((text[i] === '+' || text[i] === '-') && !/[eE]/.test(text[i - 1] ?? '')) break
        i++
      }
      tokens.push({ kind: 'number', text: text.slice(start, i), start, end: i })
      continue
    }

    i++
    tokens.push({ kind: 'punct', text: char, start, end: i })
  }

  return tokens
}

/** The name a token stands for, with any quoting removed. */
export function identifierOf(token: SqlToken): string {
  if (token.kind === 'word') return token.text
  if (token.kind !== 'quoted') return ''

  const closer = QUOTES[token.text[0]!] ?? '"'
  const inner = token.text.slice(1, token.text.endsWith(closer) ? -1 : undefined)

  return inner.replaceAll(closer + closer, closer)
}

function isIdentifier(token: SqlToken | undefined): token is SqlToken {
  return token?.kind === 'word' || token?.kind === 'quoted'
}

/**
 * Token index range of the statement containing `offset`.
 *
 * Splitting on semicolons is what makes a scratch buffer of a dozen statements
 * behave like a dozen separate ones: the tables named three statements ago are
 * not in scope here.
 */
export function statementRange(tokens: SqlToken[], offset: number): [number, number] {
  let start = 0
  let end = tokens.length

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!

    if (token.kind !== 'punct' || token.text !== ';') continue

    if (token.end <= offset) start = i + 1
    else { end = i; break }
  }

  return [start, end]
}

/** Words that end a table reference, so they can never be its alias. */
const NOT_AN_ALIAS = new Set([
  'select', 'from', 'where', 'join', 'inner', 'left', 'right', 'full', 'outer', 'cross',
  'natural', 'on', 'using', 'group', 'order', 'having', 'limit', 'offset', 'fetch',
  'union', 'intersect', 'except', 'set', 'values', 'returning', 'and', 'or', 'not',
  'into', 'update', 'delete', 'insert', 'with', 'as', 'for', 'window', 'lateral',
])

/** Where a table name is expected next. */
const TABLE_INTRODUCERS = new Set(['from', 'join', 'into', 'update', 'straight_join'])

/**
 * Clause keywords, as seen scanning backwards from the caret. `by` is absent on
 * purpose: it is reached through `group`/`order`, and both want expressions.
 */
const CLAUSE_OF: Partial<Record<string, SqlClause>> = {
  select: 'select',
  where: 'select',
  having: 'select',
  by: 'select',
  set: 'select',
  values: 'select',
  returning: 'select',
  when: 'select',
  then: 'select',
  case: 'select',
  from: 'from',
  into: 'from',
  update: 'from',
  table: 'from',
  join: 'join',
  on: 'on',
  using: 'on',
}

/**
 * Reads the tables a statement has in scope.
 *
 * Subqueries are deliberately not scoped: a correlated one may reference the
 * outer query's tables, and offering a column that turns out not to be in scope
 * costs the user one rejected suggestion, while withholding one that is costs
 * them the feature.
 */
function collectTables(tokens: SqlToken[], from: number, to: number): SqlTableRef[] {
  const tables: SqlTableRef[] = []

  for (let i = from; i < to; i++) {
    const token = tokens[i]!

    if (token.kind !== 'word' || !TABLE_INTRODUCERS.has(token.text.toLowerCase())) continue

    // `delete from`, `insert into`, `from only t` (Postgres).
    let j = i + 1

    for (;;) {
      while (tokens[j]?.kind === 'word' && tokens[j]!.text.toLowerCase() === 'only') j++

      // A derived table brings no names of its own that we can read.
      if (tokens[j]?.kind === 'punct' && tokens[j]!.text === '(') break
      if (!isIdentifier(tokens[j])) break

      // `delete from where ...` while it is still being typed: a keyword here
      // is the rest of the statement, not a table nobody has named yet.
      if (tokens[j]!.kind === 'word' && NOT_AN_ALIAS.has(tokens[j]!.text.toLowerCase())) break

      const parts = [identifierOf(tokens[j]!)]
      let nameEnd = tokens[j]!.end
      j++

      while (tokens[j]?.kind === 'punct' && tokens[j]!.text === '.' && isIdentifier(tokens[j + 1])) {
        parts.push(identifierOf(tokens[j + 1]!))
        nameEnd = tokens[j + 1]!.end
        j += 2
      }

      let alias: string | undefined

      if (tokens[j]?.kind === 'word' && tokens[j]!.text.toLowerCase() === 'as') j++

      if (isIdentifier(tokens[j]) && !NOT_AN_ALIAS.has(tokens[j]!.text.toLowerCase())) {
        alias = identifierOf(tokens[j]!)
        j++
      }

      tables.push({
        // The leading part of a three-part name is the database, which the tab
        // is already pointed at; only the schema changes what is looked up.
        schema: parts.length > 1 ? parts.at(-2) : undefined,
        name: parts.at(-1)!,
        alias,
        nameEnd,
      })

      // `from a, b` — one introducer, several tables.
      if (tokens[j]?.kind === 'punct' && tokens[j]!.text === ',') { j++; continue }
      break
    }

    i = j - 1
  }

  return tables
}

/**
 * What the caret is looking at: the clause it sits in, the qualifier typed
 * before it, and the tables the statement has in scope.
 */
export function analyzeSql(tokens: SqlToken[], offset: number): SqlCursorContext {
  const [from, to] = statementRange(tokens, offset)

  // The last token that starts before the caret, and whether the caret is
  // inside it: `use|rs` completes the word it is in, `users |` starts a new one.
  let index = from - 1
  for (let i = from; i < to; i++) {
    if (tokens[i]!.start >= offset) break
    index = i
  }

  const current = index >= from ? tokens[index]! : undefined
  const inWord = current && offset <= current.end && isIdentifier(current)

  let word = ''
  let wordStart = offset
  let chainAt = index

  if (inWord) {
    // Only the part before the caret filters the list; whatever follows it is
    // replaced when a suggestion is accepted.
    const typed = current.text.slice(0, offset - current.start)

    word = current.kind === 'quoted' ? typed.slice(1) : typed
    wordStart = current.start
    chainAt = index - 1
  }

  const qualifier: string[] = []

  // `schema.table.|` — walk the dotted chain back from the caret.
  while (
    tokens[chainAt]?.kind === 'punct' && tokens[chainAt]!.text === '.'
    && isIdentifier(tokens[chainAt - 1]) && chainAt - 1 >= from
  ) {
    qualifier.unshift(identifierOf(tokens[chainAt - 1]!))
    chainAt -= 2
  }

  return {
    clause: clauseAt(tokens, from, inWord ? index - 1 : index),
    qualifier,
    word,
    wordStart,
    tables: collectTables(tokens, from, to),
    atAlias: isAliasSlot(tokens, from, inWord ? index - 1 : index),
  }
}

/**
 * Scans backwards for the keyword that opened the clause the caret is in.
 *
 * A balanced group is skipped whole — `count(*)` says nothing about the clause
 * around it — but an unclosed `(` is walked straight through, because that is
 * a subquery the caret is inside and its own keywords are the relevant ones.
 */
function clauseAt(tokens: SqlToken[], from: number, index: number): SqlClause {
  let depth = 0

  for (let i = index; i >= from; i--) {
    const token = tokens[i]!

    if (token.kind === 'punct') {
      if (token.text === ')') depth++
      else if (token.text === '(' && depth > 0) depth--
      // An unclosed `(` right after a table name is a column list — the one in
      // `insert into users (|)`. What belongs there is columns of that table,
      // which is what every expression position wants.
      else if (token.text === '(' && isAliasSlot(tokens, from, i - 1)) return 'select'
      continue
    }

    if (depth > 0 || token.kind !== 'word') continue

    // A word that opens no clause of its own — AND, a column name, a function
    // — leaves the caret in whatever clause it was already in.
    const clause = CLAUSE_OF[token.text.toLowerCase()]
    if (clause) return clause
  }

  return 'none'
}

/** True where an alias would go: directly after a table name in FROM or JOIN. */
function isAliasSlot(tokens: SqlToken[], from: number, index: number): boolean {
  if (!isIdentifier(tokens[index])) return false

  // Step back over the dotted name to whatever introduced it.
  let i = index
  while (tokens[i - 1]?.kind === 'punct' && tokens[i - 1]!.text === '.' && isIdentifier(tokens[i - 2])) i -= 2

  const introducer = tokens[i - 1]
  if (i - 1 < from || introducer?.kind !== 'word') return false

  return TABLE_INTRODUCERS.has(introducer.text.toLowerCase())
}

/** The token at an offset, for hover. */
export function tokenAt(tokens: SqlToken[], offset: number): SqlToken | null {
  for (const token of tokens) {
    if (token.start > offset) break
    if (token.end >= offset) return token
  }

  return null
}
