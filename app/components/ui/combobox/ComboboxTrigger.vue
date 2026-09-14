<script setup lang="ts">
import { ComboboxAnchor as RekaComboboxAnchor, ComboboxTrigger as RekaComboboxTrigger } from 'reka-ui'

/**
 * What opens the list, and what the list is positioned against.
 *
 * Anchor and trigger are one component here because every list in this app is
 * anchored to the same control that opens it; splitting them would be two tags
 * at every call site to express a choice nobody makes.
 */
</script>

<template>
  <RekaComboboxAnchor as-child>
    <RekaComboboxTrigger as-child>
      <slot />
    </RekaComboboxTrigger>
  </RekaComboboxAnchor>
</template>
