<script setup lang="ts">
import type { MenubarSeparatorProps } from 'reka-ui'
import { MenubarSeparator as RekaMenubarSeparator } from 'reka-ui'

/** A rule between groups of rows. Skipped by arrow keys and by typeahead. */
const props = defineProps<MenubarSeparatorProps>()
</script>

<template>
  <RekaMenubarSeparator v-bind="props" class="my-1 h-px bg-edge" />
</template>
