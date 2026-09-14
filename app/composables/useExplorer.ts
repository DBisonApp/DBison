import { nodeId } from '#shared/db-nodes'
import type { DbNode, SchemaColumn, SchemaObject } from '#shared/db-types'

/**
 * What the sidebar is pointed at, and everything it draws from there.
 *
 * The old navigator made the user walk a connection down to a table one
 * expandable level at a time, which put four levels of indentation in front of
 * every name and made the filter useless — it could only search branches that
 * had already been opened by hand. This inverts it: the levels above a table
 * become a scope picked once at the top, and the tables themselves come from
 * the schema snapshot, which arrives whole. So the filter searches every table,
 * view and column in the database from the first keystroke, without a round
 * trip.
 *
 * The scope is remembered per connection, so switching away and back lands
 * where it was left rather than back at the profile's default database.
 */

interface Scope {
  database?: string
  /** `null` means every schema at once; only meaningful for engines that have them. */
  schema?: string | null
}

export interface ExplorerEntity {
  object: SchemaObject
  /** Ready to hand to `openTableData`; addressed exactly as `children` would. */
  node: DbNode
  /** `public.orders` when schemas are shown side by side, else `orders`. */
  label: string
  match: FuzzyMatch
}

export interface ExplorerColumnHit {
  object: SchemaObject
  column: SchemaColumn
  label: string
  match: FuzzyMatch
}

/**
 * How many rows are handed to the DOM at once. A filtered list is nearly always
 * far shorter; this is the ceiling for the unfiltered view of a server with
 * thousands of tables, where drawing them all would cost more than it tells
 * anyone. The footer says how many were held back.
 */
const RENDER_LIMIT = 500

/** Column hits are a hint, not a listing: enough to point at the right table. */
const COLUMN_HIT_LIMIT = 30

const STORAGE_KEY = 'dbison.explorer.v1'

function readStored(): { scopes: Record<string, Scope>, filter: string } {
  if (!import.meta.client) return { scopes: {}, filter: '' }

  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')

    return {
      scopes: stored.scopes && typeof stored.scopes === 'object' ? stored.scopes : {},
      filter: typeof stored.filter === 'string' ? stored.filter : '',
    }
  }
  catch {
    return { scopes: {}, filter: '' }
  }
}

/**
 * Built once and shared.
 *
 * The sidebar, the scope bar, the switcher, the palette and the menu bar all
 * ask for the explorer, and each call used to build its own watchers and its
 * own chain of computeds over the same state — the fuzzy match over every
 * object ran once per caller on every keystroke. One instance, in a scope of
 * its own so it outlives whichever component happened to ask first.
 */
let shared: ReturnType<typeof createExplorer> | null = null

export function useExplorer() {
  if (!shared) {
    const scope = effectScope(true)
    shared = scope.run(() => createExplorer())!
  }

  return shared
}

