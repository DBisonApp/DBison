<script setup lang="ts">
/**
 * The levels between the server and a table, as one row of pickers.
 *
 * This is where the tree's middle went. Postgres has a database and a schema
 * above a table, MySQL calls its one level a database and SQLite has neither,
 * so the row is built from `driver.levels` and a connection never offers a
 * picker that means nothing for its engine.
 *
 * Native selects on purpose: a server with three hundred databases gets the
 * platform's own type-ahead and scrolling for free, which no popover here would
 * have matched.
 */

const explorer = useExplorer()
const { openQuery, openDiagram } = useWorkbench()

/** The panel owns these flows; the bar only offers the rows that start them. */
const emit = defineEmits<{ createTable: [], backup: [], restore: [] }>()

/** Whether the engine has a dump tool the backup rows can call. */
const canBackup = computed(() => Boolean(explorer.driver.value?.capabilities?.dump))

/**
 * How many actions sit on the row depends on how wide the row is.
 *
 * A narrow explorer shows one button and a menu; a wide one earns the rest
 * back, most-used first. Measured with a ResizeObserver rather than a CSS
 * container query because the menu that holds the overflow is rendered in a
 * portal, outside the bar, where a container query of the bar cannot reach.
 * The thresholds are the bar's width with room for the selects.
 */
type Action = 'refresh' | 'diagram' | 'table'
const PROMOTE_AT: { id: Action, minWidth: number }[] = [
  { id: 'refresh', minWidth: 400 },
  { id: 'diagram', minWidth: 470 },
  { id: 'table', minWidth: 540 },
]

const bar = useTemplateRef<HTMLElement>('bar')
const width = ref(0)

onMounted(() => {
  if (!bar.value || typeof ResizeObserver === 'undefined') return
  const observer = new ResizeObserver(([entry]) => {
    width.value = entry?.contentRect.width ?? 0
  })
  observer.observe(bar.value)
  onBeforeUnmount(() => observer.disconnect())
})

const inline = computed(() => new Set(PROMOTE_AT.filter((action) => width.value >= action.minWidth).map((action) => action.id)))
/** Whether the menu still has anything to offer once the row took its share. */
const overflowNeeded = computed(() => canBackup.value || inline.value.size < PROMOTE_AT.length)

function showDiagram() {
  openDiagram({
    connectionId: explorer.connectionId.value!,
    database: explorer.database.value,
    schema: explorer.schema.value,
  })
}

/**
 * The sentinel for "all of them", since a native select only carries strings.
 * The empty string is free to use: a snapshot only ever lists schemas that are
 * actually named.
 */
const ALL = ''

</script>

<template>
  <div ref="bar" class="flex items-center gap-1 border-b border-edge bg-surface/40 px-2 py-1.5">
    <select
      v-if="explorer.levels.value.includes('database')"
      :value="explorer.database.value ?? ''"
      :disabled="!explorer.connected.value || !explorer.databases.value.length"
      class="field min-w-0 flex-1 bg-surface px-1.5 py-1"
      title="Database"
      @change="explorer.setDatabase(($event.target as HTMLSelectElement).value)"
    >
      <option value="" disabled>
        Database
      </option>
      <option v-for="item in explorer.databases.value" :key="item.id" :value="item.name">
        {{ item.name }}
      </option>
    </select>

    <select
      v-if="explorer.levels.value.includes('schema')"
      :value="explorer.schema.value ?? ALL"
      :disabled="!explorer.connected.value || !explorer.schemas.value.length"
      class="field min-w-0 flex-1 bg-surface px-1.5 py-1"
      title="Schema"
      @change="explorer.setSchema(
        ($event.target as HTMLSelectElement).value === ALL
          ? null
          : ($event.target as HTMLSelectElement).value,
      )"
    >
      <!-- Crossing schemas is rarer than living in one, but it is the case the
           old tree handled worst: every schema was its own branch to expand. -->
      <option :value="ALL">
        All schemas
      </option>
      <option v-for="name in explorer.schemas.value" :key="name" :value="name">
        {{ name }}
      </option>
    </select>

    <span v-if="!explorer.levels.value.length" class="flex-1 truncate text-faint">
      {{ explorer.profile.value?.file ?? 'Database' }}
    </span>

    <!-- One action always on the row, the rest promoted from the menu as the
         bar gets wider; see `PROMOTE_AT`. A new query is what this bar is
         reached for many times a day, so it is the one that never moves. -->
    <button
      type="button"
      class="btn-icon"
      title="New query here"
      :disabled="!explorer.connected.value"
      @click="openQuery({
        connectionId: explorer.connectionId.value,
        database: explorer.database.value,
        schema: explorer.schema.value ?? undefined,
      })"
    >
      <AppIcon name="play" />
    </button>

    <button
      v-if="inline.has('table')"
      type="button"
      class="btn-icon"
      title="New table here"
      :disabled="!explorer.connected.value"
      @click="emit('createTable')"
    >
      <AppIcon name="plus" />
    </button>

    <button
      v-if="inline.has('diagram')"
      type="button"
      class="btn-icon"
      title="Show the relationship diagram"
      :disabled="!explorer.connected.value"
      @click="showDiagram"
    >
      <AppIcon name="diagram" />
    </button>

    <button
      v-if="inline.has('refresh')"
      type="button"
      class="btn-icon"
      title="Re-read the schema (F5)"
      :disabled="!explorer.connected.value"
      @click="explorer.refresh()"
    >
      <AppIcon name="refresh" :class="explorer.loading.value ? 'animate-spin' : ''" />
    </button>

    <DropdownMenu v-if="overflowNeeded">
      <DropdownMenuTrigger>
        <button
          type="button"
          class="btn-icon"
          title="More actions"
          aria-label="More actions for this database"
          :disabled="!explorer.connected.value"
        >
          <!-- While the refresh button is in the menu, its spinner shows
               here, so the one visible sign of progress is never lost. -->
          <AppIcon v-if="explorer.loading.value && !inline.has('refresh')" name="refresh" class="animate-spin" />
          <AppIcon v-else name="more" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem v-if="!inline.has('diagram')" icon="diagram" @select="showDiagram">
          Show relationship diagram
        </DropdownMenuItem>
        <DropdownMenuItem v-if="!inline.has('table')" icon="plus" @select="emit('createTable')">
          New table…
        </DropdownMenuItem>

        <template v-if="canBackup">
          <DropdownMenuSeparator v-if="!inline.has('diagram') || !inline.has('table')" />
          <DropdownMenuItem icon="archive" @select="emit('backup')">
            Backup database…
          </DropdownMenuItem>
          <DropdownMenuItem icon="archiveRestore" @select="emit('restore')">
            Restore into database…
          </DropdownMenuItem>
        </template>

        <template v-if="!inline.has('refresh')">
          <DropdownMenuSeparator />
          <DropdownMenuItem icon="refresh" hint="F5" @select="explorer.refresh()">
            Refresh schema
          </DropdownMenuItem>
        </template>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
</template>
