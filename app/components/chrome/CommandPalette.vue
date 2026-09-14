<script setup lang="ts">
import type { IconName } from '~/components/ui/AppIcon.vue'
import type { ExplorerEntity } from '~/composables/useExplorer'

/**
 * Everything the app can do, behind one keystroke and one search box.
 *
 * The menu bar answers "what can I do?" but only for whoever is willing to
 * read four menus, and the explorer answers "where is that table?" only for
 * the connection it is pointed at. The palette folds the two together: type
 * a few letters and the command, the connection or the table with that name
 * is one Enter away, whatever is focused at the time.
 *
 * Nothing here is its own source of truth. Commands come from the registry
 * the menu bar already fills, connections from the profile list, tables from
 * the explorer's snapshot — so a command that disappears from the menu, or a
 * table that is dropped, disappears from here in the same tick.
 */

interface PaletteItem {
  id: string
  label: string
  /** The dimmed prefix that says what kind of thing the row is. */
  group: string
  icon?: IconName
  keys?: string
  keywords?: string
  run: () => void
}

interface PaletteRow {
  item: PaletteItem
  /** Which characters of the label earned the hit, for the highlighting. */
  parts: { text: string, hit: boolean }[]
}

/**
 * How many tables are listed when nothing has been typed. A server with
 * thousands of them would otherwise be scored and sorted on every open for a
 * list nobody scrolls; a query narrows it to the handful that matter.
 */
const TABLE_LIMIT = 300

/** How many rows reach the DOM. The rest are a footnote until the query is longer. */
const RENDER_LIMIT = 60

const LIST_ID = 'command-palette-list'

/** True on macOS, where the chord is on Command rather than Ctrl. */
const IS_MAC = import.meta.client && /mac/i.test(navigator.platform)

const palette = useCommandPalette()
const registry = useCommandRegistry()
const connections = useConnections()
const explorer = useExplorer()
const workbench = useWorkbench()
const saved = useSavedQueries()

const { open } = palette

const query = ref('')
const highlighted = ref(0)
const searchBox = useTemplateRef<HTMLInputElement>('searchBox')
const list = useTemplateRef<HTMLElement>('list')

/** Where focus was before the palette took it, so closing puts it back. */
let previouslyFocused: HTMLElement | null = null

/* ------------------------------------------------------------------------ *
 * What can be picked.
 * ------------------------------------------------------------------------ */

const commandItems = computed<PaletteItem[]>(() =>
  registry.commands.value
    .filter((command) => !command.disabled)
    .map((command) => ({
      id: `command:${command.id}`,
      label: command.label,
      group: command.group ?? 'Command',
      icon: command.icon,
      keys: command.keys,
      keywords: command.keywords,
      run: command.run,
    })),
)

const connectionItems = computed<PaletteItem[]>(() =>
  connections.profiles.value.map((profile) => {
    const status = connections.stateOf(profile.id).status
    const live = status === 'connected' || status === 'connecting'

    return {
      id: `connection:${profile.id}`,
      label: `${live ? 'Switch to' : 'Connect to'} ${profile.name}`,
      group: 'Connection',
      icon: 'plug',
      keywords: [profile.driver, profile.host, profile.database, profile.file].filter(Boolean).join(' '),
      run: () => {
        connections.activeId.value = profile.id
        // Switching to an idle profile is a request to use it, and the sidebar
        // would only make the user click Connect again otherwise.
        if (!live) connections.connect(profile.id)
      },
    }
  }),
)

/**
 * Every saved query, opened in a tab of its own. One saved for a connection
 * opens there whichever is active; an unscoped one opens on the active one.
 * The tags and the statement's head are searchable, so `orders` finds a query
 * named "Monthly report" that reads from that table.
 */
const savedItems = computed<PaletteItem[]>(() =>
  saved.entries.value.map((query) => ({
    id: `saved:${query.id}`,
    label: query.name,
    group: 'Saved',
    icon: 'bookmark',
    keywords: [...(query.tags ?? []), query.sql.slice(0, 200)].join(' '),
    run: () => workbench.openQuery({
      connectionId: query.connectionId ?? connections.activeId.value,
      database: query.database,
      schema: query.schema,
      sql: query.sql,
      title: query.name,
    }),
  })),
)

