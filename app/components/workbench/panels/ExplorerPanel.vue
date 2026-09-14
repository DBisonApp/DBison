<script setup lang="ts">
import type { IDockviewPanelProps } from 'dockview-vue'
import { nodeId } from '#shared/db-nodes'
import type { SchemaRoutine, SchemaSequence, SchemaTrigger } from '#shared/db-types'
import type { ExplorerColumnHit, ExplorerEntity as Entity } from '~/composables/useExplorer'

/**
 * The database explorer.
 *
 * Three fixed rows and then a flat list: which server, which database and
 * schema, what you are looking for — and every table under that scope, at one
 * level of indentation instead of four. The list is drawn from the schema
 * snapshot, so the filter reaches names that were never expanded, and the
 * columns under a row open without touching the server.
 */

const props = defineProps<{ params: IDockviewPanelProps }>()

const explorer = useExplorer()
const connections = useConnections()
const children = useDbChildren()
const schemaIndex = useSchemaIndex()
const { openTableData, openQuery, openDiagram } = useWorkbench()
const { openConnectionDialog, confirm, openExport, openImport, openBackup, openCreateTable } = useDialogs()
const { run } = useQueryRunner()
const { announce } = useLiveAnnouncer()
const { bridge } = useDatabaseBridge()
const { notice, copy, flash } = useClipboard()

const { profiles, loadError, isAvailable } = connections
const schemaObjects = useSchemaObjects()

/** F5 with the explorer active: the schema again, and everything under it. */
function refreshAll() {
  explorer.refresh()
  if (explorer.connectionId.value) schemaObjects.load(explorer.connectionId.value, explorer.database.value, true)
}

const unregisterRefresh = useRefreshables().register(props.params.api.id, refreshAll)
onBeforeUnmount(unregisterRefresh)

/**
 * A new table in the explorer's scope: the dialog writes the CREATE, and the
 * table then opens as any other would, so the first thing seen is its rows —
 * none yet — rather than the list it was added to.
 */
async function createTable() {
  const id = explorer.connectionId.value
  const driver = explorer.driver.value
  if (!id || !driver || !explorer.connected.value) return

  const result = await openCreateTable({
    connectionId: id,
    engine: engineOf(driver),
    levels: driver.levels,
    database: explorer.database.value,
    schema: explorer.schema.value,
    schemas: explorer.schemas.value,
    capabilities: driver.capabilities,
    readOnly: Boolean(explorer.profile.value?.readOnly),
    connectionName: explorer.profile.value?.name ?? 'this connection',
  })

  if (!result?.created) return

  announce(`Created ${result.name}`)
  flash(`Created ${result.name}`)
  refreshAll()

  openTableData({
    id: nodeId(id, 'table', result.path),
    connectionId: id,
    kind: 'table',
    name: result.name,
    expandable: true,
    path: result.path,
  })
}

/** Which tables have their columns showing; ids, so a re-filter keeps them. */
const opened = ref(new Set<string>())

/**
 * Sections folded shut, by name, kept across sessions: a schema with three
 * hundred functions is browsed for its tables most days. A search opens
 * everything regardless, because a hit hidden under a folded heading is a
 * hit nobody finds.
 */
const COLLAPSED_KEY = 'dbison.explorer.collapsed.v1'

function readCollapsed(): Set<string> {
  if (!import.meta.client) return new Set()
  try {
    const stored = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')
    return new Set(Array.isArray(stored) ? stored.filter((key): key is string => typeof key === 'string') : [])
  }
  catch {
    return new Set()
  }
}

const collapsed = ref(readCollapsed())

function isCollapsed(section: string) {
  return collapsed.value.has(section) && !explorer.filter.value.trim()
}

function toggleSection(section: string) {
  const next = new Set(collapsed.value)
  if (next.has(section)) next.delete(section)
  else next.add(section)
  collapsed.value = next

  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]))
  }
  catch {
    // Storage can be unavailable; the fold then lasts the session.
  }
}

let unsubscribe: (() => void) | undefined

onMounted(async () => {
  await connections.refresh()
  unsubscribe = connections.subscribe()
})

onBeforeUnmount(() => unsubscribe?.())

