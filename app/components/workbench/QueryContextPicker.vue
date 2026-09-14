<script setup lang="ts">
import type { DbNode, QueryContext } from '#shared/db-types'

/**
 * Where the query tab is pointed, as one control: a breadcrumb that always
 * reads out the full path, and a popover to change any level of it.
 *
 * The levels shown come from the driver — Postgres has a database and a schema
 * above a table, MySQL calls its one level a database, SQLite has neither — so
 * a connection never offers a picker that means nothing for its engine.
 */
const context = defineModel<QueryContext>({ required: true })

const connections = useConnections()
const children = useDbChildren()

const databases = ref<DbNode[]>([])
const schemas = ref<DbNode[]>([])
const loading = ref(false)
const error = ref<string | null>(null)

/** Keeps the two watchers below from fetching the same schema list twice. */
let loadedSchemasFor: string | null = null

const profile = computed(
  () => connections.profiles.value.find((p) => p.id === context.value.connectionId) ?? null,
)
const driver = computed(() => (profile.value ? connections.driverOf(profile.value) : null))
const levels = computed(() => driver.value?.levels ?? [])
const status = computed(() =>
  context.value.connectionId ? connections.stateOf(context.value.connectionId).status : 'disconnected',
)
const connected = computed(() => status.value === 'connected')

/** The path as it reads in the toolbar; a level not yet filled shows a dash. */
const crumbs = computed(() => {
  if (!profile.value) return ['No connection']

  return [
    profile.value.name,
    ...(levels.value.includes('database') ? [context.value.database ?? '—'] : []),
    ...(levels.value.includes('schema') ? [context.value.schema ?? '—'] : []),
  ]
})

/** `AppSelect` takes its choices as data rather than as `<option>` children. */
function toOptions(nodes: DbNode[]) {
  return nodes.map((node) => ({ value: node.name, label: node.name }))
}

const connectionOptions = computed(() =>
  connections.profiles.value.map((item) => ({ value: item.id, label: item.name })),
)

function patch(next: Partial<QueryContext>) {
  context.value = { ...context.value, ...next }
}

function pickConnection(id: string) {
  // Everything below a connection belongs to it; none of it survives a switch.
  const next = connections.profiles.value.find((p) => p.id === id)
  patch({ connectionId: id, database: next?.database || undefined, schema: undefined })
}

async function loadDatabases() {
  const id = context.value.connectionId

  if (!id || !connected.value || !levels.value.includes('database')) {
    databases.value = []
    return
  }

  loading.value = true
  error.value = null

  try {
    databases.value = await children.childrenOf(id, { id, kind: 'connection', path: {} })
    error.value = children.branchOf(id).error ?? null

    // Without a default the tab would sit on a dash and the first statement
    // would land wherever the driver felt like; the profile's own database is
    // the closest thing to an intent the user has expressed.
    if (!context.value.database) {
      const preferred = databases.value.find((d) => d.name === profile.value?.database)
        ?? databases.value[0]

      if (preferred) patch({ database: preferred.name, schema: undefined })
    }
  }
  finally {
    loading.value = false
  }
}

async function loadSchemas() {
  const id = context.value.connectionId
  const database = context.value.database

  if (!id || !connected.value || !levels.value.includes('schema') || !database) {
    schemas.value = []
    return
  }

  const key = `${id}:${database}`
  if (loadedSchemasFor === key) return
  loadedSchemasFor = key

  const node = databases.value.find((d) => d.name === database)
  if (!node) {
    loadedSchemasFor = null
    return
  }

  schemas.value = await children.childrenOf(id, node)
  error.value = children.branchOf(node.id).error ?? error.value

  if (!context.value.schema) {
    const preferred = schemas.value.find((s) => s.name === 'public') ?? schemas.value[0]
    if (preferred) patch({ schema: preferred.name })
  }
}

// A connection that opens fills the pickers; one that drops empties them, since
// the cache they are read from is discarded at the same moment. `levels` is
// watched too: a query tab can mount before the profile list has loaded, and
// until it has, the driver — and so the shape of the context — is unknown.
watch(
  [() => context.value.connectionId, connected, levels],
  async () => {
    databases.value = []
    schemas.value = []
    loadedSchemasFor = null

    await loadDatabases()
    await loadSchemas()
  },
  { immediate: true },
)

watch(() => context.value.database, loadSchemas)

onMounted(() => {
  // A query tab can be the first thing on screen when the explorer is closed.
  if (!connections.profiles.value.length) connections.refresh()
})
</script>

<template>
  <Popover>
    <PopoverTrigger>
      <button
        type="button"
        class="flex max-w-80 items-center gap-1.5 rounded-md border border-edge bg-surface px-2 py-1 text-content transition-colors hover:border-accent-line hover:bg-raised data-[state=open]:border-accent-line data-[state=open]:bg-raised"
        title="Where this query runs"
      >
        <span
          class="size-1.5 shrink-0 rounded-full"
          :class="{
            'bg-success': status === 'connected',
            'bg-warning app-pulse': status === 'connecting',
            'bg-faint': status === 'disconnected',
            'bg-danger': status === 'error',
          }"
        />

        <span class="flex min-w-0 items-center gap-1">
          <template v-for="(crumb, index) in crumbs" :key="index">
            <span v-if="index" class="text-faint">▸</span>
            <span class="truncate" :class="crumb === '—' ? 'text-faint' : ''">{{ crumb }}</span>
          </template>
        </span>

        <AppIcon name="chevronDown" :size="12" class="shrink-0 text-faint" />
      </button>
    </PopoverTrigger>

    <PopoverContent class="w-72 p-2.5">
      <label class="mb-2 flex items-center gap-2">
        <span class="w-20 shrink-0 text-faint">Connection</span>
        <AppSelect
          :model-value="context.connectionId ?? null"
          :options="connectionOptions"
          class="min-w-0 flex-1"
          @update:model-value="pickConnection($event!)"
        />
      </label>

      <label v-if="levels.includes('database')" class="mb-2 flex items-center gap-2">
        <span class="w-20 shrink-0 text-faint">Database</span>
        <AppSelect
          :model-value="context.database ?? null"
          :options="toOptions(databases)"
          :placeholder="loading ? 'Loading…' : 'Pick one'"
          :disabled="!connected || loading"
          class="min-w-0 flex-1"
          @update:model-value="patch({ database: $event ?? undefined, schema: undefined })"
        />
      </label>

      <label v-if="levels.includes('schema')" class="flex items-center gap-2">
        <span class="w-20 shrink-0 text-faint">Schema</span>
        <AppSelect
          :model-value="context.schema ?? null"
          :options="toOptions(schemas)"
          :disabled="!connected || !schemas.length"
          class="min-w-0 flex-1"
          @update:model-value="patch({ schema: $event ?? undefined })"
        />
      </label>

      <p v-if="error" class="mt-2 flex items-start gap-1.5 text-warning">
        <AppIcon name="warning" :size="12" />
        <span class="selectable">{{ error }}</span>
      </p>

      <button
        v-if="context.connectionId && !connected"
        type="button"
        class="btn btn-accent mt-2 w-full justify-center"
        @click="connections.connect(context.connectionId)"
      >
        {{ status === 'connecting' ? 'Connecting…' : 'Connect' }}
      </button>
    </PopoverContent>
  </Popover>
</template>
