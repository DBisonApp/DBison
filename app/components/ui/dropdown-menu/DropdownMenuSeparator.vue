<script setup lang="ts">
import type { DropdownMenuSeparatorProps } from 'reka-ui'
import { DropdownMenuSeparator as RekaDropdownMenuSeparator } from 'reka-ui'

/** A rule between groups. Skipped by the arrow keys and by typeahead. */
const props = defineProps<DropdownMenuSeparatorProps>()
</script>

<template>
  <RekaDropdownMenuSeparator v-bind="props" class="my-1 h-px bg-edge" />
</template>
