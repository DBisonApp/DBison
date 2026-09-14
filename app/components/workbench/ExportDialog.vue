<script setup lang="ts">
import { useModalContext } from '@kolirt/vue-modal'
import type { DriverError, ExportFormat, ExportOutcome } from '#shared/db-types'
import type { SqlDialect } from '~/utils/serialize'

/**
 * A whole result written to a file.
 *
 * The grid's own "Save as CSV" writes the rows it holds, which is a page of a
 * table or the first few thousand rows of a query. This runs the statement
 * again on the server and streams every row it returns straight to disk, so
 * nothing has to fit in the renderer on the way.
 */
export interface ExportDialogProps {
  connectionId: string
  /** The statement to run again; the file holds everything it returns. */
  sql: string
  database?: string
  schema?: string
  /** The file name offered by the save dialog, without an extension. */
  suggestedName: string
  /** How an INSERT names the table and quotes its identifiers. */
  dialect: SqlDialect
  /** What the file will hold, for the sentence at the top: "every row of users". */
  description: string
}

const props = defineProps<ExportDialogProps>()

defineOptions({ modalGroup: 'dialog' })

const { confirm, close } = useModalContext<ExportOutcome>()
const { bridge } = useDatabaseBridge()
const { watchJob } = useJobProgress()

const FORMATS: { id: ExportFormat, label: string, title: string }[] = [
  { id: 'csv', label: 'CSV', title: 'Comma-separated values' },
  { id: 'tsv', label: 'TSV', title: 'Tab-separated values' },
  { id: 'json', label: 'JSON', title: 'An array of objects, one per row' },
  { id: 'sql', label: 'SQL INSERT', title: 'One INSERT statement per row' },
]

const DELIMITERS = [
  { value: ',', label: 'Comma' },
  { value: ';', label: 'Semicolon' },
  { value: '\t', label: 'Tab' },
  { value: '|', label: 'Pipe' },
]

const format = ref<ExportFormat>('csv')
const header = ref(true)
const delimiter = ref(',')
const nullText = ref('')
const table = ref(props.dialect.table)

const delimited = computed(() => format.value === 'csv' || format.value === 'tsv')

const phase = ref<'idle' | 'running' | 'done'>('idle')
const stopping = ref(false)
const error = ref<DriverError | null>(null)
const outcome = ref<ExportOutcome | null>(null)
/** Said in place of a result when the user stopped the export themselves. */
const note = ref<string | null>(null)

let jobId: string | null = null
const progress = ref<ReturnType<typeof watchJob> | null>(null)

const progressLine = computed(() => {
  const job = progress.value
  if (!job) return ''

  const rows = `${job.rows.toLocaleString()} row${job.rows === 1 ? '' : 's'}`
  return job.bytes ? `${rows} · ${formatBytes(job.bytes)}` : rows
})

