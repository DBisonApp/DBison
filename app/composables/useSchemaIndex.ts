import type { SchemaSnapshot } from '#shared/db-types'

/**
 * Holds one read-ahead copy of each database's structure.
 *
 * `useDbChildren` answers "what is inside this node?" one node at a time, which
 * is right for a picker with two levels in it and useless for anything that
 * needs the whole database at once: nobody will wait a round trip per
 * keystroke, or per table drawn. This is the other shape of the same data — a
 * whole database, read once, kept until the connection drops or the copy goes
 * stale. Both the editor's completions and the explorer's list read it.
 *
 * Deliberately not `useState`: the index is read from inside a Monaco provider
 * that runs on every keystroke, and there is nothing to gain from putting a
 * reactive proxy between it and a few thousand table names.
 */

export interface SchemaScope {
  connectionId: string | null
  /** The database the tab is pointed at; a snapshot describes exactly one. */
  database?: string
  /** How this engine quotes an identifier, from its driver. */
  quote: string
}

interface Entry {
  index: SchemaIndex | null
  error: string | null
  /** When the snapshot behind `index` was read. */
  readAt: number
  loading: boolean
}

/**
 * How long a snapshot is trusted before it is read again in the background. A
 * schema changes rarely, and a stale name in the list costs far less than a
 * suggestion widget that stutters while it waits on the server.
 */
const STALE_AFTER_MS = 5 * 60_000

/**
 * How long a failed read is left alone. A tab whose connection was not open
 * yet, or a server that blinked, should recover on its own without turning
 * every keystroke into another attempt.
 */
const RETRY_AFTER_MS = 15_000

const cache = new Map<string, Entry>()

/**
 * Bumped whenever a read finishes, so a component can show what happened. The
 * index itself stays out of reactivity; this is the one bit of it the UI needs.
 */
const revision = shallowRef(0)

function keyOf(scope: SchemaScope): string {
  return `${scope.connectionId}::${scope.database ?? ''}`
}

/**
 * Turns the one failure that is not about the database into an instruction.
 *
 * The renderer hot-reloads and the main process does not, so a window can be
 * running an editor that knows about `db:schema` while the process behind it
 * was started before that channel existed. Electron's own wording for it — "no
 * handler registered" — tells the user nothing they can act on.
 */
function explain(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)

  return message.includes('No handler registered')
    ? 'The DBison background process is older than this window. Restart the app.'
    : message
}

export function useSchemaIndex() {
  const { bridge } = useDatabaseBridge()

  async function load(key: string, scope: SchemaScope) {
    const entry = cache.get(key) ?? { index: null, error: null, readAt: 0, loading: false }

    if (entry.loading) return
    cache.set(key, { ...entry, loading: true })

    try {
      const snapshot: SchemaSnapshot = await bridge().schema(scope.connectionId!, {
        database: scope.database,
      })

      cache.set(key, {
        index: new SchemaIndex(snapshot, scope.quote),
        error: null,
        readAt: Date.now(),
        loading: false,
      })

      revision.value++
    }
    catch (error) {
      // The previous index, if there is one, stays: an editor that has been
      // completing table names all session should not stop because the server
      // was briefly unreachable.
      cache.set(key, {
        ...cache.get(key)!,
        error: explain(error),
        readAt: Date.now(),
        loading: false,
      })

      revision.value++
    }
  }

  /**
   * What is known about a scope right now, without asking for it to be read.
   *
   * A failed read would otherwise be invisible: the editor would quietly fall
   * back to completing keywords, and nothing would say that the schema behind
   * the suggestion list never arrived.
   */
  function statusFor(connectionId: string | null, database?: string) {
    // Touched so a computed that reads this re-runs when a read finishes.
    void revision.value

    const entry = connectionId ? cache.get(`${connectionId}::${database ?? ''}`) : undefined

    return {
      ready: Boolean(entry?.index),
      loading: Boolean(entry?.loading),
      error: entry?.index ? null : entry?.error ?? null,
      tables: entry?.index?.snapshot.objects.length ?? 0,
      truncated: Boolean(entry?.index?.snapshot.truncated),
    }
  }

  /**
   * The index for a scope, if it is already in memory — and a read started for
   * it if it is not.
   *
   * Synchronous on purpose. It is called from a completion provider, where
   * returning what is known now beats returning the right answer later.
   */
  function indexFor(scope: SchemaScope): { index: SchemaIndex | null, loading: boolean } {
    if (!scope.connectionId) return { index: null, loading: false }

    const key = keyOf(scope)
    const entry = cache.get(key)

    if (!entry) {
      load(key, scope)
      return { index: null, loading: true }
    }

    // A stale copy is revalidated behind the user's back; they keep completing
    // against the old one until the new one lands.
    const patience = entry.index ? STALE_AFTER_MS : RETRY_AFTER_MS

    if (!entry.loading && Date.now() - entry.readAt > patience) load(key, scope)

    return { index: entry.index, loading: entry.loading }
  }

  /**
   * The snapshot for a scope, as a reactive read.
   *
   * `indexFor` above is deliberately not reactive: it answers a completion
   * provider, where the current value is the only useful one. The explorer
   * wants the opposite — it draws the whole database and must redraw when a
   * read lands — so this touches `revision` and reports the read's progress
   * alongside the data.
   */
  function snapshotFor(scope: SchemaScope) {
    void revision.value

    if (!scope.connectionId) return { snapshot: null, loading: false, error: null }

    const { index, loading } = indexFor(scope)
    const entry = cache.get(keyOf(scope))

    return {
      snapshot: index?.snapshot ?? null,
      loading,
      // A stale copy that failed to revalidate keeps drawing; the error only
      // surfaces when there is nothing to draw instead.
      error: index ? null : entry?.error ?? null,
    }
  }

  /** Reads a scope ahead of the first keystroke, so the first list is instant. */
  function prefetch(scope: SchemaScope) {
    if (scope.connectionId) indexFor(scope)
  }

  /** Throws the copy away and reads it again; for an explicit refresh. */
  function reload(scope: SchemaScope) {
    if (!scope.connectionId) return
    cache.delete(keyOf(scope))
    indexFor(scope)
  }

  /** Everything a connection had; called when it drops. */
  function forget(connectionId: string) {
    for (const key of cache.keys()) {
      if (key.startsWith(`${connectionId}::`)) cache.delete(key)
    }
  }

  return { indexFor, snapshotFor, statusFor, prefetch, reload, forget }
}
