<script setup lang="ts">
import { ComboboxLabel as RekaComboboxLabel } from 'reka-ui'

/**
 * A group's heading. Not a row: the highlight skips it and it takes no click.
 * Styled like the sticky section heads in the explorer, so a folder of
 * connections reads the same way a schema of tables does.
 */
</script>

<template>
  <RekaComboboxLabel class="flex items-center gap-1.5 px-2.5 pt-2 pb-1 text-[10px] font-bold tracking-[0.08em] text-faint uppercase select-none">
    <slot />
  </RekaComboboxLabel>
</template>
