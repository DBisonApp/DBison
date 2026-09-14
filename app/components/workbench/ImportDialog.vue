<script setup lang="ts">
import { useModalContext } from '@kolirt/vue-modal'
import type { DbNode, DriverError, ImportOutcome, ImportPreview } from '#shared/db-types'

/**
 * A delimited file read into a table.
 *
 * Two steps in one card: pick the file and check the app read it the way it
 * was written, then say which of its columns goes where. The insert itself
 * runs in the main process, in one transaction, so a bad row near the end
 * leaves the table exactly as it was.
 */
export interface ImportDialogProps {
  /** The table the rows go into. */
  node: DbNode
  /** The table's columns, as the mapping offers them. */
  columns: { name: string, type: string, nullable?: boolean, hasDefault?: boolean }[]
  connectionName: string
  /** The profile's read-only mark; the import asks first and then passes consent along. */
  readOnly: boolean
}

const props = defineProps<ImportDialogProps>()

defineOptions({ modalGroup: 'dialog' })

const { confirm: finish, close } = useModalContext<{ inserted: number }>()
const { bridge } = useDatabaseBridge()
const { watchJob } = useJobProgress()
const { confirm } = useDialogs()

const DELIMITERS = [
  { value: ',', label: 'Comma' },
  { value: ';', label: 'Semicolon' },
  { value: '\t', label: 'Tab' },
  { value: '|', label: 'Pipe' },
]

const BATCH_SIZES = [100, 500, 2000]

/** How many of the file's first rows the preview table shows. */
const PREVIEW_ROWS = 8

/* -------------------------------------------------------------- the file -- */

const preview = ref<ImportPreview | null>(null)
const previewing = ref(false)
const previewError = ref<string | null>(null)

const delimiter = ref(',')
const hasHeader = ref(true)

/** The guessed delimiter joins the list when it is none of the usual four. */
const delimiterOptions = computed(() => {
  const current = preview.value?.delimiter
  if (!current || DELIMITERS.some((option) => option.value === current)) return DELIMITERS

  return [...DELIMITERS, { value: current, label: `Detected (${JSON.stringify(current)})` }]
})

const previewRows = computed(() => preview.value?.rows.slice(0, PREVIEW_ROWS) ?? [])

const fileLabel = computed(() => (preview.value ? fileName(preview.value.path) : ''))

/** Opens the system's file picker; a dismissed picker changes nothing. */
async function chooseFile() {
  await readPreview(undefined)
}

/** The same file again, read with the delimiter and header the user chose. */
async function repreview() {
  if (!preview.value) return
  await readPreview({ path: preview.value.path, delimiter: delimiter.value, hasHeader: hasHeader.value })
}

async function readPreview(request: { path: string, delimiter: string, hasHeader: boolean } | undefined) {
  if (previewing.value) return

  previewing.value = true
  previewError.value = null

  try {
    const next = await bridge().importPreview(request)

    // A different set of columns is a different mapping; the same set keeps
    // whatever the user has already lined up.
    const columnsChanged = !preview.value
      || preview.value.path !== next.path
      || preview.value.columns.join('\0') !== next.columns.join('\0')

    preview.value = next
    delimiter.value = next.delimiter
    hasHeader.value = next.hasHeader
    if (columnsChanged) mapping.value = autoMap(next.columns)
  }
  catch (cause) {
    if (!isCancellation(cause)) previewError.value = cause instanceof Error ? cause.message : String(cause)
  }
  finally {
    previewing.value = false
  }
}

/* ------------------------------------------------------------- mapping -- */

/** Per file column, the table column it feeds — or `null` to skip it. */
const mapping = ref<(string | null)[]>([])

/**
 * A first guess at the mapping: a header that names the table's own columns
 * is matched by name, and what is left over is matched by position — which
 * is all a headerless file can offer.
 */
function autoMap(fileColumns: string[]): (string | null)[] {
  const used = new Set<string>()
  const result: (string | null)[] = fileColumns.map(() => null)

  fileColumns.forEach((name, index) => {
    const needle = name.trim().toLowerCase()
    const hit = props.columns.find((column) => !used.has(column.name) && column.name.toLowerCase() === needle)

    if (hit) {
      result[index] = hit.name
      used.add(hit.name)
    }
  })

  fileColumns.forEach((_, index) => {
    if (result[index]) return

    const candidate = props.columns[index]
    if (candidate && !used.has(candidate.name)) {
      result[index] = candidate.name
      used.add(candidate.name)
    }
  })

  return result
}

