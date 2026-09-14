<script setup lang="ts">
/**
 * A parsed JSON document as a tree that folds.
 *
 * Pretty-printed JSON is readable up to a screen or two; past that, what the
 * user wants is to open the one branch they came for and leave the rest shut.
 * The tree is walked once into a flat list of rows, and folding only decides
 * which of those rows are painted — there is no recursion in the template,
 * and no component per node, which is what keeps a wide document cheap.
 */
const props = defineProps<{
  value: unknown
}>()

/** Past this many rows the walk stops; a document this size is a file, not a cell. */
const NODE_CAP = 2000

type Kind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'

interface TreeRow {
  id: string
  parent: string | null
  depth: number
  /** The key in an object, the index in an array, nothing at the root. */
  label: string | null
  kind: Kind
  /** The leaf value, shown as it is; a container carries its size instead. */
  leaf?: string
  count?: number
  raw: unknown
  /** Whether this is the last entry of its parent, for the trailing comma. */
  last: boolean
}

function kindOf(value: unknown): Kind {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value === 'object' ? 'object' : (typeof value as Kind)
}

/**
 * Every node in document order, up to the cap, and whether the cap was hit.
 *
 * An explicit stack rather than recursion: a deeply nested document would
 * otherwise be one call frame per level, and the rows have to come out in the
 * order they are painted anyway.
 */
const walked = computed(() => {
  const rows: TreeRow[] = []
  let capped = false

  const stack: { value: unknown, parent: string | null, depth: number, label: string | null, last: boolean }[]
    = [{ value: props.value, parent: null, depth: 0, label: null, last: true }]

  while (stack.length) {
    if (rows.length >= NODE_CAP) {
      capped = true
      break
    }

    const node = stack.pop()!

    const kind = kindOf(node.value)
    const id = node.parent === null ? '$' : `${node.parent}/${node.label}`

    if (kind === 'object' || kind === 'array') {
      const entries = kind === 'array'
        ? (node.value as unknown[]).map((item, index) => [String(index), item] as const)
        : Object.entries(node.value as Record<string, unknown>)

      rows.push({ ...node, id, kind, count: entries.length, raw: node.value })

      // Pushed in reverse so the first entry is the next one popped.
      for (let at = entries.length - 1; at >= 0; at--) {
        const [label, value] = entries[at]!
        stack.push({ value, parent: id, depth: node.depth + 1, label, last: at === entries.length - 1 })
      }
      continue
    }

    rows.push({
      ...node,
      id,
      kind,
      leaf: kind === 'string' ? JSON.stringify(node.value) : String(node.value),
      raw: node.value,
    })
  }

  return { rows, capped }
})

/**
 * Which containers are shut. Everything below the first level starts shut:
 * the shape of the document is its top-level keys, and a tree that opened
 * every branch at once would be the pretty-printed text with chevrons on it.
 */
const collapsed = ref(new Set<string>())

watch(walked, ({ rows }) => {
  collapsed.value = new Set(
    rows.filter((row) => (row.kind === 'object' || row.kind === 'array') && row.depth >= 1).map((row) => row.id),
  )
}, { immediate: true })

function toggle(row: TreeRow) {
  const next = new Set(collapsed.value)
  if (next.has(row.id)) next.delete(row.id)
  else next.add(row.id)
  collapsed.value = next
}

/**
 * The rows to paint: those with no shut ancestor. Document order means a
 * parent is always seen before its children, so one pass and one set of the
 * ids that are out of sight is enough.
 */
const visible = computed(() => {
  const hidden = new Set<string>()

  return walked.value.rows.filter((row) => {
    if (row.parent !== null && (hidden.has(row.parent) || collapsed.value.has(row.parent))) {
      hidden.add(row.id)
      return false
    }
    return true
  })
})

const { notice, copy } = useClipboard()

/**
 * A click on a value copies it — the string itself without its quotes, and a
 * container as compact JSON, since that is what gets pasted into a query.
 */
function copyValue(row: TreeRow) {
  const text = row.kind === 'string' ? (row.raw as string) : JSON.stringify(row.raw)
  copy(text, row.label === null ? 'the document' : row.label)
}

function colorOf(kind: Kind) {
  switch (kind) {
    case 'string': return 'text-type-string'
    case 'number': return 'text-type-number'
    case 'boolean': return 'text-type-bool'
    case 'null': return 'text-type-null'
    default: return 'text-faint'
  }
}

/** `[3]` for an array and `{3}` for an object, what a shut branch reads as. */
function summaryOf(row: TreeRow) {
  return row.kind === 'array' ? `[${row.count}]` : `{${row.count}}`
}
</script>

<template>
  <div class="json-tree selectable font-mono text-[12px] leading-relaxed">
    <p v-if="walked.capped" class="mb-1 text-warning">
      Only the first {{ NODE_CAP.toLocaleString() }} nodes are shown — the Raw view has all of it.
    </p>

    <p v-if="notice" class="mb-1 text-accent-bright">
      {{ notice }}
    </p>

    <div
      v-for="row in visible"
      :key="row.id"
      class="tree-row flex items-start whitespace-pre"
      :style="{ paddingLeft: `${row.depth * 14}px` }"
    >
      <!-- The chevron sits in its own column even for a leaf, so the keys of
           one level line up whether or not each of them can be opened. -->
      <button
        v-if="row.kind === 'object' || row.kind === 'array'"
        type="button"
        class="tree-toggle text-faint hover:bg-raised"
        :title="collapsed.has(row.id) ? 'Open this branch' : 'Close this branch'"
        :aria-expanded="!collapsed.has(row.id)"
        @click="toggle(row)"
      >
        <AppIcon :name="collapsed.has(row.id) ? 'chevronRight' : 'chevronDown'" :size="11" />
      </button>
      <span v-else class="tree-toggle" />

      <span v-if="row.label !== null" class="text-faint">{{ row.label }}: </span>

      <!-- A branch always reads its size, shut or open: when open the size
           is what says how far the rows below it run, and the closing bracket
           a flat list cannot place is not missed. -->
      <template v-if="row.kind === 'object' || row.kind === 'array'">
        <button
          type="button"
          class="tree-value text-faint hover:bg-accent-soft"
          :title="`${row.count} ${row.kind === 'array' ? 'items' : 'keys'} — click to copy as JSON`"
          @click="copyValue(row)"
        >
          {{ summaryOf(row) }}
        </button>
        <span v-if="!row.last && collapsed.has(row.id)" class="text-faint">,</span>
      </template>

      <template v-else>
        <button
          type="button"
          class="tree-value break-all whitespace-pre-wrap text-left hover:bg-accent-soft"
          :class="colorOf(row.kind)"
          title="Click to copy this value"
          @click="copyValue(row)"
        >
          {{ row.leaf }}
        </button>
        <span v-if="!row.last" class="text-faint">,</span>
      </template>
    </div>
  </div>
</template>

<style scoped>
.tree-toggle {
  display: inline-flex;
  width: 14px;
  height: 18px;
  flex: none;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
}

.tree-value {
  border-radius: 3px;
  padding-inline: 2px;
  margin-inline: -2px;
  cursor: copy;
}
</style>
