<script setup lang="ts">
import { useModalContext } from '@kolirt/vue-modal'
import type { ColumnSpec, DbPath, DdlOperation, DriverMeta } from '#shared/db-types'
import type { DdlEngine } from '~/utils/ddl-types'

/**
 * A new table: a name, a grid of columns, and the CREATE the driver writes
 * from them, shown before it runs.
 *
 * The grid is deliberately the short form of a column — name, type, null,
 * key, auto-increment, default. Foreign keys, checks and the rest are one
 * ALTER away once the table exists, and a dialog that offered all of them
 * would be a worse editor than the query tab already is.
 */

export interface CreateTableResult {
  created: true
  name: string
  /** Addressed the way the driver's own listing would address it. */
  path: DbPath
  statements: string[]
}

export interface CreateTableDialogProps {
  connectionId: string
  engine: DdlEngine
  /** The levels this engine has above a table; decides which pickers show. */
  levels: DriverMeta['levels']
  database?: string
  /** The explorer's schema, or `null` when it is showing all of them. */
  schema?: string | null
  schemas: string[]
  capabilities?: DriverMeta['capabilities']
  readOnly: boolean
  connectionName: string
}

const props = defineProps<CreateTableDialogProps>()

defineOptions({ modalGroup: 'dialog' })

const { confirm: resolve, close } = useModalContext<CreateTableResult>()
const { bridge } = useDatabaseBridge()
const { confirm } = useDialogs()

const name = ref('')

// With every schema on show there is no one place a table goes; `public` is
// where most of them do, so it is the default when it exists.
const schema = ref(props.schema ?? (props.schemas.includes('public') ? 'public' : props.schemas[0] ?? ''))

const hasSchema = props.levels.includes('schema')
const hasDatabase = props.levels.includes('database')

interface Row extends Required<Pick<ColumnSpec, 'name' | 'type' | 'nullable' | 'primaryKey' | 'autoIncrement' | 'defaultExpression' | 'comment'>> {
  /** For the row's key; the name is edited and cannot be one. */
  id: string
}

function blankRow(): Row {
  return { id: crypto.randomUUID(), name: '', type: '', nullable: true, primaryKey: false, autoIncrement: false, defaultExpression: '', comment: '' }
}

// Nearly every table starts with a surrogate key, so the grid starts with one
// filled in; deleting the row is one click for the tables that do not.
const rows = ref<Row[]>([
  { ...blankRow(), name: 'id', type: autoIncrementType(props.engine), nullable: false, primaryKey: true, autoIncrement: true },
  blankRow(),
])

const typeListId = useId()
const types = commonTypes(props.engine)

const nameBox = useTemplateRef<HTMLInputElement>('nameBox')

// After the modal has finished moving focus into itself, not before: the
// focus trap runs on the next frame and would otherwise take it back.
onMounted(() => {
  nextTick(() => window.setTimeout(() => nameBox.value?.focus(), 30))
})

function addRow() {
  rows.value = [...rows.value, blankRow()]
}

function removeRow(index: number) {
  rows.value = rows.value.filter((_, at) => at !== index)
}

function moveRow(index: number, delta: number) {
  const target = index + delta
  if (target < 0 || target >= rows.value.length) return

  const next = [...rows.value]
  const [moved] = next.splice(index, 1)
  next.splice(target, 0, moved!)
  rows.value = next
}

/**
 * Auto-increment implies the rest of a key column: it is the key, it cannot
 * be null, and it is an integer. Filled in rather than enforced, so a column
 * that is auto-incremented but not the key is still one unchecking away.
 */
function onAutoIncrement(row: Row) {
  if (!row.autoIncrement) return

  row.primaryKey = true
  row.nullable = false
  if (!row.type.trim() || props.engine === 'sqlite') row.type = autoIncrementType(props.engine)
}

/** The typed row on its last blank line: Tab out of it adds another. */
function onLastCellKeydown(event: KeyboardEvent, index: number) {
  if (event.key === 'Tab' && !event.shiftKey && index === rows.value.length - 1) {
    const last = rows.value[index]
    if (last && last.name.trim()) addRow()
  }
}

/* ------------------------------------------------------------- operation -- */

/** Rows the user actually filled in; a blank trailing row is not a column. */
const columns = computed<ColumnSpec[]>(() => rows.value
  .filter((row) => row.name.trim() || row.type.trim())
  .map((row) => ({
    name: row.name.trim(),
    type: row.type.trim(),
    nullable: row.nullable,
    primaryKey: row.primaryKey,
    autoIncrement: row.autoIncrement,
    defaultExpression: row.defaultExpression.trim() || undefined,
    comment: props.capabilities?.comments && row.comment.trim() ? row.comment.trim() : undefined,
  })))

const operation = computed<DdlOperation | null>(() => {
  const tableName = name.value.trim()
  if (!tableName || !columns.value.length) return null
  if (columns.value.some((column) => !column.name || !column.type)) return null
  if (hasSchema && !schema.value) return null

  return { kind: 'createTable', name: tableName, columns: columns.value }
})

