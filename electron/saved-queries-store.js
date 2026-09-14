import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { app } from 'electron'

const FILE_NAME = 'saved-queries.json'
const FORMAT_VERSION = 1

const MAX_NAME_LENGTH = 200
const MAX_SQL_LENGTH = 200_000
const MAX_TAGS = 20

/**
 * The statements kept on purpose.
 *
 * History remembers everything that ran and forgets the oldest; this keeps
 * what was named, for as long as it is wanted. A saved query may belong to a
 * connection — the report that only makes sense against one database — or to
 * none, for the "show me the locks" kind that is the same everywhere.
 */
export class SavedQueriesStore {
  #file
  /** @type {Map<string, object>} */
  #queries = new Map()

  constructor(directory = app.getPath('userData')) {
    this.#file = path.join(directory, FILE_NAME)
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.#file, 'utf8'))
      for (const query of Array.isArray(parsed.queries) ? parsed.queries : []) {
        if (query?.id && typeof query.sql === 'string') this.#queries.set(query.id, query)
      }
    }
    catch (error) {
      // A saved query is something the user typed and named: a file that
      // cannot be read is worth hearing about, unlike a missing one.
      if (error.code !== 'ENOENT') throw error
    }
  }

  /** Most recently changed first. */
  list() {
    return [...this.#queries.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  save(input) {
    const name = String(input?.name ?? '').trim().slice(0, MAX_NAME_LENGTH)
    const sql = String(input?.sql ?? '').slice(0, MAX_SQL_LENGTH)
    if (!name) throw new Error('A saved query needs a name.')
    if (!sql.trim()) throw new Error('A saved query needs a statement.')

    const id = typeof input.id === 'string' && input.id ? input.id : `saved-${randomUUID()}`
    const existing = this.#queries.get(id)
    const now = Date.now()

    const tags = Array.isArray(input.tags)
      ? [...new Set(input.tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))].slice(0, MAX_TAGS)
      : []

    const query = {
      id,
      name,
      sql,
      connectionId: input.connectionId ? String(input.connectionId) : undefined,
      database: input.database ? String(input.database) : undefined,
      schema: input.schema ? String(input.schema) : undefined,
      tags: tags.length ? tags : undefined,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }

    this.#queries.set(id, query)
    this.#persist()
    return query
  }

  remove(id) {
    const removed = this.#queries.delete(id)
    if (removed) this.#persist()
    return { removed }
  }

  #writing = Promise.resolve()

  #persist() {
    this.#writing = this.#writing.then(async () => {
      await mkdir(path.dirname(this.#file), { recursive: true })

      const payload = JSON.stringify({ version: FORMAT_VERSION, queries: [...this.#queries.values()] }, null, 2)

      // Write-then-rename, so a crash mid-write cannot lose the library.
      const temporary = `${this.#file}.tmp`
      await writeFile(temporary, payload, 'utf8')
      await rename(temporary, this.#file)
    }).catch(() => {})

    return this.#writing
  }

  async flush() {
    await this.#writing
  }
}
