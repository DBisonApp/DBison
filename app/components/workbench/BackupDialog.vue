<script setup lang="ts">
import { useModalContext } from '@kolirt/vue-modal'
import type { CliTool, ConnectionProfile, ToolOutcome } from '#shared/db-types'

/**
 * A database written to a file with the engine's own tool, or read back from one.
 *
 * The app does not serialise a schema itself: pg_dump, mysqldump and sqlite3
 * already know every corner of their engine, and a file they wrote is one
 * anyone can restore without this app. So the dialog is a front for the tool —
 * find it, gather the flags, run it, show what it printed — and the main
 * process holds the password and the process.
 */
export interface BackupDialogProps {
  profile: ConnectionProfile
  mode: 'dump' | 'restore'
  /** The database to start on; the profile's own otherwise. */
  database?: string
  /** Tables to preselect, named the way the explorer names them. */
  tables?: string[]
}

const props = defineProps<BackupDialogProps>()

defineOptions({ modalGroup: 'dialog' })

const { confirm, close } = useModalContext<ToolOutcome>()
const { bridge } = useDatabaseBridge()
const { watchJob } = useJobProgress()
const connections = useConnections()
const explorer = useExplorer()

const dumping = computed(() => props.mode === 'dump')
const driver = computed(() => connections.driverOf(props.profile))
const tool = computed<CliTool | null>(() =>
  (dumping.value ? driver.value.capabilities?.dump : driver.value.capabilities?.restore) ?? null,
)
const connected = computed(() => connections.stateOf(props.profile.id).status === 'connected')

/** SQLite has no database level: the profile's file is the whole database. */
const hasDatabases = computed(() => driver.value.levels.includes('database'))
const fileBased = computed(() => driver.value.target === 'file')

/* ------------------------------------------------------------------------ *
 * The tool.
 * ------------------------------------------------------------------------ */

/**
 * Where a tool was pointed at by hand, per tool. An installer that put
 * pg_dump somewhere unusual did so once; asking for it every time would make
 * the Locate button the first step of every backup.
 */
const TOOLS_KEY = 'dbison.tools.v1'

function readToolPaths(): Partial<Record<CliTool, string>> {
  try {
    const stored = JSON.parse(localStorage.getItem(TOOLS_KEY) ?? '{}')
    return stored && typeof stored === 'object' ? stored : {}
  }
  catch {
    return {}
  }
}

function rememberToolPath(name: CliTool, path: string) {
  try {
    localStorage.setItem(TOOLS_KEY, JSON.stringify({ ...readToolPaths(), [name]: path }))
  }
  catch {
    // Storage can be unavailable; the path then lasts the dialog.
  }
}

const locating = ref(true)
const found = ref<{ path: string | null, version?: string }>({ path: null })
/** A path chosen with Locate…, now or in an earlier session; wins over PATH. */
const toolPath = ref<string | undefined>(tool.value ? readToolPaths()[tool.value] : undefined)

const toolLine = computed(() => {
  if (!tool.value) return ''
  if (toolPath.value) return `${tool.value} · ${toolPath.value}`
  if (!found.value.path) return ''
  return [tool.value, found.value.version].filter(Boolean).join(' ') + ` · ${found.value.path}`
})

const toolReady = computed(() => Boolean(toolPath.value || found.value.path))

onMounted(async () => {
  if (!tool.value) {
    locating.value = false
    return
  }

  try {
    found.value = await bridge().locateTool(tool.value)
  }
  catch {
    found.value = { path: null }
  }
  finally {
    locating.value = false
  }
})

async function locate() {
  if (!tool.value) return

  const picked = await bridge().openFile({
    filters: [
      { name: 'Programs', extensions: import.meta.client && /win/i.test(navigator.platform) ? ['exe'] : ['*'] },
      { name: 'All files', extensions: ['*'] },
    ],
  }).catch(() => ({ opened: false as const }))

  if (!picked.opened || !picked.path) return

  toolPath.value = picked.path
  rememberToolPath(tool.value, picked.path)
}

/* ------------------------------------------------------------------------ *
 * The form.
 * ------------------------------------------------------------------------ */

