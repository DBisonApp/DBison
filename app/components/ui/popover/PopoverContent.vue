<script setup lang="ts">
import type { PopoverContentEmits, PopoverContentProps } from 'reka-ui'
import {
  PopoverContent as RekaPopoverContent,
  PopoverPortal as RekaPopoverPortal,
  useForwardPropsEmits,
} from 'reka-ui'

/**
 * The panel itself: portalled, collision-aware, dismissed by Esc or by a click
 * outside, with focus moved in on open and handed back to the trigger on close.
 *
 * That last pair is what the `fixed inset-0` click-catchers this replaced could
 * not do — they caught the click, but a keyboard user was left with focus on a
 * panel that had gone.
 */
const props = withDefaults(defineProps<PopoverContentProps>(), {
  align: 'start',
  sideOffset: 6,
  collisionPadding: 8,
})
const emits = defineEmits<PopoverContentEmits>()

const forwarded = useForwardPropsEmits(props, emits)

// The portal is the root, and a portal has no element to put a class on: the
// caller's `class` has to be handed to the panel by hand, as the dropdown
// menu's content already does.
defineOptions({ inheritAttrs: false })
</script>

<template>
  <RekaPopoverPortal>
    <RekaPopoverContent v-bind="{ ...forwarded, ...$attrs }" class="popover popover-panel z-50 focus:outline-none">
      <slot />
    </RekaPopoverContent>
  </RekaPopoverPortal>
</template>
