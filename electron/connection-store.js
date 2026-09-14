import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { app, safeStorage } from 'electron'

const FILE_NAME = 'connections.json'
const FORMAT_VERSION = 1

/**
 * Persists connection profiles.
 *
 * Passwords never sit in the JSON in clear text: they go through Electron's
 * `safeStorage`, which is backed by the OS keychain (DPAPI on Windows, Keychain
 * on macOS, libsecret on Linux). Where the OS refuses to provide encryption the
 * password is dropped rather than written in the clear, and the user is asked
 * for it per session.
 */
export class ConnectionStore {
  #file
  /** @type {Map<string, object>} id -> profile including its encrypted secret */
  #profiles = new Map()

  constructor(directory = app.getPath('userData')) {
    this.#file = path.join(directory, FILE_NAME)
  }

  async load() {
    try {
      const raw = await readFile(this.#file, 'utf8')
      const parsed = JSON.parse(raw)

      for (const profile of parsed.profiles ?? []) {
        this.#profiles.set(profile.id, profile)
      }
    }
    catch (error) {
      // A missing file is simply a first run. Anything else (corrupt JSON, bad
      // permissions) must be visible rather than silently starting empty.
      if (error.code !== 'ENOENT') throw error
    }

    return this.list()
  }

  async #persist() {
    await mkdir(path.dirname(this.#file), { recursive: true })

    const payload = JSON.stringify(
      { version: FORMAT_VERSION, profiles: [...this.#profiles.values()] },
      null,
      2,
    )

    // Write-then-rename, so a crash mid-write cannot leave a truncated file
    // that would lose every saved connection.
    const temporary = `${this.#file}.tmp`
    await writeFile(temporary, payload, 'utf8')
    await rename(temporary, this.#file)
  }

  /** Profiles as the renderer sees them: no secrets, encrypted or otherwise. */
  list() {
    return [...this.#profiles.values()].map(({ secret, sshSecret, ...profile }) => ({
      ...profile,
      hasStoredPassword: Boolean(secret),
      hasStoredSshSecret: Boolean(sshSecret),
    }))
  }

  /** The decrypted SSH password or passphrase, or undefined when none is stored. */
  sshSecretFor(id) {
    const stored = this.#profiles.get(id)?.sshSecret
    if (!stored) return undefined

    try {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'))
    }
    catch {
      return undefined
    }
  }

  get(id) {
    return this.#profiles.get(id) ?? null
  }

  /** The decrypted password for a profile, or undefined when none is stored. */
  secretFor(id) {
    const stored = this.#profiles.get(id)?.secret
    if (!stored) return undefined

    try {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'))
    }
    catch {
      // Keychain entry from another machine or a reset OS profile.
      return undefined
    }
  }

  async save(input) {
    const id = input.id ?? `conn-${randomUUID()}`
    const existing = this.#profiles.get(id)

    const profile = {
      id,
      name: input.name,
      driver: input.driver,
      host: input.host ?? undefined,
      port: input.port ?? undefined,
      database: input.database ?? undefined,
      username: input.username ?? undefined,
      file: input.file ?? undefined,
      ssl: Boolean(input.ssl),
      sslVerify: Boolean(input.sslVerify),
      sslCa: typeof input.sslCa === 'string' && input.sslCa.trim() ? input.sslCa.trim() : undefined,
      sslCert: typeof input.sslCert === 'string' && input.sslCert.trim() ? input.sslCert.trim() : undefined,
      sslKey: typeof input.sslKey === 'string' && input.sslKey.trim() ? input.sslKey.trim() : undefined,
      ssh: input.ssh?.enabled
        ? {
            enabled: true,
            host: String(input.ssh.host ?? '').trim() || undefined,
            port: Number.isInteger(input.ssh.port) ? input.ssh.port : 22,
            username: String(input.ssh.username ?? '').trim() || undefined,
            keyPath: String(input.ssh.keyPath ?? '').trim() || undefined,
          }
        : undefined,
      noHistory: Boolean(input.noHistory),
      // The SSH password (or key passphrase) is kept like the database
      // password: encrypted, or not at all.
      sshSecret: existing?.sshSecret,
      // A colour is kept only in the one shape the renderer paints with; an
      // unexpected string is dropped rather than written into a style.
      color: /^#[0-9a-f]{6}$/i.test(input.color ?? '') ? input.color.toLowerCase() : undefined,
      readOnly: Boolean(input.readOnly),
      // A heading in the connection list; free text, trimmed and bounded.
      folder: typeof input.folder === 'string' && input.folder.trim() ? input.folder.trim().slice(0, 80) : undefined,
      // Keep the stored secret when the caller did not send a new one, so
      // editing a name does not wipe the password.
      secret: existing?.secret,
    }

    if (input.password === '') {
      profile.secret = undefined
    }
    else if (typeof input.password === 'string') {
      profile.secret = safeStorage.isEncryptionAvailable()
        ? safeStorage.encryptString(input.password).toString('base64')
        : undefined
    }

    if (input.sshPassword === '' || !profile.ssh) {
      profile.sshSecret = undefined
    }
    else if (typeof input.sshPassword === 'string') {
      profile.sshSecret = safeStorage.isEncryptionAvailable()
        ? safeStorage.encryptString(input.sshPassword).toString('base64')
        : undefined
    }

    this.#profiles.set(id, profile)
    await this.#persist()

    const { secret, sshSecret, ...visible } = profile
    return { ...visible, hasStoredPassword: Boolean(secret), hasStoredSshSecret: Boolean(sshSecret) }
  }

  async delete(id) {
    this.#profiles.delete(id)
    await this.#persist()
  }

  /** True when passwords can be stored at all on this machine. */
  static canStoreSecrets() {
    return safeStorage.isEncryptionAvailable()
  }
}