/** Where the table goes: the driver reads the schema or database off this. */
const scope = computed(() => ({
  kind: 'schema' as const,
  path: {
    ...(hasDatabase && props.database ? { database: props.database } : {}),
    ...(hasSchema ? { schema: schema.value } : {}),
  } satisfies DbPath,
}))

const incomplete = computed(() => {
  if (operation.value) return null
  if (!name.value.trim()) return 'The table needs a name.'
  if (hasSchema && !schema.value) return 'Pick a schema.'
  if (!columns.value.length) return 'Add at least one column.'
  return 'Every column needs a name and a type.'
})

/* --------------------------------------------------------------- preview -- */

const statements = ref<string[]>([])
const previewError = ref<string | null>(null)
const previewing = ref(false)

const PREVIEW_DELAY_MS = 200

let previewTimer: ReturnType<typeof setTimeout> | undefined
let previewSerial = 0

async function preview(next: DdlOperation | null) {
  const serial = ++previewSerial

  if (!next) {
    statements.value = []
    previewError.value = null
    previewing.value = false
    return
  }

  previewing.value = true

  try {
    const outcome = await bridge().ddl(props.connectionId, scope.value, next, { dryRun: true })
    // A slower answer to an older form must not paint over a newer one.
    if (serial !== previewSerial) return
    statements.value = outcome.statements
    previewError.value = null
  }
  catch (cause) {
    if (serial !== previewSerial) return
    statements.value = []
    previewError.value = cause instanceof Error ? cause.message : String(cause)
  }
  finally {
    if (serial === previewSerial) previewing.value = false
  }
}

watch([operation, scope], ([next]) => {
  clearTimeout(previewTimer)
  previewTimer = setTimeout(() => preview(next), PREVIEW_DELAY_MS)
}, { immediate: true })

onBeforeUnmount(() => clearTimeout(previewTimer))

/* ---------------------------------------------------------------- create -- */

const creating = ref(false)
const createError = ref<string | null>(null)

const canCreate = computed(
  () => Boolean(operation.value) && !previewError.value && !previewing.value && !creating.value,
)

async function create() {
  const next = operation.value
  if (!next || next.kind !== 'createTable' || !canCreate.value) return

  if (props.readOnly) {
    const ok = await confirm({
      title: `${props.connectionName} is marked read-only`,
      message: `Table ${next.name} will be created on ${props.connectionName}.`,
      confirmLabel: 'Create',
      danger: true,
    })

    if (!ok) return
  }

  creating.value = true
  createError.value = null

  try {
    const outcome = await bridge().ddl(props.connectionId, scope.value, next, { allowWrite: props.readOnly })

    resolve({
      created: true,
      name: next.name,
      path: { ...scope.value.path, table: next.name },
      statements: outcome.statements,
    })
  }
  catch (cause) {
    createError.value = cause instanceof Error ? cause.message : String(cause)
  }
  finally {
    creating.value = false
  }
}

const cellClass = 'field px-1.5 py-1 font-mono'
</script>

