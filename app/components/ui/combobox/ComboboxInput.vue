<script setup lang="ts">
import { ComboboxInput as RekaComboboxInput } from 'reka-ui'

/** The narrowing box. Reka gives it the focus when the list opens. */
defineProps<{ placeholder?: string }>()

const model = defineModel<string>({ default: '' })
</script>

<template>
  <RekaComboboxInput
    v-model="model"
    auto-focus
    :placeholder="placeholder"
    class="w-full border-b border-edge bg-bg px-2.5 py-2 text-content placeholder:text-faint focus:outline-none"
  />
</template>
