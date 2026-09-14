<script setup lang="ts">
import type { MenubarMenuProps } from 'reka-ui'
import { MenubarMenu as RekaMenubarMenu } from 'reka-ui'

/** One menu in the bar. Purely structural: it has no element of its own. */
const props = defineProps<MenubarMenuProps>()
</script>

<template>
  <RekaMenubarMenu v-bind="props">
    <slot />
  </RekaMenubarMenu>
</template>