// A connection that drops takes its cached schema with it, so a reconnect
// re-reads a database that may have changed while it was closed.
watch(
  () => profiles.value.map((profile) => `${profile.id}:${connections.stateOf(profile.id).status}`).join(),
  (next, previous) => {
    if (!previous) return

    for (const entry of previous.split(',')) {
      const [id, status] = entry.split(':')
      if (status === 'connected' && !next.includes(`${id}:connected`)) {
        children.forget(id!)
        schemaIndex.forget(id!)
        schemaObjects.forget(id!)
      }
    }
  },
)

function toggle(id: string) {
  const next = new Set(opened.value)
  if (!next.delete(id)) next.add(id)
  opened.value = next
}

/* ------------------------------------------- routines, sequences, triggers -- */

/**
 * Read once the tables are up, not with them: the snapshot the tables come
 * from is also what the editor's completions wait on, and a slow catalog
 * query for trigger bodies should not hold that up.
 */
watch(
  [() => explorer.connectionId.value, () => explorer.database.value, () => explorer.ready.value],
  ([id, database, ready]) => { if (id && ready) schemaObjects.load(id, database) },
  { immediate: true },
)

const objectsRead = computed(() => schemaObjects.readOf(explorer.connectionId.value, explorer.database.value))

/** Whether an object sits in the schema the explorer is scoped to. */
function inScope(schema: string) {
  return explorer.schema.value === null || !schema || schema === explorer.schema.value
}

function objectLabel(schema: string, name: string) {
  return explorer.qualified.value && schema ? `${schema}.${name}` : name
}

/** Name-matched against the same filter box the tables use. */
function matching<T extends { schema: string, name: string }>(items: T[]) {
  const needle = explorer.filter.value.trim()

  return items
    .filter((item) => inScope(item.schema))
    .map((item) => ({ item, label: objectLabel(item.schema, item.name), match: fuzzyMatch(objectLabel(item.schema, item.name), needle) }))
    .filter((entry) => entry.match)
    .sort((a, b) => b.match!.score - a.match!.score || a.label.localeCompare(b.label))
}

const routines = computed(() => matching(objectsRead.value.objects?.routines ?? []))
const sequences = computed(() => matching(objectsRead.value.objects?.sequences ?? []))
const triggers = computed(() => matching(objectsRead.value.objects?.triggers ?? []))

/** A routine or trigger opens as its definition, ready to read or alter. */
function openDefinition(kind: 'routine' | 'trigger', item: SchemaRoutine | SchemaTrigger) {
  const definition = item.definition ?? `-- The engine reported no definition for ${item.name}.`

  openQuery({
    connectionId: explorer.connectionId.value,
    database: explorer.database.value ?? undefined,
    schema: item.schema || undefined,
    sql: definition,
    title: `${item.name} · ${kind}`,
  })
}

/** A sequence has no body; the useful thing to open is its current state. */
function openSequence(item: SchemaSequence) {
  const quote = explorer.driver.value?.quote ?? '"'
  const name = item.schema ? `${quoteIdentifier(item.schema, quote)}.${quoteIdentifier(item.name, quote)}` : quoteIdentifier(item.name, quote)

  openQuery({
    connectionId: explorer.connectionId.value,
    database: explorer.database.value ?? undefined,
    schema: item.schema || undefined,
    sql: `select * from ${name};`,
    title: `${item.name} · sequence`,
  })
}

function routineDetail(item: SchemaRoutine) {
  return [item.args !== undefined ? `(${item.args})` : '', item.returns ? `→ ${item.returns}` : ''].filter(Boolean).join(' ')
}

/** A column hit opens its table, with the column it was found by showing. */
function openHit(hit: ExplorerColumnHit) {
  const node = explorer.nodeOf(hit.object)

  opened.value = new Set(opened.value).add(node.id)
  openTableData(node)
}

/**
 * Which row the right-click landed on, or `null` for the blank space below the
 * list — which gets the shorter menu rather than no menu.
 *
 * One `ContextMenu` serves the whole list. The rows record themselves here on
 * the way up; the container clears it on the way down, in the capture phase, so
 * a click that reaches no row leaves nothing stale behind.
 */
const target = ref<Entity | null>(null)

/** The SELECT this driver would write for the table, quoted its own way. */
async function previewSql(entity: Entity) {
  const id = explorer.connectionId.value
  if (!id) return null

  try {
    const { sql } = await bridge().preview(id, entity.node, { limit: 100 })
    return sql
  }
  catch (error) {
    flash((error as Error).message)
    return null
  }
}