async function start() {
  if (phase.value === 'running') return

  jobId = crypto.randomUUID()
  const job = watchJob(jobId)
  progress.value = job
  phase.value = 'running'
  stopping.value = false
  error.value = null
  note.value = null

  try {
    const saved = await bridge().exportRows(props.connectionId, {
      sql: props.sql,
      database: props.database,
      schema: props.schema,
      format: format.value,
      suggestedName: `${props.suggestedName}.${format.value}`,
      jobId,
      ...(delimited.value
        ? {
            header: header.value,
            delimiter: format.value === 'csv' ? delimiter.value : '\t',
            nullText: nullText.value,
          }
        : {}),
      ...(format.value === 'sql'
        ? {
            table: table.value.trim() || props.dialect.table,
            quote: props.dialect.quote,
            escapeBackslashes: props.dialect.escapeBackslashes,
          }
        : {}),
    })

    // The save dialog was dismissed: nothing was written, nothing to report.
    if (!saved.saved) {
      phase.value = 'idle'
      return
    }

    outcome.value = saved
    phase.value = 'done'
  }
  catch (cause) {
    if (isCancellation(cause)) note.value = 'Stopped. A partial file may have been left where you pointed.'
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

// Esc or a backdrop click mid-export must not leave the server streaming
// rows into a file nobody is waiting for.
onBeforeUnmount(() => { if (jobId) bridge().cancel(jobId).catch(() => ({ cancelled: false })) })

function reveal() {
  if (outcome.value?.path) bridge().reveal(outcome.value.path).catch(() => ({ revealed: false }))
}

const savedLine = computed(() => {
  const result = outcome.value
  if (!result) return ''

  return `Saved ${result.rows.toLocaleString()} row${result.rows === 1 ? '' : 's'}`
    + `${result.bytes ? ` (${formatBytes(result.bytes)})` : ''} in ${result.durationMs.toLocaleString()} ms`
})
</script>

<template>
  <AppDialog title="Export" size="md">
    <form class="grid gap-3 p-4" @submit.prevent="start">
      <p class="text-muted">
        Exports {{ description }}.
        <span class="block text-faint">
          The statement is run again on the server and everything it returns is written to the file — not only the rows on screen.
        </span>
      </p>

      <template v-if="phase === 'done' && outcome">
        <p class="flex items-start gap-2 rounded-md border border-success/40 bg-success/10 px-3 py-2">
          <AppIcon name="check" class="mt-0.5 text-success" />
          <span class="min-w-0">
            {{ savedLine }}
            <span class="selectable block truncate font-mono text-faint" :title="outcome.path">{{ outcome.path }}</span>
          </span>
        </p>

        <footer class="flex items-center justify-end gap-2">
          <button type="button" class="btn btn-ghost px-3 py-1.5" @click="reveal">
            <AppIcon name="folderSearch" :size="12" />
            Show in folder
          </button>
          <button type="button" class="btn btn-accent px-3 py-1.5" autofocus @click="confirm(outcome)">
            Close
          </button>
        </footer>
      </template>

      <template v-else>
        <div class="grid gap-1">
          <span id="export-format" class="text-faint">Format</span>
          <span class="flex rounded-md bg-raised p-0.5" role="radiogroup" aria-labelledby="export-format">
            <button
              v-for="option in FORMATS"
              :key="option.id"
              type="button"
              role="radio"
              class="btn btn-ghost flex-1 justify-center px-2 py-1"
              :data-active="format === option.id"
              :aria-checked="format === option.id"
              :title="option.title"
              :disabled="phase === 'running'"
              @click="format = option.id"
            >
              {{ option.label }}
            </button>
          </span>
        </div>

        <template v-if="delimited">
          <div class="grid grid-cols-2 gap-2">
            <label v-if="format === 'csv'" class="grid gap-1">
              <span class="text-faint">Delimiter</span>
              <select v-model="delimiter" class="field py-1.5" :disabled="phase === 'running'">
                <option v-for="option in DELIMITERS" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
            </label>

            <label class="grid gap-1">
              <span class="text-faint">NULL is written as</span>
              <input
                v-model="nullText"
                class="field py-1.5 font-mono"
                placeholder="(empty)"
                spellcheck="false"
                autocomplete="off"
                :disabled="phase === 'running'"
              >
            </label>
          </div>

          <label class="flex items-center gap-2 text-muted">
            <input v-model="header" type="checkbox" class="accent-accent" :disabled="phase === 'running'">
            First line names the columns
          </label>
        </template>

        <label v-else-if="format === 'sql'" class="grid gap-1">
          <span class="text-faint">Table the INSERTs name</span>
          <input
            v-model="table"
            class="field py-1.5 font-mono"
            spellcheck="false"
            autocomplete="off"
            :disabled="phase === 'running'"
          >
        </label>

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
              {{ progressLine || 'Starting…' }}
            </span>
            <button type="button" class="btn btn-danger px-3 py-1.5" :disabled="stopping" @click="stop">
              <AppIcon name="stop" :size="12" />
              {{ stopping ? 'Stopping…' : 'Stop' }}
            </button>
          </template>

          <template v-else>
            <button type="button" class="btn btn-ghost ml-auto px-3 py-1.5" @click="close()">
              Cancel
            </button>
            <button type="submit" class="btn btn-accent px-3 py-1.5">
              <AppIcon name="fileDown" :size="12" />
              Export…
            </button>
          </template>
        </footer>
      </template>
    </form>
  </AppDialog>
</template>
