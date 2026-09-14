import type { SchemaObjects } from '#shared/db-types'

interface ObjectsRead {
  objects: SchemaObjects | null
  loading: boolean
  error: string | null
}

const EMPTY: SchemaObjects = { routines: [], sequences: [], triggers: [] }

/**
 * The routines, sequences and triggers of a database, read once per
 * database and kept until the explorer asks again.
 *
 * Separate from the schema snapshot on purpose: the snapshot is what the
 * editor's completions wait on, and it should stay the cheapest read there
 * is. This is read a moment later, for the explorer alone.
 */
export function useSchemaObjects() {
  const { bridge } = useDatabaseBridge()

  const reads = useState<Record<string, ObjectsRead>>('schema-objects', () => ({}))

  function keyOf(connectionId: string, database?: string) {
    return `${connectionId}::${database ?? ''}`
  }

  function readOf(connectionId: string | null, database?: string): ObjectsRead {
    if (!connectionId) return { objects: null, loading: false, error: null }
    return reads.value[keyOf(connectionId, database)] ?? { objects: null, loading: false, error: null }
  }

  async function load(connectionId: string, database?: string, force = false) {
    const key = keyOf(connectionId, database)
    const existing = reads.value[key]
    if (existing && (existing.loading || (existing.objects && !force))) return

    reads.value = { ...reads.value, [key]: { objects: existing?.objects ?? null, loading: true, error: null } }

    try {
      const objects = await bridge().objects(connectionId, { database })
      reads.value = { ...reads.value, [key]: { objects, loading: false, error: null } }
    }
    catch (cause) {
      // The explorer still shows its tables; only these sections say why.
      reads.value = {
        ...reads.value,
        [key]: { objects: existing?.objects ?? EMPTY, loading: false, error: cause instanceof Error ? cause.message : String(cause) },
      }
    }
  }

  /** Drops everything read on a connection, when it closes. */
  function forget(connectionId: string) {
    reads.value = Object.fromEntries(
      Object.entries(reads.value).filter(([key]) => !key.startsWith(`${connectionId}::`)),
    )
  }

  return { readOf, load, forget }
}