async function copySelect(entity: Entity) {
  const sql = await previewSql(entity)
  if (sql) copy(sql, 'the SELECT statement')
}

/** Opens a query tab already scoped to the table, with its SELECT in the editor. */
async function queryHere(entity: Entity) {
  openQuery({
    connectionId: explorer.connectionId.value,
    database: explorer.database.value ?? undefined,
    schema: entity.object.schema || undefined,
    sql: (await previewSql(entity)) ?? '',
    title: entity.object.name,
  })
}

/**
 * The table's name as a statement needs it: qualified by whatever level the
 * engine has above a table, quoted the engine's way.
 */
function qualifiedFor(entity: Entity) {
  const quote = explorer.driver.value?.quote ?? '"'
  const levels = explorer.levels.value
  const path = entity.node.path
  const qualifier = levels.includes('schema') ? path.schema : levels.includes('database') ? path.database : undefined
  const name = quoteIdentifier(path.table ?? entity.object.name, quote)

  return qualifier ? `${quoteIdentifier(qualifier, quote)}.${name}` : name
}

/**
 * Drops or empties a table. No undo, so the name is typed, not clicked; and
 * the statement runs through the ordinary query path so a connection marked
 * read-only still gets its say in the driver's own error if it refuses.
 */
async function destroy(entity: Entity, action: 'drop' | 'truncate') {
  const id = explorer.connectionId.value
  if (!id) return

  const kind = entity.object.kind
  const name = entity.object.name
  const readOnly = Boolean(explorer.profile.value?.readOnly)
  const ok = await confirm({
    title: action === 'drop' ? `Drop ${kind} ${name}?` : `Empty table ${name}?`,
    message: (action === 'drop'
      ? `The ${kind} and everything in it will be gone. There is no undo.`
      : 'Every row will be deleted. There is no undo.')
    + (readOnly ? ` ${explorer.profile.value?.name} is marked read-only.` : ''),
    confirmLabel: action === 'drop' ? 'Drop' : 'Delete all rows',
    danger: true,
    typed: name,
  })
  if (!ok) return

  const target = qualifiedFor(entity)
  // SQLite has no TRUNCATE; a DELETE with no WHERE is the same thing there.
  const sql = action === 'drop'
    ? `drop ${kind} ${target}`
    : explorer.driver.value?.id === 'sqlite' ? `delete from ${target}` : `truncate table ${target}`

  try {
    // Typing the name is the consent the read-only guard asks for.
    await run(
      { connectionId: id, database: explorer.database.value, schema: entity.node.path.schema },
      sql,
      undefined,
      { allowWrite: readOnly },
    ).result
    announce(action === 'drop' ? `Dropped ${name}` : `Emptied ${name}`)
    flash(action === 'drop' ? `Dropped ${name}` : `Emptied ${name}`)
    if (action === 'drop') refreshAll()
  }
  catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    flash(message)
    announce(message, 'assertive')
  }
}

/** Every row of the table to a file: the driver's SELECT with no LIMIT. */
async function exportTable(entity: Entity) {
  const id = explorer.connectionId.value
  if (!id) return

  try {
    const { sql } = await bridge().preview(id, entity.node, { limit: null })
    const driver = explorer.driver.value

    openExport({
      connectionId: id,
      sql,
      database: entity.node.path.database ?? explorer.database.value ?? undefined,
      schema: entity.node.path.schema,
      suggestedName: entity.object.name,
      dialect: {
        table: qualifiedFor(entity),
        quote: driver?.quote ?? '"',
        escapeBackslashes: driver?.id === 'mysql' || driver?.id === 'mariadb',
      },
      description: `every row of ${entity.object.name}`,
    })
  }
  catch (error) {
    flash((error as Error).message)
  }
}

/**
 * A file into the table. The columns come from `children` rather than the
 * snapshot where they can: the snapshot does not say which columns the
 * server fills in by itself, and that is what tells a required column from
 * an auto-increment id.
 */
