<script setup lang="ts">
import type { QueryHistoryEntry } from '#shared/db-types'

/**
 * What ran before, as a list to pull a statement back out of.
 *
 * A popover rather than a panel: the question "what was that query I ran on
 * Tuesday?" comes up mid-edit, and the answer wants to land in the editor that
 * is already open. Picking a row appends it there; a second button opens it
 * in a tab of its own for the times the current buffer is not to be touched.
 */
const props = defineProps<{
  /** The tab's connection, which the list is narrowed to by default. */
  connectionId: string | null
}>()

const emit = defineEmits<{
  /** Put this statement in the current editor. */
  use: [entry: QueryHistoryEntry]
  /** Open this statement in a new tab, on the connection it ran on. */
  openInTab: [entry: QueryHistoryEntry]
}>()

const history = useQueryHistory()
const connections = useConnections()
const { confirm, openSaveQuery } = useDialogs()

const open = ref(false)
const filter = ref('')
const thisConnectionOnly = ref(true)
const searchBox = useTemplateRef<HTMLInputElement>('searchBox')

/** How many rows are drawn at most; the search box narrows the rest. */
const RENDER_CAP = 200

watch(open, (isOpen) => {
  if (!isOpen) return

  history.load()
  nextTick(() => searchBox.value?.focus())
})

const scoped = computed(() => {
  const needle = filter.value.trim().toLowerCase()

  return history.entries.value.filter((entry) => {
    if (thisConnectionOnly.value && props.connectionId && entry.connectionId !== props.connectionId) return false
    return !needle || entry.sql.toLowerCase().includes(needle)
  })
})

const shown = computed(() => scoped.value.slice(0, RENDER_CAP))

function connectionName(id: string) {
  return connections.profiles.value.find((profile) => profile.id === id)?.name ?? 'removed connection'
}

/** The statement's first meaningful line, for the one line a row has. */
function headline(sql: string) {
  const line = sql.split('\n').map((part) => part.trim()).find((part) => part && !part.startsWith('--'))
  return line ?? sql.trim()
}

/**
 * When it ran, at the precision a memory has: "just now", "14 min ago",
 * "yesterday". The exact moment is in the tooltip.
 */
