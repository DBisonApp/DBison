<script setup lang="ts">
import type { ContextMenuSeparatorProps } from 'reka-ui'
import { ContextMenuSeparator as RekaContextMenuSeparator } from 'reka-ui'

/** A rule between groups. Skipped by the arrow keys and by typeahead. */
const props = defineProps<ContextMenuSeparatorProps>()
</script>

<template>
  <RekaContextMenuSeparator v-bind="props" class="my-1 h-px bg-edge" />
</template>
