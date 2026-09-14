import { describe, expect, it } from 'vitest'

import { fromPgpassLine, parseConnectionImport } from '../app/utils/connection-import'

describe('parseConnectionImport', () => {
  it('reads the app export, dropping ids and stored-secret flags', () => {
    const text = JSON.stringify({
      dbison: 1,
      connections: [
        { id: 'abc', name: 'Shop', driver: 'postgres', host: 'db', port: 5432, folder: 'Production', hasStoredPassword: true },
        { name: '', driver: 'postgres' },
        'nonsense',
      ],
    })

    expect(parseConnectionImport(text)).toEqual({
      source: 'dbison',
      skipped: 2,
      profiles: [{ name: 'Shop', driver: 'postgres', host: 'db', port: 5432, folder: 'Production' }],
    })
  })

  it('ignores fields the profile does not have', () => {
    const text = JSON.stringify({ dbison: 1, connections: [{ name: 'X', driver: 'sqlite', file: 'a.db', evil: 1 }] })
    const [profile] = parseConnectionImport(text).profiles

    expect(profile).toEqual({ name: 'X', driver: 'sqlite', file: 'a.db' })
    expect(profile).not.toHaveProperty('evil')
  })

  it('reads a pgpass file with escapes, comments and wildcards', () => {
    const text = [
      '# production',
      'db.example.com:5432:shop:alice:s3cret',
      '',
      'localhost:5432:*:bob:x',
      String.raw`host\:weird:5433:db:carol:pa\\ss\:word`,
      'garbage line',
    ].join('\n')

    expect(parseConnectionImport(text)).toEqual({
      source: 'pgpass',
      skipped: 2,
      profiles: [
        { name: 'alice@db.example.com/shop', driver: 'postgres', host: 'db.example.com', port: 5432, database: 'shop', username: 'alice', password: 's3cret' },
        { name: 'carol@host:weird/db', driver: 'postgres', host: 'host:weird', port: 5433, database: 'db', username: 'carol', password: String.raw`pa\ss:word` },
      ],
    })
  })

  it('reads one url per line and keeps the password', () => {
    const text = [
      'postgres://alice:pw@db:5432/shop?sslmode=require',
      '# a comment',
      'mysql://root@localhost/app',
      'sqlite:///C:/data/local.db',
      'https://not-a-database',
    ].join('\r\n')

    const result = parseConnectionImport(text)

    expect(result.source).toBe('urls')
    expect(result.skipped).toBe(1)
    expect(result.profiles.map((p) => p.name)).toEqual(['alice@db/shop', 'root@localhost/app', 'local'])
    expect(result.profiles[0]).toMatchObject({ driver: 'postgres', password: 'pw', ssl: true })
    expect(result.profiles[2]).toMatchObject({ driver: 'sqlite', file: 'C:/data/local.db' })
  })

  it('counts everything as skipped when nothing is recognised', () => {
    expect(parseConnectionImport('{"not":"ours"}')).toEqual({ source: 'pgpass', skipped: 1, profiles: [] })
    expect(parseConnectionImport('')).toEqual({ source: 'pgpass', skipped: 0, profiles: [] })
  })
})

describe('fromPgpassLine', () => {
  it('rejects wildcard hosts and ports, and non-numeric ports', () => {
    expect(fromPgpassLine('*:5432:db:u:p')).toBeNull()
    expect(fromPgpassLine('h:*:db:u:p')).toBeNull()
    expect(fromPgpassLine('h:abc:db:u:p')).toBeNull()
    expect(fromPgpassLine('h:5432:db:u')).toBeNull()
  })

  it('keeps a wildcard user and an empty password', () => {
    expect(fromPgpassLine('h::db:*:')).toEqual({
      name: '*@h/db',
      driver: 'postgres',
      host: 'h',
      port: undefined,
      database: 'db',
      username: '*',
      password: undefined,
    })
  })
})
