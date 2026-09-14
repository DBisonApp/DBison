import type { SavedQuery, SavedQueryInput } from '#shared/db-types'

/**
 * The statements kept on purpose, shared by every query tab and the palette.
 *
 * The main process owns the file; this is the renderer's copy of it, read
 * once and then kept in step with what this window saves or removes. Newest
 * change first, so the query just edited is the one at the top of the list.
 */
export function useSavedQueries() {
  const { bridge, isAvailable } = useDatabaseBridge()

  const entries = useState<SavedQuery[]>('saved-queries', () => [])
  const loaded = useState('saved-queries-loaded', () => false)
  const loading = useState('saved-queries-loading', () => false)

  async function load() {
    if (loaded.value || loading.value || !isAvailable.value) return

    loading.value = true
    try {
      entries.value = await bridge().saved.list()
      loaded.value = true
    }
    catch {
      // A shelf that cannot be read is an empty shelf; the editor still works.
    }
    finally {
      loading.value = false
    }
  }

  /**
   * Creates or updates one query and returns it as the store wrote it. Errors
   * are left to the caller: the dialog that asked for the save shows them.
   */
  async function save(input: SavedQueryInput) {
    const saved = await bridge().saved.save(input)

    // Mirror the store's upsert rather than re-reading the whole list.
    entries.value = [saved, ...entries.value.filter((existing) => existing.id !== saved.id)]

    return saved
  }

  async function remove(id: string) {
    await bridge().saved.remove(id)
    entries.value = entries.value.filter((existing) => existing.id !== id)
  }

  return { entries, loaded, loading, load, save, remove }
}
