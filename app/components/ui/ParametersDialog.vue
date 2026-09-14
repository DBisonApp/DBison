<script setup lang="ts">
import { useModalContext } from '@kolirt/vue-modal'

/**
 * Values for the bind parameters a statement names.
 *
 * Shown only when a statement has one, so the ordinary run never sees it.
 * Each value is remembered by the tab for the next run: a parameterised
 * query is typically run many times with one or two values changed.
 */
const props = defineProps<{
  names: string[]
  values: Record<string, string>
}>()

defineOptions({ modalGroup: 'dialog' })

const { confirm, close } = useModalContext<Record<string, string>>()

const draft = reactive<Record<string, string>>(
  Object.fromEntries(props.names.map((name) => [name, props.values[name] ?? ''])),
)

const first = useTemplateRef<HTMLInputElement[]>('inputs')

// After the modal has finished moving focus into itself, not before: the
// focus trap runs on the next frame and would otherwise take it back.
onMounted(() => {
  nextTick(() => window.setTimeout(() => first.value?.[0]?.focus(), 30))
})

function label(name: string) {
  return /^\d+$/.test(name) ? `$${name}` : `:${name}`
}
</script>

<template>
  <AppDialog title="Parameters" size="sm">
    <form class="grid gap-3 p-4" @submit.prevent="confirm({ ...draft })">
      <p class="text-faint">
        Typed as SQL reads it: <span class="font-mono">NULL</span> is null, a number is a number, anything else is a string.
      </p>

      <label v-for="name in names" :key="name" class="grid gap-1">
        <span class="font-mono text-faint">{{ label(name) }}</span>
        <input
          ref="inputs"
          v-model="draft[name]"
          class="field py-1.5 font-mono"
          spellcheck="false"
          autocomplete="off"
        >
      </label>

      <footer class="flex items-center justify-end gap-2">
        <button type="button" class="btn btn-ghost px-3 py-1.5" @click="close()">
          Cancel
        </button>
        <button type="submit" class="btn btn-accent px-3 py-1.5">
          Run
        </button>
      </footer>
    </form>
  </AppDialog>
</template>
