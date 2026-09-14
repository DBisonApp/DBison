import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A stand-in keychain whose availability each test chooses; the "encryption"
// is only a marker so the file contents can be checked.
const safeStorage = vi.hoisted(() => ({
  available: false,
  isEncryptionAvailable: () => safeStorage.available,
  encryptString: (text) => Buffer.from(`enc:${text}`),
  decryptString: (buffer) => buffer.toString().slice(4),
}))

vi.mock('electron', () => ({ app: { getPath: () => '' }, safeStorage }))

const { ConnectionStore } = await import('../electron/connection-store.js')

const profile = { name: 'pg', driver: 'postgres', host: '127.0.0.1', port: 5432, username: 'me' }

describe('ConnectionStore secrets', () => {
  let directory

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'dbison-store-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('keeps a password in memory only when there is no keychain', async () => {
    safeStorage.available = false
    const store = new ConnectionStore(directory)
    const saved = await store.save({ ...profile, password: 'hunter2' })

    expect(saved.hasStoredPassword).toBe(true)
    expect(store.secretFor(saved.id)).toBe('hunter2')
    expect(await readFile(path.join(directory, 'connections.json'), 'utf8')).not.toContain('hunter2')

    // Renaming without retyping keeps it; clearing the field drops it.
    await store.save({ ...profile, id: saved.id, name: 'renamed' })
    expect(store.secretFor(saved.id)).toBe('hunter2')
    await store.save({ ...profile, id: saved.id, password: '' })
    expect(store.secretFor(saved.id)).toBeUndefined()
  })

  it('forgets the in-memory password on restart', async () => {
    safeStorage.available = false
    const saved = await new ConnectionStore(directory).save({ ...profile, password: 'hunter2' })

    const restarted = new ConnectionStore(directory)
    const [listed] = await restarted.load()
    expect(listed.hasStoredPassword).toBe(false)
    expect(restarted.secretFor(saved.id)).toBeUndefined()
  })

  it('writes an encrypted password that survives a restart when the keychain works', async () => {
    safeStorage.available = true
    const saved = await new ConnectionStore(directory).save({ ...profile, password: 'hunter2' })

    const restarted = new ConnectionStore(directory)
    await restarted.load()
    expect(restarted.secretFor(saved.id)).toBe('hunter2')
  })
})
