<script setup lang="ts">
import type { DropdownMenuRootEmits, DropdownMenuRootProps } from 'reka-ui'
import { DropdownMenuRoot as RekaDropdownMenuRoot, useForwardPropsEmits } from 'reka-ui'

/**
 * A menu hung off a button — the row overflow menus, and anything else that
 * needs the menu-bar's vocabulary without living in the menu bar.
 *
 * Non-modal by default. These open from inside other overlays (a list row
 * inside the connection picker), and a modal menu takes the pointer away from
 * the layer underneath, which closes the picker the moment the menu opens.
 */
const props = withDefaults(defineProps<DropdownMenuRootProps>(), { modal: false })
const emits = defineEmits<DropdownMenuRootEmits>()

const forwarded = useForwardPropsEmits(props, emits)
</script>

<template>
  <RekaDropdownMenuRoot v-bind="forwarded">
    <slot />
  </RekaDropdownMenuRoot>
</template>
