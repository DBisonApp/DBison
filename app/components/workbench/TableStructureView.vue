<script setup lang="ts">
import type { DbNode, DdlOperation, DriverMeta, IndexInfo } from '#shared/db-types'
import type { StructureChangeResult } from '~/components/workbench/StructureChangeDialog.vue'
import type { ColumnRef } from '~/utils/cell-types'

/**
 * A table as its definition describes it: columns, keys and indexes — and,
 * for a table on a live connection, the place to change them.
 *
 * The rows say what a table holds; this says what it is. Most of it is
 * already in memory — the column list is what the grid's editors were built
 * from — so the only new round trip is for the indexes. Each change opens
 * one dialog that shows the SQL before it runs; this view only says which
 * change, about which column, and tells its owner when one went through.
 */
const props = defineProps<{
  node: DbNode
  columns: DbNode[]
  /** Where each column points, by name, when it is a foreign key. */
  references: Record<string, ColumnRef>
  indexes: IndexInfo[]
  loading: boolean
  error: string | null
  /**
   * Whether the structure may be changed from here: a table, not a view, on
   * a connection that is open. The driver decides what kinds of change.
   */
  editable?: boolean
  driver?: DriverMeta | null
  readOnly?: boolean
  connectionName?: string
}>()

const emit = defineEmits<{
  reload: []
  /** A structure change ran; the owner re-reads whatever it shows. */
  changed: [result: StructureChangeResult]
}>()

const { copy, notice } = useClipboard()
const { openStructureChange } = useDialogs()

const keyColumns = computed(() => props.columns.filter((column) => column.primaryKey).map((column) => column.name))

/* --------------------------------------------------------------- editing -- */

const engine = computed(() => engineOf(props.driver))
const capabilities = computed(() => props.driver?.capabilities)
const canAlter = computed(() => Boolean(capabilities.value?.alterColumn))

/** Opens the change dialog on this table, and reports the change if it ran. */
async function change(operation: DdlOperation) {
  const result = await openStructureChange({
    connectionId: props.node.connectionId,
    node: props.node,
    operation,
    columns: props.columns,
    indexes: props.indexes,
    engine: engine.value,
    capabilities: capabilities.value,
    readOnly: Boolean(props.readOnly),
    connectionName: props.connectionName ?? 'this connection',
  })

  if (result?.applied) emit('changed', result)
}

function addColumn() {
  change({ kind: 'addColumn', column: { name: '', type: '', nullable: true } })
}

function renameColumn(column: DbNode) {
  change({ kind: 'renameColumn', name: column.name, to: column.name })
}

/** The dialog starts from the column as it is, so a change is one edit. */
function alterColumn(column: DbNode) {
  change({
    kind: 'alterColumn',
    name: column.name,
    type: column.declaredType ?? column.detail ?? '',
    nullable: column.nullable !== false,
  })
}

function dropColumn(column: DbNode) {
  change({ kind: 'dropColumn', name: column.name })
}

/** An index over the column under the pointer, or over nothing yet. */
function addIndex(column?: DbNode) {
  change({ kind: 'createIndex', name: '', columns: column ? [column.name] : [], unique: false })
}

function dropIndex(index: IndexInfo) {
  change({ kind: 'dropIndex', name: index.name })
}

function renameTable() {
  change({ kind: 'renameTable', to: props.node.path.table ?? props.node.name })
}

function dropTable() {
  change({ kind: 'dropTable' })
}

/** The keeper of the primary key goes with the constraint, not with DROP INDEX. */
function indexDropTitle(index: IndexInfo) {
  return index.primary ? 'The primary key is a constraint; it cannot be dropped as an index' : `Drop ${index.name}`
}

/** What a column falls back to when a row leaves it out, in one word. */
function fallback(column: DbNode) {
  if (column.hasDefault) return 'default'
  if (column.nullable === false) return 'required'
  return 'null'
}

