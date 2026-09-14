import { describe, expect, it } from 'vitest'

import { createRequire } from 'node:module'

import { linuxChannelFile, linuxUpdateManifest, updateFeed } from '../shared/update-feed.js'

// The parser the installed app runs, so the manifest is checked against what
// actually reads it rather than against a YAML library of our choosing.
const { parseUpdateInfo, resolveFiles } = createRequire(import.meta.url)('electron-updater/out/providers/Provider.js')

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

describe('linuxUpdateManifest', () => {
  const manifest = linuxUpdateManifest({
    version: '0.1.3',
    releaseDate: '2026-09-14T00:00:00.000Z',
    files: [
      { url: 'dbison_0.1.3_amd64.deb', sha512: 'ab+/cd==', size: 10 },
      { url: `dbison-0.1.3-1.x86_64.rpm`, sha512: 'ef==', size: 2 },
    ],
  })

  it('names the channel file the way electron-updater asks for it', () => {
    expect(linuxChannelFile('x64')).toBe('latest-linux.yml')
    expect(linuxChannelFile('arm64')).toBe('latest-linux-arm64.yml')
  })

  it('parses in electron-updater and resolves files next to the manifest', () => {
    const info = parseUpdateInfo(manifest, 'latest-linux.yml', new URL('https://b.example.com/dbison/linux/x64/latest-linux.yml'))
    expect(info.version).toBe('0.1.3')

    const files = resolveFiles(info, new URL('https://b.example.com/dbison/linux/x64/'))
    expect(files.map((file) => file.url.href)).toEqual([
      'https://b.example.com/dbison/linux/x64/dbison_0.1.3_amd64.deb',
      'https://b.example.com/dbison/linux/x64/dbison-0.1.3-1.x86_64.rpm',
    ])
    expect(files[0].info).toMatchObject({ sha512: 'ab+/cd==', size: 10 })
  })

  it('quotes values so a stray quote cannot break the YAML', () => {
    const quoted = linuxUpdateManifest({ version: '1', releaseDate: 'd', files: [{ url: `it's.deb`, sha512: 's', size: 1 }] })
    expect(parseUpdateInfo(quoted, 'latest-linux.yml', new URL('https://b.example.com/latest-linux.yml')).files[0].url).toBe(`it's.deb`)
  })
})
