<script setup lang="ts">
import { useModalContext } from '@kolirt/vue-modal'
import type { DbNode, DdlOperation, DriverMeta, IndexInfo } from '#shared/db-types'
import type { DdlEngine } from '~/utils/ddl-types'

/**
 * One change to a table's structure: a column added, renamed, changed or
 * dropped, an index created or dropped, the table renamed or dropped.
 *
 * One dialog with a form per kind rather than eight dialogs, because they all
 * end the same way: the driver spells the change as SQL, the SQL is shown
 * before it runs, and Apply runs it. The preview is a dry run of the very
 * operation Apply will send, so what is read is what will happen — and an
 * engine that cannot do the thing at all says so in the same place.
 */

/** What Apply resolves with; a dismissal resolves with nothing at all. */
export interface StructureChangeResult {
  applied: true
  operation: DdlOperation
  statements: string[]
}

export interface StructureChangeDialogProps {
  connectionId: string
  /** The table the change is about. */
  node: DbNode
  /** The kind of change, and the values the form starts from. */
  operation: DdlOperation
  /** The table's columns as they are, for the pickers and for what changed. */
  columns: DbNode[]
  indexes: IndexInfo[]
  engine: DdlEngine
  capabilities?: DriverMeta['capabilities']
  /** The profile asks before any write; the dialog asks on its behalf. */
  readOnly: boolean
  connectionName: string
}

const props = defineProps<StructureChangeDialogProps>()

defineOptions({ modalGroup: 'dialog' })

const { confirm: resolve, close } = useModalContext<StructureChangeResult>()
const { bridge } = useDatabaseBridge()
const { confirm } = useDialogs()

const kind = props.operation.kind
const tableName = props.node.path.table ?? props.node.name

const TITLES: Record<DdlOperation['kind'], { title: string, apply: string }> = {
  createTable: { title: 'Create Table', apply: 'Create' },
  addColumn: { title: 'Add Column', apply: 'Add column' },
  renameColumn: { title: 'Rename Column', apply: 'Rename' },
  alterColumn: { title: 'Change Column', apply: 'Apply' },
  dropColumn: { title: 'Drop Column', apply: 'Drop column' },
  renameTable: { title: 'Rename Table', apply: 'Rename' },
  createIndex: { title: 'Add Index', apply: 'Create index' },
  dropIndex: { title: 'Drop Index', apply: 'Drop index' },
  dropTable: { title: 'Drop Table', apply: 'Drop table' },
}

const destructive = kind === 'dropColumn' || kind === 'dropIndex' || kind === 'dropTable'

/* ------------------------------------------------------------------ form -- */

/** The column an existing-column operation names, as the table declares it. */
const original = computed(() => {
  const name = 'name' in props.operation ? props.operation.name : null
  return name ? props.columns.find((column) => column.name === name) ?? null : null
})

const originalType = computed(() => original.value?.declaredType ?? original.value?.detail ?? '')
const originalNullable = computed(() => original.value?.nullable !== false)

const form = reactive({
  /** The new column's name, or the existing column's. */
  name: '',
  /** The new name, for a rename. */
  to: '',
  type: '',
  nullable: true,
  defaultExpression: '',
  dropDefault: false,
  comment: '',
  indexName: '',
  indexColumns: [] as string[],
  unique: false,
  /** The table's name typed back, before a drop will go. */
  typed: '',
})

/**
 * Whether the index name is the user's or still the suggestion. A name that
 * was typed stays as typed; one that was not follows the columns as they
 * are picked, so the field never has to be cleared and retyped.
 */
let indexNameTouched = false

// The form starts from whatever the caller knew — the column under the
// pointer, its current type — so the common change is a few keystrokes.
const op = props.operation
switch (op.kind) {
  case 'addColumn':
    form.name = op.column.name
    form.type = op.column.type
    form.nullable = op.column.nullable !== false
    form.defaultExpression = op.column.defaultExpression ?? ''
    form.comment = op.column.comment ?? ''
    break
  case 'renameColumn':
    form.name = op.name
    form.to = op.to || op.name
    break
  case 'alterColumn':
    form.name = op.name
    form.type = op.type ?? originalType.value
    form.nullable = op.nullable ?? originalNullable.value
    form.defaultExpression = op.defaultExpression ?? ''
    break
  case 'dropColumn':
  case 'dropIndex':
    form.name = op.name
    break
  case 'renameTable':
    form.to = op.to || tableName
    break
  case 'createIndex':
    form.indexColumns = [...op.columns]
    form.unique = Boolean(op.unique)
    form.indexName = op.name
    indexNameTouched = Boolean(op.name)
    break
}

