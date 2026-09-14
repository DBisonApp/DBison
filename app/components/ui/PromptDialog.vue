<script setup lang="ts">
import { useModalContext } from '@kolirt/vue-modal'

/**
 * One line of text, asked for: a new name for a folder, and whatever else
 * turns out to need a word rather than a yes. Resolves with the trimmed
 * text; a dismissal rejects, which `useDialogs().prompt` turns into null.
 */
const props = defineProps<{
  title: string
  label: string
  value?: string
  placeholder?: string
  confirmLabel?: string
  /** A line under the field, for what the answer will do. */
  hint?: string
}>()

defineOptions({ modalGroup: 'dialog' })

const { confirm, close } = useModalContext<string>()

const draft = ref(props.value ?? '')
const input = useTemplateRef<HTMLInputElement>('input')

// After the modal has moved focus into itself; see ParametersDialog.
onMounted(() => {
  nextTick(() => window.setTimeout(() => {
    input.value?.focus()
    input.value?.select()
  }, 30))
})

function submit() {
  const text = draft.value.trim()
  if (text) confirm(text)
}
</script>

<template>
  <AppDialog :title="title" size="sm">
    <form class="grid gap-3 p-4" @submit.prevent="submit">
      <label class="grid gap-1">
        <span class="text-faint">{{ label }}</span>
        <input
          ref="input"
          v-model="draft"
          class="field py-1.5"
          :placeholder="placeholder"
          spellcheck="false"
          autocomplete="off"
          maxlength="80"
        >
      </label>

      <p v-if="hint" class="text-faint">
        {{ hint }}
      </p>

      <footer class="flex items-center justify-end gap-2">
        <button type="button" class="btn btn-ghost px-3 py-1.5" @click="close()">
          Cancel
        </button>
        <button type="submit" class="btn btn-accent px-3 py-1.5" :disabled="!draft.trim()">
          {{ confirmLabel ?? 'OK' }}
        </button>
      </footer>
    </form>
  </AppDialog>
</template>
