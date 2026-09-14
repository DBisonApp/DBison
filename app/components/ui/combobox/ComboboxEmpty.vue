<script setup lang="ts">
import { ComboboxEmpty as RekaComboboxEmpty } from 'reka-ui'

/** Shown in place of the list when nothing matches. */
</script>

<template>
  <RekaComboboxEmpty class="px-3 py-3 text-center text-faint">
    <slot />
  </RekaComboboxEmpty>
</template>