const mapped = computed(() => new Set(mapping.value.filter((name): name is string => Boolean(name))))

/**
 * Table columns the file has to supply: no NULL allowed and nothing the
 * server would fill in. Left unmapped, the very first row fails the import.
 */
const requiredUnmapped = computed(() => props.columns
  .filter((column) => column.nullable === false && !column.hasDefault && !mapped.value.has(column.name))
  .map((column) => column.name))

/** The type beside a column's name in the picker, kept short. */
function columnLabel(column: ImportDialogProps['columns'][number]) {
  return column.type ? `${column.name} · ${column.type}` : column.name
}

/* ------------------------------------------------------------- options -- */

const nullText = ref('')
const emptyIsNull = ref(true)
const trim = ref(true)
const truncate = ref(false)
const batchSize = ref(500)

/* ------------------------------------------------------------- running -- */

const phase = ref<'idle' | 'running' | 'done'>('idle')
const stopping = ref(false)
const error = ref<DriverError | null>(null)
const outcome = ref<ImportOutcome | null>(null)
const note = ref<string | null>(null)

let jobId: string | null = null
const progress = ref<ReturnType<typeof watchJob> | null>(null)

const canRun = computed(() => Boolean(preview.value) && mapped.value.size > 0 && phase.value !== 'running')

/**
 * The questions worth asking before a row is written. A read-only mark asks
 * about any import; emptying the table asks on every connection, because it
 * is the one part of this with no undo.
 */
async function consent(): Promise<boolean> {
  const rows = `the rows of ${fileLabel.value}`

  if (props.readOnly) {
    return confirm({
      title: `${props.connectionName} is marked read-only`,
      message: truncate.value
        ? `Every row of ${props.node.name} will be deleted and ${rows} inserted in its place. Import anyway?`
        : `${rows[0]!.toUpperCase()}${rows.slice(1)} will be inserted into ${props.node.name}. Import anyway?`,
      confirmLabel: 'Import',
      danger: true,
    })
  }

  if (truncate.value) {
    return confirm({
      title: `Empty ${props.node.name} first?`,
      message: `Every row of ${props.node.name} will be deleted before ${rows} are inserted, in the same transaction. There is no undo.`,
      confirmLabel: 'Empty and import',
      danger: true,
    })
  }

  return true
}

async function start() {
  const file = preview.value
  if (!file || !canRun.value) return
  if (!await consent()) return

  jobId = crypto.randomUUID()
  const job = watchJob(jobId)
  progress.value = job
  phase.value = 'running'
  stopping.value = false
  error.value = null
  note.value = null

  try {
    const result = await bridge().importRows(
      props.node.connectionId,
      { kind: props.node.kind, path: props.node.path },
      {
        path: file.path,
        delimiter: delimiter.value,
        hasHeader: hasHeader.value,
        mapping: mapping.value.flatMap((column, source) => (column ? [{ source, column }] : [])),
        nullText: nullText.value || undefined,
        emptyIsNull: emptyIsNull.value,
        trim: trim.value,
        batchSize: batchSize.value,
        truncate: truncate.value,
        jobId,
        // The dialog above is the consent the main process insists on before
        // it writes through a connection marked read-only.
        allowWrite: props.readOnly,
      },
    )

    outcome.value = result
    phase.value = 'done'
  }
  catch (cause) {
    if (isCancellation(cause)) note.value = 'Stopped. The transaction was rolled back, so the table is as it was.'
    else error.value = toDriverError(cause)
    phase.value = 'idle'
  }
  finally {
    job.stop()
    jobId = null
  }
}

async function stop() {
  if (!jobId || stopping.value) return

  stopping.value = true
  await bridge().cancel(jobId).catch(() => ({ cancelled: false }))
}

// A dialog dismissed mid-import rolls the import back rather than leaving it
// to finish unwatched.
onBeforeUnmount(() => { if (jobId) bridge().cancel(jobId).catch(() => ({ cancelled: false })) })
</script>

