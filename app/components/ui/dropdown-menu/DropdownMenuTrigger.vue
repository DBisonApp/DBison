<script setup lang="ts">
import type { DropdownMenuTriggerProps } from 'reka-ui'
import { DropdownMenuTrigger as RekaDropdownMenuTrigger } from 'reka-ui'

/** The button that opens the menu, and what the menu is placed against. */
const props = withDefaults(defineProps<DropdownMenuTriggerProps>(), { asChild: true })
</script>

<template>
  <RekaDropdownMenuTrigger v-bind="props">
    <slot />
  </RekaDropdownMenuTrigger>
</template>
