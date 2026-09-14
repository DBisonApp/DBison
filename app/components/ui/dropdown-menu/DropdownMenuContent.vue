<script setup lang="ts">
import type { DropdownMenuContentEmits, DropdownMenuContentProps } from 'reka-ui'
import {
  DropdownMenuContent as RekaDropdownMenuContent,
  DropdownMenuPortal as RekaDropdownMenuPortal,
  useForwardPropsEmits,
} from 'reka-ui'

/** The panel, anchored to the trigger and flipped when the edge is close. */
const props = withDefaults(defineProps<DropdownMenuContentProps>(), {
  align: 'end',
  sideOffset: 4,
  collisionPadding: 8,
})
const emits = defineEmits<DropdownMenuContentEmits>()

const forwarded = useForwardPropsEmits(props, emits)

defineOptions({ inheritAttrs: false })
</script>

<template>
  <RekaDropdownMenuPortal>
    <RekaDropdownMenuContent
      v-bind="{ ...forwarded, ...$attrs }"
      class="popover popover-panel z-50 min-w-48 overflow-hidden p-1 focus:outline-none"
    >
      <slot />
    </RekaDropdownMenuContent>
  </RekaDropdownMenuPortal>
</template>
