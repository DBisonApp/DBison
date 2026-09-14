<script setup lang="ts">
import { ComboboxRoot as RekaComboboxRoot } from 'reka-ui'

/**
 * A list the user picks one thing out of, optionally narrowed by typing.
 *
 * Reka owns the part that was hand-written twice in this app: the highlight
 * moving with the arrow keys, Enter taking the highlighted row, Esc closing,
 * and the highlight resetting when the list shrinks under it.
 *
 * Deliberately not a pass-through of `ComboboxRootProps`: that type is generic
 * in the value, and pinning it to a string here keeps every call site's
 * `@update:model-value` typed as an id rather than as `AcceptableValue`.
 */
withDefaults(defineProps<{
  /** Off by default: callers here filter the list themselves. */
  ignoreFilter?: boolean
  /** Keeps the typed term when a row is chosen, for multi-pick lists. */
  resetSearchTermOnSelect?: boolean
}>(), { ignoreFilter: true, resetSearchTermOnSelect: true })

const model = defineModel<string | null>({ default: null })
const open = defineModel<boolean>('open')
</script>

<template>
  <RekaComboboxRoot
    v-model="model"
    v-model:open="open"
    :ignore-filter="ignoreFilter"
    :reset-search-term-on-select="resetSearchTermOnSelect"
  >
    <slot />
  </RekaComboboxRoot>
</template>