/** Whether the explorer is looking at this very connection, so its lists apply. */
const explorerHere = computed(() => explorer.connectionId.value === props.profile.id)

/**
 * The profile's own database first, then whatever the explorer has listed
 * for the server. Not a live read: the dialog can open on a connection that
 * is not open, and a dump does not need it to be.
 */
const databases = computed(() => {
  const names = [props.profile.database, ...(explorerHere.value ? explorer.databases.value.map((d) => d.name) : [])]
  return [...new Set(names.filter((name): name is string => Boolean(name)))]
})

const database = ref(
  props.database
  ?? (explorerHere.value ? explorer.database.value : undefined)
  ?? props.profile.database
  ?? '',
)

/** What the file is named after, and what a restore asks to have typed. */
const databaseLabel = computed(() =>
  fileBased.value ? fileName(props.profile.file ?? '').replace(/\.[^.]+$/, '') || 'database' : database.value.trim(),
)

const what = ref<'all' | 'schema' | 'data'>('all')

const WHAT: { id: typeof what.value, label: string, title: string }[] = [
  { id: 'all', label: 'Everything', title: 'Structure and rows' },
  { id: 'schema', label: 'Schema only', title: 'CREATE statements, no rows' },
  { id: 'data', label: 'Data only', title: 'Rows, for a database that already has the tables' },
]

/**
 * The explorer's tables, when it is showing exactly this database. Named as
 * the tool wants them: `schema.table` where the engine has schemas, since a
 * bare name there would match one in every schema.
 */
const knownTables = computed(() => {
  if (!explorerHere.value || !explorer.ready.value) return []
  if (hasDatabases.value && explorer.database.value !== database.value) return []

  const qualify = driver.value.levels.includes('schema')
  return explorer.everything.value
    .filter((entity) => entity.object.kind === 'table')
    .map((entity) => (qualify && entity.object.schema ? `${entity.object.schema}.${entity.object.name}` : entity.object.name))
})

const onlyTables = ref(Boolean(props.tables?.length))
const picked = ref(new Set<string>(props.tables ?? []))
const typedTables = ref((props.tables ?? []).join(', '))
const tableFilter = ref('')

const shownTables = computed(() => {
  const needle = tableFilter.value.trim().toLowerCase()
  return needle ? knownTables.value.filter((name) => name.toLowerCase().includes(needle)) : knownTables.value
})

function togglePicked(name: string) {
  const next = new Set(picked.value)
  if (!next.delete(name)) next.add(name)
  picked.value = next
}

/** The table list the request carries, from whichever control was shown. */
const chosenTables = computed(() => {
  if (!onlyTables.value) return undefined

  const names = knownTables.value.length
    ? [...picked.value]
    : typedTables.value.split(',').map((name) => name.trim()).filter(Boolean)

  return names.length ? names : undefined
})

const suggestedName = computed(() => {
  const stamp = new Date().toISOString().slice(0, 10)
  return `${databaseLabel.value || 'database'}-${stamp}.sql`
})

/** A restore is typed for, not clicked: the wrong database here has no undo. */
const attempt = ref('')
const unlocked = computed(() => dumping.value || attempt.value.trim() === databaseLabel.value)

const phase = ref<'idle' | 'running' | 'done'>('idle')

const ready = computed(() => {
  if (!tool.value || !toolReady.value || phase.value === 'running') return false
  if (hasDatabases.value && !database.value.trim()) return false
  if (onlyTables.value && !chosenTables.value) return false
  return unlocked.value
})

/* ------------------------------------------------------------------------ *
 * The run.
 * ------------------------------------------------------------------------ */

const stopping = ref(false)
const outcome = ref<ToolOutcome | null>(null)
const error = ref<{ message: string, detail: string[] } | null>(null)
/** Said in place of a result when the user stopped the tool themselves. */
const note = ref<string | null>(null)

let jobId: string | null = null
const progress = ref<ReturnType<typeof watchJob> | null>(null)
const logBox = useTemplateRef<HTMLElement>('logBox')

/** The tool's output while it runs; the failure's detail lines afterwards. */
const logLines = computed(() => error.value?.detail.length ? error.value.detail : progress.value?.lines ?? [])

