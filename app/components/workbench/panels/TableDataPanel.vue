<script setup lang="ts">
import type { IDockviewPanelProps } from 'dockview-vue'
import { nodeId } from '#shared/db-nodes'
import type { CellValue, DbNode, DbPath, QueryResult, SchemaObject, SortOrder, TableStructure } from '#shared/db-types'
import type { StructureChangeResult } from '~/components/workbench/StructureChangeDialog.vue'
import type { ColumnFacts, ColumnRef } from '~/utils/cell-types'
import type { SqlDialect } from '~/utils/serialize'

/**
 * `where` and `filterToken` are how a foreign key arrives from another tab: the
 * clause to show, and a token that changes on every jump so following the same
 * key twice still lands. Both are absent for a table opened from the explorer.
 */
const props = defineProps<{
  params: IDockviewPanelProps<{ node: DbNode, where?: string, filterToken?: string }>
}>()

const { bridge } = useDatabaseBridge()
const { run } = useQueryRunner()
const { openQuery, openTableData } = useWorkbench()
const connections = useConnections()
const { childrenOf, invalidate } = useDbChildren()
const schemaIndex = useSchemaIndex()
const { confirm, openExport, openImport } = useDialogs()
const { settings } = useSettings()
const { announce } = useLiveAnnouncer()

const node = props.params.params.node

/** A table is read where it lives, not where the profile happens to point. */
const context = computed(() => ({
  connectionId: node.connectionId,
  database: node.path.database,
  schema: node.path.schema,
}))

const result = ref<QueryResult | null>(null)
const statement = ref('')
const loading = ref(false)
const cancelled = ref(false)
const error = ref<string | null>(null)
/**
 * How many rows a page holds; `null` is "All", which builds the statement with
 * no LIMIT at all.
 *
 * Nothing about that is free — every row crosses IPC and lands in the
 * renderer's memory — so the query still carries the cap below. The grid
 * itself no longer cares: it windows whatever it is handed.
 */
const limit = ref<number | null>(200)

/**
 * What "All" is allowed to mean before it stops being a good idea. Every row
 * lands in the renderer's memory; two hundred thousand is where a grid stops
 * being a way to look at data and starts being a way to run out of it.
 */
const ALL_ROWS_CAP = 200_000

const offset = ref(0)

/**
 * The grid's header sort, as an ORDER BY rather than a shuffle of the page.
 *
 * A table view shows the first few hundred rows of something much larger, so
 * ordering only those would answer "the largest of the rows we happened to
 * fetch" — almost never the question being asked. The driver puts the clause in
 * the statement and the server picks the rows again.
 */
const order = ref<SortOrder | null>(null)

/**
 * A WHERE clause, in the user's own SQL.
 *
 * The grid's own filter box searches the rows already fetched, which is the
 * wrong tool the moment the table is bigger than the page: this asks the server
 * instead. `applied` is what the last successful read used, so an edit in
 * progress does not make the toolbar claim a filter that is not on yet.
 */
const where = ref(props.params.params.where ?? '')
const appliedWhere = ref('')

const running = shallowRef<ReturnType<typeof run> | null>(null)

/**
 * Which face of the table is showing. The rows are the default and stay
 * mounted behind the other two, so switching to the definition and back does
 * not lose a scroll position or a staged edit.
 */
type TableView = 'data' | 'structure' | 'ddl'
const view = ref<TableView>('data')

const VIEWS: { id: TableView, label: string, icon: 'table' | 'structure' | 'code', title: string }[] = [
  { id: 'data', label: 'Data', icon: 'table', title: 'The rows' },
  { id: 'structure', label: 'Structure', icon: 'structure', title: 'Columns, keys and indexes' },
  { id: 'ddl', label: 'DDL', icon: 'code', title: 'The CREATE statement' },
]

/** The profile's own name; the id is a uuid and means nothing to anyone. */
const profile = computed(
  () => connections.profiles.value.find((p) => p.id === node.connectionId) ?? null,
)
const connectionName = computed(() => profile.value?.name ?? 'this connection')
const driver = computed(() => (profile.value ? connections.driverOf(profile.value) : null))

const status = computed(() => connections.stateOf(node.connectionId).status)
const connecting = computed(() => status.value === 'connecting')

const STATUS_DOT: Record<string, string> = {
  connected: 'bg-success',
  connecting: 'bg-warning app-pulse',
  disconnected: 'bg-faint',
  error: 'bg-danger',
}

/**
 * Where the table lives, outermost first. Two tabs on the same table in two
 * environments are otherwise the same word twice, and the toolbar is the only
 * place that can tell them apart.
 */
const crumbs = computed(
  () => [node.path.database, node.path.schema].filter(Boolean) as string[],
)

/**
 * How the grid's "Copy as INSERT" names this table: qualified the way the
 * engine would want it back, in the engine's own quotes.
 */
const dialect = computed<SqlDialect>(() => {
  const quote = driver.value?.quote ?? '"'
  const levels = driver.value?.levels ?? []
  const qualifier = levels.includes('schema') ? node.path.schema : levels.includes('database') ? node.path.database : undefined
  const table = quoteIdentifier(node.path.table ?? node.name, quote)

  return {
    table: qualifier ? `${quoteIdentifier(qualifier, quote)}.${table}` : table,
    quote,
    escapeBackslashes: driver.value?.id === 'mysql' || driver.value?.id === 'mariadb',
  }
})

/* ------------------------------------------------------------- blobs -- */