const typeListId = useId()
const types = commonTypes(props.engine)

const first = useTemplateRef<HTMLElement>('first')

// After the modal has finished moving focus into itself, not before: the
// focus trap runs on the next frame and would otherwise take it back.
onMounted(() => {
  nextTick(() => window.setTimeout(() => first.value?.focus(), 30))
})

/* --------------------------------------------------------------- indexes -- */

const unpicked = computed(() => props.columns.filter((column) => !form.indexColumns.includes(column.name)))

function pickColumn(event: Event) {
  const select = event.target as HTMLSelectElement
  if (select.value) form.indexColumns = [...form.indexColumns, select.value]
  select.value = ''
}

function moveColumn(index: number, delta: number) {
  const target = index + delta
  if (target < 0 || target >= form.indexColumns.length) return

  const next = [...form.indexColumns]
  const [moved] = next.splice(index, 1)
  next.splice(target, 0, moved!)
  form.indexColumns = next
}

function removeColumn(index: number) {
  form.indexColumns = form.indexColumns.filter((_, at) => at !== index)
}

watch([() => form.indexColumns, () => form.unique], ([columns, unique]) => {
  if (!indexNameTouched) form.indexName = columns.length ? suggestIndexName(tableName, columns, unique) : ''
}, { immediate: true })

function onIndexNameInput() {
  // Emptied by hand, the field goes back to following the columns.
  indexNameTouched = form.indexName.trim() !== ''
}

/* ------------------------------------------------------------- operation -- */

/**
 * The operation as the form now describes it, or `null` while it describes
 * nothing runnable — a rename to the same name, an index with no columns.
 * Both the preview and Apply read this, so they can never disagree.
 */
const operation = computed<DdlOperation | null>(() => {
  const name = form.name.trim()
  const to = form.to.trim()
  const type = form.type.trim()
  const defaultExpression = form.defaultExpression.trim()

  switch (kind) {
    case 'addColumn':
      if (!name || !type) return null
      return {
        kind,
        column: {
          name,
          type,
          nullable: form.nullable,
          defaultExpression: defaultExpression || undefined,
          comment: props.capabilities?.comments && form.comment.trim() ? form.comment.trim() : undefined,
        },
      }

    case 'renameColumn':
      return to && to !== name ? { kind, name, to } : null

    case 'alterColumn': {
      const typeChanged = type !== originalType.value.trim()
      const nullableChanged = form.nullable !== originalNullable.value
      const defaultChanged = form.dropDefault || defaultExpression !== ''

      if (!typeChanged && !nullableChanged && !defaultChanged) return null

      // MODIFY on MySQL restates the whole column, so every part goes each
      // time; Postgres alters one facet per clause, so only what changed.
      if (props.engine === 'mysql') {
        return { kind, name, type, nullable: form.nullable, defaultExpression: form.dropDefault ? null : defaultExpression }
      }

      return {
        kind,
        name,
        ...(typeChanged ? { type } : {}),
        ...(nullableChanged ? { nullable: form.nullable } : {}),
        ...(form.dropDefault ? { defaultExpression: null } : defaultExpression ? { defaultExpression } : {}),
      }
    }

    case 'dropColumn':
    case 'dropIndex':
      return { kind, name }

    case 'renameTable':
      return to && to !== tableName ? { kind, to } : null

    case 'createIndex':
      if (!form.indexName.trim() || !form.indexColumns.length) return null
      return { kind, name: form.indexName.trim(), columns: [...form.indexColumns], unique: form.unique }

    case 'dropTable':
      return { kind }

    default:
      return null
  }
})

/** Why there is nothing to preview yet, in the user's terms. */
const incomplete = computed(() => {
  if (operation.value) return null

  switch (kind) {
    case 'addColumn': return 'The column needs a name and a type.'
    case 'renameColumn':
    case 'renameTable': return 'Type a different name.'
    case 'alterColumn': return 'Nothing about the column has been changed yet.'
    case 'createIndex': return form.indexColumns.length ? 'The index needs a name.' : 'Pick at least one column.'
    default: return null
  }
})