async function importInto(entity: Entity) {
  const id = explorer.connectionId.value
  if (!id) return

  const columns = await children.childrenOf(id, entity.node)
    .then((nodes) => nodes.map((column) => ({
      name: column.name,
      type: column.declaredType ?? column.detail ?? '',
      nullable: column.nullable,
      hasDefault: column.hasDefault,
    })))
    .catch(() => entity.object.columns.map((column) => ({
      name: column.name,
      type: column.type,
      nullable: column.nullable,
    })))

  const outcome = await openImport({
    node: entity.node,
    columns,
    connectionName: explorer.profile.value?.name ?? 'This connection',
    readOnly: Boolean(explorer.profile.value?.readOnly),
  })
  if (!outcome) return

  const message = `Imported ${outcome.inserted.toLocaleString()} row${outcome.inserted === 1 ? '' : 's'} into ${entity.object.name}`
  announce(message)
  flash(message)
  // The row estimate beside the name is what changed; the snapshot carries it.
  refreshAll()
}

/** The diagram of this table and the tables its keys reach. */
function showRelations(entity: Entity) {
  openDiagram({
    connectionId: explorer.connectionId.value!,
    database: explorer.database.value,
    schema: explorer.schema.value,
    focus: { schema: entity.object.schema, name: entity.object.name },
  })
}

/* ------------------------------------------------------------ backup -- */

/** Whether the current connection's engine has a dump tool the app can drive. */
const canBackup = computed(() => Boolean(explorer.driver.value?.capabilities?.dump))

/** The engine's own dump or restore tool, pointed at the database on screen. */
async function backup(mode: 'dump' | 'restore') {
  const profile = explorer.profile.value
  if (!profile) return

  const outcome = await openBackup({ profile, mode, database: explorer.database.value })

  // A restore replaced what the list is showing; read it again.
  if (outcome?.ok && mode === 'restore') refreshAll()
}

// The palette lists both for whichever connection the explorer is on; the
// dialog itself says when the tool is missing, so only the engine gates them.
const unregisterCommands = useCommandRegistry().register('explorer-backup', () => {
  const profile = explorer.profile.value
  if (!profile || !canBackup.value) return []

  return [
    {
      id: 'backup',
      label: `Backup ${profile.name}…`,
      group: 'Connection',
      icon: 'archive',
      keywords: 'dump export pg_dump mysqldump sqlite',
      run: () => { backup('dump') },
    },
    {
      id: 'restore',
      label: `Restore into ${profile.name}…`,
      group: 'Connection',
      icon: 'archiveRestore',
      keywords: 'dump import psql mysql sqlite',
      run: () => { backup('restore') },
    },
  ]
})
onBeforeUnmount(unregisterCommands)

const shown = computed(() => explorer.tables.value.length + explorer.views.value.length)
const hidden = computed(() => Math.max(0, shown.value - explorer.renderLimit))

/* ------------------------------------------------------------------------ *
 * Keyboard: one tab stop for the list, arrows for everything inside it.
 * ------------------------------------------------------------------------ */

/**
 * The row Tab lands on. Every row carries `tabindex="-1"` except this one, so
 * a list of five hundred tables is a single stop on the way to the footer,
 * and tabbing away and back returns to the row the user was on rather than
 * the top. `null` means nobody has been anywhere yet: the first row takes it.
 */
const focusedRowId = ref<string | null>(null)

const list = ref<HTMLElement | null>(null)

function hitId(hit: ExplorerColumnHit) {
  return `${hit.object.schema}.${hit.object.name}.${hit.column.name}`
}

/**
 * Every id the list is currently drawing, in the order it draws them. Column
 * hits count: they are rows to the arrow keys, even though they cannot expand.
 */
const renderedIds = computed(() => [
  ...explorer.tables.value.slice(0, explorer.renderLimit).map((entity) => entity.node.id),
  ...explorer.views.value.slice(0, explorer.renderLimit).map((entity) => entity.node.id),
  ...routines.value.map((entry) => `routine:${entry.label}`),
  ...sequences.value.map((entry) => `sequence:${entry.label}`),
  ...triggers.value.map((entry) => `trigger:${entry.label}`),
  ...explorer.columnHits.value.map(hitId),
])

const tabbableId = computed(() => focusedRowId.value ?? renderedIds.value[0] ?? null)

// A filter that drops the remembered row would otherwise leave the list with
// no tab stop at all, since no rendered row would match the id.
watch(renderedIds, (ids) => {
  if (focusedRowId.value && !ids.includes(focusedRowId.value)) focusedRowId.value = null
})

function rowsOf(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-explorer-row]'))
}

