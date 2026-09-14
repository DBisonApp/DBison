<script setup lang="ts">
import type { SavedQuery } from '#shared/db-types'

/**
 * The statements kept under a name, as a list to pull one back out of.
 *
 * A popover beside the history for the same reason the history is one: the
 * moment of wanting a saved query is mid-edit, and the answer wants to land
 * in the editor that is already open. Picking a row appends it there; the
 * hover buttons open it in a tab of its own, rename it, or drop it.
 */
const props = defineProps<{
  /** The tab's connection, which the list is narrowed to by default. */
  connectionId: string | null
}>()

const emit = defineEmits<{
  /** Put this statement in the current editor. */
  use: [query: SavedQuery]
  /** Open this statement in a new tab, on the connection it was saved for. */
  openInTab: [query: SavedQuery]
  /** Save what the editor holds now: the selection, or all of it. */
  saveCurrent: []
}>()

const saved = useSavedQueries()
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

  saved.load()
  nextTick(() => searchBox.value?.focus())
})

/**
 * Narrowed to this connection when asked, which still keeps the unscoped
 * ones: a query saved for "any connection" is for this one too.
 */
const scoped = computed(() => {
  const needle = filter.value.trim().toLowerCase()

  return saved.entries.value.filter((query) => {
    if (thisConnectionOnly.value && props.connectionId && query.connectionId && query.connectionId !== props.connectionId) return false
    if (!needle) return true

    return query.name.toLowerCase().includes(needle)
      || query.sql.toLowerCase().includes(needle)
      || (query.tags ?? []).some((tag) => tag.toLowerCase().includes(needle))
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

function use(query: SavedQuery) {
  emit('use', query)
  open.value = false
}

function openInTab(query: SavedQuery) {
  emit('openInTab', query)
  open.value = false
}

function saveCurrent() {
  open.value = false
  emit('saveCurrent')
}

// The tab's connection goes along so a query saved for any connection can be
// narrowed to this one; a query already scoped keeps its own.
function edit(query: SavedQuery) {
  openSaveQuery({ sql: query.sql, existing: query, connectionId: props.connectionId })
}

async function remove(query: SavedQuery) {
  const ok = await confirm({
    title: 'Delete saved query',
    message: `"${query.name}" will be removed. The statement itself stays wherever it is open.`,
    confirmLabel: 'Delete',
    danger: true,
  })

  if (ok) await saved.remove(query.id)
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger>
      <button
        type="button"
        class="btn btn-ghost"
        title="Statements saved under a name"
        :aria-label="`Saved queries, ${saved.entries.value.length} entries`"
      >
        <AppIcon name="bookmark" :size="12" />
        <span class="hidden @lg:inline">Saved</span>
      </button>
    </PopoverTrigger>

    <PopoverContent class="flex w-[34rem] max-w-[calc(100vw-2rem)] flex-col" :side-offset="4">
      <div class="flex items-center gap-2 border-b border-edge px-2 py-1.5">
        <AppIcon name="search" :size="12" class="text-faint" />
        <input
          ref="searchBox"
          v-model="filter"
          type="search"
          placeholder="Search by name, tag or text"
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
        <p v-if="saved.loading.value && !saved.entries.value.length" class="p-3 text-faint">
          Loading…
        </p>

        <p v-else-if="!shown.length" class="p-3 text-faint">
          {{ filter ? 'Nothing matches.' : 'Nothing saved yet. Save the current statement to keep it here.' }}
        </p>

        <div
          v-for="query in shown"
          :key="query.id"
          role="listitem"
          class="group flex items-start gap-2 border-b border-edge/60 px-2 py-1.5 last:border-b-0 hover:bg-accent-soft/60"
        >
          <button
            type="button"
            class="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
            :title="`${query.sql}\n\nClick to add it to the editor`"
            @click="use(query)"
          >
            <span class="flex w-full min-w-0 items-center gap-1.5">
              <span class="truncate text-content">{{ query.name }}</span>
              <span v-for="tag in query.tags ?? []" :key="tag" class="chip shrink-0 font-normal">{{ tag }}</span>
            </span>

            <span class="flex w-full min-w-0 items-center gap-1.5 text-faint">
              <span class="truncate font-mono">{{ headline(query.sql) }}</span>
              <span v-if="!thisConnectionOnly || !connectionId" class="shrink-0">
                · {{ query.connectionId ? connectionName(query.connectionId) : 'any connection' }}
              </span>
              <span v-if="query.database" class="shrink-0">· {{ query.database }}</span>
            </span>
          </button>

          <span class="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <button
              type="button"
              class="btn-icon"
              title="Open in a new query tab"
              :aria-label="`Open in a new tab: ${query.name}`"
              @click="openInTab(query)"
            >
              <AppIcon name="plus" :size="12" />
            </button>
            <button
              type="button"
              class="btn-icon"
              title="Rename or retag"
              :aria-label="`Edit: ${query.name}`"
              @click="edit(query)"
            >
              <AppIcon name="pencil" :size="12" />
            </button>
            <button
              type="button"
              class="btn-icon hover:text-danger"
              title="Delete"
              :aria-label="`Delete: ${query.name}`"
              @click="remove(query)"
            >
              <AppIcon name="trash" :size="12" />
            </button>
          </span>
        </div>

        <p v-if="scoped.length > shown.length" class="px-3 py-1.5 text-faint">
          {{ scoped.length - shown.length }} more — narrow the search to see them.
        </p>
      </div>

      <div class="flex items-center gap-2 border-t border-edge px-2 py-1 text-faint">
        <span>{{ scoped.length }} of {{ saved.entries.value.length }}</span>
        <button type="button" class="btn btn-ghost ml-auto" @click="saveCurrent">
          <AppIcon name="bookmarkPlus" :size="11" />
          Save current statement…
        </button>
      </div>
    </PopoverContent>
  </Popover>
</template>