function createExplorer() {
  const connections = useConnections()
  const children = useDbChildren()
  const schemaIndex = useSchemaIndex()

  const scopes = useState<Record<string, Scope>>('explorer-scopes', () => readStored().scopes)
  const filter = useState('explorer-filter', () => readStored().filter)

  /**
   * The filter as the matcher sees it: a few keystrokes behind the box.
   *
   * Matching runs over every object in the database, and a fast typist can
   * put five keystrokes in before the first match would have finished on a
   * large schema. Only the last one matters.
   */
  const needle = ref(filter.value.trim())
  let needleTimer: ReturnType<typeof setTimeout> | undefined

  watch(filter, (next) => {
    clearTimeout(needleTimer)
    // An emptied box is answered at once: clearing should feel like a reset.
    if (!next.trim()) {
      needle.value = ''
      return
    }
    needleTimer = setTimeout(() => { needle.value = next.trim() }, 80)
  })

  // The scope is a decision — which database, which schema — and a decision
  // is worth more than one session. The filter goes with it because a reload
  // mid-search should come back mid-search.
  watch([scopes, filter], ([nextScopes, nextFilter]) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ scopes: nextScopes, filter: nextFilter }))
    }
    catch {
      // Storage can be unavailable; the scope then lasts the session.
    }
  }, { deep: true })

  const connectionId = connections.activeId

  const profile = computed(
    () => connections.profiles.value.find((p) => p.id === connectionId.value) ?? null,
  )
  const driver = computed(() => (profile.value ? connections.driverOf(profile.value) : null))
  const levels = computed(() => driver.value?.levels ?? [])
  const status = computed(() =>
    connectionId.value ? connections.stateOf(connectionId.value).status : 'disconnected',
  )
  const connected = computed(() => status.value === 'connected')

  const scope = computed<Scope>(() =>
    connectionId.value ? scopes.value[connectionId.value] ?? {} : {},
  )
  const database = computed(() => scope.value.database)
  const schema = computed(() => scope.value.schema ?? null)

  function patch(next: Scope) {
    if (!connectionId.value) return
    scopes.value = { ...scopes.value, [connectionId.value]: { ...scope.value, ...next } }
  }

  /* ---------------------------------------------------------------------- *
   * Scope: the levels above a table, read one at a time.
   * ---------------------------------------------------------------------- */

  /**
   * Read straight out of the shared cache rather than copied into a ref here.
   *
   * Several components call `useExplorer`, so several copies would exist, and
   * they would not agree: `childrenOf` only starts a read when its branch is
   * still idle, so the first caller starts it and every later one gets back the
   * branch as it stands — empty. The copy that lost the race then kept an empty
   * list for good, which is what left the database picker disabled with nothing
   * in it. There is one branch, so there is one list.
   */
  const databases = computed<DbNode[]>(() =>
    connectionId.value ? children.branchOf(connectionId.value).children : [],
  )

  const scopeError = computed(() =>
    connectionId.value ? children.branchOf(connectionId.value).error ?? null : null,
  )

  function loadDatabases() {
    const id = connectionId.value
    if (!id || !connected.value || !levels.value.includes('database')) return

    // Fire and forget: what it fetches lands in the branch above.
    children.childrenOf(id, { id, kind: 'connection', path: {} })
  }

  // Without a default the list would have nothing to draw. The profile's own
  // database is the closest thing to an intent the user has expressed.
  watch(databases, (list) => {
    if (database.value || !list.length) return

    const preferred = list.find((d) => d.name === profile.value?.database) ?? list[0]
    if (preferred) patch({ database: preferred.name, schema: undefined })
  }, { immediate: true })

  function setDatabase(name: string) {
    // Schemas belong to the database they were read from; none of it survives.
    patch({ database: name, schema: undefined })
  }

  function setSchema(name: string | null) {
    patch({ schema: name })
  }

  async function connect() {
    if (connectionId.value && !connected.value) await connections.connect(connectionId.value)
  }

  function select(id: string) {
    connections.activeId.value = id
    filter.value = ''
  }

  /* ---------------------------------------------------------------------- *
   * Objects: the whole database at once.
   * ---------------------------------------------------------------------- */

  const read = computed(() => {
    if (!connected.value) return { snapshot: null, loading: false, error: null }

    return schemaIndex.snapshotFor({
      connectionId: connectionId.value,
      database: database.value,
      quote: driver.value?.quote ?? '"',
    })
  })

  const loading = computed(() => read.value.loading)
  const error = computed(() => read.value.error ?? scopeError.value)

  /**
   * Schema names come from the snapshot rather than a query of their own: it
   * already lists every one, including the empty ones an object list could not
   * imply. The picker is therefore exactly as current as the list below it.
   */
  const schemas = computed(() => read.value.snapshot?.schemas ?? [])

  watch(schemas, (names) => {
    if (!levels.value.includes('schema') || !names.length) return

    // `undefined` is "not chosen yet" and `null` is a deliberate "all of them";
    // only the first gets a default filled in.
    if (scope.value.schema === undefined) {
      patch({ schema: names.includes('public') ? 'public' : names[0] })
    }
  }, { immediate: true })

  const inScope = computed(() => {
    const objects = read.value.snapshot?.objects ?? []
    if (schema.value === null) return objects

    return objects.filter((object) => object.schema === schema.value)
  })

  /** Whether a name is drawn qualified — which is also what the filter sees. */
  const qualified = computed(() => schema.value === null && levels.value.includes('schema'))

  function labelOf(object: SchemaObject) {
    return qualified.value && object.schema ? `${object.schema}.${object.name}` : object.name
  }

  function nodeOf(object: SchemaObject): DbNode {
    return {
      id: nodeId(connectionId.value!, object.kind, object.path),
      connectionId: connectionId.value!,
      kind: object.kind,
      name: object.name,
      expandable: true,
      path: object.path,
    }
  }

  /**
   * `{ column: 'users.id' }` for one object, from the foreign keys the snapshot
   * already carries. An expanded table therefore shows what each of its columns
   * points at without a second look at the server.
   */
  function foreignKeysOf(object: SchemaObject): Record<string, string> {
    const targets: Record<string, string> = {}

    for (const relation of read.value.snapshot?.relations ?? []) {
      if (relation.schema !== object.schema || relation.table !== object.name) continue

      relation.columns.forEach((column, index) => {
        const table = qualified.value && relation.refSchema
          ? `${relation.refSchema}.${relation.refTable}`
          : relation.refTable

        targets[column] = `${table}.${relation.refColumns[index]}`
      })
    }

    return targets
  }

  const matched = computed<ExplorerEntity[]>(() => {
    const text = needle.value

    // No filter: no scoring, just the name order. The fuzzy matcher would
    // return a zero score for everything anyway, at the cost of a pass.
    if (!text) {
      return inScope.value
        .map((object) => ({ object, node: nodeOf(object), label: labelOf(object), match: { score: 0, ranges: [] as [number, number][] } }))
        .sort((a, b) => a.label.localeCompare(b.label))
    }

    const hits = inScope.value.flatMap((object) => {
      const label = labelOf(object)
      const match = fuzzyMatch(label, text)

      return match ? [{ object, node: nodeOf(object), label, match }] : []
    })

    // With no filter every score is zero, so this is a plain name sort — the
    // same order on every engine, whatever its catalog happened to return.
    return hits.sort((a, b) => b.match.score - a.match.score || a.label.localeCompare(b.label))
  })

  const tables = computed(() => matched.value.filter((entity) => entity.object.kind === 'table'))
  const views = computed(() => matched.value.filter((entity) => entity.object.kind === 'view'))

  /**
   * Every object in scope, untouched by the sidebar's filter box, for the
   * command palette: its own search box is the filter there, and a table
   * hidden by whatever was last typed in the sidebar would be a puzzle.
   */
  const everything = computed<ExplorerEntity[]>(() => inScope.value
    .map((object) => ({ object, node: nodeOf(object), label: labelOf(object), match: { score: 0, ranges: [] } }))
    .sort((a, b) => a.label.localeCompare(b.label)))

  /**
   * Tables reached by one of their columns rather than by their own name.
   *
   * Typing `email` should find the table that has an email column, which is the
   * question the old tree could not answer at all. Objects already listed above
   * are left out: the point of this group is the ones the name search missed.
   */
  const columnHits = computed<ExplorerColumnHit[]>(() => {
    const text = needle.value
    if (text.length < 2) return []

    const named = new Set(matched.value.map((entity) => entity.object))
    const hits: ExplorerColumnHit[] = []

    for (const object of inScope.value) {
      if (named.has(object)) continue

      for (const column of object.columns) {
        const match = fuzzyMatch(column.name, text)
        if (!match) continue

        hits.push({ object, column, label: `${labelOf(object)}.${column.name}`, match })
        break
      }

      // A wide schema can match on thousands of columns; the group only ever
      // shows the best few, so there is no reason to score every last one.
      if (hits.length >= COLUMN_HIT_LIMIT * 4) break
    }

    return hits
      .sort((a, b) => b.match.score - a.match.score || a.label.localeCompare(b.label))
      .slice(0, COLUMN_HIT_LIMIT)
  })

  /** Drops the cached snapshot and the database list, then reads both again. */
  function refresh() {
    const id = connectionId.value
    if (!id) return

    children.invalidate(id)

    schemaIndex.reload({
      connectionId: id,
      database: database.value,
      quote: driver.value?.quote ?? '"',
    })

    loadDatabases()
  }

  // A connection that opens fills the pickers; one that drops has its branch
  // discarded elsewhere, which empties them. `levels` is watched too, because
  // the sidebar can mount before the profile list has loaded, and until it has
  // the driver — and so the shape of the scope — is unknown.
  watch([connectionId, connected, levels], () => loadDatabases(), { immediate: true })

  return {
    profile,
    driver,
    levels,
    status,
    connected,
    connectionId,
    database,
    schema,
    databases,
    schemas,
    filter,
    qualified,
    tables,
    views,
    everything,
    columnHits,
    total: computed(() => inScope.value.length),
    truncated: computed(() => Boolean(read.value.snapshot?.truncated)),
    ready: computed(() => Boolean(read.value.snapshot)),
    loading,
    error,
    renderLimit: RENDER_LIMIT,
    select,
    setDatabase,
    setSchema,
    connect,
    refresh,
    nodeOf,
    foreignKeysOf,
  }
}
