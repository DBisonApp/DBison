<script setup lang="ts">
import type { PopoverRootEmits, PopoverRootProps } from 'reka-ui'
import { PopoverRoot as RekaPopoverRoot, useForwardPropsEmits } from 'reka-ui'

/**
 * A panel anchored to a trigger, for content that is not a list of commands —
 * a small form, a settings panel, a column list with its own controls.
 *
 * Use `Combobox` instead when the panel is a list the user picks one thing out
 * of, and `Menubar` when it is a menu of commands.
 */
const props = defineProps<PopoverRootProps>()
const emits = defineEmits<PopoverRootEmits>()

const forwarded = useForwardPropsEmits(props, emits)
</script>

<template>
  <RekaPopoverRoot v-bind="forwarded">
    <slot />
  </RekaPopoverRoot>
</template>
