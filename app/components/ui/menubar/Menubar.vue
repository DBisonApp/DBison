<script setup lang="ts">
import type { MenubarRootEmits, MenubarRootProps } from 'reka-ui'
import { MenubarRoot as RekaMenubarRoot, useForwardPropsEmits } from 'reka-ui'

/**
 * The bar that owns a row of menus, on Reka's `Menubar` primitive.
 *
 * Reka is imported under a `Reka…` alias in every file here, because Nuxt
 * auto-imports these wrappers under the unprefixed names and two `MenubarItem`s
 * in one file would be a puzzle rather than a component.
 *
 * What the primitive brings, and what this app's hand-rolled bar never had: one
 * menu open at a time, hovering across the bar moving the open menu with the
 * pointer, Alt/arrow keys to walk it, typeahead, focus returning to the trigger
 * on close, and the ARIA roles a screen reader needs to call it a menu bar.
 */
const props = defineProps<MenubarRootProps>()
const emits = defineEmits<MenubarRootEmits>()

const forwarded = useForwardPropsEmits(props, emits)
</script>

<template>
  <RekaMenubarRoot v-bind="forwarded" class="flex items-center gap-0.5">
    <slot />
  </RekaMenubarRoot>
</template>