/* --------------------------------------------------------------- preview -- */

const statements = ref<string[]>([])
const previewError = ref<string | null>(null)
const previewing = ref(false)

/**
 * How long the form is left alone before the driver is asked again. A dry run
 * is cheap — no statement reaches the server — but it is still a round trip
 * to the main process per keystroke without this.
 */
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
    const outcome = await bridge().ddl(props.connectionId, { kind: props.node.kind, path: props.node.path }, next, { dryRun: true })
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

watch(operation, (next) => {
  clearTimeout(previewTimer)
  previewTimer = setTimeout(() => preview(next), PREVIEW_DELAY_MS)
}, { immediate: true })

onBeforeUnmount(() => clearTimeout(previewTimer))

/* ----------------------------------------------------------------- apply -- */

const applying = ref(false)
const applyError = ref<string | null>(null)

/** A drop is unlocked by typing the table's name; everything else by a valid form. */
const unlocked = computed(() => kind !== 'dropTable' || form.typed.trim() === tableName)

const canApply = computed(
  () => Boolean(operation.value) && !previewError.value && !previewing.value && !applying.value && unlocked.value,
)

/** What the confirmation says is about to happen, when one is shown. */
function describe(): string {
  switch (kind) {
    case 'dropColumn': return `Column ${form.name} of ${tableName} and every value in it will be gone. There is no undo.`
    case 'dropIndex': return `Index ${form.name} will be dropped from ${tableName}. Queries that used it will still run, more slowly.`
    case 'dropTable': return `Table ${tableName} and everything in it will be gone. There is no undo.`
    default: return `${statements.value.length} statement${statements.value.length === 1 ? '' : 's'} will run on ${tableName}.`
  }
}

async function apply() {
  const next = operation.value
  if (!next || !canApply.value) return

  // A drop asks once more, however it was reached; the table's own drop has
  // its typed name and needs no second click. A read-only profile asks for
  // everything, and says so, because that is what the profile is for.
  const askDrop = kind === 'dropColumn' || kind === 'dropIndex'

  if (askDrop || props.readOnly) {
    const ok = await confirm({
      title: props.readOnly ? `${props.connectionName} is marked read-only` : `${TITLES[kind].title.split(' ')[0]} ${form.name}?`,
      message: describe() + (props.readOnly && askDrop ? ` ${props.connectionName} is marked read-only.` : ''),
      confirmLabel: TITLES[kind].apply,
      danger: destructive || props.readOnly,
    })

    if (!ok) return
  }

  applying.value = true
  applyError.value = null

  try {
    const outcome = await bridge().ddl(
      props.connectionId,
      { kind: props.node.kind, path: props.node.path },
      next,
      // The dialog above is the consent the main process insists on before
      // it writes through a connection marked read-only.
      { allowWrite: props.readOnly },
    )

    resolve({ applied: true, operation: next, statements: outcome.statements })
  }
  catch (cause) {
    applyError.value = cause instanceof Error ? cause.message : String(cause)
  }
  finally {
    applying.value = false
  }
}

/** The index being dropped, for the row that says what it covered. */
const droppedIndex = computed(() => (kind === 'dropIndex' ? props.indexes.find((index) => index.name === form.name) ?? null : null))
</script>

