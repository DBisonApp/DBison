<script setup lang="ts">
import type { ContextMenuContentEmits, ContextMenuContentProps } from 'reka-ui'
import {
  ContextMenuContent as RekaContextMenuContent,
  ContextMenuPortal as RekaContextMenuPortal,
  useForwardPropsEmits,
} from 'reka-ui'

/**
 * The panel, placed at the pointer and flipped when the window edge is close.
 *
 * A context menu opens against a point rather than an element, so near the
 * bottom of a panel it is the collision handling — not an anchor — that keeps
 * the last item reachable.
 */
const props = withDefaults(defineProps<ContextMenuContentProps>(), { collisionPadding: 8 })
const emits = defineEmits<ContextMenuContentEmits>()

const forwarded = useForwardPropsEmits(props, emits)
</script>

<template>
  <RekaContextMenuPortal>
    <RekaContextMenuContent
      v-bind="forwarded"
      class="popover popover-panel z-50 min-w-56 overflow-hidden p-1 focus:outline-none"
    >
      <slot />
    </RekaContextMenuContent>
  </RekaContextMenuPortal>
</template>
