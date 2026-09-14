<script setup lang="ts">
import type { CellValue, QueryResult } from '#shared/db-types'
import type { IconName } from '~/components/ui/AppIcon.vue'
import type { GridColumn } from '~/composables/useGridColumns'
import type { ColumnFacts } from '~/utils/cell-types'

/** One mark a column wears in the grid's header, drawn here beside its name. */
interface Glyph {
  icon: IconName
  tone: string
  label: string
}

/**
 * One row of a result, stood on end.
 *
 * A grid is for comparing rows; a row with forty columns, or one long text in
 * the middle of it, is not something a grid can show at once. This is the
 * other reading of the same data: every visible column of the row the keyboard
 * is on, name over value, with the long values allowed to wrap. It follows the
 * grid's focus rather than keeping a row of its own, so the arrow keys in the
 * grid page through records here without a second cursor to keep in step.
 *
 * It reads one row and nothing else — the grid may hold tens of thousands, and
 * this panel must cost the same however many there are.
 */
const props = defineProps<{
  result: QueryResult
  /** The grid's visible columns, in the order they are on screen. */
  columns: GridColumn[]
  /**
   * The row to show: where it sits on screen and which row of the result it
   * is, or a negative draft id. Null when the grid has no focused row.
   */
  row: { position: number, source: number } | null
  /** How many rows the grid is showing, for "Row 12 of 5,000". */
  total: number
  rowOffset?: number
  width: number
  edits?: ReturnType<typeof useGridEdits>
  columnInfo?: Record<string, ColumnFacts>
  /** Whether the grid can stage edits at all; see `ResultGrid`'s `edits`. */
  editable: boolean
  readOnlyReason?: string
  /** The header's marks for a column, so a key reads as a key here too. */
  glyphsOf: (column: GridColumn) => Glyph[]
}>()

const emit = defineEmits<{
  'close': []
  /** Move the grid's focus this many rows; the view follows it. */
  'step': [delta: number]
  /** Open this column of the row full size, the way the grid's cell would. */
  'inspect': [column: GridColumn]
  /**
   * Stage what was typed for this column, or NULL. Read by the grid rather
   * than staged here: it is the grid that knows how a typed "42" becomes a
   * number for this column, and the two editors must agree on that.
   */
  'stage': [column: GridColumn, text: string | null]
  /** Flip a boolean column, in whatever shape the column already uses. */
  'toggle': [column: GridColumn]
  'update:width': [width: number]
}>()

const panel = useTemplateRef<HTMLElement>('panel')

/** Narrow enough to leave the grid room, wide enough to still wrap a sentence. */
const MIN_WIDTH = 240
const MAX_WIDTH = 900

/* ---------------------------------------------------------------- values -- */

function factsOf(column: GridColumn) {
  return props.columnInfo?.[column.name]
}

/** The table's own type where there is one: `tinyint(1)` says more than `tiny`. */
function typeOf(column: GridColumn) {
  return factsOf(column)?.declaredType ?? column.type
}

function kindOf(column: GridColumn) {
  return classifyCell(column.type, factsOf(column))
}

/** What the row holds in this column, a staged edit winning over the server. */
function valueOf(column: GridColumn): CellValue {
  const row = props.row
  if (!row) return null

  const pending = props.edits?.pendingValue(row.source, column.name)
  if (pending !== undefined) return pending

  return props.result.rows[row.source]?.[column.index] ?? null
}

function isDirty(column: GridColumn) {
  return Boolean(props.row && props.edits?.isDirty(props.row.source, column.name))
}

/** A new row's cell nobody has typed into: neither a value nor a NULL yet. */
function isUnset(column: GridColumn) {
  return Boolean(props.row && props.row.source < 0 && props.edits?.pendingValue(props.row.source, column.name) === undefined)
}

const isDeleted = computed(() => Boolean(props.row && props.edits?.isDeleted(props.row.source)))

