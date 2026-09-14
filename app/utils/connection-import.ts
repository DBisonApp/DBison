import type { ConnectionProfileInput } from '#shared/db-types'
import { parseConnectionUrl } from '~/utils/connection-url'

/** The shape `exportProfiles()` writes; the version is for a future reader. */
export const CONNECTION_EXPORT_VERSION = 1

export interface ConnectionImport {
  profiles: ConnectionProfileInput[]
  /** Lines or entries that were neither a connection nor a comment. */
  skipped: number
  source: 'dbison' | 'pgpass' | 'urls'
}

/**
 * The fields an export carries and an import is allowed to set. An allow-list
 * rather than a spread: a file from elsewhere could name anything, and the
 * main process trusts the renderer to hand it a profile, not a payload.
 */
const PROFILE_FIELDS = [
  'name',
  'driver',
  'host',
  'port',
  'database',
  'username',
  'file',
  'ssl',
  'sslVerify',
  'sslCa',
  'sslCert',
  'sslKey',
  'ssh',
  'noHistory',
  'color',
  'folder',
  'readOnly',
  'password',
  'sshPassword',
] as const satisfies readonly (keyof ConnectionProfileInput)[]

/**
 * Reads connections out of a file the user picked.
 *
 * Three formats, tried in order: this app's own export, a libpq `.pgpass`
 * file, and a plain list of connection URLs — the last two because that is
 * what people already have lying around. Comment lines and blank lines are
 * ignored in the line-based formats; anything else that does not parse is
 * counted rather than aborting the import, so one bad line does not cost the
 * other forty.
 */
export function parseConnectionImport(text: string): ConnectionImport {
  const fromExport = parseExport(text)
  if (fromExport) return fromExport

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))

  // The first real line decides the format: a `.pgpass` line splits into five
  // fields on `:`, but so does `postgres://user:pass@host:5432/db`, so the URL
  // reading has to win when it applies at all.
  const source = lines.length && parseConnectionUrl(lines[0]!) ? 'urls' : 'pgpass'
  const profiles: ConnectionProfileInput[] = []
  let skipped = 0

  for (const line of lines) {
    const profile = source === 'urls' ? fromUrl(line) : fromPgpassLine(line)
    if (profile) profiles.push(profile)
    else skipped += 1
  }

  return { profiles, skipped, source }
}

function parseExport(text: string): ConnectionImport | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  }
  catch {
    return null
  }

  if (!isRecord(parsed) || typeof parsed.dbison !== 'number' || !Array.isArray(parsed.connections)) return null

  const profiles: ConnectionProfileInput[] = []
  let skipped = 0

  for (const entry of parsed.connections) {
    const profile = fromExportEntry(entry)
    if (profile) profiles.push(profile)
    else skipped += 1
  }

  return { profiles, skipped, source: 'dbison' }
}

function fromExportEntry(entry: unknown): ConnectionProfileInput | null {
  if (!isRecord(entry) || typeof entry.name !== 'string' || !entry.name.trim() || typeof entry.driver !== 'string') return null

  const profile: Record<string, unknown> = {}
  for (const field of PROFILE_FIELDS) {
    if (entry[field] !== undefined) profile[field] = entry[field]
  }

  return { ...profile, name: entry.name.trim() } as ConnectionProfileInput
}

/**
 * One `hostname:port:database:username:password` line. libpq's escaping is
 * just `\:` and `\\`; any other backslash is literal. A wildcard host, port
 * or database names no server to dial, so such a line is skipped; a wildcard
 * user is kept as written, which is at least a profile to correct.
 */
export function fromPgpassLine(line: string): ConnectionProfileInput | null {
  const fields = splitPgpass(line)
  if (fields.length !== 5) return null

  const [host, port, database, username, password] = fields as [string, string, string, string, string]
  if (!host || host === '*' || port === '*' || database === '*') return null

  const portNumber = port ? Number(port) : undefined
  if (portNumber !== undefined && !Number.isInteger(portNumber)) return null

  return {
    name: connectionName({ host, database, username }),
    driver: 'postgres',
    host,
    port: portNumber,
    database,
    username,
    password: password || undefined,
  }
}

function splitPgpass(line: string): string[] {
  const fields: string[] = []
  let current = ''

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!
    const next = line[i + 1]

    if (char === '\\' && (next === ':' || next === '\\')) {
      current += next
      i += 1
    }
    else if (char === ':') {
      fields.push(current)
      current = ''
    }
    else {
      current += char
    }
  }

  fields.push(current)
  return fields
}

function fromUrl(line: string): ConnectionProfileInput | null {
  const parsed = parseConnectionUrl(line)
  if (!parsed?.driver) return null

  if (parsed.driver === 'sqlite') {
    if (!parsed.file) return null
    const base = parsed.file.split(/[/\\]/).pop() ?? parsed.file
    return { ...parsed, driver: parsed.driver, name: base.replace(/\.[^.]+$/, '') || base }
  }

  if (!parsed.host) return null
  return { ...parsed, driver: parsed.driver, name: connectionName(parsed) }
}

/** `user@host/db`, dropping whichever parts the source did not have. */
function connectionName(fields: { host?: string, database?: string, username?: string }): string {
  const where = [fields.host, fields.database].filter(Boolean).join('/')
  return fields.username ? `${fields.username}@${where}` : where
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
