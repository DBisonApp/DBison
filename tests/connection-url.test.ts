import { describe, expect, it } from 'vitest'

import { parseConnectionUrl } from '../app/utils/connection-url'

describe('parseConnectionUrl', () => {
  it('reads a postgres url with ssl mode', () => {
    expect(parseConnectionUrl('postgres://alice:s3cret@db.example.com:5433/shop?sslmode=verify-full')).toEqual({
      driver: 'postgres',
      host: 'db.example.com',
      port: 5433,
      username: 'alice',
      password: 's3cret',
      database: 'shop',
      ssl: true,
      sslVerify: true,
    })
  })

  it('reads a sqlite file url', () => {
    expect(parseConnectionUrl('sqlite:///C:/data/app.db')).toEqual({ driver: 'sqlite', file: 'C:/data/app.db' })
  })

  it('rejects anything else', () => {
    expect(parseConnectionUrl('https://example.com')).toBeNull()
    expect(parseConnectionUrl('not a url')).toBeNull()
  })
})
