<script setup lang="ts">
import type { ContextMenuRootEmits, ContextMenuRootProps } from 'reka-ui'
import { ContextMenuRoot as RekaContextMenuRoot, useForwardPropsEmits } from 'reka-ui'

/**
 * A right-click menu for a region of the UI.
 *
 * One root serves a whole list or grid rather than one per row: the trigger
 * wraps the container, and the component records which row or cell the click
 * landed on. A grid draws thousands of cells, and a root per cell would be
 * thousands of providers for a menu the user opens once.
 */
const props = defineProps<ContextMenuRootProps>()
const emits = defineEmits<ContextMenuRootEmits>()

const forwarded = useForwardPropsEmits(props, emits)
</script>

<template>
  <RekaContextMenuRoot v-bind="forwarded">
    <slot />
  </RekaContextMenuRoot>
</template>