/**
 * One binary value, whole. The rows carry a digest so a table of images does
 * not cross IPC as images; the viewer asks for the real thing by key, and
 * only for a table that has one.
 */
async function loadBytes(row: Record<string, CellValue>, column: string): Promise<string | null> {
  if (!keyColumns.value.length || !driver.value) return null

  const quote = driver.value.quote
  const where = keyColumns.value
    .map((key) => `${quoteIdentifier(key, quote)} = ${sqlLiteral(row[key] ?? null, driver.value!.id === 'mysql' || driver.value!.id === 'mariadb')}`)
    .join(' and ')
  const sql = `select ${quoteIdentifier(column, quote)} from ${dialect.value.table} where ${where}`

  const outcome = await run(context.value, sql, 1, { binary: 'base64' }).result
  const value = outcome.rows[0]?.[0]

  return typeof value === 'string' ? value : null
}

/* ------------------------------------------------------------ counting -- */

/**
 * The exact number of rows, under the current filter, when asked for.
 *
 * Asked for, never assumed: on a large table `count(*)` is a full scan, and
 * the estimate the explorer shows is free. It is forgotten whenever the rows
 * are re-read under a different filter, or written to, because the number
 * would then be describing a table that no longer exists.
 */
const exactCount = ref<number | null>(null)
const counting = shallowRef<{ stop: () => Promise<unknown> } | null>(null)
const countError = ref<string | null>(null)

async function countRows() {
  if (counting.value) return

  const queryId = crypto.randomUUID()
  counting.value = { stop: () => bridge().cancel(queryId).catch(() => ({ cancelled: false })) }
  countError.value = null

  try {
    const outcome = await bridge().countRows(
      node.connectionId,
      { kind: node.kind, path: node.path },
      { where: appliedWhere.value, queryId },
    )
    exactCount.value = outcome.count
  }
  catch (cause) {
    if (!isCancellation(cause)) countError.value = cause instanceof Error ? cause.message : String(cause)
  }
  finally {
    counting.value = null
  }
}

function forgetCount() {
  exactCount.value = null
  countError.value = null
}

async function load() {
  loading.value = true
  error.value = null
  cancelled.value = false

  try {
    // The driver builds the SELECT so identifiers are quoted its own way.
    const preview = await bridge().preview(
      node.connectionId,
      { kind: node.kind, path: node.path },
      {
        limit: limit.value,
        offset: offset.value,
        order: order.value,
        where: where.value,
      },
    )
    statement.value = preview.sql
    // A count was for the rows a filter picked; a different filter is a
    // different number. Paging under the same filter is not.
    if (appliedWhere.value !== where.value.trim()) forgetCount()
    appliedWhere.value = where.value.trim()

    // The first batch paints the first screen while the rest is still on its
    // way; the final result then replaces the provisional one whole.
    const arrived: CellValue[][] = []
    const startedAt = performance.now()
    const handle = run(context.value, preview.sql, limit.value ?? ALL_ROWS_CAP, {
      stream: true,
      onRows: (rows, columns) => {
        for (const row of rows) arrived.push(row)
        result.value = {
          columns,
          rows: arrived.slice(),
          rowCount: arrived.length,
          truncated: false,
          durationMs: Math.round(performance.now() - startedAt),
        }
      },
    })
    running.value = handle
    result.value = await handle.result
  }
  catch (cause) {
    if (isCancellation(cause)) cancelled.value = true
    else error.value = cause instanceof Error ? cause.message : String(cause)
  }
  finally {
    loading.value = false
    running.value = null
  }

  if (error.value) announce(`Could not read ${node.name}: ${error.value}`, 'assertive')
  else if (result.value) announce(`${node.name}: ${result.value.rowCount} rows loaded`)
}

function stop() {
  running.value?.stop()
}

/**
 * Asks before anything that would re-read the rows under staged edits.
 *
 * Edits are staged against the rows as they are: row 4 of the next read is a
 * different row, so pending changes cannot survive a reload, a re-sort or a new
 * page. Losing them silently would be the worst version of this — so the user
 * is asked, every time, and answers for the whole gesture.
 */
async function mayReload() {
  if (!edits.dirty.value) return true

  const ok = await confirm({
    title: 'Unsaved changes',
    message: `${edits.summary.value.total} change${edits.summary.value.total === 1 ? '' : 's'} `
      + 'have not been saved. Reading the rows again will discard them.',
    confirmLabel: 'Discard and reload',
    danger: true,
  })

  if (ok) edits.clear()
  return ok
}

async function reload() {
  if (!await mayReload()) return

  // An explicit reload is a suspicion that the table changed; so did its count.
  forgetCount()
  load()
}

/** A header click is a new statement, not a re-arrangement of this one. */
async function reorder(next: SortOrder | null) {
  if (!await mayReload()) return

  order.value = next
  // A different order is a different first page; staying on page 4 of it would
  // land the user somewhere they never asked to be.
  offset.value = 0
  load()
}

/** Whether the page came back full, and so whether another one may exist. */
const hasMore = computed(
  () => limit.value !== null && (result.value?.rows.length ?? 0) >= limit.value,
)

async function page(delta: number) {
  if (limit.value === null || !await mayReload()) return

  offset.value = Math.max(0, offset.value + delta * limit.value)
  load()
}

async function relimit(next: number | null) {
  if (!await mayReload()) return

  limit.value = next
  offset.value = 0
  load()
}

async function applyWhere() {
  if (!await mayReload()) return

  offset.value = 0
  load()
}