function focusRow(row: HTMLElement | undefined) {
  if (!row) return

  row.focus()
  row.scrollIntoView({ block: 'nearest' })
}

/** Remembers the row the user reached, however they got there. */
function onListFocusin(event: FocusEvent) {
  const row = (event.target as HTMLElement).closest<HTMLElement>('[data-explorer-row]')
  const id = row?.dataset.entityId

  if (id) focusedRowId.value = id
}

/**
 * Up and Down walk the rows, Home and End jump, Right opens a table's columns
 * and Left closes them. Enter and Space are left to the button itself, which
 * already opens the table on click.
 */
function onListKeydown(event: KeyboardEvent) {
  const container = list.value
  if (!container) return

  const current = (event.target as HTMLElement).closest<HTMLElement>('[data-explorer-row]')
  if (!current) return

  const rows = rowsOf(container)
  const index = rows.indexOf(current)
  const id = current.dataset.entityId

  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      focusRow(rows[Math.min(index + 1, rows.length - 1)])
      break

    case 'ArrowUp':
      event.preventDefault()
      focusRow(rows[Math.max(index - 1, 0)])
      break

    case 'Home':
      event.preventDefault()
      focusRow(rows[0])
      break

    case 'End':
      event.preventDefault()
      focusRow(rows[rows.length - 1])
      break

    // Only entity rows can open; a column hit has no columns of its own to
    // show, and toggling its id would only plant a stray entry in `opened`.
    case 'ArrowRight':
      event.preventDefault()
      if (id && !opened.value.has(id) && current.hasAttribute('aria-expanded')) toggle(id)
      break

    case 'ArrowLeft':
      event.preventDefault()
      if (id && opened.value.has(id)) toggle(id)
      break
  }
}

/** Down from the filter drops into the list; Escape clears what was typed. */
function onFilterKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    if (list.value) focusRow(rowsOf(list.value)[0])
  }
  else if (event.key === 'Escape' && explorer.filter.value) {
    // Cleared here rather than left to the search field's own reset, so the
    // model empties on the same keystroke in every engine, not just Chromium's.
    event.preventDefault()
    explorer.filter.value = ''
  }
}
</script>

