<script setup lang="ts">
import type { ContextMenuTriggerProps } from 'reka-ui'
import { ContextMenuTrigger as RekaContextMenuTrigger } from 'reka-ui'

/**
 * The region that answers a right-click.
 *
 * `as-child` by default so it can wrap a `<tbody>` or a `<thead>` without
 * putting a `<div>` inside a table, which the parser would hoist straight back
 * out of it.
 */
const props = withDefaults(defineProps<ContextMenuTriggerProps>(), { asChild: true })
</script>

<template>
  <RekaContextMenuTrigger v-bind="props">
    <slot />
  </RekaContextMenuTrigger>
</template>
