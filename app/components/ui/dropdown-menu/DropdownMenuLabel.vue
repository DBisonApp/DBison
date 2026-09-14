<script setup lang="ts">
import type { DropdownMenuLabelProps } from 'reka-ui'
import { DropdownMenuLabel as RekaDropdownMenuLabel } from 'reka-ui'

/** What the menu is about, for a menu that opens away from its own row. */
const props = defineProps<DropdownMenuLabelProps>()
</script>

<template>
  <RekaDropdownMenuLabel v-bind="props" class="truncate px-2 pt-1 pb-1.5 font-medium text-faint">
    <slot />
  </RekaDropdownMenuLabel>
</template>
