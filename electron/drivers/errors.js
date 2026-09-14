/**
 * Connection failures are the errors users hit most, and raw driver text is
 * rarely actionable ("client password must be a string" when the server simply
 * wanted a password). Each driver maps what it knows here; anything unmapped
 * passes through unchanged rather than being flattened into a vague message.
 */

/** Socket-level failures look the same whatever engine is on the other end. */
function describeTransport(error, { host, port }) {
  const where = `${host ?? 'the server'}:${port ?? '?'}`

  switch (error?.code) {
    case 'ECONNREFUSED':
      return `Nothing is listening on ${where}. Is the server running, and is the port right?`
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `Cannot resolve the host "${host}".`
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
      return `Timed out reaching ${where}. A firewall or VPN may be in the way.`
    case 'ECONNRESET':
      return `${where} closed the connection. It may require SSL.`
    default:
      return null
  }
}

/** The socket went, whichever engine was on the other end of it. */
const LOST_TRANSPORT_CODES = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH'])

/**
 * Postgres: the operator-intervention class (57P01 admin_shutdown, 57P02
 * crash_shutdown, 57P03 cannot_connect_now) and the connection-exception
 * class (08000, 08003 does-not-exist, 08006 failure).
 */
const LOST_PG_CODES = new Set(['57P01', '57P02', '57P03', '08000', '08003', '08006'])

/** What pg says on its own behalf when the socket closes under a statement. */
const LOST_PG_MESSAGE = /connection terminated|connection ended|client has encountered a connection error/i

/** mysql2 has a code for it, and one message that arrives with no code at all. */
const LOST_MYSQL_CODES = new Set(['PROTOCOL_CONNECTION_LOST', 'ER_SERVER_SHUTDOWN'])
const LOST_MYSQL_MESSAGE = /can't add new command when connection is in closed state/i

/**
 * Whether an error means the connection itself is gone — the server
 * restarted, the network dropped, an idle timeout fired — as opposed to the
 * statement being wrong. The distinction is what lets the renderer offer a
 * reconnect instead of an error to read. The cause chain is checked too:
 * both drivers wrap what the socket told them at least once.
 */
export function isConnectionLost(error) {
  for (let current = error; current; current = current.cause) {
    const code = current.code ? String(current.code) : ''
    const message = current.message ? String(current.message) : ''

    if (LOST_TRANSPORT_CODES.has(code)) return true
    if (LOST_PG_CODES.has(code) || LOST_PG_MESSAGE.test(message)) return true
    if (LOST_MYSQL_CODES.has(code) || LOST_MYSQL_MESSAGE.test(message)) return true
  }

  return false
}

/**
 * @param {Error & { code?: string }} error
 * @param {{ host?: string, port?: number, database?: string, username?: string, hasPassword: boolean }} context
 * @param {(error: Error, context: object) => string | null} [describeEngine]
 */
export function explainConnectionError(error, context, describeEngine) {
  const message = describeTransport(error, context) ?? describeEngine?.(error, context)
  const lost = isConnectionLost(error)
  if (!message && !lost) return error

  const explained = new Error(message ?? error?.message ?? String(error))
  // The original code still travels to the renderer, which shows it as a
  // secondary line for anyone who needs the engine's own wording.
  explained.code = error?.code
  explained.cause = error
  if (lost) explained.lost = true
  return explained
}

export function describePostgresError(error, { database, username, hasPassword }) {
  // pg raises this from the SASL exchange when the server wants a password and
  // none was configured; the wording is about its own internals, not the user.
  if (!hasPassword && /password must be a string/i.test(error?.message ?? '')) {
    return 'This server requires a password, and none is stored for this connection.'
  }

  switch (error?.code) {
    case '28P01':
      return `Password authentication failed for user "${username}".`
    case '28000':
      return `The server rejected user "${username}". Check pg_hba.conf for this host.`
    case '3D000':
      return `Database "${database}" does not exist on this server.`
    default:
      return null
  }
}

export function describeMysqlError(error, { database, username }) {
  switch (error?.code) {
    case 'ER_ACCESS_DENIED_ERROR':
    case 'ER_NOT_SUPPORTED_AUTH_MODE':
      return `Access denied for user "${username}". Check the username and password.`
    case 'ER_BAD_DB_ERROR':
      return `Database "${database}" does not exist on this server.`
    case 'ER_HOST_NOT_PRIVILEGED':
      return 'This host is not allowed to connect to the server.'
    default:
      return null
  }
}

/**
 * Query errors are the other half of the story, and every engine tells it
 * differently: Postgres reports a character offset, MySQL buries the location
 * in prose ("near 'x' at line 3"), SQLite quotes the offending token and says
 * nothing about where it was. The functions below dig all three out and turn
 * them into one offset into the statement the user typed, which is what the
 * editor needs in order to underline it.
 */

/** What sits at an offset: an identifier, a quoted literal, or a lone symbol. */
const TOKEN_AT = /^(?:[\w$]+|"(?:[^"]|"")*"|`(?:[^`]|``)*`|'(?:[^']|'')*'|\S)/

function tokenLengthAt(sql, offset) {
  return TOKEN_AT.exec(sql.slice(offset))?.[0].length ?? 1
}

function lineStartOffset(sql, line) {
  let offset = 0

  for (let n = 1; n < line; n += 1) {
    const newline = sql.indexOf('\n', offset)
    if (newline === -1) break
    offset = newline + 1
  }

  return offset
}

function lineAndColumn(sql, offset) {
  const before = sql.slice(0, offset)

  return {
    line: before.split('\n').length,
    column: offset - before.lastIndexOf('\n'),
  }
}