<template>
  <AppDialog :title="TITLES[kind].title" size="md">
    <form class="grid gap-3 p-4" @submit.prevent="apply">
      <p class="flex min-w-0 items-center gap-1.5 text-faint">
        <AppIcon name="table" :size="12" class="shrink-0 text-accent" />
        <span class="truncate font-mono text-muted">{{ tableName }}</span>
        <span class="shrink-0">on {{ connectionName }}</span>
        <span v-if="readOnly" class="chip ml-auto shrink-0 gap-1">
          <AppIcon name="lock" :size="10" />
          Read-only
        </span>
      </p>

      <!-- Add column: everything a column definition has, comment included
           where the engine keeps one. -->
      <template v-if="kind === 'addColumn'">
        <label class="grid gap-1">
          <span class="text-faint">Name</span>
          <input
            ref="first"
            v-model="form.name"
            class="field py-1.5 font-mono"
            spellcheck="false"
            autocomplete="off"
            required
          >
        </label>

        <label class="grid gap-1">
          <span class="text-faint">Type</span>
          <input
            v-model="form.type"
            class="field py-1.5 font-mono"
            :list="typeListId"
            placeholder="text"
            spellcheck="false"
            autocomplete="off"
            required
          >
        </label>

        <label class="flex items-center gap-2 text-muted">
          <input v-model="form.nullable" type="checkbox" class="accent-[var(--app-accent)]">
          Nullable
        </label>

        <label class="grid gap-1">
          <span class="text-faint">Default <span class="opacity-70">(an expression, as SQL reads it)</span></span>
          <input
            v-model="form.defaultExpression"
            class="field py-1.5 font-mono"
            placeholder="now()"
            spellcheck="false"
            autocomplete="off"
          >
        </label>

        <label v-if="capabilities?.comments" class="grid gap-1">
          <span class="text-faint">Comment</span>
          <input v-model="form.comment" class="field py-1.5" autocomplete="off">
        </label>
      </template>

      <template v-else-if="kind === 'renameColumn'">
        <label class="grid gap-1">
          <span class="text-faint">Column</span>
          <input :value="form.name" class="field py-1.5 font-mono" disabled>
        </label>

        <label class="grid gap-1">
          <span class="text-faint">New name</span>
          <input
            ref="first"
            v-model="form.to"
            class="field py-1.5 font-mono"
            spellcheck="false"
            autocomplete="off"
            required
          >
        </label>
      </template>

      <template v-else-if="kind === 'alterColumn'">
        <label class="grid gap-1">
          <span class="text-faint">Column</span>
          <input :value="form.name" class="field py-1.5 font-mono" disabled>
        </label>

        <label class="grid gap-1">
          <span class="text-faint">Type <span v-if="originalType" class="opacity-70">(now {{ originalType }})</span></span>
          <input
            ref="first"
            v-model="form.type"
            class="field py-1.5 font-mono"
            :list="typeListId"
            spellcheck="false"
            autocomplete="off"
            required
          >
        </label>

        <label class="flex items-center gap-2 text-muted">
          <input v-model="form.nullable" type="checkbox" class="accent-[var(--app-accent)]">
          Nullable
        </label>

        <label class="grid gap-1">
          <span class="text-faint">
            New default
            <span class="opacity-70">(leave empty to keep the current one)</span>
          </span>
          <input
            v-model="form.defaultExpression"
            class="field py-1.5 font-mono"
            :disabled="form.dropDefault"
            placeholder="now()"
            spellcheck="false"
            autocomplete="off"
          >
        </label>

        <label class="flex items-center gap-2 text-muted">
          <input v-model="form.dropDefault" type="checkbox" class="accent-[var(--app-accent)]">
          Drop the default
        </label>

        <!-- MODIFY restates the whole definition, and the app does not know
             the current default's text to restate it. Said here rather than
             discovered afterwards. -->
        <p v-if="engine === 'mysql' && original?.hasDefault && !form.dropDefault && !form.defaultExpression.trim()" class="flex items-start gap-2 text-warning">
          <AppIcon name="warning" class="mt-0.5 shrink-0" />
          <span>MySQL rewrites the whole column, so the current default will be dropped unless it is typed again above.</span>
        </p>
      </template>

      <template v-else-if="kind === 'dropColumn'">
        <p class="text-muted">
          Column <span class="font-mono text-content">{{ form.name }}</span>
          <span v-if="originalType"> ({{ originalType }})</span>
          will be dropped, and every value in it with it.
        </p>
      </template>

      <template v-else-if="kind === 'renameTable'">
        <label class="grid gap-1">
          <span class="text-faint">New name <span class="opacity-70">(now {{ tableName }})</span></span>
          <input
            ref="first"
            v-model="form.to"
            class="field py-1.5 font-mono"
            spellcheck="false"
            autocomplete="off"
            required
          >
        </label>
        <p class="text-faint">
          Views and foreign keys that name the table are the engine's to follow; most do, some do not.
        </p>
      </template>

      <template v-else-if="kind === 'createIndex'">
        <div class="grid gap-1">
          <span class="text-faint">Columns <span class="opacity-70">(in index order)</span></span>

          <ol v-if="form.indexColumns.length" class="grid gap-1">
            <li
              v-for="(column, index) in form.indexColumns"
              :key="column"
              class="flex items-center gap-1 rounded-md border border-edge bg-surface px-2 py-1"
            >
              <span class="w-4 text-faint tabular-nums">{{ index + 1 }}</span>
              <span class="min-w-0 flex-1 truncate font-mono">{{ column }}</span>
              <button
                type="button"
                class="btn-icon p-1"
                :disabled="index === 0"
                title="Move up"
                aria-label="Move up"
                @click="moveColumn(index, -1)"
              >
                <AppIcon name="sortAsc" :size="11" />
              </button>
              <button
                type="button"
                class="btn-icon p-1"
                :disabled="index === form.indexColumns.length - 1"
                title="Move down"
                aria-label="Move down"
                @click="moveColumn(index, 1)"
              >
                <AppIcon name="sortDesc" :size="11" />
              </button>
              <button
                type="button"
                class="btn-icon p-1"
                title="Remove"
                aria-label="Remove"
                @click="removeColumn(index)"
              >
                <AppIcon name="close" :size="11" />
              </button>
            </li>
          </ol>

          <select
            ref="first"
            class="field py-1.5"
            :disabled="!unpicked.length"
            aria-label="Add a column to the index"
            @change="pickColumn"
          >
            <option value="">
              {{ unpicked.length ? 'Add a column…' : 'Every column is in the index' }}
            </option>
            <option v-for="column in unpicked" :key="column.name" :value="column.name">
              {{ column.name }}
            </option>
          </select>
        </div>

        <label class="flex items-center gap-2 text-muted">
          <input v-model="form.unique" type="checkbox" class="accent-[var(--app-accent)]">
          Unique
        </label>

        <label class="grid gap-1">
          <span class="text-faint">Name</span>
          <input
            v-model="form.indexName"
            class="field py-1.5 font-mono"
            spellcheck="false"
            autocomplete="off"
            required
            @input="onIndexNameInput"
          >
        </label>
      </template>

      <template v-else-if="kind === 'dropIndex'">
        <p class="text-muted">
          Index <span class="font-mono text-content">{{ form.name }}</span>
          <template v-if="droppedIndex"> on <span class="font-mono">{{ droppedIndex.columns.join(', ') }}</span></template>
          will be dropped.
          <span v-if="droppedIndex?.unique"> It is unique: the values it kept apart may repeat once it is gone.</span>
        </p>
      </template>

      <template v-else-if="kind === 'dropTable'">
        <p class="text-muted">
          Table <span class="font-mono text-content">{{ tableName }}</span> and everything in it will be gone. There is no undo.
        </p>

        <label class="grid gap-1">
          <span class="text-faint">Type <span class="font-mono text-content">{{ tableName }}</span> to confirm</span>
          <input
            ref="first"
            v-model="form.typed"
            class="field py-1.5 font-mono"
            spellcheck="false"
            autocomplete="off"
          >
        </label>
      </template>

      <datalist :id="typeListId">
        <option v-for="type in types" :key="type" :value="type" />
      </datalist>

      <!-- What will run, from the driver itself, so it can be read first. -->
      <div class="grid gap-1">
        <span class="flex items-center gap-2 text-faint">
          SQL
          <span v-if="previewing" class="text-faint">· previewing…</span>
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
          class="selectable max-h-48 overflow-auto rounded-md border border-edge bg-bg px-2.5 py-2 font-mono text-muted whitespace-pre"
          :class="previewing ? 'opacity-60' : ''"
        >{{ statements.join('\n') || '…' }}</pre>
      </div>

      <p v-if="applyError" class="selectable flex items-start gap-2 text-danger">
        <AppIcon name="warning" class="mt-0.5 shrink-0" />
        <span class="min-w-0 font-mono">{{ applyError }}</span>
      </p>

      <footer class="flex items-center justify-end gap-2">
        <button type="button" class="btn btn-ghost px-3 py-1.5" @click="close()">
          Cancel
        </button>
        <button
          type="submit"
          class="btn px-3 py-1.5"
          :class="destructive ? 'btn-danger' : 'btn-accent'"
          :disabled="!canApply"
        >
          <AppIcon v-if="destructive" name="trash" :size="12" />
          {{ applying ? 'Applying…' : TITLES[kind].apply }}
        </button>
      </footer>
    </form>
  </AppDialog>
</template>
