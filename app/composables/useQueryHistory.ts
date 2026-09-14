import type { QueryHistoryEntry, QueryHistoryInput } from '#shared/db-types'

/**
 * What the editor has run, newest first, shared by every query tab.
 *
 * The main process owns the file; this is the renderer's copy of it, read
 * once and then kept in step with what this window records. A statement that
 * ran is remembered whether it worked or not: the failed one is often the one
 * worth finding again, to fix.
 */
export function useQueryHistory() {
  const { bridge, isAvailable } = useDatabaseBridge()

  const entries = useState<QueryHistoryEntry[]>('query-history', () => [])
  const loaded = useState('query-history-loaded', () => false)
  const loading = useState('query-history-loading', () => false)

  async function load() {
    if (loaded.value || loading.value || !isAvailable.value) return

    loading.value = true
    try {
      entries.value = await bridge().history.list()
      loaded.value = true
    }
    catch {
      // History is a convenience; a tab must not fail to open over it.
    }
    finally {
      loading.value = false
    }
  }

  /** Files a run. The store decides whether it is new or a rerun. */
  async function record(input: QueryHistoryInput) {
    if (!isAvailable.value) return

    try {
      const entry = await bridge().history.add(input)
      if (!entry) return

      // The store moved a rerun to the top; mirror that rather than re-reading
      // the whole list for one row.
      entries.value = [entry, ...entries.value.filter((existing) => existing.id !== entry.id)]
    }
    catch {
      // Same as above: a run that could not be remembered still ran.
    }
  }

  /** Drops one entry: the statement with the password in it, usually. */
  async function remove(id: string) {
    await bridge().history.remove(id)
    entries.value = entries.value.filter((existing) => existing.id !== id)
  }

  async function clear() {
    await bridge().history.clear()
    entries.value = []
  }

  return { entries, loaded, loading, load, record, remove, clear }
}
