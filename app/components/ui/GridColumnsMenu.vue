<script setup lang="ts">
import type { useGridColumns } from '~/composables/useGridColumns'

/**
 * Which columns a grid shows, in what order, and how many are pinned.
 *
 * The header itself handles the common cases — click to sort, drag to move,
 * drag the edge to resize — so this is for the ones a header cannot express:
 * putting a column away, getting it back, and pinning a run of them to the left
 * edge so an id stays on screen while the row scrolls.
 *
 * The trigger lives here rather than in `ResultGrid` so the open state does too:
 * the grid used to carry a `menuOpen` ref and a `@close` handler for a panel it
 * otherwise knew nothing about.
 */
const props = defineProps<{ columns: ReturnType<typeof useGridColumns> }>()

const dragging = ref<number | null>(null)

function onDrop(position: number) {
  if (dragging.value !== null && dragging.value !== position) props.columns.move(dragging.value, position)
  dragging.value = null
}

/** How many leading columns are pinned, as the row the user picks from. */
function pinLabel(position: number) {
  return props.columns.frozen.value === position + 1
    ? 'Unpin here'
    : `Pin the first ${position + 1} column${position ? 's' : ''}`
}
</script>

<template>
  <Popover>
    <PopoverTrigger>
      <button
        type="button"
        class="btn btn-ghost"
        title="Show, hide, reorder and pin columns"
      >
        <AppIcon name="column" :size="12" />
        Columns
        <span v-if="columns.hidden.value.length" class="chip">{{ columns.hidden.value.length }} hidden</span>
      </button>
    </PopoverTrigger>

    <PopoverContent align="end" class="w-72 overflow-hidden">
      <div class="max-h-80 overflow-auto py-1">
        <div
          v-for="(column, position) in columns.all.value"
          :key="column.index"
          class="rail group flex items-center gap-2 py-1 pr-1 pl-2"
          draggable="true"
          @dragstart="dragging = position"
          @dragend="dragging = null"
          @dragover.prevent
          @drop.prevent="onDrop(position)"
        >
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-2 text-left"
            :title="column.hidden ? 'Show this column' : 'Hide this column'"
            @click="columns.toggleHidden(column.index)"
          >
            <AppIcon
              :name="column.hidden ? 'eyeOff' : 'check'"
              :size="12"
              :class="column.hidden ? 'text-faint' : 'text-accent-bright'"
            />
            <span class="min-w-0 flex-1 truncate" :class="column.hidden ? 'text-faint line-through' : ''">
              {{ column.name }}
            </span>
            <span class="chip shrink-0 font-mono font-normal text-faint">{{ column.type }}</span>
          </button>

          <button
            type="button"
            class="btn-icon p-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            :class="columns.frozen.value === position + 1 ? '!opacity-100 text-accent-bright' : ''"
            :title="pinLabel(position)"
            @click="columns.freezeThrough(position)"
          >
            <AppIcon name="pin" :size="12" />
          </button>
        </div>
      </div>

      <div class="flex items-center gap-1 border-t border-edge px-2 py-1.5">
        <button
          type="button"
          class="btn btn-ghost"
          :disabled="!columns.hidden.value.length"
          @click="columns.showAll()"
        >
          Show all
        </button>

        <button
          type="button"
          class="btn btn-ghost ml-auto"
          title="Back to the widths and order this result came with"
          @click="columns.forget()"
        >
          Reset layout
        </button>
      </div>

      <p class="border-t border-edge px-2 py-1.5 text-faint">
        Drag a row to reorder · drag a header edge to resize
      </p>
    </PopoverContent>
  </Popover>
</template>