function display(value: CellValue) {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

function classOf(value: CellValue) {
  if (typeof value === 'number') return 'text-type-number tabular-nums'
  if (typeof value === 'boolean') return 'text-type-bool'
  return 'text-type-string'
}

/** "Row 12 of 5,000", or what stands in for it. */
const heading = computed(() => {
  const row = props.row
  if (!row) return 'Select a row'
  if (row.source < 0) return 'New row'

  return `Row ${((props.rowOffset ?? 0) + row.position + 1).toLocaleString()} of ${props.total.toLocaleString()}`
})

/* --------------------------------------------------------------- editing -- */

/**
 * Whether this column can be typed into here. Binary is a digest, and typing
 * over a digest corrupts the bytes; a boolean is flipped rather than typed.
 */
function canType(column: GridColumn) {
  if (!props.editable || !props.row) return false
  const kind = kindOf(column)
  return kind !== 'binary' && kind !== 'boolean'
}

function canToggle(column: GridColumn) {
  return props.editable && Boolean(props.row) && kindOf(column) === 'boolean'
}

/** The column being typed into, and the text so far. */
const editing = ref<{ column: string, text: string } | null>(null)

function startEdit(column: GridColumn) {
  if (!canType(column)) return

  const value = valueOf(column)
  editing.value = { column: column.name, text: value === null ? '' : display(value) }

  // The box lives inside a `v-for`, where a template ref would collect into an
  // array; there is only ever one open, so it is found by its class.
  nextTick(() => {
    const box = panel.value?.querySelector<HTMLTextAreaElement>('.record-editor')
    box?.focus()
    box?.select()
  })
}

function cancelEdit() {
  editing.value = null
  panel.value?.focus()
}

function commitEdit(text?: string | null) {
  const at = editing.value
  if (!at) return

  const column = props.columns.find((candidate) => candidate.name === at.column)
  editing.value = null

  if (column) emit('stage', column, text === undefined ? at.text : text)
}

function onEditKey(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    cancelEdit()
    return
  }

  // Enter commits; Shift+Enter is how a multi-line value gets its newline,
  // which is the one thing this box can do that the grid's cannot.
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    commitEdit()
    return
  }

  if ((event.ctrlKey || event.metaKey) && event.key === 'Backspace') {
    event.preventDefault()
    commitEdit(null)
  }
}

// The row under the panel moved on; a draft written for the old one must not
// land in the new one on blur. Keyed on where the row is rather than on the
// object, which the grid rebuilds on every staged edit.
watch(() => `${props.row?.position}:${props.row?.source}`, () => { editing.value = null })

/* -------------------------------------------------------------- keyboard -- */

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' || event.key === 'F4') {
    event.preventDefault()
    emit('close')
    return
  }

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    emit('step', event.key === 'ArrowDown' ? 1 : -1)
  }
}

/* ---------------------------------------------------------------- sizing -- */

const resizing = ref(false)

/**
 * Dragging the panel's leading edge. The pointer is captured so the drag
 * survives leaving the 7px handle, as the grid's column dividers do.
 */
function startResize(event: PointerEvent) {
  const handle = event.currentTarget as HTMLElement
  const startX = event.clientX
  const startWidth = props.width

  resizing.value = true
  handle.setPointerCapture(event.pointerId)

  const onMove = (move: PointerEvent) => {
    // The handle is on the left, so dragging leftward makes the panel wider.
    const next = Math.round(startWidth + startX - move.clientX)
    emit('update:width', Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next)))
  }

  const onUp = () => {
    resizing.value = false
    handle.releasePointerCapture(event.pointerId)
    handle.removeEventListener('pointermove', onMove)
    handle.removeEventListener('pointerup', onUp)
    handle.removeEventListener('pointercancel', onUp)
  }

  handle.addEventListener('pointermove', onMove)
  handle.addEventListener('pointerup', onUp)
  handle.addEventListener('pointercancel', onUp)
}
</script>

