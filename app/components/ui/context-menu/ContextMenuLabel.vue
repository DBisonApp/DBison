<script setup lang="ts">
import type { ContextMenuLabelProps } from 'reka-ui'
import { ContextMenuLabel as RekaContextMenuLabel } from 'reka-ui'

/**
 * What the menu is about — the table, the column, the size of the selection.
 *
 * A context menu opens away from the thing it acts on and covers the rest, so
 * without this the user has to remember what they right-clicked.
 */
const props = defineProps<ContextMenuLabelProps>()
</script>

<template>
  <RekaContextMenuLabel
    v-bind="props"
    class="truncate px-2 pt-1 pb-1.5 font-medium text-faint"
  >
    <slot />
  </RekaContextMenuLabel>
</template>