const entityItems = computed<PaletteItem[]>(() => {
  if (!explorer.connected.value) return []

  const toItem = (group: 'Table' | 'View', icon: IconName) =>
    (entity: ExplorerEntity): PaletteItem => ({
      id: `entity:${entity.node.id}`,
      label: `Open ${entity.label}`,
      group,
      icon,
      run: () => workbench.openTableData(entity.node),
    })

  const all = explorer.everything.value

  return [
    ...all.filter((entity) => entity.object.kind === 'table').map(toItem('Table', 'table')),
    ...all.filter((entity) => entity.object.kind === 'view').map(toItem('View', 'view')),
  ]
})

/* ------------------------------------------------------------------------ *
 * What is shown.
 * ------------------------------------------------------------------------ */

/**
 * Every row the query admits, best first.
 *
 * With nothing typed the order is by kind — commands, saved queries, then
 * connections, then tables — because that is the order of how often each is
 * wanted from here.
 * With a query the kinds are pooled and ranked together: the user typing
 * `ord` wants `orders` near the top whether it is a table or a menu item.
 */
const matches = computed<PaletteRow[]>(() => {
  const needle = query.value.trim()

  if (!needle) {
    return [
      ...commandItems.value,
      ...savedItems.value,
      ...connectionItems.value,
      ...entityItems.value.slice(0, TABLE_LIMIT),
    ].map((item) => ({ item, parts: [{ text: item.label, hit: false }] }))
  }

  const hits: (PaletteRow & { score: number })[] = []

  for (const item of [...commandItems.value, ...savedItems.value, ...connectionItems.value, ...entityItems.value]) {
    const onLabel = fuzzyMatch(item.label, needle)

    if (onLabel) {
      hits.push({ item, score: onLabel.score, parts: highlight(item.label, onLabel.ranges) })
      continue
    }

    // A hit on a keyword or the group name still lists the row, but has no
    // characters in the label to light up, and ranks below any label hit so
    // that typing `table` puts a table called `tables` above every other one.
    const elsewhere = fuzzyMatch(`${item.keywords ?? ''} ${item.group}`, needle)
    if (elsewhere) hits.push({ item, score: elsewhere.score - 5000, parts: [{ text: item.label, hit: false }] })
  }

  return hits.sort((a, b) => b.score - a.score)
})

const rows = computed(() => matches.value.slice(0, RENDER_LIMIT))

/** The rows the two ceilings kept off screen, for the footnote. */
const heldBack = computed(() => {
  const unlisted = query.value.trim() ? 0 : Math.max(0, entityItems.value.length - TABLE_LIMIT)
  return matches.value.length - rows.value.length + unlisted
})

function rowId(index: number) {
  return `${LIST_ID}-${index}`
}

/* ------------------------------------------------------------------------ *
 * Opening, closing, focus.
 * ------------------------------------------------------------------------ */

watch(open, (isOpen) => {
  if (isOpen) {
    previouslyFocused = document.activeElement as HTMLElement | null
    query.value = ''
    highlighted.value = 0
    // Read on first open rather than at startup: the list is only wanted here
    // and in the popover, and both ask; the composable reads it once.
    saved.load()
    nextTick(() => searchBox.value?.focus())
    return
  }

  // Whatever had focus — an editor, a grid cell — gets it back, so a palette
  // opened mid-edit and dismissed leaves the caret where it was.
  previouslyFocused?.focus?.()
  previouslyFocused = null
})

// A new query has a new first row, and that is the one Enter should run.
watch(query, () => { highlighted.value = 0 })

// A shorter list can leave the highlight pointing past its end.
watch(rows, (next) => {
  if (highlighted.value >= next.length) highlighted.value = Math.max(0, next.length - 1)
})

watch(highlighted, () => {
  nextTick(() => {
    list.value?.querySelector(`#${rowId(highlighted.value)}`)?.scrollIntoView({ block: 'nearest' })
  })
})

function isToggleChord(event: KeyboardEvent) {
  const mod = IS_MAC ? event.metaKey : event.ctrlKey
  if (!mod || event.altKey) return false

  const key = event.key.toLowerCase()
  return (key === 'p' && event.shiftKey) || (key === 'k' && !event.shiftKey)
}