<template>
  <aside
    ref="panel"
    tabindex="-1"
    class="record-view relative flex h-full min-h-0 shrink-0 flex-col border-l border-edge bg-surface/40 focus:outline-none"
    :class="resizing ? 'select-none' : ''"
    :style="{ width: `${width}px` }"
    aria-label="Record view"
    @keydown="onKeydown"
  >
    <span
      class="resize-handle"
      :class="resizing ? 'is-active' : ''"
      title="Drag to resize"
      @pointerdown.stop.prevent="startResize"
    />

    <div class="flex shrink-0 items-center gap-1 border-b border-edge px-2 py-1">
      <span class="min-w-0 flex-1 truncate font-medium text-content">{{ heading }}</span>

      <span v-if="isDeleted" class="chip shrink-0 text-danger">Deleted</span>

      <button
        type="button"
        class="btn-icon p-1"
        :disabled="!total || (row !== null && row.position <= 0)"
        title="Previous row (Up)"
        @click="emit('step', -1)"
      >
        <AppIcon name="chevronUp" :size="12" />
      </button>

      <button
        type="button"
        class="btn-icon p-1"
        :disabled="!total || (row !== null && row.position >= total - 1)"
        title="Next row (Down)"
        @click="emit('step', 1)"
      >
        <AppIcon name="chevronDown" :size="12" />
      </button>

      <button type="button" class="btn-icon p-1" title="Close the record view (Esc)" @click="emit('close')">
        <AppIcon name="close" :size="12" />
      </button>
    </div>

    <p v-if="!row" class="px-3 py-3 text-faint">
      Click a cell, or use the arrow keys, and the row it is in will be shown here.
    </p>

    <div v-else class="min-h-0 flex-1 overflow-auto">
      <div
        v-for="column in columns"
        :key="column.index"
        class="record-field group border-b border-edge px-2 py-1.5"
      >
        <div class="flex items-center gap-1.5">
          <AppIcon
            v-for="glyph in glyphsOf(column)"
            :key="glyph.icon"
            :name="glyph.icon"
            :size="11"
            :class="glyph.tone"
            :title="glyph.label"
          />

          <span class="min-w-0 truncate font-medium text-content" :title="column.name">{{ column.name }}</span>

          <span class="chip ml-auto shrink-0 font-mono font-normal text-faint" :title="typeOf(column)">
            {{ typeOf(column) }}
          </span>

          <!-- Drawn only under the pointer, so a row of forty fields is not a
               column of forty pencils. -->
          <button
            v-if="canType(column)"
            type="button"
            class="btn-icon p-0.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            title="Edit here — Enter commits · Shift+Enter for a new line · Ctrl+Backspace writes NULL"
            @click="startEdit(column)"
          >
            <AppIcon name="pencil" :size="11" />
          </button>

          <button
            v-else-if="canToggle(column)"
            type="button"
            class="btn-icon p-0.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            :title="valueOf(column) === null ? 'NULL — click to set it' : 'Click to change it'"
            @click="emit('toggle', column)"
          >
            <AppIcon name="check" :size="11" />
          </button>
        </div>

        <textarea
          v-if="editing?.column === column.name"
          v-model="editing.text"
          class="record-editor field mt-1 max-h-60 min-h-12 resize-y font-mono text-[12px]"
          spellcheck="false"
          rows="2"
          @keydown.stop="onEditKey"
          @blur="commitEdit()"
        />

        <!-- The value is a button so the whole of it is a way in to the full
             viewer, which is where a value too long even for this panel goes. -->
        <button
          v-else
          type="button"
          class="record-value selectable mt-1 w-full text-left font-mono text-[12px]"
          :class="[isDirty(column) ? 'is-dirty' : '', classOf(valueOf(column))]"
          :title="editable ? 'Open this value' : readOnlyReason ? `Open this value — ${readOnlyReason}` : 'Open this value'"
          @click="emit('inspect', column)"
        >
          <span v-if="isUnset(column)" class="text-faint italic">not set</span>
          <span v-else-if="valueOf(column) === null" class="null-pill">NULL</span>
          <template v-else>{{ display(valueOf(column)) }}</template>
        </button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
/*
 * The value box: wrapped rather than truncated, which is the whole reason this
 * panel exists, and capped so one document does not push the other thirty-nine
 * columns off the bottom.
 */
.record-value {
  display: block;
  max-height: 10rem;
  overflow: auto;
  border-radius: var(--app-radius);
  padding: 0.25rem 0.375rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.45;
  transition: background-color 90ms;
}

.record-value:hover {
  background-color: var(--app-accent-soft);
}

/* The same mark the grid puts on a cell whose edit has not been written yet:
 * the warning colour on a corner, so it survives whatever else the box paints. */
.record-value.is-dirty {
  background-image: linear-gradient(225deg, var(--app-warning) 0 6px, transparent 6px);
  box-shadow: inset 2px 0 0 var(--app-warning);
  color: var(--app-text);
}

/* The panel's leading edge, grabbable the way a column divider is. */
.resize-handle {
  position: absolute;
  top: 0;
  left: -3px;
  z-index: 1;
  width: 7px;
  height: 100%;
  cursor: col-resize;
  touch-action: none;
}

.resize-handle::after {
  content: '';
  position: absolute;
  top: 0;
  left: 3px;
  width: 2px;
  height: 100%;
  background-color: transparent;
  transition: background-color 120ms;
}

.resize-handle:hover::after,
.resize-handle.is-active::after {
  background-color: var(--app-accent-bright);
}

/* As the grid draws it, so NULL reads the same on both sides of the seam. */
.null-pill {
  display: inline-block;
  border-radius: 3px;
  background-color: color-mix(in oklab, var(--app-type-null) 22%, transparent);
  padding-inline: 0.3rem;
  font-size: 10px;
  font-style: normal;
  letter-spacing: 0.06em;
  color: var(--app-type-null);
}
</style>
