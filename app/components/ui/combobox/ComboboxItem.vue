<script setup lang="ts">
import { ComboboxItem as RekaComboboxItem } from 'reka-ui'

/**
 * One row of the list.
 *
 * Styled with `.rail` rather than `.menu-row` because these rows are two lines
 * with their own trailing controls; what it takes from Reka is `data-highlighted`,
 * which follows the pointer and the arrow keys alike — the hand-rolled lists
 * tracked those two with separate state and could disagree about which row was
 * current.
 */
defineProps<{ value: string }>()
</script>

<template>
  <RekaComboboxItem
    :value="value"
    class="rail group flex items-center gap-2 px-2 py-1.5 outline-none data-[highlighted]:bg-accent-soft"
  >
    <slot />
  </RekaComboboxItem>
</template>
