<script setup lang="ts">
import type { MenubarTriggerProps } from 'reka-ui'
import { MenubarTrigger as RekaMenubarTrigger } from 'reka-ui'

/** The bar's clickable label. Reka drives `data-state` as the menu opens. */
const props = defineProps<MenubarTriggerProps>()
</script>

<template>
  <RekaMenubarTrigger
    v-bind="props"
    class="cursor-default rounded px-2.5 py-1 text-muted transition-colors select-none hover:bg-raised data-[highlighted]:bg-raised data-[state=open]:bg-raised data-[state=open]:text-content"
  >
    <slot />
  </RekaMenubarTrigger>
</template>