function findNear(sql, near, from) {
  // A bare name has to match a whole token: a complaint about the column `id`
  // must not land inside `identity`. Anything else is a fragment of the
  // statement itself, quoted verbatim, and is matched as it stands.
  if (!/^[\w$]+$/.test(near)) return sql.indexOf(near, from)

  const boundary = new RegExp(`\\b${near}\\b`, 'g')
  boundary.lastIndex = from

  return boundary.exec(sql)?.index ?? -1
}

/**
 * Resolves whatever an engine gave us into `{ offset, length, line, column }`.
 * `offset` is 0-based; `line` and `column` are 1-based, as editors count them.
 *
 * @param {string} sql
 * @param {{ offset?: number, near?: string, line?: number }} clues
 */
function locate(sql, { offset, near, line }) {
  let start = offset

  // MySQL and SQLite quote the text at the fault instead of locating it. The
  // quoted fragment is searched for from the reported line, because the same
  // token may well appear earlier in the statement.
  if (start === undefined && near) {
    const from = line ? lineStartOffset(sql, line) : 0
    const found = findNear(sql, near, from)
    start = found === -1 ? findNear(sql, near, 0) : found
    if (start === -1) start = undefined
  }

  // A line number on its own still beats nothing: point at its first
  // non-blank character rather than at the indentation.
  if (start === undefined && line) {
    start = lineStartOffset(sql, line)
    start += /^[ \t]*/.exec(sql.slice(start))[0].length
  }

  if (start === undefined) return null

  // Errors about what the statement is missing are reported one past its end.
  if (start >= sql.length) start = Math.max(0, sql.trimEnd().length - 1)

  return { offset: start, length: tokenLengthAt(sql, start), ...lineAndColumn(sql, start) }
}

export function describePostgresQueryError(error, sql) {
  const position = Number(error?.position)
  if (!Number.isInteger(position) || position < 1) return {}

  // Postgres counts characters, not UTF-16 code units, so a statement holding
  // an emoji or an astral-plane name would otherwise underline the wrong token.
  return { offset: Array.from(sql).slice(0, position - 1).join('').length }
}

/** The manual reference is the same 90 characters on every MySQL parse error. */
const MYSQL_PARSE = /right syntax to use near '([\s\S]*)' at line (\d+)/

/** A misspelled name, which MySQL quotes but never locates. */
const MYSQL_UNKNOWN = /^(?:Unknown column|Unknown table|Table) '([^']+)'/

export function describeMysqlQueryError(error) {
  const message = error?.message ?? ''
  const match = MYSQL_PARSE.exec(message)

  if (!match) {
    // Every other MySQL error already says what it means; only where it went
    // wrong is missing, and the quoted name is the one place worth pointing at.
    // Tables come back schema-qualified ("test.userz"), the statement rarely does.
    const unknown = MYSQL_UNKNOWN.exec(message)?.[1]
    return unknown ? { near: unknown.split('.').at(-1) } : {}
  }

  const [, near, line] = match
  const token = TOKEN_AT.exec(near.trim())?.[0]

  return {
    // The fragment MySQL quotes is the rest of the statement from the fault,
    // truncated at 80 characters — long enough to be unique, so it locates the
    // fault exactly, while the token at its head is what to underline.
    near: near || undefined,
    line: Number(line),
    message: token
      ? `Syntax error near "${token}" on line ${line}.`
      : `The statement ends unexpectedly on line ${line}.`,
  }
}

const SQLITE_SYNTAX = /near "([^"]*)": syntax error/
const SQLITE_TOKEN = /unrecognized token: "([^"]*)"/
const SQLITE_MISSING = /no such (?:table|column|function|index|view|collation sequence): (.+)$/

export function describeSqliteQueryError(error) {
  const message = error?.message ?? ''

  // node:sqlite reports `ERR_SQLITE_ERROR` for everything; `errstr` is the
  // engine's own category ("SQL logic error"), which at least says something.
  const code = error?.errstr ? String(error.errstr) : undefined

  const syntax = SQLITE_SYNTAX.exec(message) ?? SQLITE_TOKEN.exec(message)
  if (syntax) {
    return { code, near: syntax[1] || undefined, message: `Syntax error near "${syntax[1]}".` }
  }

  // "no such column: naem" — the name is the only place worth pointing at.
  const missing = SQLITE_MISSING.exec(message)
  if (missing) return { code, near: missing[1].split('.').at(-1) }

  return { code }
}

/**
 * Rebuilds a failed statement's error with a location the renderer can act on.
 * An engine that said nothing useful is passed through untouched, so nothing is
 * ever lost in the name of tidying it up.
 *
 * @param {Error} error
 * @param {string} sql
 * @param {(error: Error, sql: string) => { offset?: number, near?: string, line?: number, message?: string, code?: string }} describeEngine
 */
export function explainQueryError(error, sql, describeEngine) {
  // A deliberate stop is not a failure and has no place in the statement.
  if (error?.cancelled) return error

  const described = describeEngine(error, sql) ?? {}
  const where = typeof sql === 'string' ? locate(sql, described) : null
  const lost = isConnectionLost(error)

  if (!where && !described.message && !described.code && !lost) return error

  const explained = new Error(described.message ?? error?.message ?? String(error))
  explained.code = described.code ?? error?.code
  explained.detail = error?.detail
  explained.hint = error?.hint
  explained.cause = error
  // Not a fault in the statement at all: the connection under it went away,
  // and the manager drops the session so the renderer can offer a reconnect.
  if (lost) explained.lost = true

  // Rewriting an engine's wording hides the string someone would paste into a
  // search engine, so the original travels alongside rather than instead.
  if (described.message && described.message !== error?.message) explained.raw = error?.message

  if (where) {
    // 1-based, the way Postgres reports it and the way editors count.
    explained.position = where.offset + 1
    explained.length = where.length
    explained.line = where.line
    explained.column = where.column
  }

  return explained
}
