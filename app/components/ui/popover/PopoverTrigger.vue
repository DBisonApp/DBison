<script setup lang="ts">
import type { PopoverTriggerProps } from 'reka-ui'
import { PopoverTrigger as RekaPopoverTrigger } from 'reka-ui'

/**
 * Whatever opens the popover. Unstyled on purpose: it is `as-child` by default
 * so the caller's own button keeps its markup and classes, and gains only the
 * `aria-expanded` / `aria-controls` wiring and the `data-state` attribute.
 */
const props = withDefaults(defineProps<PopoverTriggerProps>(), { asChild: true })
</script>

<template>
  <RekaPopoverTrigger v-bind="props">
    <slot />
  </RekaPopoverTrigger>
</template>
