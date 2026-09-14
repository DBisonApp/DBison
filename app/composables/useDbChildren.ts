import type { DbNode } from '#shared/db-types'

interface Branch {
  status: 'idle' | 'loading' | 'loaded' | 'error'
  children: DbNode[]
  error?: string
}

/**
 * One level of a server's object tree, fetched on demand and then cached.
 *
 * What is left of the old navigator tree. The explorer draws tables from a
 * schema snapshot instead (see `useSchemaIndex`), so nothing walks node by node
 * any more — but the database and schema pickers still need exactly the two
 * levels above a table, and those are cheap to read one at a time and worth
 * keeping once read.
 */
/**
 * Reads that have been started but not finished, keyed by node id. Module-level
 * because the cache they fill is shared: every component that calls this
 * composable has to be looking at the same in-flight read.
 */
const inFlight = new Map<string, Promise<void>>()

/**
 * Bumped whenever a branch is thrown away. A read that was already out when
 * that happened is answering a question nobody is asking any more, so its
 * result is dropped rather than written over the fresh one — otherwise an
 * explicit refresh would land on the very data it was meant to replace.
 */
const epochs = new Map<string, number>()

function epochOf(id: string) {
  return epochs.get(id) ?? 0
}

function expire(matches: (id: string) => boolean) {
  for (const id of new Set([...inFlight.keys(), ...epochs.keys()])) {
    if (!matches(id)) continue

    epochs.set(id, epochOf(id) + 1)
    inFlight.delete(id)
  }
}

export function useDbChildren() {
  const { children } = useConnections()

  const branches = useState<Record<string, Branch>>('db-children', () => ({}))

  function branchOf(id: string): Branch {
    return branches.value[id] ?? { status: 'idle', children: [] }
  }

  function setBranch(id: string, patch: Partial<Branch>) {
    branches.value = { ...branches.value, [id]: { ...branchOf(id), ...patch } }
  }

  function load(connectionId: string, node: Pick<DbNode, 'id' | 'kind' | 'path'>) {
    // Callers that arrive while a read is already out wait on that read rather
    // than starting a second one — or, worse, walking away with the branch as
    // it stands, which is empty until the first read lands.
    const started = inFlight.get(node.id)
    if (started) return started

    setBranch(node.id, { status: 'loading', error: undefined })

    const epoch = epochOf(node.id)
    const current = () => epochOf(node.id) === epoch

    const reading = children(connectionId, { kind: node.kind, path: node.path })
      .then((rows) => {
        if (current()) setBranch(node.id, { status: 'loaded', children: rows })
      })
      .catch((error: unknown) => {
        if (!current()) return

        setBranch(node.id, {
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => {
        if (current()) inFlight.delete(node.id)
      })

    inFlight.set(node.id, reading)
    return reading
  }

  /** Children of a node, read once and then served from the cache. */
  async function childrenOf(connectionId: string, node: Pick<DbNode, 'id' | 'kind' | 'path'>) {
    const { status } = branchOf(node.id)

    if (status === 'idle' || status === 'loading') await load(connectionId, node)
    return branchOf(node.id).children
  }

  /** Throws a level away so the next read goes back to the server. */
  function invalidate(id: string) {
    expire((key) => key === id)

    branches.value = Object.fromEntries(
      Object.entries(branches.value).filter(([key]) => key !== id),
    )
  }

  /**
   * Drops everything at or below a connection; used when it disconnects, so a
   * reconnect re-reads a schema that may have changed in the meantime.
   * The connection's own root branch is keyed by the bare connection id.
   */
  function forget(connectionId: string) {
    const owns = (id: string) => id === connectionId || id.startsWith(`${connectionId}:`)

    expire(owns)

    branches.value = Object.fromEntries(
      Object.entries(branches.value).filter(([id]) => !owns(id)),
    )
  }

  return { branchOf, childrenOf, invalidate, forget }
}
