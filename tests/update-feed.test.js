import { describe, expect, it } from 'vitest'

import { updateFeed } from '../shared/update-feed.js'

describe('updateFeed', () => {
  it('stays dormant until bucket and endpoint are both set', () => {
    expect(updateFeed({})).toBeNull()
    expect(updateFeed({ updates: { bucket: 'b' } })).toBeNull()
    expect(updateFeed({ updates: { bucket: 'b', endpoint: 'not a url' } })).toBeNull()
  })

  it('derives the virtual-host public URL from a Spaces endpoint', () => {
    const feed = updateFeed({ updates: { bucket: 'rel', endpoint: 'https://fra1.digitaloceanspaces.com/' } })
    expect(feed).toMatchObject({ bucket: 'rel', endpoint: 'https://fra1.digitaloceanspaces.com', region: 'us-east-1', folder: 'dbison' })
    expect(feed.baseUrl('win32', 'x64')).toBe('https://rel.fra1.digitaloceanspaces.com/dbison/win32/x64')
  })

  it('honours a custom public URL, folder and region', () => {
    const feed = updateFeed({ updates: { bucket: 'rel', endpoint: 'https://fra1.digitaloceanspaces.com', publicUrl: 'https://cdn.example.com/', folder: '/app/', region: 'fra1' } })
    expect(feed.region).toBe('fra1')
    expect(feed.baseUrl('darwin', 'arm64')).toBe('https://cdn.example.com/app/darwin/arm64')
  })
})
