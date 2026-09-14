<script setup lang="ts">
import { ComboboxGroup as RekaComboboxGroup } from 'reka-ui'

/**
 * A run of rows under one heading.
 *
 * Reka labels the group for assistive tech from the `ComboboxLabel` inside
 * it; the arrow keys walk straight through the heading as if it were not
 * there, which is the whole point of a heading that cannot be picked.
 */
</script>

<template>
  <RekaComboboxGroup>
    <slot />
  </RekaComboboxGroup>
</template>
