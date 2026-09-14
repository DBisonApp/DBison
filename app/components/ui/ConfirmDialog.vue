<script setup lang="ts">
import { ModalDescription, useModalContext } from '@kolirt/vue-modal'

const props = withDefaults(
  defineProps<{
    title: string
    message: string
    confirmLabel?: string
    /** Empty hides the button: a notice has nothing to decline. */
    cancelLabel?: string
    danger?: boolean
    /**
     * A word the user has to type before the button works — the table's
     * name, for a drop. For the few actions with no undo, a click is too
     * cheap a gesture; typing the name is the moment to notice it is the
     * wrong one.
     */
    typed?: string
  }>(),
  { confirmLabel: 'Confirm', cancelLabel: 'Cancel', danger: false, typed: undefined },
)

defineOptions({ modalGroup: 'confirm' })

const { confirm, close } = useModalContext<boolean>()

const attempt = ref('')
const unlocked = computed(() => !props.typed || attempt.value.trim() === props.typed)
</script>

<template>
  <AppDialog :title="title" size="sm">
    <form class="grid gap-4 p-4" @submit.prevent="unlocked && confirm(true)">
      <ModalDescription class="selectable text-muted">
        {{ message }}
      </ModalDescription>

      <label v-if="typed" class="grid gap-1">
        <span class="text-faint">Type <span class="font-mono text-content">{{ typed }}</span> to confirm</span>
        <input
          v-model="attempt"
          class="field py-1.5 font-mono"
          spellcheck="false"
          autocomplete="off"
          autofocus
        >
      </label>

      <footer class="flex items-center justify-end gap-2">
        <button
          v-if="cancelLabel"
          type="button"
          class="btn btn-ghost px-3 py-1.5"
          @click="close()"
        >
          {{ cancelLabel }}
        </button>

        <button
          type="submit"
          class="btn px-3 py-1.5"
          :class="danger ? 'btn-danger' : 'btn-accent'"
          :disabled="!unlocked"
          :autofocus="!typed"
        >
          {{ confirmLabel }}
        </button>
      </footer>
    </form>
  </AppDialog>
</template>