const FALLBACK_CLASS: Record<string, string> = {
  default: 'text-accent-bright',
  required: 'text-warning',
  null: 'text-faint',
}

function copyColumnList() {
  copy(props.columns.map((column) => column.name).join(', '), 'the column list')
}
</script>

<template>
  <div class="h-full overflow-auto">
    <p v-if="loading && !columns.length" class="p-3 text-faint">
      Loading…
    </p>

    <div v-else-if="error" class="p-3">
      <p class="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-danger">
        <AppIcon name="warning" class="mt-0.5" />
        <span class="selectable min-w-0 flex-1 font-mono">{{ error }}</span>
        <button type="button" class="btn btn-ghost shrink-0" @click="emit('reload')">
          Retry
        </button>
      </p>
    </div>

    <template v-else>
      <section class="px-3 pt-3">
        <header class="mb-1.5 flex items-center gap-2">
          <h3 class="font-medium text-content">
            Columns
          </h3>
          <span class="text-faint tabular-nums">{{ columns.length }}</span>
          <span v-if="keyColumns.length" class="chip gap-1" :title="`Primary key: ${keyColumns.join(', ')}`">
            <AppIcon name="key" :size="10" />
            {{ keyColumns.join(', ') }}
          </span>
          <span v-if="notice" class="text-accent-bright">{{ notice }}</span>
          <button type="button" class="btn btn-ghost ml-auto" @click="copyColumnList">
            <AppIcon name="copy" :size="11" />
            Copy column list
          </button>

          <template v-if="editable">
            <button type="button" class="btn btn-ghost" title="Add a column to the table" @click="addColumn">
              <AppIcon name="plus" :size="11" />
              Add column…
            </button>

            <!-- The two changes to the table itself rather than to a part of
                 it, behind one button: neither is done often enough to earn a
                 place on the row. -->
            <DropdownMenu>
              <DropdownMenuTrigger>
                <button type="button" class="btn-icon p-1" title="Table actions" aria-label="Table actions">
                  <AppIcon name="more" :size="14" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem icon="pencil" @select="renameTable">
                  Rename table…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem icon="trash" danger @select="dropTable">
                  Drop table…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </template>
        </header>

        <div class="overflow-x-auto rounded-md border border-edge">
          <table class="w-full border-collapse font-mono">
            <thead class="bg-surface/60 text-left text-faint">
              <tr>
                <th class="px-2 py-1 font-medium">
                  Name
                </th>
                <th class="px-2 py-1 font-medium">
                  Type
                </th>
                <th class="px-2 py-1 font-medium">
                  Nullable
                </th>
                <th class="px-2 py-1 font-medium" title="What a new row gets when the column is left out">
                  When omitted
                </th>
                <th class="px-2 py-1 font-medium">
                  References
                </th>
                <th v-if="editable" class="w-8 px-1 py-1">
                  <span class="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="column in columns"
                :key="column.name"
                class="group border-t border-edge/60 hover:bg-accent-soft/40"
              >
                <td class="px-2 py-1 whitespace-nowrap">
                  <span class="flex items-center gap-1.5">
                    <AppIcon
                      v-if="column.primaryKey"
                      name="key"
                      :size="11"
                      class="text-warning"
                      title="Primary key"
                    />
                    <AppIcon
                      v-else-if="references[column.name]"
                      name="link"
                      :size="11"
                      class="text-accent-bright"
                      title="Foreign key"
                    />
                    <span v-else class="inline-block w-[11px]" />
                    <span class="selectable text-content">{{ column.name }}</span>
                  </span>
                </td>
                <td class="selectable px-2 py-1 whitespace-nowrap text-muted">
                  {{ column.declaredType ?? column.detail ?? '' }}
                  <span v-if="column.enumValues?.length" class="text-faint" :title="column.enumValues.join(', ')">
                    ({{ column.enumValues.length }} values)
                  </span>
                </td>
                <td class="px-2 py-1 text-faint">
                  {{ column.nullable === false ? 'not null' : 'null' }}
                </td>
                <td class="px-2 py-1" :class="FALLBACK_CLASS[fallback(column)]">
                  {{ fallback(column) }}
                </td>
                <td class="selectable px-2 py-1 whitespace-nowrap text-muted">
                  <template v-if="references[column.name]">
                    {{ describeRef(references[column.name]!) }}
                  </template>
                </td>
                <td v-if="editable" class="px-1 py-0.5">
                  <!-- Shown on hover, kept reachable by keyboard: the row is a
                       fact about the table first and a place to change it
                       second. -->
                  <DropdownMenu>
                    <DropdownMenuTrigger>
                      <button
                        type="button"
                        class="btn-icon p-1 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                        :title="`Actions for ${column.name}`"
                        :aria-label="`Actions for ${column.name}`"
                      >
                        <AppIcon name="more" :size="13" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuLabel>{{ column.name }}</DropdownMenuLabel>
                      <DropdownMenuItem icon="pencil" @select="renameColumn(column)">
                        Rename…
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        v-if="canAlter"
                        icon="structure"
                        @select="alterColumn(column)"
                      >
                        Change type, null or default…
                      </DropdownMenuItem>
                      <DropdownMenuItem icon="index" @select="addIndex(column)">
                        Add index on this column…
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem icon="trash" danger @select="dropColumn(column)">
                        Drop column…
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Said once, up front, rather than discovered in a dialog that can
             only refuse: the engine has no ALTER COLUMN to offer. -->
        <p v-if="editable && !canAlter && columns.length" class="mt-1.5 text-faint">
          {{ driver?.label ?? 'This engine' }} cannot change a column's type, nullability or default in place; add a new column and copy the values across.
        </p>
      </section>

      <section class="px-3 pt-4 pb-3">
        <header class="mb-1.5 flex items-center gap-2">
          <h3 class="font-medium text-content">
            Indexes
          </h3>
          <span class="text-faint tabular-nums">{{ indexes.length }}</span>

          <button
            v-if="editable"
            type="button"
            class="btn btn-ghost ml-auto"
            title="Add an index to the table"
            @click="addIndex()"
          >
            <AppIcon name="plus" :size="11" />
            Add index…
          </button>
        </header>

        <p v-if="loading" class="text-faint">
          Loading…
        </p>

        <p v-else-if="!indexes.length" class="text-faint">
          No indexes.
          <span v-if="node.kind === 'table' && !keyColumns.length">The table has no primary key, either.</span>
        </p>

        <div v-else class="overflow-x-auto rounded-md border border-edge">
          <table class="w-full border-collapse font-mono">
            <thead class="bg-surface/60 text-left text-faint">
              <tr>
                <th class="px-2 py-1 font-medium">
                  Name
                </th>
                <th class="px-2 py-1 font-medium">
                  Columns
                </th>
                <th class="px-2 py-1 font-medium">
                  Kind
                </th>
                <th v-if="editable" class="w-8 px-1 py-1">
                  <span class="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="index in indexes"
                :key="index.name"
                class="group border-t border-edge/60 hover:bg-accent-soft/40"
                :title="index.definition"
              >
                <td class="selectable px-2 py-1 whitespace-nowrap text-content">
                  {{ index.name }}
                </td>
                <td class="selectable px-2 py-1 text-muted">
                  {{ index.columns.join(', ') }}
                </td>
                <td class="px-2 py-1 whitespace-nowrap text-faint">
                  {{ index.primary ? 'primary key' : index.unique ? 'unique' : 'index' }}
                </td>
                <td v-if="editable" class="px-1 py-0.5">
                  <button
                    type="button"
                    class="btn-icon p-1 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-danger"
                    :disabled="index.primary"
                    :title="indexDropTitle(index)"
                    :aria-label="indexDropTitle(index)"
                    @click="dropIndex(index)"
                  >
                    <AppIcon name="trash" :size="13" />
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>