async function clearWhere() {
  if (!where.value && !appliedWhere.value) return
  if (!await mayReload()) return

  where.value = ''
  offset.value = 0
  load()
}

/**
 * A filter handed in from outside: a foreign key followed into this table while
 * its tab was already open.
 *
 * Watched on the token rather than on the clause, because following the same
 * key twice — after scrolling away, say — produces the same clause, and the
 * second jump has to bring the rows back just as the first one did.
 */
watch(() => props.params.params.filterToken, async (token) => {
  if (!token) return
  if (!await mayReload()) return

  where.value = props.params.params.where ?? ''
  offset.value = 0
  load()
})

/* -------------------------------------------------------------- editing -- */

/**
 * The columns that identify one row, read from the table's own definition.
 *
 * Everything about writing depends on this: with a primary key an edit is an
 * UPDATE against exactly one row, and without one the grid stays read-only
 * rather than guessing. Views have none, which is the right answer for them too.
 */
const keyColumns = ref<string[]>([])
const writeError = ref<string | null>(null)
/** Why the table definition could not be read, when that is the reason. */
const keyError = ref<string | null>(null)

/**
 * What each column will accept, by name.
 *
 * A new row needs more than the key: whether the server fills a column in by
 * itself, and whether it may be left empty at all. Without that the grid cannot
 * tell an auto-increment id from a NOT NULL column nobody has typed into yet.
 */
const columnInfo = ref<Record<string, ColumnFacts>>({})

/** The columns as the table declares them, for the structure view. */
const columnNodes = ref<DbNode[]>([])

async function loadColumnInfo() {
  try {
    const children = await childrenOf(node.connectionId, node)

    columnNodes.value = children
    // A view has no key to write through, whatever its columns say.
    keyColumns.value = node.kind === 'table'
      ? children.filter((child) => child.primaryKey).map((child) => child.name)
      : []
    columnInfo.value = Object.fromEntries(children.map((child) => [child.name, {
      nullable: child.nullable ?? true,
      hasDefault: child.hasDefault ?? false,
      primaryKey: Boolean(child.primaryKey),
      declaredType: child.declaredType,
      enumValues: child.enumValues,
    }]))

    keyError.value = null
  }
  catch (cause) {
    // A failed read leaves the grid read-only, which is the safe direction —
    // but silently, it looks exactly like a grid that simply will not edit.
    keyColumns.value = []
    columnInfo.value = {}
    columnNodes.value = []
    keyError.value = cause instanceof Error ? cause.message : String(cause)
  }
}

/* ----------------------------------------------------------- structure -- */

/**
 * Indexes and the CREATE statement, read the first time either view is
 * opened. The columns come from the same read as the grid's editors, so the
 * structure view costs one round trip more than the rows did, not two.
 */
const structure = ref<TableStructure | null>(null)
const structureLoading = ref(false)
const structureError = ref<string | null>(null)

async function loadStructure() {
  if (structureLoading.value) return

  structureLoading.value = true
  structureError.value = null

  try {
    const [outcome] = await Promise.all([
      bridge().structure(node.connectionId, { kind: node.kind, path: node.path }),
      columnNodes.value.length ? Promise.resolve() : loadColumnInfo(),
    ])
    structure.value = outcome
  }
  catch (cause) {
    structureError.value = cause instanceof Error ? cause.message : String(cause)
  }
  finally {
    structureLoading.value = false
  }
}

watch(view, (next) => {
  if (next !== 'data' && !structure.value && status.value === 'connected') loadStructure()
})

/** Re-reads everything the tab shows; the structure only if it was ever read. */
async function reloadAll() {
  if (!await mayReload()) return

  forgetCount()
  load()
  loadColumnInfo()
  if (structure.value || structureError.value) loadStructure()
}

/* ------------------------------------------------------ structure edits -- */

/**
 * The table's new name after a rename, for the notice that says so.
 *
 * The tab is not silently re-pointed: its id, its saved layout entry and its
 * staged edits all name the old table, and a tab that quietly became another
 * one would be a surprise later. The notice offers the new table instead.
 */
const renamedTo = ref<string | null>(null)

/** Every copy of the table's shape this window holds, thrown away. */
function forgetShape() {
  // `childrenOf` answers from its cache, so the columns would otherwise come
  // back exactly as they were before the ALTER.
  invalidate(node.id)
  // The snapshot feeds the explorer's list and the editor's completions; both
  // should know the new column, or the missing table, without a manual refresh.
  schemaIndex.reload(schemaScope.value)
}

/** A structure change ran through the dialog; what this tab shows is stale. */
function onStructureChanged(result: StructureChangeResult) {
  forgetShape()

  if (result.operation.kind === 'dropTable') {
    announce(`Dropped ${node.name}`)
    // The rows on screen belong to a table that no longer exists; there is
    // nothing left for the close guard to protect.
    edits.clear()
    props.params.api.close()
    return
  }

  if (result.operation.kind === 'renameTable') {
    renamedTo.value = result.operation.to
    announce(`Renamed ${node.name} to ${result.operation.to}`)
    return
  }

  announce(`${node.name}: structure changed`)
  reloadAll()
}

/** Opens the table under its new name, and lets this tab go. */
function openRenamed() {
  if (!renamedTo.value) return

  const path: DbPath = { ...node.path, table: renamedTo.value }

  openTableData({
    id: nodeId(node.connectionId, 'table', path),
    connectionId: node.connectionId,
    kind: 'table',
    name: renamedTo.value,
    expandable: true,
    path,
  })

  edits.clear()
  props.params.api.close()
}