<template>
  <AppDialog :title="`Import into ${node.name}`" size="lg">
    <form class="grid gap-3 p-4" @submit.prevent="start">
      <template v-if="phase === 'done' && outcome">
        <p class="flex items-start gap-2 rounded-md border border-success/40 bg-success/10 px-3 py-2">
          <AppIcon name="check" class="mt-0.5 text-success" />
          <span>
            Inserted {{ outcome.inserted.toLocaleString() }} row{{ outcome.inserted === 1 ? '' : 's' }}
            into {{ node.name }} in {{ outcome.durationMs.toLocaleString() }} ms.
          </span>
        </p>

        <footer class="flex justify-end">
          <button type="button" class="btn btn-accent px-3 py-1.5" autofocus @click="finish({ inserted: outcome.inserted })">
            Done
          </button>
        </footer>
      </template>

      <template v-else>
        <!-- Step one: the file, and whether it was read the way it was written. -->
        <section class="grid gap-2">
          <div class="flex flex-wrap items-center gap-2">
            <button
              type="button"
              class="btn btn-outline px-3 py-1.5"
              :disabled="previewing || phase === 'running'"
              @click="chooseFile"
            >
              <AppIcon name="folderOpen" :size="12" />
              {{ preview ? 'Choose another file…' : 'Choose file…' }}
            </button>

            <span v-if="preview" class="min-w-0 truncate" :title="preview.path">
              <span class="font-medium">{{ fileLabel }}</span>
              <span class="text-faint"> · {{ formatBytes(preview.bytes) }}</span>
            </span>
            <span v-else class="text-faint">A CSV, TSV or other delimited text file.</span>

            <span v-if="previewing" class="text-faint">Reading…</span>
          </div>

          <p v-if="previewError" class="flex items-start gap-2 text-danger">
            <AppIcon name="warning" class="mt-0.5 shrink-0" />
            <span class="selectable">{{ previewError }}</span>
          </p>

          <template v-if="preview">
            <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
              <label class="flex items-center gap-2 text-faint">
                Delimiter
                <select
                  v-model="delimiter"
                  class="field w-auto py-1"
                  :disabled="previewing || phase === 'running'"
                  @change="repreview"
                >
                  <option v-for="option in delimiterOptions" :key="option.value" :value="option.value">
                    {{ option.label }}
                  </option>
                </select>
              </label>

              <label class="flex items-center gap-2 text-muted">
                <input
                  v-model="hasHeader"
                  type="checkbox"
                  class="accent-accent"
                  :disabled="previewing || phase === 'running'"
                  @change="repreview"
                >
                First row is a header
              </label>
            </div>

            <div class="max-h-48 overflow-auto rounded-md border border-edge">
              <table class="w-full border-separate border-spacing-0 font-mono text-[11px]">
                <thead>
                  <tr>
                    <th
                      v-for="(column, index) in preview.columns"
                      :key="index"
                      class="sticky top-0 border-b border-edge bg-surface px-2 py-1 text-left font-medium whitespace-nowrap text-muted"
                    >
                      {{ column }}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(row, rowIndex) in previewRows" :key="rowIndex">
                    <td
                      v-for="(_, index) in preview.columns"
                      :key="index"
                      class="max-w-48 truncate border-b border-edge/50 px-2 py-0.5 whitespace-nowrap"
                      :title="row[index]"
                    >
                      {{ row[index] ?? '' }}
                    </td>
                  </tr>
                  <tr v-if="!previewRows.length">
                    <td :colspan="preview.columns.length" class="px-2 py-2 text-faint">
                      No rows after the header.
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>
        </section>

        <!-- Step two: which file column feeds which table column. -->
        <section v-if="preview" class="grid gap-2">
          <h3 class="text-faint">
            Columns
          </h3>

          <div class="grid max-h-56 gap-1 overflow-auto pr-1">
            <label
              v-for="(column, index) in preview.columns"
              :key="index"
              class="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2"
            >
              <span class="min-w-0 truncate font-mono" :title="column">{{ column }}</span>
              <AppIcon name="chevronRight" :size="12" class="text-faint" />
              <select
                v-model="mapping[index]"
                class="field py-1"
                :class="mapping[index] ? '' : 'text-faint'"
                :disabled="phase === 'running'"
              >
                <option :value="null">(skip)</option>
                <option
                  v-for="target in columns"
                  :key="target.name"
                  :value="target.name"
                  :disabled="mapping[index] !== target.name && mapped.has(target.name)"
                >
                  {{ columnLabel(target) }}
                </option>
              </select>
            </label>
          </div>

          <p v-if="requiredUnmapped.length" class="flex items-start gap-2 text-warning">
            <AppIcon name="warning" class="mt-0.5 shrink-0" />
            <span>
              Not mapped, but required — no NULL allowed and no default:
              <span class="font-mono">{{ requiredUnmapped.join(', ') }}</span>.
              The import will fail unless the table fills them in some other way.
            </span>
          </p>
        </section>

        <section v-if="preview" class="grid gap-2">
          <h3 class="text-faint">
            Options
          </h3>

          <div class="grid gap-x-4 gap-y-2 sm:grid-cols-2">
            <label class="grid gap-1">
              <span class="text-faint">Text that means NULL</span>
              <input
                v-model="nullText"
                class="field py-1 font-mono"
                placeholder="(none)"
                spellcheck="false"
                autocomplete="off"
                :disabled="phase === 'running'"
              >
            </label>

            <label class="grid gap-1">
              <span class="text-faint">Rows per INSERT</span>
              <select v-model.number="batchSize" class="field py-1" :disabled="phase === 'running'">
                <option v-for="size in BATCH_SIZES" :key="size" :value="size">
                  {{ size.toLocaleString() }}
                </option>
              </select>
            </label>

            <label class="flex items-center gap-2 text-muted">
              <input v-model="emptyIsNull" type="checkbox" class="accent-accent" :disabled="phase === 'running'">
              An empty field is NULL
            </label>

            <label class="flex items-center gap-2 text-muted">
              <input v-model="trim" type="checkbox" class="accent-accent" :disabled="phase === 'running'">
              Trim whitespace around values
            </label>

            <label class="flex items-center gap-2 sm:col-span-2" :class="truncate ? 'text-danger' : 'text-muted'">
              <input v-model="truncate" type="checkbox" class="accent-[var(--app-danger)]" :disabled="phase === 'running'">
              Empty the table first
              <span class="text-faint">— in the same transaction; there is no undo</span>
            </label>
          </div>
        </section>

        <p v-if="error" class="grid gap-1 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-danger">
          <span class="flex items-start gap-2">
            <AppIcon name="warning" class="mt-0.5 shrink-0" />
            <span class="selectable font-mono">{{ error.message }}</span>
          </span>
          <span v-if="error.detail" class="selectable pl-6 text-muted">{{ error.detail }}</span>
          <span v-if="error.hint" class="selectable pl-6 text-muted">Hint: {{ error.hint }}</span>
        </p>

        <p v-else-if="note" class="text-warning">
          {{ note }}
        </p>

        <footer class="flex items-center gap-2">
          <template v-if="phase === 'running'">
            <span class="app-progress h-0.5 w-16 shrink-0 rounded-full" />
            <span class="min-w-0 flex-1 truncate text-accent-bright tabular-nums" role="status">
              {{ progress ? `${progress.rows.toLocaleString()} row${progress.rows === 1 ? '' : 's'}` : 'Starting…' }}
            </span>
            <button type="button" class="btn btn-danger px-3 py-1.5" :disabled="stopping" @click="stop">
              <AppIcon name="stop" :size="12" />
              {{ stopping ? 'Stopping…' : 'Stop' }}
            </button>
          </template>

          <template v-else>
            <span v-if="preview" class="text-faint">
              {{ mapped.size }} of {{ preview.columns.length }} file column{{ preview.columns.length === 1 ? '' : 's' }} mapped
            </span>
            <button type="button" class="btn btn-ghost ml-auto px-3 py-1.5" @click="close()">
              Cancel
            </button>
            <button
              type="submit"
              class="btn px-3 py-1.5"
              :class="truncate ? 'btn-danger' : 'btn-accent'"
              :disabled="!canRun"
              :title="preview ? (mapped.size ? 'Insert the rows in one transaction' : 'Map at least one column first') : 'Choose a file first'"
            >
              <AppIcon name="fileUp" :size="12" />
              {{ truncate ? 'Empty and import' : 'Import' }}
            </button>
          </template>
        </footer>
      </template>
    </form>
  </AppDialog>
</template>