<template>
  <div class="flex h-full flex-col bg-bg">
    <ExplorerConnectionSwitcher />

    <ExplorerScopeBar
      v-if="explorer.profile.value"
      @create-table="createTable"
      @backup="backup('dump')"
      @restore="backup('restore')"
    />

    <label v-if="explorer.profile.value" class="relative block border-b border-edge p-1.5">
      <AppIcon name="search" class="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-faint" />
      <input
        v-model="explorer.filter.value"
        type="search"
        placeholder="Filter tables and columns"
        aria-label="Filter tables and columns"
        class="field bg-surface py-1 pr-2 pl-7"
        @keydown="onFilterKeydown"
      >
    </label>

    <div v-if="loadError" class="flex items-start gap-2 border-b border-edge px-2 py-2 text-warning">
      <AppIcon name="warning" />
      <span class="selectable">{{ loadError }}</span>
    </div>

    <ContextMenu>
      <ContextMenuTrigger>
        <!-- Capture, so this runs before the rows below set themselves as the
             target; a right-click on blank space then finds it already null. -->
        <div
          ref="list"
          class="min-h-0 flex-1 overflow-auto"
          @contextmenu.capture="target = null"
          @focusin="onListFocusin"
          @keydown="onListKeydown"
        >
      <div
        v-if="isAvailable && !profiles.length"
        class="flex flex-col items-center gap-3 px-3 py-8 text-center"
      >
        <AppLogo :size="32" tone="current" class="text-faint opacity-30" />
        <p class="text-faint">
          No connections yet.
        </p>
        <button type="button" class="btn btn-outline" @click="openConnectionDialog()">
          <AppIcon name="plus" :size="12" />
          Add one
        </button>
      </div>

      <div v-else-if="!explorer.connected.value" class="px-3 py-4 text-center">
        <p v-if="connections.reconnecting.value[explorer.connectionId.value!]" class="text-warning">
          Connection lost. Reconnecting…
        </p>
        <p v-else class="text-faint">
          {{ explorer.status.value === 'error'
            ? connections.stateOf(explorer.connectionId.value!).error?.message
            : 'Not connected.' }}
        </p>

        <button
          type="button"
          class="btn btn-accent mt-3"
          :disabled="explorer.status.value === 'connecting' || connections.reconnecting.value[explorer.connectionId.value!]"
          @click="explorer.connect()"
        >
          {{ explorer.status.value === 'connecting' ? 'Connecting…' : 'Connect' }}
        </button>
      </div>

      <p
        v-else-if="explorer.error.value"
        class="selectable m-2 flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 px-2.5 py-2 text-danger"
      >
        <AppIcon name="warning" class="mt-0.5" />
        <span>{{ explorer.error.value }}</span>
      </p>

      <div v-else-if="!explorer.ready.value" class="px-3 py-4">
        <p class="text-center text-faint">
          Reading schema…
        </p>
        <div class="app-progress mx-auto mt-3 h-0.5 w-32 rounded-full" />
      </div>

      <template v-else>
        <section v-if="explorer.tables.value.length">
          <h2
            class="section-head cursor-pointer select-none"
            role="button"
            tabindex="-1"
            :aria-expanded="!isCollapsed('tables')"
            :title="isCollapsed('tables') ? 'Show tables' : 'Hide tables'"
            @click="toggleSection('tables')"
          >
            <AppIcon :name="isCollapsed('tables') ? 'chevronRight' : 'chevronDown'" :size="10" class="-mr-1" />
            <AppIcon name="table" :size="11" />
            Tables
            <span class="chip">{{ explorer.tables.value.length }}</span>
          </h2>
          <template v-if="!isCollapsed('tables')">

          <ExplorerEntity
            v-for="entity in explorer.tables.value.slice(0, explorer.renderLimit)"
            :key="entity.node.id"
            :entity="entity"
            :expanded="opened.has(entity.node.id)"
            :foreign-keys="opened.has(entity.node.id) ? explorer.foreignKeysOf(entity.object) : {}"
            :tabbable="entity.node.id === tabbableId"
            @open="openTableData(entity.node)"
            @toggle="toggle(entity.node.id)"
            @contextmenu="target = entity"
          />
          </template>
        </section>

        <section v-if="explorer.views.value.length">
          <h2
            class="section-head cursor-pointer select-none"
            role="button"
            tabindex="-1"
            :aria-expanded="!isCollapsed('views')"
            :title="isCollapsed('views') ? 'Show views' : 'Hide views'"
            @click="toggleSection('views')"
          >
            <AppIcon :name="isCollapsed('views') ? 'chevronRight' : 'chevronDown'" :size="10" class="-mr-1" />
            <AppIcon name="view" :size="11" />
            Views
            <span class="chip">{{ explorer.views.value.length }}</span>
          </h2>
          <template v-if="!isCollapsed('views')">

          <ExplorerEntity
            v-for="entity in explorer.views.value.slice(0, explorer.renderLimit)"
            :key="entity.node.id"
            :entity="entity"
            :expanded="opened.has(entity.node.id)"
            :foreign-keys="opened.has(entity.node.id) ? explorer.foreignKeysOf(entity.object) : {}"
            :tabbable="entity.node.id === tabbableId"
            @open="openTableData(entity.node)"
            @toggle="toggle(entity.node.id)"
            @contextmenu="target = entity"
          />
          </template>
        </section>

        <!-- Beyond tables: read after them, and listed after them, because
             a session starts at a table far more often than at a function. -->
        <section v-if="routines.length">
          <h2
            class="section-head cursor-pointer select-none"
            role="button"
            tabindex="-1"
            :aria-expanded="!isCollapsed('routines')"
            :title="isCollapsed('routines') ? 'Show functions' : 'Hide functions'"
            @click="toggleSection('routines')"
          >
            <AppIcon :name="isCollapsed('routines') ? 'chevronRight' : 'chevronDown'" :size="10" class="-mr-1" />
            <AppIcon name="bolt" :size="11" />
            Functions
            <span class="chip">{{ routines.length }}</span>
          </h2>
          <template v-if="!isCollapsed('routines')">

          <button
            v-for="entry in routines"
            :key="`routine:${entry.label}`"
            type="button"
            class="rail flex w-full items-center gap-1.5 py-1 pr-2 pl-6.5 text-left transition-colors hover:bg-surface"
            data-explorer-row
            :data-entity-id="`routine:${entry.label}`"
            :tabindex="`routine:${entry.label}` === tabbableId ? 0 : -1"
            :title="`Open the ${entry.item.kind} definition${entry.item.language ? ` (${entry.item.language})` : ''}`"
            @click="openDefinition('routine', entry.item)"
          >
            <AppIcon name="bolt" :size="11" class="text-faint" />
            <span class="truncate font-medium">{{ entry.label }}</span>
            <span class="min-w-0 truncate font-mono text-[11px] text-faint">{{ routineDetail(entry.item) }}</span>
            <span v-if="entry.item.kind === 'procedure'" class="chip ml-auto shrink-0">proc</span>
          </button>
          </template>
        </section>

        <section v-if="sequences.length">
          <h2
            class="section-head cursor-pointer select-none"
            role="button"
            tabindex="-1"
            :aria-expanded="!isCollapsed('sequences')"
            :title="isCollapsed('sequences') ? 'Show sequences' : 'Hide sequences'"
            @click="toggleSection('sequences')"
          >
            <AppIcon :name="isCollapsed('sequences') ? 'chevronRight' : 'chevronDown'" :size="10" class="-mr-1" />
            <AppIcon name="index" :size="11" />
            Sequences
            <span class="chip">{{ sequences.length }}</span>
          </h2>
          <template v-if="!isCollapsed('sequences')">

          <button
            v-for="entry in sequences"
            :key="`sequence:${entry.label}`"
            type="button"
            class="rail flex w-full items-center gap-1.5 py-1 pr-2 pl-6.5 text-left transition-colors hover:bg-surface"
            data-explorer-row
            :data-entity-id="`sequence:${entry.label}`"
            :tabindex="`sequence:${entry.label}` === tabbableId ? 0 : -1"
            title="Open a query on the sequence"
            @click="openSequence(entry.item)"
          >
            <AppIcon name="index" :size="11" class="text-faint" />
            <span class="truncate font-medium">{{ entry.label }}</span>
            <span class="ml-auto shrink-0 pl-2 font-mono text-[11px] text-faint tabular-nums">
              {{ entry.item.lastValue ?? '' }}
            </span>
          </button>
          </template>
        </section>

        <section v-if="triggers.length">
          <h2
            class="section-head cursor-pointer select-none"
            role="button"
            tabindex="-1"
            :aria-expanded="!isCollapsed('triggers')"
            :title="isCollapsed('triggers') ? 'Show triggers' : 'Hide triggers'"
            @click="toggleSection('triggers')"
          >
            <AppIcon :name="isCollapsed('triggers') ? 'chevronRight' : 'chevronDown'" :size="10" class="-mr-1" />
            <AppIcon name="bolt" :size="11" />
            Triggers
            <span class="chip">{{ triggers.length }}</span>
          </h2>
          <template v-if="!isCollapsed('triggers')">

          <button
            v-for="entry in triggers"
            :key="`trigger:${entry.label}`"
            type="button"
            class="rail flex w-full items-center gap-1.5 py-1 pr-2 pl-6.5 text-left transition-colors hover:bg-surface"
            data-explorer-row
            :data-entity-id="`trigger:${entry.label}`"
            :tabindex="`trigger:${entry.label}` === tabbableId ? 0 : -1"
            :title="`${entry.item.when ?? 'trigger'} on ${entry.item.table}`"
            @click="openDefinition('trigger', entry.item)"
          >
            <AppIcon name="bolt" :size="11" class="text-faint" />
            <span class="truncate font-medium">{{ entry.label }}</span>
            <span class="min-w-0 truncate text-faint">{{ entry.item.when }} · {{ entry.item.table }}</span>
          </button>
          </template>
        </section>

        <p v-if="objectsRead.error" class="px-3 py-1.5 text-warning" :title="objectsRead.error">
          Functions and triggers could not be read.
        </p>

        <!-- The group the old tree could not have had: tables found by a column
             name rather than their own. -->
        <section v-if="explorer.columnHits.value.length">
          <h2 class="section-head">
            <AppIcon name="column" :size="11" />
            Column matches
            <span class="chip">{{ explorer.columnHits.value.length }}</span>
          </h2>

          <button
            v-for="hit in explorer.columnHits.value"
            :key="hitId(hit)"
            type="button"
            class="rail flex w-full items-center gap-1.5 py-1 pr-2 pl-6.5 text-left transition-colors hover:bg-surface"
            data-explorer-row
            :data-entity-id="hitId(hit)"
            :tabindex="hitId(hit) === tabbableId ? 0 : -1"
            :title="`${hit.label} · ${hit.column.type}`"
            @click="openHit(hit)"
          >
            <AppIcon name="column" :size="11" class="text-faint" />
            <span class="truncate text-muted">{{ hit.label.slice(0, hit.label.lastIndexOf('.') + 1) }}</span>
            <span class="truncate font-medium">{{ hit.column.name }}</span>
          </button>
        </section>

        <p v-if="!shown && !explorer.columnHits.value.length" class="px-3 py-4 text-center text-faint">
          {{ explorer.filter.value.trim()
            ? `No match for “${explorer.filter.value.trim()}”`
            : 'Nothing here.' }}
        </p>
      </template>
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent>
        <template v-if="target">
          <ContextMenuLabel>{{ target.label }}</ContextMenuLabel>

          <ContextMenuItem icon="table" @select="openTableData(target!.node)">
            Open Data
          </ContextMenuItem>

          <ContextMenuItem icon="play" @select="queryHere(target!)">
            New Query Here
          </ContextMenuItem>

          <ContextMenuItem icon="diagram" @select="showRelations(target!)">
            Show Relationships
          </ContextMenuItem>

          <ContextMenuSeparator />

          <ContextMenuItem icon="copy" @select="copy(target!.object.name, 'the name')">
            Copy Name
          </ContextMenuItem>

          <!-- Only worth offering where it differs from the bare name, which is
               exactly when the explorer is showing schemas side by side. -->
          <ContextMenuItem
            v-if="target.label !== target.object.name"
            icon="copy"
            @select="copy(target!.label, 'the qualified name')"
          >
            Copy Qualified Name
          </ContextMenuItem>

          <ContextMenuItem
            icon="column"
            @select="copy(target!.object.columns.map((c) => c.name).join(', '), 'the column list')"
          >
            Copy Column List
          </ContextMenuItem>

          <ContextMenuItem icon="copy" @select="copySelect(target!)">
            Copy SELECT Statement
          </ContextMenuItem>

          <ContextMenuSeparator />

          <ContextMenuItem
            v-if="target.object.kind === 'table'"
            icon="fileUp"
            @select="importInto(target!)"
          >
            Import CSV…
          </ContextMenuItem>

          <ContextMenuItem icon="fileDown" @select="exportTable(target!)">
            Export {{ target.object.kind === 'view' ? 'View' : 'Table' }}…
          </ContextMenuItem>

          <ContextMenuSeparator />

          <!-- The two things with no undo, at the bottom, drawn as what they
               are; each asks for the name to be typed before it runs. -->
          <ContextMenuItem
            v-if="target.object.kind === 'table'"
            icon="trash"
            danger
            @select="destroy(target!, 'truncate')"
          >
            Delete All Rows…
          </ContextMenuItem>

          <ContextMenuItem icon="trash" danger @select="destroy(target!, 'drop')">
            Drop {{ target.object.kind === 'view' ? 'View' : 'Table' }}…
          </ContextMenuItem>

          <ContextMenuSeparator />
        </template>

        <!-- The database as a whole, for the blank space below its tables. -->
        <ContextMenuItem icon="plus" :disabled="!explorer.connected.value" @select="createTable()">
          New Table…
        </ContextMenuItem>

        <ContextMenuItem
          v-if="explorer.connected.value && canBackup"
          icon="archive"
          @select="backup('dump')"
        >
          Backup Database…
        </ContextMenuItem>

        <ContextMenuItem icon="refresh" hint="F5" @select="refreshAll()">
          Refresh Schema
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>

    <div class="flex items-center gap-2 border-t border-edge bg-surface/50 px-2 py-1 text-faint">
      <span v-if="explorer.ready.value">
        {{ explorer.filter.value.trim() ? `${shown} of ${explorer.total.value}` : explorer.total.value }}
        object{{ explorer.total.value === 1 ? '' : 's' }}
      </span>

      <span v-if="hidden" class="text-warning">· {{ hidden }} not shown, narrow the filter</span>

      <span v-if="explorer.truncated.value" class="text-warning" title="The schema was larger than one snapshot holds">
        · partial schema
      </span>

      <span v-if="notice" class="ml-auto min-w-0 truncate pl-2 text-accent-bright">{{ notice }}</span>
    </div>
  </div>
</template>
