<script setup lang="ts">
import type { QueryContext } from '#shared/db-types'

/**
 * The CREATE statement behind a table, read-only, with the two things anyone
 * does with one: copy it, or open it in an editor to change and run.
 */
const props = defineProps<{
  ddl: string | null
  /** Why the text is not quite what the server holds, when it is not. */
  note?: string
  loading: boolean
  error: string | null
  context: QueryContext
  title: string
}>()

const emit = defineEmits<{ reload: [] }>()

const { copy, notice } = useClipboard()
const { openQuery } = useWorkbench()

function copyDdl() {
  if (props.ddl) copy(props.ddl, 'the CREATE statement')
}

function openInEditor() {
  if (props.ddl) openQuery({ ...props.context, sql: props.ddl, title: `${props.title} · DDL` })
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="flex shrink-0 items-center gap-2 border-b border-edge bg-surface/40 px-2 py-1">
      <button type="button" class="btn btn-ghost" :disabled="!ddl" @click="copyDdl">
        <AppIcon name="copy" :size="11" />
        Copy
      </button>
      <button type="button" class="btn btn-ghost" :disabled="!ddl" @click="openInEditor">
        <AppIcon name="play" :size="11" />
        Open in editor
      </button>

      <span v-if="notice" class="text-accent-bright">{{ notice }}</span>

      <span v-if="note" class="ml-auto flex min-w-0 items-center gap-1.5 text-faint" :title="note">
        <AppIcon name="warning" :size="11" class="shrink-0 text-warning" />
        <span class="truncate">{{ note }}</span>
      </span>
    </div>

    <p v-if="loading && !ddl" class="p-3 text-faint">
      Loading…
    </p>

    <div v-else-if="error" class="p-3">
      <p class="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-danger">
        <AppIcon name="warning" class="mt-0.5" />
        <span class="selectable min-w-0 flex-1 font-mono">{{ error }}</span>
        <button type="button" class="btn btn-ghost shrink-0" @click="emit('reload')">
          Retry
        </button>
      </p>
    </div>

    <p v-else-if="!ddl" class="p-3 text-faint">
      The engine reported no definition for this object.
    </p>

    <SqlEditor
      v-else
      :model-value="ddl"
      :context="context"
      read-only
      class="min-h-0 flex-1"
    />
  </div>
</template>
