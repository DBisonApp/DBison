import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { app } from 'electron'

const FILE_NAME = 'history.json'
const FORMAT_VERSION = 1

/** Entries kept; the oldest fall off the end. */
const MAX_ENTRIES = 1_000
/** A statement longer than this is kept, but cut: history is a memory, not a backup. */
const MAX_SQL_LENGTH = 20_000
/** Writes are coalesced so a burst of runs is one file write, not ten. */
const WRITE_DELAY_MS = 500

/**
 * Remembers what the query editor ran.
 *
 * Passwords never come near this file: an entry is the statement text, where
 * it ran and how it went. Rerunning the same statement on the same connection
 * bumps the existing entry rather than adding a twin, so a list of the last
 * hundred runs is a list of a hundred different things.
 */
export class HistoryStore {
  #file
  /** @type {object[]} newest first */
  #entries = []
  #writeTimer = null
  #writing = Promise.resolve()

  constructor(directory = app.getPath('userData')) {
    this.#file = path.join(directory, FILE_NAME)
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.#file, 'utf8'))
      this.#entries = Array.isArray(parsed.entries) ? parsed.entries : []
    }
    catch (error) {
      // A missing file is a first run; a corrupt one is not worth losing the
      // app over — history is the one store that may honestly start empty.
      if (error.code !== 'ENOENT') console.warn('[dbison] history unreadable, starting empty:', error.message)
      this.#entries = []
    }
  }

  list() {
    return this.#entries
  }

  add(input) {
    const sql = String(input.sql ?? '').slice(0, MAX_SQL_LENGTH)
    if (!sql.trim() || !input.connectionId) return null

    const outcome = ['ok', 'error', 'cancelled'].includes(input.outcome) ? input.outcome : 'ok'

    const facts = {
      connectionId: String(input.connectionId),
      database: input.database ? String(input.database) : undefined,
      schema: input.schema ? String(input.schema) : undefined,
      sql,
      outcome,
      durationMs: Number.isFinite(input.durationMs) ? Math.round(input.durationMs) : undefined,
      rowCount: Number.isFinite(input.rowCount) ? input.rowCount : undefined,
      affectedRows: Number.isFinite(input.affectedRows) ? input.affectedRows : undefined,
      error: input.error ? String(input.error).slice(0, 2_000) : undefined,
    }

    // The same text on the same connection is the same memory, wherever it
    // sits in the list: it moves to the top with a fresh timestamp.
    const existingAt = this.#entries.findIndex(
      (entry) => entry.connectionId === facts.connectionId && entry.sql === sql,
    )
    const existing = existingAt === -1 ? null : this.#entries.splice(existingAt, 1)[0]

    const entry = {
      id: existing?.id ?? randomUUID(),
      at: Date.now(),
      ...facts,
      runs: (existing?.runs ?? 0) + 1,
    }

    this.#entries.unshift(entry)
    if (this.#entries.length > MAX_ENTRIES) this.#entries.length = MAX_ENTRIES

    this.#schedule()
    return entry
  }

  clear() {
    this.#entries = []
    this.#schedule()
    return { cleared: true }
  }

  /** Forgets one statement: the one with a password in it, usually. */
  remove(id) {
    const before = this.#entries.length
    this.#entries = this.#entries.filter((entry) => entry.id !== id)
    const removed = this.#entries.length !== before
    if (removed) this.#schedule()
    return { removed }
  }

  #schedule() {
    clearTimeout(this.#writeTimer)
    this.#writeTimer = setTimeout(() => { this.#writing = this.#writing.then(() => this.#persist()) }, WRITE_DELAY_MS)
  }

  async #persist() {
    try {
      await mkdir(path.dirname(this.#file), { recursive: true })

      const payload = JSON.stringify({ version: FORMAT_VERSION, entries: this.#entries })

      // Write-then-rename, so a crash mid-write cannot leave a truncated file.
      const temporary = `${this.#file}.tmp`
      await writeFile(temporary, payload, 'utf8')
      await rename(temporary, this.#file)
    }
    catch (error) {
      console.warn('[dbison] history not saved:', error.message)
    }
  }

  /** Writes whatever is pending now; called when the app is quitting. */
  async flush() {
    clearTimeout(this.#writeTimer)
    this.#writing = this.#writing.then(() => this.#persist())
    await this.#writing
  }
}
