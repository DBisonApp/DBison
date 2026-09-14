<script setup lang="ts">
import type { MenubarLabelProps } from 'reka-ui'
import { MenubarLabel as RekaMenubarLabel } from 'reka-ui'

/** A caption over a group of rows. Announced, but never focusable. */
const props = defineProps<MenubarLabelProps>()
</script>

<template>
  <RekaMenubarLabel v-bind="props" class="px-2 pt-1.5 pb-1 text-faint">
    <slot />
  </RekaMenubarLabel>
</template>
