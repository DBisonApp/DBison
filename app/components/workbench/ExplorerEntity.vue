<script setup lang="ts">
import type { ExplorerEntity } from '~/composables/useExplorer'

/**
 * One table or view, and — when opened — its columns.
 *
 * The single disclosure level here is the only nesting left in the explorer.
 * It costs nothing to offer, because the columns are already in the snapshot
 * that drew the row: opening a table is a render, not a round trip, which is
 * why it can be a hover-speed gesture rather than a considered one.
 */

const props = defineProps<{
  entity: ExplorerEntity
  expanded: boolean
  /** `{ column: 'users.id' }` for this object, from the snapshot's foreign keys. */
  foreignKeys: Record<string, string>
  /**
   * Whether Tab lands on this row. The list is one tab stop, not five hundred:
   * the panel marks exactly one row tabbable and the arrow keys reach the rest.
   */
  tabbable: boolean
}>()

const emit = defineEmits<{ open: []; toggle: [] }>()

const connections = useConnections()

const parts = computed(() => highlight(props.entity.label, props.entity.match.ranges))

/**
 * The name as a query would write it, for dragging into the editor: schema
 * and all when the list shows schemas side by side, bare when it does not,
 * and quoted only where the engine would otherwise mangle it — the same
 * text a completion would have inserted.
 *
 * Whether the label is qualified is read off the label itself rather than
 * asked of `useExplorer`: that composable sets up watchers for the whole
 * sidebar, and one copy per row would be five hundred of them.
 */
const draggedName = computed(() => {
  const { object, label, node } = props.entity
  const profile = connections.profiles.value.find((p) => p.id === node.connectionId)
  const quote = profile ? connections.driverOf(profile).quote : '"'
  const qualified = label !== object.name

  return qualify([qualified ? object.schema : undefined, object.name], quote)
})

function onDragStart(event: DragEvent) {
  event.dataTransfer?.setData('text/plain', draggedName.value)
}

/**
 * The right-hand column: a row estimate, not a column count.
 *
 * Column count was the one fact about a table that never changes what you do
 * with it — a six-column table and a forty-column one both get opened the same
 * way, and the number is visible the moment the row is expanded anyway. The
 * size of a table is the thing that decides whether you open it, filter it
 * first, or leave it alone, so that is what the slot holds now; the column
 * count moved into the tooltip, where it costs nothing.
 *
 * Views have no stored estimate, so their slot stays empty rather than lying.
 */
const rows = computed(() => {
  const estimate = props.entity.object.rowEstimate
  return estimate == null ? null : compactCount(estimate)
})

const tooltip = computed(() => describeSize({
  rowEstimate: props.entity.object.rowEstimate,
  bytes: props.entity.object.bytes,
  columns: props.entity.object.columns.length,
}))
</script>

<template>
  <div :class="expanded ? 'bg-surface/40' : ''">
    <!-- `rail` puts the accent gradient down the left edge on hover, and pins
         it while the row is open, so an expanded table stays findable after
         scrolling past a screen of its own columns. -->
    <div
      class="rail group flex items-center gap-1 pr-1 transition-colors hover:bg-surface"
      :data-active="expanded"
    >
      <!-- Out of the tab order: the keyboard opens and closes the row with
           Left and Right from the name button, so a second stop per row would
           only double the distance to the bottom of the list. -->
      <button
        type="button"
        class="rounded p-1 text-faint hover:text-content"
        tabindex="-1"
        :title="expanded ? 'Hide columns' : 'Show columns'"
        :aria-expanded="expanded"
        @click="emit('toggle')"
      >
        <AppIcon :name="expanded ? 'chevronDown' : 'chevronRight'" :size="12" />
      </button>

      <!-- The one focusable thing in the row, so it carries the expansion state
           too: a screen reader hears whether the columns are showing from the
           button it is actually on, not from the chevron it never reaches. -->
      <button
        type="button"
        class="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
        data-explorer-row
        :data-entity-id="entity.node.id"
        :tabindex="tabbable ? 0 : -1"
        :title="`Open ${entity.label} — ${tooltip}`"
        :aria-expanded="expanded"
        draggable="true"
        @click="emit('open')"
        @dragstart="onDragStart"
      >
        <AppIcon
          :name="entity.object.kind === 'view' ? 'view' : 'table'"
          :size="13"
          :class="entity.object.kind === 'view' ? 'text-info' : 'text-muted'"
        />

        <span class="truncate">
          <!-- The characters that earned the hit, so a fuzzy match is legible
               rather than mysterious. -->
          <span
            v-for="(part, index) in parts"
            :key="index"
            :class="part.hit ? 'rounded-xs bg-accent-soft font-semibold text-accent-bright' : ''"
          >{{ part.text }}</span>
        </span>

        <!-- What the schema says the table is for, where anyone bothered to
             write it down. It yields to the name first when the row is too
             narrow for both, because a name you cannot read is useless and a
             description you cannot read is only missing. -->
        <span v-if="entity.object.comment" class="min-w-0 shrink-[3] truncate text-faint">
          {{ entity.object.comment }}
        </span>

        <span
          class="ml-auto shrink-0 pl-2 tabular-nums transition-opacity"
          :class="rows === '0'
            ? 'text-muted'
            : 'text-faint opacity-70 group-hover:opacity-100'"
        >{{ rows }}</span>
      </button>
    </div>

    <div v-if="expanded" class="pb-1.5 pl-6.5">
      <p v-if="!entity.object.columns.length" class="py-0.5 text-faint">
        No columns
      </p>

      <div
        v-for="column in entity.object.columns"
        :key="column.name"
        class="flex items-center gap-1.5 rounded py-0.5 pr-1 hover:bg-raised/60"
      >
        <AppIcon
          :name="column.primaryKey ? 'key' : 'column'"
          :size="11"
          :class="column.primaryKey ? 'text-warning' : 'text-faint'"
        />

        <span class="truncate" :class="column.primaryKey ? 'font-medium text-content' : ''">{{ column.name }}</span>

        <span
          v-if="foreignKeys[column.name]"
          class="flex min-w-0 shrink items-center gap-0.5 text-faint"
          :title="`References ${foreignKeys[column.name]}`"
        >
          <AppIcon name="link" :size="10" />
          <span class="truncate">{{ foreignKeys[column.name] }}</span>
        </span>

        <span class="ml-auto shrink-0 truncate pl-2 font-mono text-[11px] text-faint">{{ column.type }}</span>
      </div>
    </div>
  </div>
</template>
