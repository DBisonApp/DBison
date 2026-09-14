<script setup lang="ts">
import { useModalContext } from '@kolirt/vue-modal'
import type { SavedQuery, SavedQueryInput } from '#shared/db-types'

/**
 * Names a statement so it can be found again.
 *
 * One dialog for both the first save and a later rename: an `existing` query
 * prefills every field and the save writes back under its id. The SQL is
 * shown but not edited here; the editor is where that happens, and a save
 * dialog that also edits would be two decisions in one.
 */
const props = defineProps<{
  sql: string
  /** The query being renamed or retagged; absent for a new one. */
  existing?: SavedQuery | null
  /** The tab's context, for a new query's scope. */
  connectionId?: string | null
  database?: string
  schema?: string
}>()

defineOptions({ modalGroup: 'dialog' })

const { confirm, close } = useModalContext<SavedQuery>()

const saved = useSavedQueries()
const connections = useConnections()

/** How many lines of the statement the preview shows before trailing off. */
const PREVIEW_LINES = 12

const name = ref(props.existing?.name ?? '')
const tagsText = ref(props.existing?.tags?.join(', ') ?? '')

/**
 * The connection a scoped save would name. An existing query keeps its own;
 * a new one takes the tab's. With neither there is no scope to choose.
 */
const scopeConnectionId = props.existing?.connectionId ?? props.connectionId ?? null
const scopeConnection = computed(
  () => connections.profiles.value.find((profile) => profile.id === scopeConnectionId) ?? null,
)

const scoped = ref(props.existing ? Boolean(props.existing.connectionId) : Boolean(scopeConnectionId))

const nameBox = useTemplateRef<HTMLInputElement>('nameBox')

// After the modal has finished moving focus into itself, not before: the
// focus trap runs on the next frame and would otherwise take it back.
onMounted(() => {
  nextTick(() => window.setTimeout(() => nameBox.value?.focus(), 30))
})

const preview = computed(() => {
  const lines = props.sql.replace(/\s+$/, '').split('\n')
  return { text: lines.slice(0, PREVIEW_LINES).join('\n'), more: Math.max(0, lines.length - PREVIEW_LINES) }
})

const tags = computed(() => [...new Set(
  tagsText.value.split(',').map((tag) => tag.trim()).filter(Boolean),
)])

const saving = ref(false)
const error = ref<string | null>(null)

const complete = computed(() => Boolean(name.value.trim()) && !saving.value)

async function save() {
  if (!complete.value) return

  saving.value = true
  error.value = null

  const scopedNow = scoped.value && scopeConnectionId !== null

  // Database and schema only mean something on the connection they belong
  // to, so an unscoped query carries neither.
  const input: SavedQueryInput = {
    id: props.existing?.id,
    name: name.value.trim(),
    sql: props.sql,
    tags: tags.value.length ? tags.value : undefined,
    connectionId: scopedNow ? scopeConnectionId : undefined,
    database: scopedNow ? props.existing?.database ?? props.database : undefined,
    schema: scopedNow ? props.existing?.schema ?? props.schema : undefined,
  }

  try {
    confirm(await saved.save(input))
  }
  catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <AppDialog :title="existing ? 'Edit Saved Query' : 'Save Query'" size="md">
    <form class="grid gap-3 p-4" @submit.prevent="save">
      <label class="grid gap-1">
        <span class="text-faint">Name</span>
        <input
          ref="nameBox"
          v-model="name"
          class="field py-1.5"
          placeholder="Orders awaiting shipment"
          autocomplete="off"
          required
        >
      </label>

      <label class="grid gap-1">
        <span class="text-faint">Tags <span class="opacity-70">: comma separated</span></span>
        <input
          v-model="tagsText"
          class="field py-1.5"
          placeholder="reports, monthly"
          autocomplete="off"
          spellcheck="false"
        >
        <span v-if="tags.length" class="flex flex-wrap gap-1">
          <span v-for="tag in tags" :key="tag" class="chip">
            <AppIcon name="tag" :size="9" />
            {{ tag }}
          </span>
        </span>
      </label>

      <fieldset v-if="scopeConnectionId" class="grid gap-1">
        <legend class="mb-1 text-faint">
          Available on
        </legend>
        <label class="flex items-center gap-2 text-muted">
          <input v-model="scoped" type="radio" :value="true" class="accent-[var(--app-accent)]">
          <span>Only {{ scopeConnection?.name ?? 'this connection' }}</span>
        </label>
        <label class="flex items-center gap-2 text-muted">
          <input v-model="scoped" type="radio" :value="false" class="accent-[var(--app-accent)]">
          <span>Any connection</span>
        </label>
      </fieldset>

      <div class="grid gap-1">
        <span class="text-faint">Statement</span>
        <pre class="selectable max-h-48 overflow-auto rounded-md border border-edge bg-bg px-2.5 py-2 font-mono text-muted whitespace-pre">{{ preview.text }}</pre>
        <span v-if="preview.more" class="text-faint">… {{ preview.more }} more line{{ preview.more === 1 ? '' : 's' }}</span>
      </div>

      <p v-if="error" class="selectable flex items-start gap-2 text-danger">
        <AppIcon name="warning" />
        <span class="font-mono">{{ error }}</span>
      </p>

      <footer class="flex items-center justify-end gap-2">
        <button type="button" class="btn btn-ghost px-3 py-1.5" @click="close()">
          Cancel
        </button>
        <button type="submit" class="btn btn-accent px-3 py-1.5" :disabled="!complete">
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
      </footer>
    </form>
  </AppDialog>
</template>