/* ------------------------------------------------------ foreign keys -- */

/**
 * The database's structure, which is the only place foreign keys live.
 *
 * `children` describes one table's columns and says nothing about what they
 * point at; the snapshot the explorer and the editor already read describes
 * every relation in the database. It is cached and shared, so asking for it
 * here costs nothing beyond the read those two had already paid for.
 */
const schemaScope = computed(() => ({
  connectionId: node.connectionId,
  database: node.path.database,
  quote: driver.value?.quote ?? '"',
}))

const snapshot = computed(() =>
  status.value === 'connected' ? schemaIndex.snapshotFor(schemaScope.value).snapshot : null,
)

const tableName = node.path.table ?? node.name
const tableSchema = node.path.schema ?? ''

/** The keys that leave this table, whole — a composite one stays composite. */
const relations = computed(() => (snapshot.value?.relations ?? []).filter(
  (relation) => relation.table === tableName
    && (!tableSchema || relation.schema === tableSchema),
))

/** Where each of this table's columns points, by column name. */
const references = computed(() => {
  const targets: Record<string, ColumnRef> = {}

  for (const relation of relations.value) {
    relation.columns.forEach((column, index) => {
      const refColumn = relation.refColumns[index]
      if (!refColumn) return

      targets[column] = {
        schema: relation.refSchema || undefined,
        table: relation.refTable,
        column: refColumn,
      }
    })
  }

  return targets
})

/**
 * What the grid is told about each column: what the table declares, plus what
 * each column points at.
 *
 * The two arrive from different places and at different times — the definition
 * from `children`, the keys from the snapshot — so they are merged here rather
 * than in either reader.
 */
const columnFacts = computed<Record<string, ColumnFacts>>(() => {
  const facts: Record<string, ColumnFacts> = { ...columnInfo.value }

  for (const [name, target] of Object.entries(references.value)) {
    facts[name] = {
      ...(facts[name] ?? { nullable: true, hasDefault: false, primaryKey: false }),
      references: target,
    }
  }

  return facts
})