/**
 * Capture phase, so the chord wins over a focused editor: Monaco claims
 * Ctrl+K for its own chords and Ctrl+Shift+P for its own palette, and either
 * would otherwise swallow the keystroke before the window ever saw it.
 */
function onWindowKeydown(event: KeyboardEvent) {
  if (event.repeat || !isToggleChord(event)) return

  event.preventDefault()
  event.stopPropagation()
  palette.toggle()
}

onMounted(() => window.addEventListener('keydown', onWindowKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown, true))

/* ------------------------------------------------------------------------ *
 * Moving and picking.
 * ------------------------------------------------------------------------ */

function move(delta: number) {
  const count = rows.value.length
  if (!count) return

  highlighted.value = (highlighted.value + delta + count) % count
}

function runRow(row: PaletteRow | undefined) {
  if (!row) return

  // Closed first: a command that opens a dialog or moves focus must not have
  // the palette's own focus restoration land on top of it a tick later.
  palette.hide()
  row.item.run()
}

function onPanelKeydown(event: KeyboardEvent) {
  switch (event.key) {
    case 'Escape':
      event.preventDefault()
      palette.hide()
      break
    case 'ArrowDown':
      event.preventDefault()
      move(1)
      break
    case 'ArrowUp':
      event.preventDefault()
      move(-1)
      break
    case 'Home':
      event.preventDefault()
      highlighted.value = 0
      break
    case 'End':
      event.preventDefault()
      highlighted.value = Math.max(0, rows.value.length - 1)
      break
    case 'Enter':
      event.preventDefault()
      runRow(rows.value[highlighted.value])
      break
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh]"
      @mousedown.self="palette.hide()"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        data-state="open"
        class="popover popover-panel flex max-h-[70vh] w-[36rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden"
        @keydown="onPanelKeydown"
      >
        <div class="flex items-center gap-2 border-b border-edge px-3 py-2">
          <AppIcon name="search" :size="13" class="text-faint" />
          <input
            ref="searchBox"
            v-model="query"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            :aria-controls="LIST_ID"
            :aria-activedescendant="rows.length ? rowId(highlighted) : undefined"
            placeholder="Type a command, a connection or a table name"
            autocomplete="off"
            spellcheck="false"
            class="min-w-0 flex-1 bg-transparent py-0.5 text-content outline-none placeholder:text-faint"
          >
        </div>

        <div
          :id="LIST_ID"
          ref="list"
          role="listbox"
          aria-label="Matches"
          class="min-h-0 flex-1 overflow-y-auto p-1"
        >
          <p v-if="!rows.length" class="p-3 text-faint">
            {{ query ? 'Nothing matches.' : 'Nothing to run yet.' }}
          </p>

          <div
            v-for="(row, index) in rows"
            :id="rowId(index)"
            :key="row.item.id"
            role="option"
            :aria-selected="index === highlighted"
            :data-highlighted="index === highlighted ? '' : undefined"
            class="menu-row"
            @mousemove="highlighted = index"
            @click="runRow(row)"
          >
            <AppIcon v-if="row.item.icon" :name="row.item.icon" :size="13" class="text-faint" />
            <span v-else class="size-3.25 shrink-0" aria-hidden="true" />

            <span class="flex min-w-0 flex-1 items-baseline gap-1.5">
              <span class="shrink-0 text-faint">{{ row.item.group }}</span>
              <span class="truncate">
                <span
                  v-for="(part, partIndex) in row.parts"
                  :key="partIndex"
                  :class="part.hit ? 'rounded-xs bg-accent-soft font-semibold text-accent-bright' : ''"
                >{{ part.text }}</span>
              </span>
            </span>

            <kbd v-if="row.item.keys" class="kbd shrink-0">{{ formatKeys(row.item.keys) }}</kbd>
          </div>

          <p v-if="heldBack > 0" class="px-3 py-1.5 text-faint">
            {{ heldBack }} more … narrow the search to see them.
          </p>
        </div>

        <div class="border-t border-edge px-3 py-1.5 text-faint">
          ↑↓ to move · Enter to run · Esc to close
        </div>
      </div>
    </div>
  </Teleport>
</template>
