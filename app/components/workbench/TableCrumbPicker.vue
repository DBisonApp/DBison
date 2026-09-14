<script setup lang="ts">
import type { SchemaObject } from '#shared/db-types'

/**
 * The last crumb of a table tab, as a picker.
 *
 * The breadcrumb used to read "connection › database › schema › table" and do
 * nothing; the one part of it anyone wants to change from here is the table.
 * This lists every table and view of the same database — grouped by schema
 * where the engine has schemas, so a change of schema is a change of table
 * too — narrowed by typing, and hands the choice back to the tab.
 */
const props = defineProps<{
  connectionId: string
  database?: string
  /** How the engine quotes an identifier; the snapshot is keyed by it too. */
  quote: string
  schema: string
  table: string
  kind: 'table' | 'view'
}>()

const emit = defineEmits<{ pick: [object: SchemaObject] }>()

const schemaIndex = useSchemaIndex()

const open = ref(false)
const term = ref('')

const read = computed(() => schemaIndex.snapshotFor({
  connectionId: props.connectionId,
  database: props.database,
  quote: props.quote,
}))

const objects = computed(() => read.value.snapshot?.objects ?? [])
const manySchemas = computed(() => new Set(objects.value.map((object) => object.schema)).size > 1)

/** The list narrowed by the typed term, best match first, the current table left in. */
const matches = computed(() => {
  const needle = term.value.trim()
  const scored = objects.value.flatMap((object) => {
    const label = manySchemas.value ? `${object.schema}.${object.name}` : object.name
    if (!needle) return [{ object, label, score: 0, ranges: [] as [number, number][] }]
    const match = fuzzyMatch(label, needle)
    return match ? [{ object, label, score: match.score, ranges: match.ranges }] : []
  })

  if (needle) scored.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
  return scored.slice(0, 300)
})

function keyOf(object: SchemaObject) {
  return JSON.stringify([object.schema, object.name])
}

const currentKey = computed(() => JSON.stringify([props.schema, props.table]))

function pick(key: string | null) {
  if (!key) return
  open.value = false
  const found = objects.value.find((object) => keyOf(object) === key)
  if (found && key !== currentKey.value) emit('pick', found)
}

watch(open, (isOpen) => {
  if (!isOpen) term.value = ''
})
</script>

<template>
  <!-- No selected value is bound: Reka would print it into the search box on
       open, and a key is not something to search by. The current table is
       marked on its row instead. -->
  <Combobox v-model:open="open" @update:model-value="pick($event)">
    <ComboboxTrigger>
      <button
        type="button"
        class="flex min-w-0 items-center gap-1 rounded px-0.5 text-left hover:bg-surface data-[state=open]:bg-surface"
        title="Switch to another table or view in this database"
        aria-label="Switch table"
      >
        <AppIcon :name="kind === 'view' ? 'view' : 'table'" :size="12" class="shrink-0 text-accent" />
        <span class="max-w-56 min-w-12 shrink truncate font-medium">{{ table }}</span>
        <AppIcon name="chevronDown" :size="10" class="shrink-0 text-faint" />
      </button>
    </ComboboxTrigger>

    <ComboboxContent class="w-80 max-w-[calc(100vw-2rem)]" align="start">
      <ComboboxInput v-model="term" placeholder="Switch to table or view…" />

      <div class="max-h-72 min-h-0 overflow-auto py-1">
        <ComboboxEmpty>
          {{ read.loading ? 'Reading schema…' : read.error ? 'The schema could not be read.' : 'No match' }}
        </ComboboxEmpty>

        <ComboboxItem
          v-for="entry in matches"
          :key="keyOf(entry.object)"
          :value="keyOf(entry.object)"
          :data-active="keyOf(entry.object) === currentKey"
        >
          <AppIcon
            :name="entry.object.kind === 'view' ? 'view' : 'table'"
            :size="12"
            :class="entry.object.kind === 'view' ? 'text-info' : 'text-muted'"
          />
          <span class="min-w-0 flex-1 truncate">
            <template v-for="(part, index) in highlight(entry.label, entry.ranges)" :key="index">
              <mark v-if="part.hit" class="rounded-sm bg-accent-soft text-accent-bright">{{ part.text }}</mark>
              <template v-else>{{ part.text }}</template>
            </template>
          </span>
          <span v-if="entry.object.rowEstimate !== undefined" class="shrink-0 font-mono text-[11px] text-faint tabular-nums">
            {{ compactCount(entry.object.rowEstimate) }}
          </span>
        </ComboboxItem>
      </div>
    </ComboboxContent>
  </Combobox>
</template>
