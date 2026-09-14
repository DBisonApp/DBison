import type { ConnectionProfileInput, DriverId } from '#shared/db-types'

/** What a URL's scheme says the engine is. */
const SCHEMES: Record<string, DriverId> = {
  postgres: 'postgres',
  postgresql: 'postgres',
  pg: 'postgres',
  mysql: 'mysql',
  mariadb: 'mariadb',
  sqlite: 'sqlite',
  file: 'sqlite',
}

/**
 * Reads a connection URL — `postgres://user:pass@host:5432/db?sslmode=require`,
 * `mysql://…`, `sqlite:///C:/data/app.db` — into the dialog's fields.
 *
 * Every hosting provider hands one of these out, and typing it apart into
 * six boxes is the least pleasant minute of setting up a client. Only the
 * parts present are returned, so pasting over a half-filled form keeps the
 * rest. Returns null for anything that is not a URL for a known engine.
 */
export function parseConnectionUrl(text: string): Partial<ConnectionProfileInput> | null {
  const trimmed = text.trim()
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed)?.[1]?.toLowerCase()
  const driver = scheme ? SCHEMES[scheme] : undefined
  if (!driver) return null

  if (driver === 'sqlite') {
    // `sqlite:///C:/x.db` and `sqlite://x.db` both mean the path after the
    // slashes; a Windows drive letter is kept as written.
    const file = decodeURIComponent(trimmed.replace(/^[a-z]+:\/\/\/?/i, ''))
    return file ? { driver, file } : { driver }
  }

  // WHATWG URL does not parse unknown schemes with hosts reliably, so the
  // scheme is swapped for http before parsing and never read back.
  let url: URL
  try {
    url = new URL(trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, 'http://'))
  }
  catch {
    return null
  }

  const fields: Partial<ConnectionProfileInput> = { driver }

  if (url.hostname) fields.host = decodeURIComponent(url.hostname)
  if (url.port) fields.port = Number(url.port)
  if (url.username) fields.username = decodeURIComponent(url.username)
  if (url.password) fields.password = decodeURIComponent(url.password)

  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (database) fields.database = database

  const sslMode = url.searchParams.get('sslmode') ?? url.searchParams.get('ssl-mode') ?? url.searchParams.get('ssl')
  if (sslMode) {
    const mode = sslMode.toLowerCase()
    fields.ssl = !['disable', 'disabled', 'false', '0', 'allow'].includes(mode)
    fields.sslVerify = ['verify-ca', 'verify-full', 'verify_ca', 'verify_identity', 'true'].includes(mode)
  }

  const ca = url.searchParams.get('sslrootcert') ?? url.searchParams.get('ssl-ca')
  if (ca) fields.sslCa = ca

  return fields
}