/** A value as SQL text, for the WHERE clause a followed key is turned into. */
function literal(value: CellValue): string {
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'

  return `'${String(value).replaceAll(`'`, `''`)}'`
}

/**
 * Follows a foreign key: opens the table it names, showing the row it names.
 *
 * The whole relation is used, not just the column that was clicked. Half of a
 * composite key matches every row that shares that half, and landing on forty
 * rows when the cell was talking about one is worse than not offering the jump.
 */
function follow(event: { column: string, row: Record<string, CellValue> }) {
  const relation = relations.value.find((r) => r.columns.includes(event.column))
  if (!relation) return

  const quote = driver.value?.quote ?? '"'

  const clauses = relation.columns.flatMap((column, index) => {
    const refColumn = relation.refColumns[index]
    if (!refColumn) return []

    const value = event.row[column] ?? null
    const name = quoteIdentifier(refColumn, quote)

    return [value === null ? `${name} is null` : `${name} = ${literal(value)}`]
  })

  if (!clauses.length) return

  // The snapshot's own path where it has one: how a table is addressed is the
  // driver's business, and only the object it described knows the shape.
  const object = snapshot.value?.objects.find(
    (candidate) => candidate.name === relation.refTable
      && candidate.schema === relation.refSchema,
  )

  const kind = object?.kind ?? 'table'
  const path: DbPath = object?.path ?? {
    database: node.path.database,
    ...(relation.refSchema ? { schema: relation.refSchema } : {}),
    table: relation.refTable,
  }

  openTableData({
    id: nodeId(node.connectionId, kind, path),
    connectionId: node.connectionId,
    kind,
    name: relation.refTable,
    expandable: true,
    path,
  }, { where: clauses.join(' and ') })
}

/**
 * Another table picked from the breadcrumb. Opened as its own tab rather than
 * swapped into this one: a tab is one table's rows, edits and scroll position,
 * and the user may well want both open. An already-open tab is focused.
 */
function switchTable(object: SchemaObject) {
  openTableData({
    id: nodeId(node.connectionId, object.kind, object.path),
    connectionId: node.connectionId,
    kind: object.kind,
    name: object.name,
    expandable: true,
    path: object.path,
  })
}

/**
 * Why nothing here can be written, when nothing can.
 *
 * Read-only is a fact about the object, not a failure, and a grid that refuses
 * to edit without saying why reads as broken — especially now that a boolean
 * looks like a checkbox whichever way it is.
 */
const readOnlyReason = computed(() => {
  if (editable.value) return null
  if (node.kind !== 'table') return `A ${node.kind} has no rows of its own to write back to.`
  if (keyError.value) return `The table definition could not be read: ${keyError.value}`

  return 'This table has no primary key, so no row can be identified to write to.'
})

/** Whether the page on screen is the table itself, and so can be written to. */
const editable = computed(() => node.kind === 'table' && keyColumns.value.length > 0)

/**
 * The edits staged in the grid, waiting to be saved.
 *
 * Nothing here has touched the database: the grid paints what the table would
 * hold, and one save applies the lot in a transaction.
 */
const edits = useGridEdits(
  () => result.value ?? { columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 0 },
  () => keyColumns.value,
)

const saving = ref(false)

/**
 * Writes every staged change, then patches the copy on screen.
 *
 * Updates are patched in rather than re-read: the transaction committing is
 * itself the confirmation, and re-running the page would throw away the user's
 * scroll position and selection to learn what it already knows. Deletions do
 * force a re-read, because the rows below them have all moved.
 */
/** Columns a new row has to be given: not nullable, nothing to fall back on. */
function isRequired(column: string) {
  const info = columnInfo.value[column]
  return Boolean(info) && !info!.nullable && !info!.hasDefault
}

async function save() {
  if (!result.value || !edits.dirty.value || saving.value) return

  // Caught here rather than by the engine: "name needs a value" beats a
  // round trip that comes back as a not-null constraint violation.
  const missing = new Set(
    edits.draftRows.value.flatMap((row) => edits.missingFor(row, isRequired)),
  )

  if (missing.size) {
    writeError.value = `A new row is missing ${[...missing].join(', ')}. `
      + 'Those columns have no default, and cannot be left empty.'
    return
  }

  // A connection marked read-only asks every time; the setting can make
  // every connection ask. Either way the write goes through once confirmed.
  if (profile.value?.readOnly || settings.value.confirmAllWrites) {
    const total = edits.summary.value.total
    const ok = await confirm({
      title: profile.value?.readOnly ? `${connectionName.value} is marked read-only` : 'Save changes',
      message: `${total} change${total === 1 ? '' : 's'} will be written to ${node.name} in one transaction.`,
      confirmLabel: `Save ${total}`,
      danger: Boolean(profile.value?.readOnly),
    })

    if (!ok) return
  }

  // Both change the rows below them, and inserts come back with ids, defaults
  // and whatever a trigger did — none of which the grid can guess.
  const rereads = edits.summary.value.deleted + edits.summary.value.added
  saving.value = true
  writeError.value = null

  try {
    await bridge().applyChanges(
      node.connectionId,
      { kind: node.kind, path: node.path },
      edits.changes.value,
      // The dialog above is the consent the main process insists on before
      // it writes through a connection marked read-only.
      { allowWrite: Boolean(profile.value?.readOnly) },
    )

    if (rereads) {
      edits.clear()
      forgetCount()
      await load()
    }
    else {
      edits.commitLocally()
    }

    announce('Changes saved')
  }
  catch (cause) {
    // Nothing was written — the batch is a transaction — so the staged edits
    // stay exactly as they were, for the user to fix and try again.
    writeError.value = cause instanceof Error ? cause.message : String(cause)
    announce(`Save failed: ${writeError.value}`, 'assertive')
  }
  finally {
    saving.value = false
  }
}

/** Opens the batch as a script, so it can be read — or run — before saving. */
async function showChangeScript() {
  if (!edits.dirty.value) return

  try {
    const outcome = await bridge().applyChanges(
      node.connectionId,
      { kind: node.kind, path: node.path },
      edits.changes.value,
      { dryRun: true },
    )

    openQuery({
      ...context.value,
      sql: outcome.statements.map((statement) => statement.preview).join(`\n`),
      title: `${node.name} · changes`,
    })
  }
  catch (cause) {
    writeError.value = cause instanceof Error ? cause.message : String(cause)
  }
}

/* ------------------------------------------------------- files in, out -- */

/**
 * Every row the filter matches, to a file: the same SELECT as the grid's, in
 * the same order, but with no LIMIT — the page on screen is a window onto
 * the table, and the file should hold the table.
 */
async function exportRows() {
  try {
    const { sql } = await bridge().preview(
      node.connectionId,
      { kind: node.kind, path: node.path },
      { limit: null, where: appliedWhere.value || undefined, order: order.value },
    )

    openExport({
      connectionId: node.connectionId,
      sql,
      database: node.path.database,
      schema: node.path.schema,
      suggestedName: node.path.table ?? node.name,
      dialect: dialect.value,
      description: appliedWhere.value
        ? `every row of ${node.name} matching the current filter`
        : `every row of ${node.name}`,
    })
  }
  catch (cause) {
    writeError.value = cause instanceof Error ? cause.message : String(cause)
  }
}

/** A file into the table; the rows are read again once it is in. */
async function importRows() {
  if (node.kind !== 'table') return
  if (!columnNodes.value.length) await loadColumnInfo()

  const outcome = await openImport({
    node,
    columns: columnNodes.value.map((column) => ({
      name: column.name,
      type: column.declaredType ?? column.detail ?? '',
      nullable: column.nullable,
      hasDefault: column.hasDefault,
    })),
    connectionName: connectionName.value,
    readOnly: Boolean(profile.value?.readOnly),
  })
  if (!outcome) return

  announce(`Imported ${outcome.inserted.toLocaleString()} row${outcome.inserted === 1 ? '' : 's'} into ${node.name}`)
  // The count is stale whether or not the reload below is allowed to happen.
  forgetCount()
  reload()
}

async function revert() {
  const ok = await confirm({
    title: 'Discard changes',
    message: `${edits.summary.value.total} unsaved change${edits.summary.value.total === 1 ? '' : 's'} will be thrown away.`,
    confirmLabel: 'Discard',
    danger: true,
  })

  if (ok) edits.clear()
}

/**
 * The tab strip has room for a word, and "users" alone is the word both the
 * prod and the dev tab would carry. The connection is appended so the strip
 * answers "which one is this?" without focusing the tab first.
 */
watch(
  [() => profile.value?.name, () => edits.dirty.value],
  ([name, dirty]) => {
    // A dot on the tab is the only warning a tab that is not on screen can
    // give: staged edits live in this panel, and closing it drops them.
    const title = name ? `${node.name} · ${name}` : node.name
    props.params.api.setTitle(dirty ? `● ${title}` : title)
  },
  { immediate: true },
)

// Closing the tab must not leave the statement running on the server.
onBeforeUnmount(() => running.value?.stop())

// F5: the rows again, or the definition too when that is what is showing.
const unregisterRefresh = useRefreshables().register(
  props.params.api.id,
  () => (view.value === 'data' ? reload() : reloadAll()),
)
onBeforeUnmount(unregisterRefresh)

// Staged edits die with the tab, so the tab asks before it goes.
const unregisterGuard = useCloseGuards().register(props.params.api.id, {
  dirty: () => edits.dirty.value,
  mayClose: () => confirm({
    title: 'Close this tab?',
    message: `${edits.summary.value.total} unsaved change${edits.summary.value.total === 1 ? '' : 's'} to ${node.name} will be thrown away.`,
    confirmLabel: 'Close',
    danger: true,
  }),
})
onBeforeUnmount(unregisterGuard)

/**
 * A clause the grid built from a cell — "Filter to status = 'active'" — is
 * added to whatever filter is already on, so two clicks narrow twice.
 */
async function addFilter(clause: string) {
  if (!await mayReload()) return

  const existing = where.value.trim()
  where.value = existing ? `${existing} and ${clause}` : clause
  offset.value = 0
  load()
}

// Reopening a saved layout can land on a connection that is not open yet.
watch(
  status,
  (next) => {
    if (next !== 'connected') return

    if (!result.value && !loading.value) load()
    if (!keyColumns.value.length) loadColumnInfo()
  },
  { immediate: true },
)
</script>

<template>
  <div class="@container flex h-full flex-col bg-bg">
    <!-- The connection's colour along the top, where the eye lands first. -->
    <div
      v-if="profile?.color"
      class="h-0.5 shrink-0"
      :style="{ backgroundColor: profile.color }"
    />

    <!-- Two rows rather than one. The first says what this tab is and which
         face of it is showing; the second, only for the rows, is the filter
         and the window onto them. One row held both until a narrow split
         pushed the filter box off the right edge. -->
    <div class="flex items-center gap-2 border-b border-edge bg-surface/40 px-2 py-1">
      <span
        class="flex min-w-0 items-center gap-1.5 rounded-md bg-raised py-0.5 pr-2 pl-1.5"
        :title="`${connectionName} — ${[...crumbs, node.name].join(' › ')}`"
      >
        <DriverIcon v-if="driver" :driver="driver.id" />

        <ConnectionSwatch :profile="profile" lock />
        <!-- The table name is what the tab is about, so it yields last; the
             connection and the crumbs give way first when the row is tight. -->
        <span class="min-w-6 max-w-40 shrink truncate font-medium">{{ connectionName }}</span>
        <span class="size-1.5 shrink-0 rounded-full" :class="STATUS_DOT[status]" />

        <template v-for="crumb in crumbs" :key="crumb">
          <span class="text-faint">›</span>
          <span class="min-w-4 max-w-32 shrink truncate text-muted">{{ crumb }}</span>
        </template>

        <span class="text-faint">›</span>
        <!-- The one crumb that changes from here: another table of the same
             database, picked from a list, opens in its own tab. -->
        <TableCrumbPicker
          :connection-id="node.connectionId"
          :database="node.path.database"
          :quote="driver?.quote ?? '&quot;'"
          :schema="node.path.schema ?? ''"
          :table="node.path.table ?? node.name"
          :kind="node.kind === 'view' ? 'view' : 'table'"
          @pick="switchTable"
        />
      </span>

      <!-- Rows, definition, or CREATE statement: one table, three faces. -->
      <span class="flex shrink-0 items-center rounded-md bg-raised p-0.5" role="tablist" aria-label="Table view">
        <button
          v-for="option in VIEWS"
          :key="option.id"
          type="button"
          role="tab"
          class="btn btn-ghost px-1.5 py-0.5"
          :data-active="view === option.id"
          :aria-selected="view === option.id"
          :title="option.title"
          @click="view = option.id"
        >
          <AppIcon :name="option.icon" :size="11" />
          <span class="hidden @2xl:inline">{{ option.label }}</span>
        </button>
      </span>

      <button
        v-if="loading"
        type="button"
        class="btn btn-danger shrink-0"
        title="Stop"
        @click="stop"
      >
        <AppIcon name="stop" :size="12" />
        Stop
      </button>

      <button
        v-else
        type="button"
        class="btn-icon shrink-0"
        title="Reload (F5)"
        aria-label="Reload"
        @click="view === 'data' ? reload() : reloadAll()"
      >
        <AppIcon name="refresh" />
      </button>

      <span
        v-if="readOnlyReason && result"
        class="chip ml-auto shrink-0 gap-1 text-faint"
        :title="readOnlyReason"
      >
        <AppIcon name="lock" :size="10" />
        Read-only
      </span>

      <button
        type="button"
        class="btn btn-ghost shrink-0"
        :class="readOnlyReason && result ? '' : 'ml-auto'"
        :disabled="!statement"
        title="Open this SELECT, sort and filter included, in a query tab"
        @click="openQuery({ ...context, sql: statement, title: `${node.name} · query` })"
      >
        <AppIcon name="play" :size="12" />
        <span class="hidden @3xl:inline">Open in editor</span>
      </button>

      <!-- The whole table in and out of a file; the grid's own Export menu
           only ever has the page on screen to offer. -->
      <button
        type="button"
        class="btn btn-ghost shrink-0"
        :disabled="status !== 'connected'"
        title="Write every matching row to a file — the statement runs again on the server"
        @click="exportRows"
      >
        <AppIcon name="fileDown" :size="12" />
        <span class="hidden @3xl:inline">Export…</span>
      </button>

      <button
        v-if="node.kind === 'table'"
        type="button"
        class="btn btn-ghost shrink-0"
        :disabled="status !== 'connected'"
        title="Read a CSV or other delimited file into this table"
        @click="importRows"
      >
        <AppIcon name="fileUp" :size="12" />
        <span class="hidden @3xl:inline">Import…</span>
      </button>
    </div>

    <!-- The rows' own row: the filter first, because it is the one control
         that grows with the space, and the window onto the table after it. -->
    <div
      v-show="view === 'data'"
      class="flex items-center gap-2 border-b border-edge bg-surface/40 px-2 py-1"
    >
      <!-- The server-side half of filtering: the grid's own box searches the
           rows already fetched, which stops being the question the moment the
           table is bigger than the page. -->
      <label class="flex min-w-0 flex-1 items-center gap-1 text-faint">
        <span class="shrink-0 font-mono">where</span>
        <input
          v-model="where"
          type="text"
          spellcheck="false"
          aria-label="WHERE clause"
          placeholder="status = 'active' and created_at > now() - interval '1 day'"
          class="field min-w-24 flex-1 bg-surface px-1.5 py-0.5 font-mono"
          :class="appliedWhere ? 'border-accent-line text-content' : ''"
          @keydown.enter.prevent="applyWhere"
          @keydown.escape.prevent="clearWhere"
        >
        <button
          v-if="where || appliedWhere"
          type="button"
          class="btn-icon shrink-0"
          title="Clear the filter (Esc)"
          aria-label="Clear the filter"
          @click="clearWhere"
        >
          <AppIcon name="close" :size="11" />
        </button>
      </label>

      <!-- The sort as the statement carries it, so it is clear that "Open in
           editor" hands over an ORDER BY and not just the rows on screen. -->
      <button
        v-if="order"
        type="button"
        class="btn btn-ghost max-w-40 shrink"
        :title="`Sorted by ${order.column}, ${order.dir === 'asc' ? 'ascending' : 'descending'} — click to clear`"
        @click="reorder(null)"
      >
        <AppIcon :name="order.dir === 'asc' ? 'sortAsc' : 'sortDesc'" :size="12" class="shrink-0 text-accent-bright" />
        <span class="truncate">{{ order.column }}</span>
        <AppIcon name="close" :size="10" class="shrink-0 text-faint" />
      </button>

      <span class="h-4 w-px shrink-0 bg-edge" />

      <label class="flex shrink-0 items-center gap-1 text-faint" title="Rows per page">
        <span class="hidden @xl:inline">Rows</span>
        <select
          class="field w-auto bg-surface px-1 py-0.5"
          aria-label="Rows per page"
          :value="limit === null ? 'all' : String(limit)"
          @change="relimit(($event.target as HTMLSelectElement).value === 'all'
            ? null
            : Number(($event.target as HTMLSelectElement).value))"
        >
          <option value="100">100</option>
          <option value="200">200</option>
          <option value="1000">1000</option>
          <option value="5000">5000</option>
          <option value="all" title="Every row, up to 200,000 — the grid only draws what is on screen">
            All
          </option>
        </select>
      </label>

      <!-- Paging exists only when the rows were capped; "All" has no pages. -->
      <span v-if="limit !== null" class="flex shrink-0 items-center">
        <button
          type="button"
          class="btn-icon"
          :disabled="offset === 0 || loading"
          title="Previous page"
          aria-label="Previous page"
          @click="page(-1)"
        >
          <AppIcon name="chevronLeft" :size="12" />
        </button>

        <span class="px-1 text-faint tabular-nums" :title="`Rows ${offset + 1}–${offset + (result?.rowCount ?? 0)}`">
          {{ Math.floor(offset / limit) + 1 }}
        </span>

        <button
          type="button"
          class="btn-icon"
          :disabled="!hasMore || loading"
          title="Next page"
          aria-label="Next page"
          @click="page(1)"
        >
          <AppIcon name="chevronRight" :size="12" />
        </button>
      </span>

      <span v-if="result" class="flex shrink-0 items-center gap-1 text-faint tabular-nums">
        {{ offset ? `${offset + 1}–${offset + result.rowCount}` : `${result.rowCount} rows` }}

        <!-- The exact total, on request: the estimate is free and a count is
             a scan, so the scan is the user's call. -->
        <span v-if="exactCount !== null" class="text-content" :title="appliedWhere ? `Rows matching the filter` : 'Rows in the table'">
          of {{ exactCount.toLocaleString() }}
        </span>
        <button
          v-else-if="counting"
          type="button"
          class="btn btn-ghost px-1 py-0"
          title="Stop counting"
          @click="counting.stop()"
        >
          counting…
        </button>
        <button
          v-else
          type="button"
          class="btn-icon"
          :title="countError ?? 'Count every row (a full scan on a large table)'"
          :class="countError ? 'text-danger' : ''"
          aria-label="Count all rows"
          @click="countRows"
        >
          <AppIcon name="count" :size="12" />
        </button>

        <span class="hidden @xl:inline">· {{ result.durationMs }} ms</span>
      </span>
    </div>

    <!-- After a rename this tab still reads the old name, which no longer
         answers; the notice stays until the tab is closed or replaced. -->
    <div
      v-if="renamedTo"
      class="flex shrink-0 items-center gap-2 border-b border-edge bg-warning/10 px-3 py-1.5 text-warning"
    >
      <AppIcon name="warning" :size="12" />
      <span>
        <span class="font-mono">{{ node.name }}</span> is now
        <span class="font-mono">{{ renamedTo }}</span>. This tab still names the old table and cannot reload.
      </span>
      <button type="button" class="btn btn-accent ml-auto shrink-0" @click="openRenamed">
        Open {{ renamedTo }}
      </button>
    </div>

    <TableStructureView
      v-show="view === 'structure'"
      :node="node"
      :columns="columnNodes"
      :references="references"
      :indexes="structure?.indexes ?? []"
      :loading="structureLoading"
      :error="structureError ?? keyError"
      :editable="node.kind === 'table' && status === 'connected' && !renamedTo"
      :driver="driver"
      :read-only="Boolean(profile?.readOnly)"
      :connection-name="connectionName"
      class="min-h-0 flex-1"
      @reload="loadStructure"
      @changed="onStructureChanged"
    />

    <TableDdlView
      v-if="view === 'ddl'"
      :ddl="structure?.ddl ?? null"
      :note="structure?.ddlNote"
      :loading="structureLoading"
      :error="structureError"
      :context="context"
      :title="node.name"
      class="min-h-0 flex-1"
      @reload="loadStructure"
    />

    <div v-show="view === 'data'" class="min-h-0 flex-1">
      <p v-if="loading && !result" class="p-3 text-faint">
        Loading…
      </p>

      <p v-else-if="cancelled && !result" class="p-3 text-warning">
        Cancelled.
      </p>

      <div v-else-if="error" class="p-3">
        <p class="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-danger">
          <AppIcon name="warning" class="mt-0.5" />
          <span class="selectable font-mono">{{ error }}</span>
        </p>
      </div>

      <ResultGrid
        v-else-if="result"
        :result="result"
        :sort="order"
        :storage-key="`table:${node.id}`"
        :export-name="node.path.table ?? node.name"
        :dialect="dialect"
        :row-offset="offset"
        :edits="editable ? edits : undefined"
        :column-info="columnFacts"
        :read-only-reason="readOnlyReason ?? undefined"
        :load-bytes="loadBytes"
        filterable
        @update:sort="reorder"
        @save="save"
        @navigate="follow"
        @filter="addFilter"
      />

      <div v-else class="flex h-full flex-col items-center justify-center gap-3 text-faint">
        <AppIcon name="server" :size="22" class="opacity-50" />
        <p>
          <span class="text-muted">{{ connectionName }}</span> is not connected.
        </p>
        <button
          type="button"
          class="btn btn-accent"
          :disabled="connecting"
          @click="connections.connect(node.connectionId)"
        >
          {{ connecting ? 'Connecting…' : 'Connect' }}
        </button>
      </div>
    </div>

    <!-- Staged edits, and the only two things to do with them.
         Below the grid rather than above it: a bar that appears the moment a
         cell is edited would otherwise push the rows down under the pointer,
         and the row being edited out from under the eye. -->
    <div
      v-if="edits.dirty.value"
      class="flex shrink-0 items-center gap-2 border-t border-edge bg-warning/10 px-2 py-1"
    >
      <AppIcon name="pencil" :size="12" class="text-warning" />
      <span class="text-warning">
        <template v-if="edits.summary.value.cells">
          {{ edits.summary.value.cells }} cell{{ edits.summary.value.cells === 1 ? '' : 's' }}
        </template>
        <template v-if="edits.summary.value.added">
          <template v-if="edits.summary.value.cells"> · </template>
          {{ edits.summary.value.added }} new row{{ edits.summary.value.added === 1 ? '' : 's' }}
        </template>
        <template v-if="edits.summary.value.deleted">
          · {{ edits.summary.value.deleted }} row{{ edits.summary.value.deleted === 1 ? '' : 's' }} to delete
        </template>
        not saved
      </span>

      <button
        type="button"
        class="btn btn-ghost"
        :disabled="!edits.canUndo.value"
        title="Undo the last change (Ctrl+Z)"
        @click="edits.undo()"
      >
        Undo
      </button>

      <button
        type="button"
        class="btn btn-ghost"
        title="Open these changes as SQL, without running them"
        @click="showChangeScript"
      >
        Show SQL
      </button>

      <span class="ml-auto flex items-center gap-1">
        <button type="button" class="btn btn-ghost" @click="revert">
          Discard
        </button>

        <button
          type="button"
          class="btn btn-accent"
          :disabled="saving"
          title="Write every change in one transaction (Ctrl+S)"
          @click="save"
        >
          <AppIcon name="check" :size="12" />
          {{ saving ? 'Saving…' : `Save ${edits.summary.value.total}` }}
        </button>
      </span>
    </div>

    <p
      v-if="writeError"
      class="flex shrink-0 items-start gap-2 border-t border-edge bg-danger/10 px-3 py-1.5 text-danger"
    >
      <AppIcon name="warning" class="mt-0.5" />
      <span class="selectable min-w-0 flex-1 font-mono">{{ writeError }}</span>
      <button type="button" class="btn-icon shrink-0" title="Dismiss" @click="writeError = null">
        <AppIcon name="close" :size="11" />
      </button>
    </p>
  </div>
</template>