function timeAgo(at: number) {
  const seconds = Math.round((Date.now() - at) / 1000)

  if (seconds < 45) return 'just now'
  if (seconds < 3_600) return `${Math.max(1, Math.round(seconds / 60))} min ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)} h ago`

  const days = Math.round(seconds / 86_400)
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`

  return new Date(at).toLocaleDateString()
}

function outcomeLabel(entry: QueryHistoryEntry) {
  if (entry.outcome === 'error') return entry.error ?? 'Failed'
  if (entry.outcome === 'cancelled') return 'Cancelled'

  const parts = []
  if (entry.rowCount !== undefined) parts.push(`${entry.rowCount} row${entry.rowCount === 1 ? '' : 's'}`)
  if (entry.affectedRows !== undefined) parts.push(`${entry.affectedRows} affected`)
  if (entry.durationMs !== undefined) parts.push(`${entry.durationMs} ms`)

  return parts.join(' · ')
}

const OUTCOME_DOT: Record<QueryHistoryEntry['outcome'], string> = {
  ok: 'bg-success',
  error: 'bg-danger',
  cancelled: 'bg-warning',
}

function use(entry: QueryHistoryEntry) {
  emit('use', entry)
  open.value = false
}

function openInTab(entry: QueryHistoryEntry) {
  emit('openInTab', entry)
  open.value = false
}

/** The run worth keeping: named, and put on the shelf with its context. */
function saveAsQuery(entry: QueryHistoryEntry) {
  open.value = false
  openSaveQuery({
    sql: entry.sql,
    connectionId: entry.connectionId,
    database: entry.database,
    schema: entry.schema,
  })
}

// No confirmation for one row: the cost of a slip is one line of history,
// and the row is usually being forgotten because it should never have been
// remembered — a statement with a secret in it.
function forget(entry: QueryHistoryEntry) {
  history.remove(entry.id).catch(() => {})
}

async function clearAll() {
  const ok = await confirm({
    title: 'Clear history',
    message: `${history.entries.value.length} remembered statement${history.entries.value.length === 1 ? '' : 's'} will be forgotten, on every connection.`,
    confirmLabel: 'Clear',
    danger: true,
  })

  if (ok) await history.clear()
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger>
      <button
        type="button"
        class="btn btn-ghost"
        title="Statements this editor has run before"
        :aria-label="`Query history, ${history.entries.value.length} entries`"
      >
        <AppIcon name="history" :size="12" />
        <span class="hidden @lg:inline">History</span>
      </button>
    </PopoverTrigger>

    <PopoverContent class="flex w-[34rem] max-w-[calc(100vw-2rem)] flex-col" :side-offset="4">
      <div class="flex items-center gap-2 border-b border-edge px-2 py-1.5">
        <AppIcon name="search" :size="12" class="text-faint" />
        <input
          ref="searchBox"
          v-model="filter"
          type="search"
          placeholder="Search statements"
          spellcheck="false"
          class="min-w-0 flex-1 bg-transparent py-0.5 outline-none placeholder:text-faint"
          @keydown.escape.stop="filter ? (filter = '') : (open = false)"
        >

        <label v-if="connectionId" class="flex shrink-0 items-center gap-1 text-faint select-none">
          <input v-model="thisConnectionOnly" type="checkbox" class="accent-accent">
          This connection
        </label>
      </div>

      <div class="max-h-[60vh] min-h-24 overflow-y-auto" role="list">
        <p v-if="history.loading.value && !history.entries.value.length" class="p-3 text-faint">
          Loading…
        </p>

        <p v-else-if="!shown.length" class="p-3 text-faint">
          {{ filter ? 'Nothing matches.' : 'Nothing has run yet. Statements appear here once they do.' }}
        </p>

        <div
          v-for="entry in shown"
          :key="entry.id"
          role="listitem"
          class="group flex items-start gap-2 border-b border-edge/60 px-2 py-1.5 last:border-b-0 hover:bg-accent-soft/60"
        >
          <button
            type="button"
            class="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
            :title="`${entry.sql}\n\nClick to add it to the editor`"
            @click="use(entry)"
          >
            <span class="flex w-full items-center gap-1.5">
              <span
                class="size-1.5 shrink-0 rounded-full"
                :class="OUTCOME_DOT[entry.outcome]"
                :title="entry.outcome"
              />
              <span class="truncate font-mono text-content">{{ headline(entry.sql) }}</span>
            </span>

            <span class="flex w-full min-w-0 items-center gap-1.5 pl-3 text-faint">
              <span class="shrink-0 tabular-nums" :title="new Date(entry.at).toLocaleString()">{{ timeAgo(entry.at) }}</span>
              <span v-if="!thisConnectionOnly || !connectionId" class="truncate">· {{ connectionName(entry.connectionId) }}</span>
              <span v-if="entry.database" class="truncate">· {{ entry.database }}</span>
              <span class="truncate" :class="entry.outcome === 'error' ? 'text-danger' : ''">· {{ outcomeLabel(entry) }}</span>
              <span v-if="entry.runs > 1" class="shrink-0">· ×{{ entry.runs }}</span>
            </span>
          </button>

          <span class="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <button
              type="button"
              class="btn-icon"
              title="Open in a new query tab"
              :aria-label="`Open in a new tab: ${headline(entry.sql)}`"
              @click="openInTab(entry)"
            >
              <AppIcon name="plus" :size="12" />
            </button>
            <button
              type="button"
              class="btn-icon"
              title="Save as query…"
              :aria-label="`Save as query: ${headline(entry.sql)}`"
              @click="saveAsQuery(entry)"
            >
              <AppIcon name="bookmarkPlus" :size="12" />
            </button>
            <button
              type="button"
              class="btn-icon hover:text-danger"
              title="Forget this statement"
              :aria-label="`Forget: ${headline(entry.sql)}`"
              @click="forget(entry)"
            >
              <AppIcon name="close" :size="12" />
            </button>
          </span>
        </div>

        <p v-if="scoped.length > shown.length" class="px-3 py-1.5 text-faint">
          {{ scoped.length - shown.length }} more — narrow the search to see them.
        </p>
      </div>

      <div class="flex items-center gap-2 border-t border-edge px-2 py-1 text-faint">
        <span>{{ scoped.length }} of {{ history.entries.value.length }}</span>
        <button
          type="button"
          class="btn btn-ghost ml-auto"
          :disabled="!history.entries.value.length"
          @click="clearAll"
        >
          <AppIcon name="trash" :size="11" />
          Clear
        </button>
      </div>
    </PopoverContent>
  </Popover>
</template>