<template>
  <AppDialog title="Create Table" size="lg">
    <form class="grid gap-3 p-4" @submit.prevent="create">
      <div class="flex flex-wrap items-end gap-3">
        <label v-if="hasDatabase" class="grid gap-1">
          <span class="text-faint">Database</span>
          <input :value="database ?? ''" class="field py-1.5 font-mono" disabled>
        </label>

        <label v-if="hasSchema" class="grid gap-1">
          <span class="text-faint">Schema</span>
          <select v-model="schema" class="field py-1.5 font-mono" required>
            <option v-for="item in schemas" :key="item" :value="item">
              {{ item }}
            </option>
          </select>
        </label>

        <label class="grid min-w-48 flex-1 gap-1">
          <span class="text-faint">Table name</span>
          <input
            ref="nameBox"
            v-model="name"
            class="field py-1.5 font-mono"
            spellcheck="false"
            autocomplete="off"
            required
          >
        </label>

        <span v-if="readOnly" class="chip mb-2 gap-1" :title="`${connectionName} asks before any write`">
          <AppIcon name="lock" :size="10" />
          Read-only
        </span>
      </div>

      <div class="grid gap-1">
        <span class="text-faint">Columns</span>

        <div class="overflow-x-auto rounded-md border border-edge">
          <table class="w-full border-collapse">
            <thead class="bg-surface/60 text-left text-faint">
              <tr>
                <th class="px-2 py-1 font-medium">
                  Name
                </th>
                <th class="px-2 py-1 font-medium">
                  Type
                </th>
                <th class="px-1 py-1 text-center font-medium" title="May hold NULL">
                  Null
                </th>
                <th class="px-1 py-1 text-center font-medium" title="Primary key">
                  PK
                </th>
                <th class="px-1 py-1 text-center font-medium" title="Auto-increment / identity">
                  Auto
                </th>
                <th class="px-2 py-1 font-medium">
                  Default
                </th>
                <th v-if="capabilities?.comments" class="px-2 py-1 font-medium">
                  Comment
                </th>
                <th class="px-1 py-1" />
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, index) in rows" :key="row.id" class="border-t border-edge/60">
                <td class="px-1 py-0.5">
                  <input
                    v-model="row.name"
                    :class="cellClass"
                    class="min-w-24"
                    :aria-label="`Column ${index + 1} name`"
                    spellcheck="false"
                    autocomplete="off"
                  >
                </td>
                <td class="px-1 py-0.5">
                  <input
                    v-model="row.type"
                    :class="cellClass"
                    class="min-w-24"
                    :list="typeListId"
                    :aria-label="`Column ${index + 1} type`"
                    :disabled="row.autoIncrement && engine === 'sqlite'"
                    spellcheck="false"
                    autocomplete="off"
                  >
                </td>
                <td class="px-1 py-0.5 text-center">
                  <input
                    v-model="row.nullable"
                    type="checkbox"
                    class="accent-[var(--app-accent)]"
                    :aria-label="`Column ${index + 1} nullable`"
                    :disabled="row.autoIncrement"
                  >
                </td>
                <td class="px-1 py-0.5 text-center">
                  <input
                    v-model="row.primaryKey"
                    type="checkbox"
                    class="accent-[var(--app-accent)]"
                    :aria-label="`Column ${index + 1} primary key`"
                    :disabled="row.autoIncrement && engine === 'sqlite'"
                  >
                </td>
                <td class="px-1 py-0.5 text-center">
                  <input
                    v-model="row.autoIncrement"
                    type="checkbox"
                    class="accent-[var(--app-accent)]"
                    :aria-label="`Column ${index + 1} auto-increment`"
                    @change="onAutoIncrement(row)"
                  >
                </td>
                <td class="px-1 py-0.5">
                  <input
                    v-model="row.defaultExpression"
                    :class="cellClass"
                    class="min-w-20"
                    :aria-label="`Column ${index + 1} default`"
                    :disabled="row.autoIncrement"
                    spellcheck="false"
                    autocomplete="off"
                    @keydown="!capabilities?.comments && onLastCellKeydown($event, index)"
                  >
                </td>
                <td v-if="capabilities?.comments" class="px-1 py-0.5">
                  <input
                    v-model="row.comment"
                    class="field min-w-20 px-1.5 py-1"
                    :aria-label="`Column ${index + 1} comment`"
                    autocomplete="off"
                    @keydown="onLastCellKeydown($event, index)"
                  >
                </td>
                <td class="px-1 py-0.5 whitespace-nowrap">
                  <button
                    type="button"
                    class="btn-icon p-1"
                    :disabled="index === 0"
                    title="Move up"
                    aria-label="Move up"
                    tabindex="-1"
                    @click="moveRow(index, -1)"
                  >
                    <AppIcon name="sortAsc" :size="11" />
                  </button>
                  <button
                    type="button"
                    class="btn-icon p-1"
                    :disabled="index === rows.length - 1"
                    title="Move down"
                    aria-label="Move down"
                    tabindex="-1"
                    @click="moveRow(index, 1)"
                  >
                    <AppIcon name="sortDesc" :size="11" />
                  </button>
                  <button
                    type="button"
                    class="btn-icon p-1"
                    title="Remove column"
                    aria-label="Remove column"
                    tabindex="-1"
                    @click="removeRow(index)"
                  >
                    <AppIcon name="close" :size="11" />
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div>
          <button type="button" class="btn btn-ghost" @click="addRow">
            <AppIcon name="plus" :size="11" />
            Add column
          </button>
        </div>
      </div>

      <datalist :id="typeListId">
        <option v-for="type in types" :key="type" :value="type" />
      </datalist>

      <div class="grid gap-1">
        <span class="flex items-center gap-2 text-faint">
          SQL
          <span v-if="previewing">· previewing…</span>
        </span>

        <p v-if="previewError" class="selectable flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 px-2.5 py-2 text-danger">
          <AppIcon name="warning" class="mt-0.5 shrink-0" />
          <span class="min-w-0 font-mono">{{ previewError }}</span>
        </p>

        <p v-else-if="incomplete" class="rounded-md border border-edge bg-bg px-2.5 py-2 text-faint">
          {{ incomplete }}
        </p>

        <pre
          v-else
          class="selectable max-h-56 overflow-auto rounded-md border border-edge bg-bg px-2.5 py-2 font-mono text-muted whitespace-pre"
          :class="previewing ? 'opacity-60' : ''"
        >{{ statements.join('\n') || '…' }}</pre>
      </div>

      <p v-if="createError" class="selectable flex items-start gap-2 text-danger">
        <AppIcon name="warning" class="mt-0.5 shrink-0" />
        <span class="min-w-0 font-mono">{{ createError }}</span>
      </p>

      <footer class="flex items-center justify-end gap-2">
        <button type="button" class="btn btn-ghost px-3 py-1.5" @click="close()">
          Cancel
        </button>
        <button type="submit" class="btn btn-accent px-3 py-1.5" :disabled="!canCreate">
          {{ creating ? 'Creating…' : 'Create' }}
        </button>
      </footer>
    </form>
  </AppDialog>
</template>