// The newest line is the one worth reading; keep it in view as they arrive.
watch(() => logLines.value.length, async () => {
  await nextTick()
  if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight
})

const startedAt = ref(0)
const now = ref(0)
let ticker: ReturnType<typeof setInterval> | undefined

const elapsed = computed(() => (phase.value === 'running' ? formatSeconds(now.value - startedAt.value) : ''))

function formatSeconds(ms: number) {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`
}

/** The tool's last lines, however main attached them to the rejection. */
function detailLines(cause: unknown): string[] {
  const detail = (cause as { detail?: unknown })?.detail
  if (Array.isArray(detail)) return detail.map(String)
  if (typeof detail === 'string') return detail.split(/\r?\n/).filter(Boolean)
  return []
}

async function start() {
  if (!ready.value || !tool.value) return

  jobId = crypto.randomUUID()
  const job = watchJob(jobId)
  progress.value = job
  phase.value = 'running'
  stopping.value = false
  error.value = null
  note.value = null
  startedAt.value = Date.now()
  now.value = startedAt.value
  ticker = setInterval(() => { now.value = Date.now() }, 200)

  const scope = hasDatabases.value ? database.value.trim() : undefined

  try {
    const result = dumping.value
      ? await bridge().dump(props.profile.id, {
          database: scope,
          suggestedName: suggestedName.value,
          toolPath: toolPath.value,
          schemaOnly: what.value === 'schema' || undefined,
          dataOnly: what.value === 'data' || undefined,
          tables: chosenTables.value,
          jobId,
        })
      : await bridge().restore(props.profile.id, {
          database: scope,
          toolPath: toolPath.value,
          jobId,
          // The typed name is the consent the read-only guard asks for.
          allowWrite: props.profile.readOnly ? true : undefined,
        })

    // The file dialog was dismissed: nothing ran, nothing to report.
    if (!result.ok) {
      phase.value = 'idle'
      return
    }

    outcome.value = result
    phase.value = 'done'
  }
  catch (cause) {
    if (isCancellation(cause)) {
      note.value = dumping.value
        ? 'Stopped. A partial file may have been left where you pointed.'
        : 'Stopped. Whatever ran before the stop has been applied.'
    }
    else {
      error.value = { message: cause instanceof Error ? cause.message : String(cause), detail: detailLines(cause) }
    }
    phase.value = 'idle'
  }
  finally {
    clearInterval(ticker)
    job.stop()
    jobId = null
  }
}

async function stop() {
  if (!jobId || stopping.value) return

  stopping.value = true
  await bridge().cancel(jobId).catch(() => ({ cancelled: false }))
}

// Esc or a backdrop click mid-run must not leave a tool writing a file, or
// a restore half-applied, with nobody watching.
onBeforeUnmount(() => {
  clearInterval(ticker)
  if (jobId) bridge().cancel(jobId).catch(() => ({ cancelled: false }))
})

function reveal() {
  if (outcome.value?.path) bridge().reveal(outcome.value.path).catch(() => ({ revealed: false }))
}

const doneLine = computed(() => {
  const result = outcome.value
  if (!result) return ''

  return `${dumping.value ? 'Saved to' : 'Restored from'} ${result.path ?? 'the file'} in ${formatSeconds(result.durationMs)}`
})

const fieldClass = 'field py-1.5'
</script>

<template>
  <AppDialog :title="dumping ? `Backup ${profile.name}` : `Restore into ${profile.name}`" size="md">
    <form class="grid gap-3 p-4" @submit.prevent="start">
      <p class="text-muted">
        Runs <span class="font-mono">{{ tool ?? 'no tool' }}</span> with this connection's settings;
        the file is a plain SQL dump the engine's own tools can read.
      </p>

      <!-- The tool row is drawn in every phase: a failure is usually a
           version or a path, and this is where both are said. -->
      <div class="flex items-center gap-2 rounded-md border border-edge bg-surface px-2.5 py-1.5">
        <AppIcon name="terminal" class="shrink-0 text-faint" />

        <span v-if="!tool" class="min-w-0 flex-1 text-warning">
          {{ driver.label }} has no {{ dumping ? 'dump' : 'restore' }} tool the app knows.
        </span>
        <span v-else-if="locating" class="min-w-0 flex-1 text-faint">Looking for {{ tool }}…</span>
        <span v-else-if="toolLine" class="selectable min-w-0 flex-1 truncate font-mono" :title="toolLine">{{ toolLine }}</span>
        <span v-else class="flex min-w-0 flex-1 items-center gap-1.5 text-warning">
          <AppIcon name="warning" />
          {{ tool }} not found on PATH or where its installers put it
        </span>

        <button
          v-if="tool"
          type="button"
          class="btn btn-ghost shrink-0"
          :disabled="phase === 'running'"
          title="Point at the executable yourself"
          @click="locate"
        >
          <AppIcon name="folderOpen" :size="12" />
          Locate…
        </button>
      </div>

      <template v-if="phase === 'done' && outcome">
        <p class="flex items-start gap-2 rounded-md border border-success/40 bg-success/10 px-3 py-2">
          <AppIcon name="check" class="mt-0.5 text-success" />
          <span class="selectable min-w-0 break-all">{{ doneLine }}</span>
        </p>

        <pre
          v-if="logLines.length"
          ref="logBox"
          class="selectable max-h-40 overflow-auto rounded-md border border-edge bg-surface p-2 font-mono text-[11px] leading-relaxed text-muted whitespace-pre-wrap"
        >{{ logLines.join('\n') }}</pre>

        <footer class="flex items-center justify-end gap-2">
          <button v-if="outcome.path" type="button" class="btn btn-ghost px-3 py-1.5" @click="reveal">
            <AppIcon name="folderOpen" :size="12" />
            Show in folder
          </button>
          <button type="button" class="btn btn-accent px-3 py-1.5" autofocus @click="confirm(outcome!)">
            Close
          </button>
        </footer>
      </template>

      <template v-else>
        <p v-if="profile.ssh?.enabled && !connected" class="flex items-start gap-2 text-warning">
          <AppIcon name="warning" class="mt-0.5" />
          <span>This connection goes through an SSH tunnel, which only exists while it is connected. Connect first.</span>
        </p>

        <label v-if="hasDatabases" class="grid gap-1">
          <span class="text-faint">Database</span>
          <select v-if="databases.length" v-model="database" :class="fieldClass" :disabled="phase === 'running'">
            <option v-for="name in databases" :key="name" :value="name">
              {{ name }}
            </option>
          </select>
          <input
            v-else
            v-model="database"
            :class="fieldClass"
            placeholder="Database name"
            spellcheck="false"
            autocomplete="off"
            :disabled="phase === 'running'"
          >
        </label>

        <template v-if="dumping">
          <div class="grid gap-1">
            <span id="backup-what" class="text-faint">What</span>
            <span class="flex rounded-md bg-raised p-0.5" role="radiogroup" aria-labelledby="backup-what">
              <button
                v-for="option in WHAT"
                :key="option.id"
                type="button"
                role="radio"
                class="btn btn-ghost flex-1 justify-center px-2 py-1"
                :data-active="what === option.id"
                :aria-checked="what === option.id"
                :title="option.title"
                :disabled="phase === 'running'"
                @click="what = option.id"
              >
                {{ option.label }}
              </button>
            </span>
          </div>

          <label class="flex items-center gap-2 text-muted">
            <input v-model="onlyTables" type="checkbox" class="accent-accent" :disabled="phase === 'running'">
            Only some tables
          </label>

          <template v-if="onlyTables">
            <!-- The explorer's list when it is showing this database; a box
                 to type into otherwise, since a closed connection has no
                 list to offer. -->
            <div v-if="knownTables.length" class="grid gap-1">
              <div class="flex items-center gap-2">
                <input
                  v-model="tableFilter"
                  type="search"
                  :class="fieldClass"
                  class="min-w-0 flex-1"
                  placeholder="Filter tables"
                  aria-label="Filter tables"
                  :disabled="phase === 'running'"
                >
                <span class="shrink-0 text-faint tabular-nums">{{ picked.size }} of {{ knownTables.length }}</span>
                <button
                  type="button"
                  class="btn btn-ghost shrink-0"
                  :disabled="phase === 'running'"
                  @click="picked = picked.size === knownTables.length ? new Set() : new Set(knownTables)"
                >
                  {{ picked.size === knownTables.length ? 'None' : 'All' }}
                </button>
              </div>

              <div class="max-h-40 overflow-auto rounded-md border border-edge bg-surface py-1">
                <label
                  v-for="name in shownTables"
                  :key="name"
                  class="flex items-center gap-2 px-2.5 py-0.5 hover:bg-raised"
                >
                  <input
                    type="checkbox"
                    class="accent-accent"
                    :checked="picked.has(name)"
                    :disabled="phase === 'running'"
                    @change="togglePicked(name)"
                  >
                  <span class="truncate font-mono">{{ name }}</span>
                </label>
                <p v-if="!shownTables.length" class="px-2.5 py-1 text-faint">
                  No table matches.
                </p>
              </div>
            </div>

            <label v-else class="grid gap-1">
              <span class="text-faint">Tables <span class="opacity-70">(comma-separated{{ driver.levels.includes('schema') ? ', schema.table' : '' }})</span></span>
              <input
                v-model="typedTables"
                :class="fieldClass"
                class="font-mono"
                placeholder="users, orders"
                spellcheck="false"
                autocomplete="off"
                :disabled="phase === 'running'"
              >
            </label>
          </template>

          <div class="grid gap-1">
            <span class="text-faint">Output</span>
            <p class="text-muted">
              Ask where to save
              <span class="block text-faint">Suggested name: <span class="font-mono">{{ suggestedName }}</span></span>
            </p>
          </div>
        </template>

        <template v-else>
          <p class="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-danger">
            <AppIcon name="warning" class="mt-0.5 shrink-0" />
            <span>
              The dump runs as-is against <span class="font-mono">{{ databaseLabel }}</span>: every statement in the file,
              in order, with no check of what is already there. There is no undo.
              <span v-if="profile.readOnly" class="block">
                {{ profile.name }} is marked read-only; confirming below lets this write through.
              </span>
            </span>
          </p>

          <label class="grid gap-1">
            <span class="text-faint">Type <span class="font-mono text-content">{{ databaseLabel }}</span> to confirm</span>
            <input
              v-model="attempt"
              :class="fieldClass"
              class="font-mono"
              spellcheck="false"
              autocomplete="off"
              :disabled="phase === 'running'"
            >
          </label>

          <p class="text-faint">
            The file is picked when you start.
          </p>
        </template>

        <p v-if="error" class="grid gap-1 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-danger">
          <span class="flex items-start gap-2">
            <AppIcon name="warning" class="mt-0.5 shrink-0" />
            <span class="selectable font-mono">{{ error.message }}</span>
          </span>
        </p>

        <p v-else-if="note" class="text-warning">
          {{ note }}
        </p>

        <!-- What the tool printed: the whole story of a failure, and the
             only sign of life during a long run. -->
        <pre
          v-if="phase === 'running' || logLines.length"
          ref="logBox"
          class="selectable max-h-40 min-h-16 overflow-auto rounded-md border border-edge bg-surface p-2 font-mono text-[11px] leading-relaxed text-muted whitespace-pre-wrap"
          aria-live="polite"
        >{{ logLines.length ? logLines.join('\n') : 'Waiting for output…' }}</pre>

        <footer class="flex items-center gap-2">
          <template v-if="phase === 'running'">
            <span class="app-progress h-0.5 w-16 shrink-0 rounded-full" />
            <span class="min-w-0 flex-1 truncate text-accent-bright tabular-nums" role="status">
              {{ dumping ? 'Dumping' : 'Restoring' }}… {{ elapsed }}
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
            <button type="submit" class="btn px-3 py-1.5" :class="dumping ? 'btn-accent' : 'btn-danger'" :disabled="!ready">
              <AppIcon :name="dumping ? 'archive' : 'archiveRestore'" :size="12" />
              {{ dumping ? 'Backup…' : 'Restore…' }}
            </button>
          </template>
        </footer>
      </template>
    </form>
  </AppDialog>
</template>
