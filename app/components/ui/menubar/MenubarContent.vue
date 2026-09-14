<script setup lang="ts">
import type { MenubarContentProps } from 'reka-ui'
import {
  MenubarContent as RekaMenubarContent,
  MenubarPortal as RekaMenubarPortal,
} from 'reka-ui'

/**
 * A menu's dropped panel.
 *
 * Portalled to the body so it is never clipped by the chrome's own overflow,
 * and positioned by Reka, which flips it when the window edge is close — the
 * one thing an `absolute top-full` panel can never do for itself.
 */
const props = withDefaults(defineProps<MenubarContentProps>(), {
  align: 'start',
  sideOffset: 6,
  collisionPadding: 8,
})

// No `defineEmits`: reka-ui publishes no `MenubarContentEmits` type to declare
// them from, and without one they fall through as attrs to the same component
// and bind as listeners anyway.
</script>

<template>
  <RekaMenubarPortal>
    <RekaMenubarContent
      v-bind="props"
      class="popover popover-panel z-50 min-w-64 overflow-hidden p-1 focus:outline-none"
    >
      <slot />
    </RekaMenubarContent>
  </RekaMenubarPortal>
</template>
