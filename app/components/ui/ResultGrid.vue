<script setup lang="ts">
import { useVirtualizer } from '@tanstack/vue-virtual'
import type { CellValue, QueryResult, SortOrder } from '#shared/db-types'
import type { IconName } from '~/components/ui/AppIcon.vue'
import type { GridColumn } from '~/composables/useGridColumns'
import type { CellKind, ColumnFacts, ColumnRef } from '~/utils/cell-types'
import type { SqlDialect } from '~/utils/serialize'

const props = defineProps<{
  result: QueryResult
  /**
   * Bind this — even as `null` — when the rows can be read again, and the grid
   * stops ordering them itself: the header only reports where it was clicked
   * and the owner comes back with a result the server ordered. A table view
   * does that, so its sort covers the table rather than the page on screen.
   *
   * Left unbound, as the query editor leaves it, the grid sorts what it holds:
   * an arbitrary statement is not something this component can re-run.
   */
  sort?: SortOrder | null
  /**
   * Names this grid's column layout so widths, order and hidden columns outlive
   * the tab. A table view passes its node id; a query tab passes nothing, since
   * its columns are whatever the last statement happened to return.
   */
  storageKey?: string
  /** What the export dialog suggests as a file name. */
  exportName?: string
  /**
   * How to spell an INSERT for the database these rows came from: the table
   * to write into, already qualified and quoted, and its literal rules. A
   * table view knows all of that; a query tab passes nothing, and its rows are
   * written against a table named after the result, for the user to rename.
   */
  dialect?: SqlDialect
  /**
   * How many rows the server skipped before this page. The `#` column counts
   * from it, so row 201 of a table reads as 201 rather than as 1 again.
   */
  rowOffset?: number
  /**
   * The staged edits, when the owner can write this result back.
   *
   * Typing into a cell files a change here rather than reaching the database;
   * the owner decides when to save them and does so in one transaction. Left
   * out — as the query editor leaves it — the grid is read-only, which is the
   * right answer for a result whose rows have no identity.
   */
  edits?: ReturnType<typeof useGridEdits>
  /**
   * What each column will accept in a new row, by name. Without it a draft row
   * cannot tell "the server fills this in" from "you must", and every empty
   * cell would look the same.
   */
  columnInfo?: Record<string, ColumnFacts>
  /**
   * Why this result cannot be written to, when it cannot.
   *
   * A grid that simply refuses to edit looks broken. Anything that reads as a
   * control — a checkbox above all — has to be able to say why it is inert.
   */
  readOnlyReason?: string
  /**
   * Whether the owner can read the rows again with a WHERE on them. A table
   * view can, so its cells offer "filter to this value"; a query tab cannot,
   * because an arbitrary statement is not something the grid can narrow.
   */
  filterable?: boolean
  /**
   * Fetches the whole of a binary cell, as base64, for the viewer. The grid
   * only ever holds a digest of a blob; the owner knows the table and the
   * key, so it can ask the server for the one value. Absent, binary cells
   * open on their digest.
   */
  loadBytes?: (row: Record<string, CellValue>, column: string) => Promise<string | null>
  /**
   * Writes the whole result to a file, however many rows that is. The grid
   * only ever holds the rows that were fetched; the owner has the statement
   * and can have the server run it again, so the file need not fit in memory.
   * Absent, the Export menu offers only what is loaded.
   */
  exportAll?: () => void
}>()

const emit = defineEmits<{
  'update:sort': [SortOrder | null]
  /** Ctrl+S from inside the grid; the owner owns the writing. */
  'save': []
  /**
   * A WHERE clause the user picked off a cell — `"status" = 'paid'`, `id is
   * null` — spelled in the owner's dialect. What to do with it is the owner's:
   * only something that can re-run the read knows where the clause goes.
   */
  'filter': [clause: string]
  /**
   * Follow a foreign key: this column of this row names a row of another
   * table, and the user asked to go and see it.
   *
   * The whole row travels with it, by column name, because a key can span more
   * than one column — and following only the column that was clicked would land
   * on every row that shares that half of the key. What to do with it is the
   * owner's: only something that knows the schema can turn a key into a table,
   * and only something that owns tabs can open one.
   */
  'navigate': [{ column: string, row: Record<string, CellValue> }]
}>()

const { bridge, isAvailable } = useDatabaseBridge()
const { openCellValue } = useDialogs()

const scroller = useTemplateRef<HTMLElement>('scroller')
const filterBox = useTemplateRef<HTMLInputElement>('filterBox')

/** Every row is this tall, which is what lets the grid window them. */
const ROW_HEIGHT = 26

/* -------------------------------------------------------------- sorting -- */

/** Whether the owner is doing the ordering. See the `sort` prop. */
const remote = computed(() => props.sort !== undefined)

const localSort = ref<SortOrder | null>(null)
const sort = computed(() => (remote.value ? props.sort ?? null : localSort.value))

/** The sorted column's position, or -1 once it is gone from the result. */
const sortedCol = computed(
  () => (sort.value ? props.result.columns.findIndex((c) => c.name === sort.value!.column) : -1),
)

/** Click cycles ascending → descending → the order the server sent. */
function toggleSort(index: number) {
  const column = props.result.columns[index]?.name
  if (!column) return

  const current = sort.value
  const next: SortOrder | null
    = current?.column !== column
      ? { column, dir: 'asc' }
      : current.dir === 'asc' ? { column, dir: 'desc' } : null

  if (remote.value) emit('update:sort', next)
  else localSort.value = next
}

function compare(a: CellValue, b: CellValue) {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)

  // `numeric` so id-2 sorts before id-10, and a base sensitivity so a column of
  // names does not come back split into upper- and lower-case halves.
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

/* --------------------------------------------------------------- filter -- */

const filter = ref('')

// A filter is over the rows that were loaded, so it cannot outlive them.
watch(() => props.result, () => { filter.value = '' })

/**
 * The rows to paint, as indexes into `result.rows`, sorted and filtered.
 *
 * Indexes rather than copies of the rows: a result is thousands of arrays wide,
 * and shuffling numbers keeps the cells themselves untouched — the body renders
 * against the same objects it already had. Rows the server ordered are left in
 * the order they arrived.
 */
const displayRows = computed(() => {
  const rows = props.result.rows
  let indexes = rows.map((_, index) => index)

  if (!remote.value && sort.value && sortedCol.value !== -1) {
    const col = sortedCol.value
    const sign = sort.value.dir === 'asc' ? 1 : -1

    indexes.sort((left, right) => {
      const a = rows[left]?.[col] ?? null
      const b = rows[right]?.[col] ?? null

      // NULLs sink in both directions, as the drivers' own ORDER BY makes them:
      // they are the absence of a value rather than a small one, and burying
      // them keeps readable rows at the top whichever way the column points.
      if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1

      return sign * compare(a, b)
    })
  }

  const needle = filter.value.trim().toLowerCase()
  if (needle) {
    indexes = indexes.filter((index) => {
      const row = rows[index]

      // Every column, hidden ones included: a filter that quietly ignored a
      // column the user had put away would just look broken.
      return Boolean(row?.some((cell) => cell !== null && String(cell).toLowerCase().includes(needle)))
    })
  }

  // New rows sit at the end, outside the sort and the filter: a row being typed
  // must not jump somewhere else — or vanish — as it is filled in.
  return props.edits ? [...indexes, ...props.edits.draftRows.value] : indexes
})

function sortHint(index: number, name: string) {
  if (sortedCol.value !== index) {
    // A locally sorted result that was cut off at the limit is a page of the
    // table, so the header promises only what it can deliver. A remote sort has
    // the whole table behind it and needs no such hedge.
    return !remote.value && props.result.truncated
      ? `Sort the loaded rows by ${name} · drag to move the column`
      : `Sort by ${name} · drag to move the column`
  }

  return sort.value?.dir === 'asc'
    ? 'Sorted ascending — click for descending'
    : 'Sorted descending — click to clear'
}

/* -------------------------------------------------------------- columns -- */

const columns = useGridColumns(() => props.result, () => props.storageKey, () => props.columnInfo)

/* -------------------------------------------------------------- headings -- */

function factsOf(column: GridColumn): ColumnFacts | undefined {
  return props.columnInfo?.[column.name]
}

/** The table a column names a row of, when it names one. */
function referenceOf(column: GridColumn): ColumnRef | undefined {
  return factsOf(column)?.references
}

/** The type as the table declares it, which is more than the wire reports. */
function typeOf(column: GridColumn): string {
  return factsOf(column)?.declaredType ?? column.type
}

/**
 * The marks a header wears, left of the name.
 *
 * One glyph for what the column holds, and one more for each thing it is: the
 * key that identifies the row, the link to the row it names. A column that is
 * both — every column of a junction table — wears both, because losing either
 * would hide half of what the column is for.
 *
 * They replace the type name the header used to spell out beside the name. A
 * `character varying(255)` chip is a lot of width to spend on something the
 * footer already says about whichever cell the user is on, and the shape is
 * what the eye is scanning a header row for anyway.
 */
function headerGlyphs(column: GridColumn): { icon: IconName, tone: string, label: string }[] {
  const facts = factsOf(column)
  const marks: { icon: IconName, tone: string, label: string }[] = []

  // What a column is for outranks what it holds. A key and a link are already
  // the answer to "what is this column?", and a `#` beside either of them reads
  // as a second, competing claim rather than as the type of the first — which
  // is exactly the thing an integer id does not need said about it. The type is
  // a tooltip and a footer away for the columns that wear one of these.
  if (facts?.primaryKey) {
    marks.push({ icon: 'key', tone: 'text-warning', label: `primary key · ${typeOf(column)}` })
  }

  if (facts?.references) {
    marks.push({
      icon: 'link',
      tone: 'text-accent-bright',
      label: `foreign key → ${describeRef(facts.references)}`,
    })
  }

  if (!marks.length) {
    marks.push({ icon: CELL_KIND_ICON[kindOf(column)], tone: 'text-faint', label: typeOf(column) })
  }

  return marks
}

/**
 * Everything the header no longer has room to say, in one tooltip: what the
 * column is, what it is for, and what clicking it will do.
 */
function headerTitle(column: GridColumn): string {
  const facts = factsOf(column)

  const parts = [column.name, typeOf(column)]
  if (facts?.primaryKey) parts.push('primary key')
  if (facts?.references) parts.push(`→ ${describeRef(facts.references)}`)
  if (facts && !facts.nullable) parts.push('not null')

  return `${parts.join(' · ')}
${sortHint(column.index, column.name)}`
}

/**
 * Which column the pointer is over, so its header can light up.
 *
 * Tracked by delegation on <tbody> and consumed only by <thead>: binding a
 * class on every cell to this would re-render the whole body on each pointer
 * move. The row half of the crosshair is plain CSS `:hover` for the same reason.
 */
const hoverCol = ref<number | null>(null)

function onCellOver(event: PointerEvent) {
  const cell = (event.target as HTMLElement | null)?.closest<HTMLElement>('td[data-col]')
  hoverCol.value = cell ? Number(cell.dataset.col) : null
}

const resizing = ref<number | null>(null)

/**
 * Dragging the divider on a header's trailing edge.
 *
 * The pointer is captured so the drag survives leaving the 7px handle — at any
 * speed the pointer is outside it more often than in — and the table keeps a
 * fixed layout throughout, so a column changes width without the other columns
 * shifting under the cursor.
 */
function startResize(event: PointerEvent, index: number) {
  const handle = event.currentTarget as HTMLElement
  const startX = event.clientX
  const startWidth = columns.widthOf(index)

  resizing.value = index
  handle.setPointerCapture(event.pointerId)

  const onMove = (move: PointerEvent) => columns.resize(index, startWidth + move.clientX - startX)

  const onUp = () => {
    resizing.value = null
    handle.releasePointerCapture(event.pointerId)
    handle.removeEventListener('pointermove', onMove)
    handle.removeEventListener('pointerup', onUp)
    handle.removeEventListener('pointercancel', onUp)
  }

  handle.addEventListener('pointermove', onMove)
  handle.addEventListener('pointerup', onUp)
  handle.addEventListener('pointercancel', onUp)
}

/** The column being dragged to a new position, and where it would land. */
const dragging = ref<number | null>(null)
const dropTarget = ref<number | null>(null)

function onDragStart(event: DragEvent, position: number) {
  dragging.value = position

  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    // Firefox and Chromium both refuse to start a drag with no payload.
    event.dataTransfer.setData('text/plain', String(position))
  }
}

function onDrop(position: number) {
  if (dragging.value !== null && dragging.value !== position) columns.move(dragging.value, position)
  dragging.value = null
  dropTarget.value = null
}

/* ------------------------------------------------------------ selection -- */

const selection = useGridSelection(
  () => props.result,
  () => displayRows.value,
  () => columns.visible.value,
)

// Row 4 of a re-sorted or re-filtered result is not the row that was selected,
// so a selection cannot be carried across one: it would quietly move.
//
// Watched at the source rather than on `displayRows`, which is rebuilt — and so
// compares as changed — on every staged edit. Clearing there would take the
// selection away each time a cell was committed, which is the one moment the
// user is most likely to still want it.
watch(() => props.result, () => selection.clear())
watch([filter, sort], () => selection.clear())

/**
 * What is being dragged out with the mouse, if anything.
 *
 * Cells and rows are two different drags: one started in the grid, the other
 * in the number gutter, and a drag that began on a row number must keep
 * selecting whole rows as it passes over cells rather than collapsing to
 * whichever column the pointer happens to cross.
 */
const dragSelecting = ref<'cell' | 'row' | null>(null)

function onCellDown(event: PointerEvent, row: number, col: number) {
  if (event.button !== 0) return

  selection.select(row, col, event.shiftKey)
  dragSelecting.value = 'cell'
  scroller.value?.focus()
}

function onCellEnter(row: number, col: number) {
  if (dragSelecting.value === 'cell') selection.select(row, col, true)
  else if (dragSelecting.value === 'row') selection.selectRow(row, { extend: true })
}

/**
 * The number gutter: picking a row picks all of it.
 *
 * Ctrl adds one row without disturbing the others, which is the whole point of
 * picking rows rather than dragging a box: the three rows worth deleting are
 * hardly ever next to each other.
 */
function onRowDown(event: PointerEvent, row: number) {
  if (event.button !== 0) return

  selection.selectRow(row, {
    extend: event.shiftKey,
    additive: event.ctrlKey || event.metaKey,
  })

  dragSelecting.value = 'row'
  scroller.value?.focus()
}

function onRowEnter(row: number) {
  if (dragSelecting.value === 'row') selection.selectRow(row, { extend: true })
}

/**
 * Right-clicking a row number picks the row, unless it is already among the
 * ones picked — the same rule the cells follow, so a set of rows gathered with
 * Ctrl survives being right-clicked to act on.
 */
function onRowContext(row: number) {
  if (!selection.containsRow(row) || !selection.isRowSelection.value) selection.selectRow(row)
}

function endDragSelect() {
  dragSelecting.value = null
}

onMounted(() => window.addEventListener('pointerup', endDragSelect))
onBeforeUnmount(() => window.removeEventListener('pointerup', endDragSelect))

/**
 * Scrolls the focused cell into view, by the smallest amount that gets it
 * there — an arrow key should move the viewport one row, not recentre it.
 *
 * The vertical half is the virtualizer's, since the row may not be rendered at
 * all yet. The horizontal half is arithmetic on the column offsets: the pinned
 * columns are sticky, so the browser counts as visible the strip they are
 * painted over and would park the selection underneath them.
 */
function revealFocus() {
  const at = selection.focus.value
  const box = scroller.value
  if (!at || !box) return

  virtualizer.value.scrollToIndex(at.row, { align: 'auto' })

  const column = columns.visible.value[at.col]
  if (!column || column.frozen) return

  const left = column.offset
  const right = column.offset + column.width

  if (left < box.scrollLeft + columns.frozenWidth.value) {
    box.scrollLeft = Math.max(0, left - columns.frozenWidth.value)
  }
  else if (right > box.scrollLeft + box.clientWidth) box.scrollLeft = right - box.clientWidth
}

/* --------------------------------------------------------------- output -- */

const { notice, flash, copy } = useClipboard()

function copySelection(withHeader = false) {
  const box = selection.block.value
  if (!box) return

  copy(selection.toTsv(box, withHeader), copyLabel.value)
}

/** What was copied, counted the way it was selected. */
const copyLabel = computed(() => {
  if (selection.isRowSelection.value) {
    const rows = selection.rowCount.value
    return `${rows} row${rows === 1 ? '' : 's'}`
  }

  return selection.size.value === 1 ? 'the cell' : `${selection.size.value} cells`
})

/**
 * Whether copying and exporting act on the selection rather than the whole
 * result: a single focused cell is not a selection anyone means to export.
 */
const hasBlock = computed(() => selection.isMultiple.value || selection.isRowSelection.value)

/** The block the format menus act on: the selection when there is one, else everything. */
function blockToSerialize() {
  return hasBlock.value ? selection.block.value! : selection.everything.value
}

/** The label the four "Copy as" rows show, said the way the block was chosen. */
function copyAsLabel(format: string) {
  return hasBlock.value ? `Copy as ${format}` : `Copy All as ${format}`
}

/**
 * Copies the block in a shape another tool can read. The rows are counted in
 * the notice, because the block is not always the selection and the user
 * should hear that a whole result went to the clipboard.
 */
function copyAs(format: 'insert' | 'markdown' | 'json' | 'csv') {
  const box = blockToSerialize()
  const count = box.rows.length
  const rows = `${count} row${count === 1 ? '' : 's'}`

  const dialect: SqlDialect = props.dialect ?? {
    table: quoteIdentifier(props.exportName ?? 'result', '"'),
    quote: '"',
    escapeBackslashes: false,
  }

  switch (format) {
    case 'insert':
      copy(toInsertStatements(selection.headersOf(box), selection.cellsOf(box), dialect), `${rows} as INSERT`)
      break
    case 'markdown':
      copy(toMarkdownTable(selection.headersOf(box), selection.cellsOf(box)), `${rows} as Markdown`)
      break
    case 'json':
      copy(selection.toJson(box), `${rows} as JSON`)
      break
    case 'csv':
      copy(selection.toCsv(box), `${rows} as CSV`)
      break
  }
}

/** Exports the selection when there is a real one, the whole result otherwise. */
async function exportAs(format: 'csv' | 'json') {
  const box = blockToSerialize()
  const content = format === 'csv' ? selection.toCsv(box) : selection.toJson(box)

  // Outside the desktop app there is no disk to write to; the clipboard is the
  // closest thing to an export a browser tab can offer.
  if (!isAvailable.value) {
    await copy(content, `${format.toUpperCase()} to the clipboard`)
    return
  }

  const saved = await bridge().saveFile({
    suggestedName: `${props.exportName ?? 'result'}.${format}`,
    content,
    filters: [{ name: format.toUpperCase(), extensions: [format] }],
  })

  if (saved.saved) flash(`Saved to ${saved.path}`)
}

/**
 * Opens the focused cell full size — for values a column cannot show, and for
 * the ones a single line has no business editing.
 */
async function inspect() {
  const cell = selection.activeCell.value
  if (!cell) return

  // A blob is fetched whole for the viewer, since the cell holds a digest.
  let bytes: string | undefined
  if (kindOf(cell.column) === 'binary' && props.loadBytes && cell.sourceRow >= 0 && focusedValue.value !== null) {
    try {
      bytes = (await props.loadBytes(rowValues(cell.sourceRow), cell.column.name)) ?? undefined
    }
    catch (cause) {
      flash(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const outcome = await openCellValue({
    column: cell.column.name,
    type: props.columnInfo?.[cell.column.name]?.declaredType ?? cell.column.type,
    value: focusedValue.value,
    editable: canEdit.value && kindOf(cell.column) !== 'binary',
    bytes,
  })

  if (outcome) props.edits?.set(cell.sourceRow, cell.column.name, outcome.value)
}

/* ------------------------------------------------- following a key -- */

/**
 * One row as a map of column name to value, staged edits included.
 *
 * Built only when a key is actually followed, and over every column rather
 * than the visible ones: half of a composite key may be a column the user has
 * put away, and the row it points at does not stop existing because of that.
 */
function rowValues(rowPosition: number): Record<string, CellValue> {
  const source = displayRows.value[rowPosition]
  const values: Record<string, CellValue> = {}
  if (source === undefined) return values

  props.result.columns.forEach((column, index) => {
    const pending = props.edits?.pendingValue(source, column.name)

    values[column.name] = pending !== undefined
      ? pending
      : props.result.rows[source]?.[index] ?? null
  })

  return values
}

/** Whether this cell names a row somewhere else, and so can be followed. */
function canFollow(rowPosition: number, column: GridColumn) {
  return Boolean(referenceOf(column)) && cellAt(rowPosition, column) !== null
}

function follow(rowPosition: number, column: GridColumn) {
  if (!canFollow(rowPosition, column)) return
  emit('navigate', { column: column.name, row: rowValues(rowPosition) })
}

/** Where following would land, spelled out — this opens a tab, so it says so. */
function followHint(rowPosition: number, column: GridColumn) {
  const target = referenceOf(column)
  if (!target) return ''

  const table = [target.schema, target.table].filter(Boolean).join('.')
  return `Open ${table} where ${target.column} = ${display(cellAt(rowPosition, column))}`
}

/** The key under the keyboard, for the footer bar and the cell menu. */
const activeReference = computed(() => {
  const at = selection.focus.value
  const column = at ? columns.visible.value[at.col] : undefined

  return at && column && canFollow(at.row, column) ? referenceOf(column) : undefined
})

function followFocused() {
  const at = selection.focus.value
  const column = at ? columns.visible.value[at.col] : undefined
  if (at && column) follow(at.row, column)
}

/* -------------------------------------------------------- quick filters -- */

/** One row of the "Filter rows" menu: what it says, and the WHERE it means. */
interface QuickFilter {
  icon: IconName
  label: string
  clause: string
}

/** The kinds a value can be compared against with < and >, and mean something. */
const ORDERED_KINDS = new Set<CellKind>(['number', 'date', 'time', 'datetime'])

/** A column name as the owner's WHERE must spell it. */
function filterName(column: GridColumn) {
  return quoteIdentifier(column.name, props.dialect?.quote ?? '"')
}

/**
 * A value short enough to sit in a menu row. Only the label is cut: the clause
 * that is emitted carries the whole value, or it would match the wrong rows.
 */
function shortValue(value: CellValue) {
  const text = typeof value === 'string' ? `'${display(value)}'` : display(value)
  return text.length > 24 ? `${text.slice(0, 23)}…` : text
}

/**
 * The filters the focused cell can be turned into.
 *
 * Equality and its negation for every value; the two bounds as well for the
 * kinds that have an order, since "everything since this date" is what a date
 * cell is usually right-clicked for. NULL gets its own spelling, because
 * `= null` is a comparison no engine answers yes to.
 */
const quickFilters = computed<QuickFilter[]>(() => {
  const at = selection.focus.value
  const column = at ? columns.visible.value[at.col] : undefined
  if (!props.filterable || !at || !column) return []

  // A new row is not in the table yet, so nothing in it can narrow a read of
  // the table.
  if (sourceRowAt(at.row) < 0) return []

  const name = filterName(column)
  const value = cellAt(at.row, column)

  if (value === null) {
    return [
      { icon: 'search', label: `Filter to ${column.name} is null`, clause: `${name} is null` },
      { icon: 'eyeOff', label: `Exclude ${column.name} is null`, clause: `${name} is not null` },
    ]
  }

  const literal = sqlLiteral(value, props.dialect?.escapeBackslashes ?? false)
  const shown = shortValue(value)

  const filters: QuickFilter[] = [
    { icon: 'search', label: `Filter to ${column.name} = ${shown}`, clause: `${name} = ${literal}` },
    { icon: 'eyeOff', label: `Exclude ${column.name} = ${shown}`, clause: `${name} <> ${literal}` },
  ]

  if (ORDERED_KINDS.has(kindOf(column))) {
    filters.push(
      { icon: 'search', label: `Filter ${column.name} ≥ ${shown}`, clause: `${name} >= ${literal}` },
      { icon: 'search', label: `Filter ${column.name} ≤ ${shown}`, clause: `${name} <= ${literal}` },
    )
  }

  return filters
})

/** The header's two filters, which need no cell: whether the column is set at all. */
function filterNull(column: GridColumn, isNull: boolean) {
  emit('filter', `${filterName(column)} is ${isNull ? 'null' : 'not null'}`)
}

/* -------------------------------------------------------------- editing -- */

const canEdit = computed(() => Boolean(props.edits))

/**
 * The cell being typed into and the text so far.
 *
 * The row and column travel with it rather than being read back from the
 * selection when the edit commits: clicking another cell both moves the
 * selection and blurs the editor, and a commit that asked the selection where
 * it was would write the draft into whichever cell the user had just clicked.
 */
const editing = ref<{
  row: number
  col: number
  sourceRow: number
  column: string
  type: string
  kind: CellKind
  nullable: boolean
  options: string[]
  original: CellValue
} | null>(null)

const draft = ref('')

function startEdit() {
  const cell = selection.activeCell.value
  const at = selection.focus.value
  if (!canEdit.value || !cell || !at) return

  const kind = kindOf(cell.column)
  const facts = props.columnInfo?.[cell.column.name]

  // What is on screen, staged edits included — not what the server sent.
  const current = cellAt(at.row, cell.column)

  // Binary is shown as a digest rather than as its bytes; there is nothing a
  // text box could do with it but corrupt it.
  if (kind === 'binary') {
    flash('A binary column cannot be edited here')
    return
  }

  // A checkbox is the whole interaction: there is no text to type.
  if (kind === 'boolean') {
    toggleBoolean(at.row, cell.column)
    return
  }

  // A document does not fit on one line, and pretending otherwise is how a
  // JSON column gets truncated by an accidental keystroke.
  if (needsFullEditor(kind, current)) {
    inspect()
    return
  }

  editing.value = {
    row: at.row,
    col: at.col,
    sourceRow: cell.sourceRow,
    column: cell.column.name,
    type: cell.column.type,
    kind,
    nullable: facts?.nullable ?? true,
    options: facts?.enumValues ?? [],
    original: current,
  }

  draft.value = toInputValue(kind, current)

  // The editor lives inside a `v-for`, where a template ref would collect into
  // an array; there is only ever one open, so it is found by its class. An enum
  // opens a `<select>` rather than an `<input>`, so the class alone is the
  // handle — matching on the tag would leave the dropdown unfocused.
  //
  // A row that was just scrolled to may not be in the DOM yet — the virtualizer
  // only renders it once the scroll has been applied — so a miss is retried on
  // the next frame rather than leaving an open editor nobody is typing into.
  nextTick(() => {
    const focusEditor = () => {
      const box = scroller.value?.querySelector<HTMLElement>('.cell-editor')
      if (!box) return false

      box.focus()
      // Only a text box has a selection to put the caret across; a dropdown is
      // already showing the value it is set to.
      if (box instanceof HTMLInputElement) box.select()
      return true
    }

    if (!focusEditor()) requestAnimationFrame(focusEditor)
  })
}

function cancelEdit() {
  editing.value = null
  scroller.value?.focus()
}

/** Engine type names that mean "a number", across all three drivers. */
const NUMERIC_TYPE = /^(small|big|tiny|medium)?(int|serial)|numeric|decimal|float|double|real|money/i
const BOOLEAN_TYPE = /^bool/i

/**
 * Reads the typed text back as the kind of value the column holds.
 *
 * A grid cell is a text box, and the database is not: without this, editing a
 * number would send the string "42" and leave the engine to decide what that
 * means. The value already in the cell is the best evidence of its kind; a new
 * row has none, so the column's declared type answers instead.
 */
function coerce(text: string, previous: CellValue, type: string): CellValue {
  const trimmed = text.trim()
  const numeric = typeof previous === 'number' || (previous === null && NUMERIC_TYPE.test(type))

  if (numeric && trimmed !== '' && Number.isFinite(Number(trimmed))) return Number(trimmed)

  if (typeof previous === 'boolean' || (previous === null && BOOLEAN_TYPE.test(type))) {
    const lowered = trimmed.toLowerCase()
    if (['true', 'false', '1', '0'].includes(lowered)) return lowered === 'true' || lowered === '1'
  }

  return text
}

/**
 * What the text in an editor means for the cell it was typed over.
 *
 * Shared by the cell editor and the record view's box, so a value typed in
 * either arrives in the staging layer as the same thing.
 */
function readDraft(text: string, kind: CellKind, original: CellValue, type: string): CellValue {
  // Opening a cell that was empty and closing it again is not a change: an
  // untouched editor must not turn a NULL into an empty string.
  if (text === '' && original === null) return null
  if (kind === 'number' || kind === 'text') return coerce(text, original, type)
  // A picker cleared back to nothing means NULL, not the empty string — no
  // engine here would accept `''` as a date anyway.
  if (text === '') return null
  return fromInputValue(kind, text)
}

function commitEdit(value?: CellValue) {
  const at = editing.value
  if (!at) return

  const next = value !== undefined ? value : readDraft(draft.value, at.kind, at.original, at.type)
  editing.value = null
  scroller.value?.focus()

  // The staging layer drops a value typed back to what it already was, so a
  // cell someone opened and closed again costs nothing.
  props.edits?.set(at.sourceRow, at.column, next)
}

function onEditKey(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    cancelEdit()
    return
  }

  if (event.key === 'Enter') {
    event.preventDefault()
    commitEdit()
    return
  }

  // The one gesture a text box cannot express: emptiness that means NULL
  // rather than an empty string.
  if ((event.ctrlKey || event.metaKey) && event.key === 'Backspace') {
    event.preventDefault()
    commitEdit(null)
    return
  }

  if (event.key === 'Tab') {
    event.preventDefault()
    commitEdit()
    selection.moveBy(0, event.shiftKey ? -1 : 1)
    revealFocus()
  }
}

/**
 * Flips a boolean cell where it stands.
 *
 * The value is written back in the shape the column already uses — `1` where
 * the column holds 1 and 0, `true` where it holds booleans — so a table does
 * not end up with both.
 */
function toggleBoolean(rowPosition: number, column: GridColumn) {
  const source = displayRows.value[rowPosition]
  if (!props.edits || source === undefined) return

  const current = cellAt(rowPosition, column)
  props.edits.set(source, column.name, fromBoolean(toBoolean(current) !== true, current))
}

/** The control a kind of value is typed into. */
function inputTypeFor(kind: CellKind) {
  if (kind === 'number') return 'number'
  if (kind === 'date') return 'date'
  if (kind === 'time') return 'time'
  if (kind === 'datetime') return 'datetime-local'

  return 'text'
}

/**
 * Adds a row and puts the cursor straight into it.
 *
 * The first column worth typing into is the first one the server will not fill
 * in by itself — landing on an auto-increment id would make every new row start
 * with a tab keypress.
 */
function addRow(seedRow?: number) {
  if (!props.edits) return

  const id = props.edits.addDraft(seedRow)

  nextTick(() => {
    const row = displayRows.value.indexOf(id)
    if (row === -1) return

    const first = columns.visible.value.findIndex((column) => placeholderFor(column) !== 'default')

    selection.select(row, first === -1 ? 0 : first)
    revealFocus()
    startEdit()
  })
}


/* --------------------------------------------------------- context menu -- */

/**
 * Right-clicking a cell that is outside the selection moves the selection onto
 * it.
 *
 * Without this the menu would act on cells elsewhere on screen: the user points
 * at one value, and the "Copy" they pick copies a different one. A click that
 * lands *inside* an existing selection leaves it alone, so a range the user
 * dragged out survives being right-clicked.
 */
function onCellContext(row: number, col: number) {
  if (!selection.contains(row, col)) selection.select(row, col)
}

/** Which header the right-click landed on; its menu acts on this column. */
const headerTarget = ref<GridColumn | null>(null)

/** Where that column sits among the visible ones, for the pin commands. */
const headerPosition = computed(() =>
  columns.visible.value.findIndex((column) => column.index === headerTarget.value?.index),
)

/** Sets the direction outright, where clicking a header only cycles it. */
function sortBy(index: number, dir: SortOrder['dir']) {
  const column = props.result.columns[index]?.name
  if (!column) return

  const next: SortOrder = { column, dir }

  if (remote.value) emit('update:sort', next)
  else localSort.value = next
}

/**
 * The rows the selection covers, as the staging layer names them.
 *
 * Read once, before anything acts on them: discarding a draft takes it out of
 * `displayRows`, and every position below it would shift under a loop that was
 * still walking display positions.
 */
const selectedSourceRows = computed(
  () => (selection.block.value?.rows ?? []).map(sourceRowAt).filter((row) => row !== -1),
)

/** How the row commands name what they are about to do. */
const rowsLabel = computed(() => {
  const count = selectedSourceRows.value.length
  return count === 1 ? 'Row' : `${count} Rows`
})

/** Whether the whole selection is already staged for deletion. */
const selectionDeleted = computed(
  () => selectedSourceRows.value.length > 0
    && selectedSourceRows.value.every((row) => props.edits?.isDeleted(row)),
)

/**
 * Marks every selected row for deletion — or takes every one of them back.
 *
 * One direction for the whole gesture, decided before it starts: toggling each
 * row on its own would flip a mixed selection into the other kind of mixed
 * selection, and leave the user no way to say what they meant.
 */
function toggleDeleteSelected() {
  if (!props.edits) return

  const deleting = !selectionDeleted.value

  for (const row of selectedSourceRows.value) {
    if (props.edits.isDeleted(row) !== deleting) props.edits.toggleDeleted(row)
  }
}

/** Copies every selected row into a new one, keys left for the server. */
function duplicateSelected() {
  if (!props.edits) return

  const rows = selectedSourceRows.value.filter((row) => row >= 0)
  if (!rows.length) return

  // One row is the common case and deserves the full gesture: the draft is
  // selected and opened for typing. A dozen would be a dozen editors.
  if (rows.length === 1) {
    addRow(rows[0])
    return
  }

  for (const row of rows) props.edits.addDraft(row)
}

/**
 * Writes NULL into every selected cell.
 *
 * The keyboard has had this as Ctrl+Backspace, but only inside an open editor —
 * which is the one place a NULL is hardest to express, and impossible to apply
 * to more than one cell at a time.
 */
function setSelectionNull() {
  const box = selection.block.value
  if (!box || !props.edits) return

  for (const row of box.rows) {
    const source = sourceRowAt(row)

    for (let col = box.left; col <= box.right; col++) {
      const column = columns.visible.value[col]
      if (column) props.edits.set(source, column.name, null)
    }
  }
}

/* ---------------------------------------------------------------- paste -- */

/**
 * The clipboard read back as a block of cells.
 *
 * Tab-separated lines are what Copy writes and what every spreadsheet writes,
 * so they are the one shape worth reading. An empty cell stays the empty
 * string: Copy spells NULL that way, but so does a genuinely empty text cell,
 * and guessing would turn one of them into the other. Only the literal word
 * `NULL` stages a null, which is the one thing a user can type to mean it.
 */
const parseClipboard = parseClipboardGrid

/**
 * Stages one pasted cell, read the way the inline editor would have read it
 * typed. Returns whether anything was staged, so the notice can count.
 */
function stagePasted(rowPosition: number, column: GridColumn, text: string | null) {
  const source = sourceRowAt(rowPosition)
  if (!props.edits || source === -1) return false

  // A key names the row the update is for; overwriting it would write the
  // change to some other row, or to none. A draft has no row yet, so its key
  // is the user's to fill in.
  if (source >= 0 && factsOf(column)?.primaryKey) return false

  const kind = kindOf(column)

  // Binary is shown as a digest, and there is nothing text can do to it but
  // corrupt it — the same refusal the editor makes.
  if (kind === 'binary') return false

  const current = cellAt(rowPosition, column)
  let value: CellValue

  if (text === null) value = null
  else if (kind === 'boolean') {
    // Written in the shape the column already uses, as the checkbox does, so a
    // paste of `true` into a tinyint column does not leave it holding a word.
    const flag = toBoolean(text)
    value = flag === null ? text : fromBoolean(flag, current)
  }
  else value = coerce(text, current, typeOf(column))

  props.edits.set(source, column.name, value)
  return true
}

/** Said when every cell the paste aimed at was one it may not write. */
const SKIPPED_ALL = 'Nothing pasted — key and binary cells are skipped'

/**
 * Ctrl+V: the clipboard as cells, anchored at the top-left of the selection.
 *
 * One clipboard cell over many selected ones fills all of them, which is the
 * spreadsheet gesture for "set these to the same thing". Anything larger is
 * laid out from the anchor, dropping whatever runs off the right edge and
 * adding draft rows for whatever runs off the bottom — a paste of twenty rows
 * into an empty table is how a table gets its first twenty rows.
 */
async function pasteSelection() {
  const edits = props.edits
  const box = selection.block.value
  if (!edits || !box || !box.rows.length) return

  let text = ''
  try {
    // Through the main process in the desktop app: the browser's own read
    // wants a focused document and a permission grant, and quietly returns
    // nothing when either is missing.
    text = isAvailable.value
      ? (await bridge().readClipboard()).text
      : await navigator.clipboard.readText()
  }
  catch {
    // A denied or unavailable clipboard reads the same as an empty one.
  }

  if (!text) {
    flash('Nothing to paste')
    return
  }

  const grid = parseClipboard(text)
  const cols = columns.visible.value
  let staged = 0

  if (grid.length === 1 && grid[0]!.length === 1) {
    const only = grid[0]![0]!

    for (const row of box.rows) {
      for (let col = box.left; col <= box.right; col++) {
        const column = cols[col]
        if (column && stagePasted(row, column, only)) staged++
      }
    }

    flash(staged ? `Pasted ${staged} cell${staged === 1 ? '' : 's'}` : SKIPPED_ALL)
    return
  }

  const top = box.rows[0]!
  const left = box.left
  let bottom = top
  let right = left

  grid.forEach((line, r) => {
    const row = top + r

    // Past the last row, each further line becomes a new row. The draft is
    // added through the staging layer rather than `addRow`, which would also
    // open an editor in it — a dozen editors is not what a paste means.
    if (row >= displayRows.value.length) edits.addDraft()
    if (row >= displayRows.value.length) return

    line.forEach((cell, c) => {
      const col = left + c
      const column = cols[col]
      if (!column) return

      if (stagePasted(row, column, cell)) staged++
      bottom = Math.max(bottom, row)
      right = Math.max(right, col)
    })
  })

  if (!staged) {
    flash(SKIPPED_ALL)
    return
  }

  // The pasted range is left selected, so a wrong paste is one Ctrl+Backspace
  // or Ctrl+Z from gone — and so the user can see what landed where.
  selection.select(top, left)
  selection.select(bottom, right, true)
  revealFocus()

  flash(`Pasted ${staged} cell${staged === 1 ? '' : 's'}`)
}

/* ------------------------------------------------------------- keyboard -- */

function onKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null

  // The filter box and the header's own buttons keep their keys.
  if (target?.tagName === 'INPUT' || target?.tagName === 'BUTTON') return

  const rowCount = displayRows.value.length
  const colCount = columns.visible.value.length
  const page = Math.max(1, Math.floor((scroller.value?.clientHeight ?? 400) / ROW_HEIGHT) - 1)
  const ctrl = event.ctrlKey || event.metaKey

  if (ctrl && (event.key === 'c' || event.key === 'C')) {
    // Text dragged out with the mouse is a selection the user made deliberately
    // and expects to get back; only an empty one means "copy the cells".
    if (window.getSelection()?.toString()) return

    event.preventDefault()
    copySelection(event.shiftKey)
    return
  }

  // Only where the grid can write, and never over an open editor: its input
  // stops the key before it gets here, and would paste as text on its own.
  if (ctrl && (event.key === 'v' || event.key === 'V')) {
    if (!canEdit.value || editing.value) return
    event.preventDefault()
    pasteSelection()
    return
  }

  if (ctrl && (event.key === 's' || event.key === 'S')) {
    event.preventDefault()
    if (props.edits?.dirty.value) emit('save')
    return
  }

  // Alt+Insert is the gesture every desktop grid uses for "new row"; Ctrl+D
  // duplicates, which is how most new rows actually start life.
  if (event.altKey && event.key === 'Insert') {
    if (!props.edits) return
    event.preventDefault()
    addRow()
    return
  }

  if (ctrl && (event.key === 'd' || event.key === 'D')) {
    if (!props.edits) return
    event.preventDefault()
    duplicateSelected()
    return
  }

  if (ctrl && (event.key === 'z' || event.key === 'Z')) {
    if (!props.edits) return
    event.preventDefault()
    props.edits.undo()
    return
  }

  // Ctrl rather than Delete alone: a stray keypress in a grid should not mark a
  // row for deletion, even a deletion that still has to be saved.
  if (ctrl && (event.key === 'Delete' || event.key === 'Backspace')) {
    if (!props.edits || !selection.block.value) return
    event.preventDefault()
    toggleDeleteSelected()
    return
  }

  if (ctrl && (event.key === 'a' || event.key === 'A')) {
    event.preventDefault()
    // Shift makes it a selection of rows, which is what the row commands act on.
    if (event.shiftKey) selection.selectAllRows()
    else selection.selectAll()
    return
  }

  if (ctrl && (event.key === 'f' || event.key === 'F')) {
    event.preventDefault()
    filterBox.value?.focus()
    filterBox.value?.select()
    return
  }

  if (event.key === 'F4') {
    event.preventDefault()
    recordOpen.value = !recordOpen.value
    return
  }

  if (event.key === 'Escape') {
    event.preventDefault()
    selection.clear()
    return
  }

  if (event.key === 'Enter' || event.key === 'F2') {
    if (!selection.focus.value) return
    event.preventDefault()

    // Enter is the edit key in every grid that has one; without editing, it is
    // the only key that opens a value too long for its column.
    if (canEdit.value && !event.shiftKey) startEdit()
    else inspect()
  }

  const moves: Record<string, [number, number]> = {
    ArrowDown: [1, 0],
    ArrowUp: [-1, 0],
    ArrowRight: [0, 1],
    ArrowLeft: [0, -1],
    PageDown: [page, 0],
    PageUp: [-page, 0],
    Home: [ctrl ? -rowCount : 0, -colCount],
    End: [ctrl ? rowCount : 0, colCount],
  }

  const move = moves[event.key]
  if (!move) return

  // Arrow keys scroll the box otherwise, and the selection would run away from
  // the viewport in one direction while the viewport ran in the other.
  event.preventDefault()
  selection.moveBy(move[0], move[1], event.shiftKey)
  revealFocus()
}

/* ---------------------------------------------------------- virtualizer -- */

/**
 * Only the rows near the viewport are in the DOM.
 *
 * A result can be tens of thousands of rows of twenty columns, and a table that
 * renders all of it spends seconds in layout before the first pixel. Rows are a
 * fixed height, so their positions are arithmetic rather than measurement, and
 * the padding rows above and below keep the table's own geometry — and its
 * scrollbar — honest.
 */
const virtualizer = useVirtualizer(computed(() => ({
  count: displayRows.value.length,
  getScrollElement: () => scroller.value,
  estimateSize: () => ROW_HEIGHT,
  overscan: 14,
})))

const virtualRows = computed(() => virtualizer.value.getVirtualItems())
const paddingTop = computed(() => virtualRows.value[0]?.start ?? 0)
const paddingBottom = computed(
  () => Math.max(0, virtualizer.value.getTotalSize() - (virtualRows.value.at(-1)?.end ?? 0)),
)

/* ------------------------------------------------------------ rendering -- */

/**
 * The cell at a display position, which every row of the body asks for.
 *
 * A staged edit wins over what the server sent: the grid shows what the table
 * will hold once the changes are saved, which is the only way a batch of edits
 * can be reviewed before it is written.
 */
function cellAt(rowPosition: number, column: GridColumn): CellValue {
  const source = displayRows.value[rowPosition]
  if (source === undefined) return null

  const pending = props.edits?.pendingValue(source, column.name)
  if (pending !== undefined) return pending

  return props.result.rows[source]?.[column.index] ?? null
}

/**
 * What an untouched cell of a new row is going to be.
 *
 * Three different kinds of empty, and a grid that drew them all as NULL would
 * be lying about two of them: the server's own value, an explicit NULL, and a
 * value that has to be supplied before the row can exist at all.
 */
/**
 * What kind of value a column holds, cached per column.
 *
 * Every rendered cell asks, and the answer only changes when the result does —
 * so it is worked out once per column rather than tens of thousands of times
 * per scroll.
 */
const kinds = computed(() => {
  const map = new Map<number, CellKind>()

  props.result.columns.forEach((column, index) => {
    map.set(index, classifyCell(column.type, props.columnInfo?.[column.name]))
  })

  return map
})

function kindOf(column: GridColumn): CellKind {
  return kinds.value.get(column.index) ?? 'text'
}

function placeholderFor(column: GridColumn): 'default' | 'null' | 'required' {
  const info = props.columnInfo?.[column.name]
  if (!info) return 'null'
  if (info.hasDefault) return 'default'

  return info.nullable ? 'null' : 'required'
}

function isMissing(rowPosition: number, column: GridColumn) {
  const source = displayRows.value[rowPosition]

  return source !== undefined
    && source < 0
    && placeholderFor(column) === 'required'
    && props.edits?.pendingValue(source, column.name) === undefined
}

/** The source row behind a display position, for the staging layer. */
function sourceRowAt(rowPosition: number) {
  return displayRows.value[rowPosition] ?? -1
}

function classOf(value: CellValue) {
  if (value === null || value === undefined) return 'text-type-null'
  if (typeof value === 'number') return 'text-type-number text-right tabular-nums'
  if (typeof value === 'boolean') return 'text-type-bool'
  return 'text-type-string'
}

function display(value: CellValue) {
  if (typeof value === 'boolean') return value ? 'true' : 'false'

  // A newline inside a cell would otherwise be swallowed silently, making a
  // multi-line value look like it simply ends early.
  return String(value).replace(/\n/g, '⏎ ')
}

/** What the focused cell holds, staged edit included. */
const focusedValue = computed(() => {
  const at = selection.focus.value
  const column = at ? columns.visible.value[at.col] : undefined

  return at && column ? cellAt(at.row, column) : null
})

/* ----------------------------------------------------------- statistics -- */

/**
 * The most cells the footer will add up. A selection is a rectangle the user
 * dragged out, and Ctrl+A over a wide result is millions of cells: walking
 * them on every keystroke is what would make the grid feel slow, so past this
 * the footer counts and stops.
 */
const STATS_CAP = 200_000

interface SelectionStats {
  /** Cells that hold a value; NULL is not one. */
  count: number
  /** Over the numeric columns only, and absent when none is selected. */
  sum?: number
  avg?: number
  min?: number
  max?: number
  /** Whether the selection was too large to be added up. */
  capped: boolean
}

/**
 * What the selection adds up to, for the footer.
 *
 * Computed only for a real selection — one cell has nothing to sum — and read
 * from the block lazily, so a grid nobody is selecting in pays nothing. Which
 * columns count as numbers is the column's kind rather than the value's type:
 * Postgres sends a `numeric` as a string, and a total that ignored it would be
 * quietly wrong.
 */
const stats = computed<SelectionStats | null>(() => {
  const box = selection.block.value
  if (!box || !hasBlock.value) return null

  if (selection.size.value > STATS_CAP) return { count: selection.size.value, capped: true }

  const numeric = columns.visible.value
    .slice(box.left, box.right + 1)
    .map((column) => kindOf(column) === 'number')

  let count = 0
  let values = 0
  let sum = 0
  let min = Infinity
  let max = -Infinity

  for (const line of selection.cellsOf(box)) {
    line.forEach((value, index) => {
      if (value === null || value === undefined) return
      count++

      if (!numeric[index]) return
      const number = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(number)) return

      values++
      sum += number
      if (number < min) min = number
      if (number > max) max = number
    })
  }

  if (!values) return { count, capped: false }
  return { count, sum, avg: sum / values, min, max, capped: false }
})

/** The footer's line, each figure rounded the way a status bar can afford. */
const statsParts = computed(() => {
  const it = stats.value
  if (!it) return []

  const parts = [`count ${it.count.toLocaleString()}`]
  if (it.sum === undefined) return parts

  return [
    ...parts,
    `sum ${it.sum.toLocaleString()}`,
    `avg ${it.avg!.toLocaleString(undefined, { maximumFractionDigits: 4 })}`,
    `min ${it.min!.toLocaleString()}`,
    `max ${it.max!.toLocaleString()}`,
  ]
})

/** The same figures unrounded, for the tooltip and the clipboard. */
const statsText = computed(() => {
  const it = stats.value
  if (!it) return ''

  if (it.capped) {
    return `${it.count} cells selected — more than ${STATS_CAP.toLocaleString()}, so they were not added up`
  }

  const lines = [`count ${it.count}`]
  if (it.sum !== undefined) lines.push(`sum ${it.sum}`, `avg ${it.avg}`, `min ${it.min}`, `max ${it.max}`)

  return lines.join('\n')
})

const summary = computed(() => {
  const shown = displayRows.value.length
  const total = props.result.rows.length

  if (filter.value.trim() && shown !== total) return `${shown} of ${total} rows`
  return `${total} row${total === 1 ? '' : 's'}`
})

/* ---------------------------------------------------------- record view -- */

/**
 * Whether the focused row is also shown stood on end, beside the grid, and
 * how wide that panel is. Remembered per table under its own key: it is a
 * separate habit from the column layout, and a query tab — which has no key —
 * starts closed, as its columns are whatever the last statement returned.
 */
const RECORD_PREFIX = 'dbison.record-view.v1:'
const RECORD_WIDTH = 352

const recordOpen = ref(false)
const recordWidth = ref(RECORD_WIDTH)

/** The row the panel shows: the focused one, addressed both ways it is needed. */
const recordRow = computed(() => {
  const at = selection.focus.value
  if (!at || at.row >= displayRows.value.length) return null

  return { position: at.row, source: sourceRowAt(at.row) }
})

watch(() => props.storageKey, (key) => {
  recordOpen.value = false
  recordWidth.value = RECORD_WIDTH
  if (!key || !import.meta.client) return

  try {
    const raw = localStorage.getItem(RECORD_PREFIX + key)
    const saved = raw ? (JSON.parse(raw) as { open?: boolean, width?: number }) : null
    recordOpen.value = Boolean(saved?.open)
    if (typeof saved?.width === 'number') recordWidth.value = saved.width
  }
  catch {
    // A setting from an older build is not worth recovering.
  }
}, { immediate: true })

// Written back once the user stops, not on every pixel of a drag.
let recordTimer: ReturnType<typeof setTimeout> | undefined
watch([recordOpen, recordWidth], () => {
  const key = props.storageKey
  if (!key || !import.meta.client) return

  clearTimeout(recordTimer)
  recordTimer = setTimeout(() => {
    try {
      localStorage.setItem(RECORD_PREFIX + key, JSON.stringify({ open: recordOpen.value, width: recordWidth.value }))
    }
    catch {
      // Out of quota, or a private window: a remembered panel is not worth an
      // error the user has to dismiss.
    }
  }, 400)
})

onBeforeUnmount(() => clearTimeout(recordTimer))

/** Esc in the panel: it goes, and the keyboard comes back to the rows. */
function closeRecordView() {
  recordOpen.value = false
  scroller.value?.focus()
}

/** Up/Down and the arrows in the panel move the grid's focus; the panel follows. */
function stepRecord(delta: number) {
  if (selection.focus.value) selection.moveBy(delta, 0)
  else selection.select(0, 0)
  revealFocus()
}

/** Which column of the shown row, as the selection addresses it. */
function positionOf(column: GridColumn) {
  return columns.visible.value.findIndex((candidate) => candidate.index === column.index)
}

/**
 * The panel's way into the full-value dialog. The focus is moved onto the cell
 * first, so `inspect` opens the value the user clicked and any edit it stages
 * lands there — and so the grid shows which cell the dialog is about.
 */
function inspectFromRecord(column: GridColumn) {
  const row = recordRow.value
  const col = positionOf(column)
  if (!row || col === -1) return

  selection.select(row.position, col)
  revealFocus()
  inspect()
}

/** Stages what the panel's box holds, read exactly as the cell editor reads it. */
function stageFromRecord(column: GridColumn, text: string | null) {
  const row = recordRow.value
  if (!row || !props.edits) return

  const current = cellAt(row.position, column)
  const next = text === null ? null : readDraft(text, kindOf(column), current, column.type)
  props.edits.set(row.source, column.name, next)
}

function toggleFromRecord(column: GridColumn) {
  if (recordRow.value) toggleBoolean(recordRow.value.position, column)
}
</script>

<template>
  <div class="result-grid @container flex h-full min-h-0 flex-col bg-bg">
    <!-- The grid's own strip: what is on screen, and the controls that decide
         it. The panel's toolbar above speaks for the statement, not the rows. -->
    <div class="flex shrink-0 items-center gap-2 border-b border-edge bg-surface/40 px-2 py-1">
      <label class="relative flex min-w-28 shrink items-center">
        <AppIcon name="search" :size="12" class="pointer-events-none absolute left-2 text-faint" />
        <input
          ref="filterBox"
          v-model="filter"
          type="search"
          placeholder="Filter rows (Ctrl+F)"
          aria-label="Filter the loaded rows"
          class="field w-56 min-w-0 bg-bg py-0.5 pr-2 pl-7"
          @keydown.escape="filter = ''"
        >
      </label>

      <!-- Only when the box above narrowed the rows: the owner's toolbar
           already says how many there are, and saying it twice says less. -->
      <span v-if="filter.trim()" class="shrink-0 text-faint tabular-nums">{{ summary }}</span>

      <!-- Counted the way it was picked: rows when rows were picked, cells
           when a corner of them was dragged out. -->
      <span
        v-if="selection.isRowSelection.value"
        class="chip shrink-0 gap-1 text-accent-bright"
        title="Right-click for what can be done with them"
      >
        {{ selection.rowCount.value }} row{{ selection.rowCount.value === 1 ? '' : 's' }} selected
      </span>

      <span v-else-if="selection.size.value > 1" class="chip shrink-0">{{ selection.size.value }} cells</span>

      <!-- Whether these rows can be written to at all, where the eye already
           is. A grid that quietly refuses every edit is the one thing worse
           than one that cannot edit. -->
      <span
        v-if="!canEdit && readOnlyReason"
        class="chip shrink-0 gap-1 text-faint"
        :title="readOnlyReason"
      >
        <AppIcon name="lock" :size="10" />
        Read-only
      </span>

      <span v-if="notice" class="min-w-0 truncate text-accent-bright">{{ notice }}</span>

      <div class="ml-auto flex shrink-0 items-center gap-1">
        <button
          v-if="edits"
          type="button"
          class="btn btn-ghost"
          title="Add a row (Alt+Insert) — Ctrl+D copies the row you are on"
          @click="addRow()"
        >
          <AppIcon name="plus" :size="12" />
          <span class="hidden @lg:inline">New row</span>
        </button>

        <button
          type="button"
          class="btn btn-ghost"
          :disabled="!selection.block.value"
          title="Copy what is selected (Ctrl+C) — Ctrl+Shift+C adds a header row"
          @click="copySelection(false)"
        >
          <AppIcon name="copy" :size="12" />
          <span class="hidden @lg:inline">Copy</span>
        </button>

        <!-- One menu for every way the rows can leave: the two file formats
             and the four clipboard shapes that used to live only in the
             right-click menu, where nobody finds them. -->
        <DropdownMenu>
          <DropdownMenuTrigger>
            <button
              type="button"
              class="btn btn-ghost"
              :title="hasBlock ? 'Export or copy the selection' : 'Export or copy every loaded row'"
            >
              <AppIcon name="save" :size="12" />
              <span class="hidden @lg:inline">Export</span>
              <AppIcon name="chevronDown" :size="10" class="text-faint" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLabel>{{ hasBlock ? 'The selection' : 'Every loaded row' }}</DropdownMenuLabel>
            <DropdownMenuItem icon="save" @select="exportAs('csv')">
              Save as CSV…
            </DropdownMenuItem>
            <DropdownMenuItem icon="save" @select="exportAs('json')">
              Save as JSON…
            </DropdownMenuItem>
            <template v-if="exportAll">
              <DropdownMenuSeparator />
              <DropdownMenuItem
                icon="fileDown"
                title="Runs the statement again on the server and writes every row it returns"
                @select="exportAll()"
              >
                Export all rows to file…
              </DropdownMenuItem>
            </template>
            <DropdownMenuSeparator />
            <DropdownMenuItem icon="copy" :disabled="!result.rows.length" @select="copyAs('insert')">
              Copy as INSERT
            </DropdownMenuItem>
            <DropdownMenuItem icon="copy" :disabled="!result.rows.length" @select="copyAs('markdown')">
              Copy as Markdown
            </DropdownMenuItem>
            <DropdownMenuItem icon="copy" :disabled="!result.rows.length" @select="copyAs('json')">
              Copy as JSON
            </DropdownMenuItem>
            <DropdownMenuItem icon="copy" :disabled="!result.rows.length" @select="copyAs('csv')">
              Copy as CSV
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <GridColumnsMenu :columns="columns" />

        <button
          type="button"
          class="btn btn-ghost"
          :data-active="recordOpen"
          title="Record view (F4)"
          @click="recordOpen = !recordOpen"
        >
          <AppIcon name="panelRight" :size="12" />
          <span class="hidden @lg:inline">Record</span>
        </button>
      </div>
    </div>

    <!-- The rows and, beside them, the one row stood on end. The panel sits
         outside the scroller, so the virtualizer's window is the same width
         whether it is open or not. -->
    <div class="flex min-h-0 flex-1">
    <div
      ref="scroller"
      tabindex="0"
      class="selectable min-h-0 min-w-0 flex-1 overflow-auto focus:outline-none"
      :class="resizing !== null ? 'cursor-col-resize select-none' : ''"
      @keydown="onKeydown"
    >
      <table
        class="table-fixed border-separate border-spacing-0 font-mono text-[12px]"
        :style="{ width: `${columns.tableWidth.value}px`, minWidth: '100%' }"
      >
        <!-- Fixed layout: a column is exactly as wide as it is told, so dragging
             one divider does not re-flow every other column, and the browser
             never has to measure thousands of cells to lay the table out. -->
        <colgroup>
          <col :style="{ width: `${columns.rowNumberWidth.value}px` }">
          <col
            v-for="column in columns.visible.value"
            :key="column.index"
            :style="{ width: `${column.width}px` }"
          >
          <!-- Soaks up the space left when the result is narrower than the
               panel. Without it the table would stretch to fill, and every
               column the user had sized would silently grow with it. -->
          <col>
        </colgroup>

        <ContextMenu>
          <ContextMenuTrigger>
          <thead class="sticky top-0 z-20">
            <tr>
              <th
                class="sticky left-0 z-30 cursor-pointer border-r border-b border-edge bg-surface px-2 py-1.5 text-right font-normal text-faint transition-colors hover:bg-raised hover:text-content"
                title="Select every row"
                @click="selection.selectAllRows()"
              >
                #
              </th>
              <th
                v-for="(column, position) in columns.visible.value"
                :key="column.index"
                :aria-sort="sortedCol === column.index ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none'"
                class="group relative border-r border-b border-edge p-0 text-left font-medium whitespace-nowrap transition-colors"
                :class="[
                  hoverCol === position || sortedCol === column.index ? 'bg-raised' : 'bg-surface',
                  column.frozen ? 'sticky z-30' : '',
                  dropTarget === position ? 'is-drop-target' : '',
                  dragging === position ? 'opacity-40' : '',
                ]"
                :style="column.frozen ? { left: `${column.offset}px` } : undefined"
                @dragover.prevent="dropTarget = position"
                @dragleave="dropTarget = dropTarget === position ? null : dropTarget"
                @drop.prevent="onDrop(position)"
                @contextmenu="headerTarget = column"
              >
                <!-- Marks, then the name, then the sort slot the header always
                     reserves on the right. Nothing here grows or shrinks with
                     the pointer: a header that reflowed on hover would move the
                     very name the user is reading. -->
                <button
                  type="button"
                  draggable="true"
                  class="flex w-full items-center gap-1.5 overflow-hidden py-1.5 pr-5 pl-2 text-left transition-colors hover:bg-accent-soft focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-accent-bright"
                  :title="headerTitle(column)"
                  @click="toggleSort(column.index)"
                  @dragstart="onDragStart($event, position)"
                  @dragend="dragging = null; dropTarget = null"
                >
                  <AppIcon v-if="column.frozen" name="pin" :size="11" class="shrink-0 text-faint" />

                  <AppIcon
                    v-for="glyph in headerGlyphs(column)"
                    :key="glyph.icon"
                    :name="glyph.icon"
                    :size="11"
                    class="shrink-0"
                    :class="glyph.tone"
                  />

                  <span
                    class="truncate"
                    :class="sortedCol === column.index ? 'text-accent-bright' : 'text-content'"
                  >{{ column.name }}</span>
                </button>

                <!-- In the slot the button's padding keeps clear, so it never
                     covers a name. The hint is only drawn under the pointer: a
                     wide result should not be a row of arrows competing with
                     the names it is there to show. -->
                <AppIcon
                  v-if="sortedCol === column.index"
                  :name="sort!.dir === 'asc' ? 'sortAsc' : 'sortDesc'"
                  :size="12"
                  class="sort-mark text-accent-bright"
                />
                <AppIcon
                  v-else
                  name="sortable"
                  :size="12"
                  class="sort-mark text-faint transition-opacity"
                  :class="hoverCol === position ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'"
                />

                <!-- Sits on the seam between two columns, half in each, so the
                     grab area is symmetrical about the line the eye is aiming at. -->
                <span
                  class="resize-handle"
                  :class="resizing === column.index ? 'is-active' : ''"
                  title="Drag to resize · double-click to fit the contents"
                  @pointerdown.stop.prevent="startResize($event, column.index)"
                  @dblclick.stop.prevent="columns.autoFit(column.index)"
                  @click.stop
                />
              </th>
              <th class="border-b border-edge bg-surface" />
            </tr>
          </thead>
          </ContextMenuTrigger>

          <ContextMenuContent v-if="headerTarget">
            <ContextMenuLabel>{{ headerTarget.name }}</ContextMenuLabel>

            <ContextMenuItem icon="sortAsc" @select="sortBy(headerTarget!.index, 'asc')">
              Sort Ascending
            </ContextMenuItem>

            <ContextMenuItem icon="sortDesc" @select="sortBy(headerTarget!.index, 'desc')">
              Sort Descending
            </ContextMenuItem>

            <ContextMenuItem
              v-if="sortedCol === headerTarget.index"
              icon="close"
              @select="remote ? emit('update:sort', null) : (localSort = null)"
            >
              Clear Sort
            </ContextMenuItem>

            <!-- The one filter a header can offer without a cell to read it
                 off: whether the column is set at all. -->
            <template v-if="filterable">
              <ContextMenuSeparator />

              <ContextMenuItem icon="search" @select="filterNull(headerTarget!, true)">
                Filter Where {{ headerTarget.name }} Is Null
              </ContextMenuItem>

              <ContextMenuItem icon="search" @select="filterNull(headerTarget!, false)">
                Filter Where {{ headerTarget.name }} Is Not Null
              </ContextMenuItem>
            </template>

            <ContextMenuSeparator />

            <ContextMenuItem icon="pin" @select="columns.freezeThrough(headerPosition)">
              {{ columns.frozen.value === headerPosition + 1
                ? 'Unpin Here'
                : `Pin Through This Column` }}
            </ContextMenuItem>

            <ContextMenuItem icon="eyeOff" @select="columns.toggleHidden(headerTarget!.index)">
              Hide Column
            </ContextMenuItem>

            <ContextMenuItem
              v-if="columns.hidden.value.length"
              icon="view"
              @select="columns.showAll()"
            >
              Show All Columns ({{ columns.hidden.value.length }} hidden)
            </ContextMenuItem>

            <ContextMenuSeparator />

            <ContextMenuItem icon="copy" @select="copy(headerTarget!.name, 'the column name')">
              Copy Column Name
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>

        <ContextMenu>
          <ContextMenuTrigger>
          <tbody @pointerover="onCellOver" @pointerleave="hoverCol = null">
            <!-- The rows above and below the window, as height rather than DOM. -->
            <tr v-if="paddingTop">
              <td :colspan="columns.visible.value.length + 2" class="p-0" :style="{ height: `${paddingTop}px` }" />
            </tr>

            <tr
              v-for="item in virtualRows"
              :key="item.index"
              :class="[
                item.index % 2 ? 'is-odd' : '',
                edits?.isDeleted(sourceRowAt(item.index)) ? 'is-deleted' : '',
                sourceRowAt(item.index) < 0 ? 'is-draft' : '',
              ]"
            >
              <!-- The gutter is the handle for the row itself: click to pick it,
                   drag for a run, Ctrl for one more, Shift for everything
                   between. What gets deleted or duplicated is a row, so there
                   has to be a way to say "that one" without dragging across
                   every column the table happens to have. -->
              <td
                class="sticky left-0 z-10 cursor-pointer border-r border-b border-edge bg-surface px-2 text-right text-faint tabular-nums select-none"
                :class="selection.containsRow(item.index) && selection.isRowSelection.value ? 'is-row-picked' : ''"
                title="Click to select this row · Ctrl for another · Shift for a run"
                @pointerdown="onRowDown($event, item.index)"
                @pointerenter="onRowEnter(item.index)"
                @contextmenu="onRowContext(item.index)"
              >
                <!-- A new row has no number: it has no place in the table yet. -->
                <template v-if="sourceRowAt(item.index) < 0">+</template>
                <template v-else>{{ (rowOffset ?? 0) + item.index + 1 }}</template>
              </td>
              <td
                v-for="(column, position) in columns.visible.value"
                :key="column.index"
                :data-col="position"
                class="truncate border-r border-b border-edge px-2 whitespace-nowrap"
                :class="[
                  classOf(cellAt(item.index, column)),
                  selection.contains(item.index, position) ? 'is-selected' : '',
                  selection.focus.value?.row === item.index && selection.focus.value?.col === position ? 'is-focused' : '',
                  edits?.isDirty(sourceRowAt(item.index), column.name) ? 'is-dirty' : '',
                  isMissing(item.index, column) ? 'is-missing' : '',
                  column.frozen ? 'sticky z-10' : '',
                  canFollow(item.index, column) ? 'is-fk' : '',
                  // A pinned cell is already a containing block; an ordinary one
                  // has to be made into one before the jump button can sit in it.
                  canFollow(item.index, column) && !column.frozen ? 'relative' : '',
                ]"
                :style="column.frozen ? { left: `${column.offset}px` } : undefined"
                @pointerdown="onCellDown($event, item.index, position)"
                @pointerenter="onCellEnter(item.index, position)"
                @contextmenu="onCellContext(item.index, position)"
                @dblclick="canEdit ? startEdit() : inspect()"
              >
                <template v-if="editing?.row === item.index && editing?.col === position">
                  <!-- One of the engine's own values, rather than a name the user
                       has to remember and spell. -->
                  <select
                    v-if="editing.kind === 'enum'"
                    v-model="draft"
                    class="cell-editor w-full bg-raised font-mono text-content focus:outline-none"
                    @keydown.stop="onEditKey"
                    @change="commitEdit()"
                    @blur="commitEdit()"
                    @pointerdown.stop
                  >
                    <option v-if="editing.nullable" value="">(NULL)</option>
                    <option v-for="option in editing.options" :key="option" :value="option">{{ option }}</option>
                  </select>

                  <input
                    v-else
                    v-model="draft"
                    :type="inputTypeFor(editing.kind)"
                    spellcheck="false"
                    class="cell-editor w-full bg-transparent font-mono text-content focus:outline-none"
                    title="Enter commits · Esc cancels · Ctrl+Backspace writes NULL"
                    @keydown.stop="onEditKey"
                    @blur="commitEdit()"
                    @pointerdown.stop
                  >
                </template>

                <!-- A boolean is a state, not a word: a box that is ticked or
                     not, and — where the grid can write — one that can be
                     clicked straight through. -->
                <template
                  v-else-if="kindOf(column) === 'boolean'
                    && (cellAt(item.index, column) !== null || (canEdit && sourceRowAt(item.index) >= 0))"
                >
                  <!-- A box drawn from the value, not an <input type=checkbox>.
                       A native checkbox keeps its own checked state, which the
                       browser flips on click and reverts when the default is
                       prevented — so what is on screen can end up disagreeing
                       with what is staged. Nothing here has state of its own. -->
                  <component
                    :is="canEdit ? 'button' : 'span'"
                    :type="canEdit ? 'button' : undefined"
                    class="cell-bool"
                    :class="{
                      'is-on': toBoolean(cellAt(item.index, column)) === true,
                      'is-null': cellAt(item.index, column) === null,
                      'is-readonly': !canEdit,
                    }"
                    role="checkbox"
                    :aria-checked="cellAt(item.index, column) === null
                      ? 'mixed'
                      : toBoolean(cellAt(item.index, column)) === true"
                    :title="!canEdit
                      ? `${cellAt(item.index, column)} — ${readOnlyReason ?? 'this result cannot be edited'}`
                      : (cellAt(item.index, column) === null ? 'NULL — click to set it' : 'Click to change it')"
                    @click="canEdit ? toggleBoolean(item.index, column) : undefined"
                  >
                    <AppIcon
                      v-if="toBoolean(cellAt(item.index, column)) === true"
                      name="check"
                      :size="12"
                      :stroke-width="3"
                    />
                  </component>
                </template>

                <!-- An untouched cell of a new row: what the server would put
                     there, rather than a NULL nobody asked for. -->
                <template v-else-if="sourceRowAt(item.index) < 0 && edits?.pendingValue(sourceRowAt(item.index), column.name) === undefined">
                  <span
                    class="placeholder-pill"
                    :class="`is-${placeholderFor(column)}`"
                    :title="{
                      default: 'The server fills this in',
                      null: 'Left empty, stored as NULL',
                      required: 'This column needs a value before the row can be saved',
                    }[placeholderFor(column)]"
                  >{{ { default: 'DEFAULT', null: 'NULL', required: 'REQUIRED' }[placeholderFor(column)] }}</span>
                </template>

                <template v-else>
                  <span v-if="cellAt(item.index, column) === null" class="null-pill">NULL</span>
                  <template v-else>{{ display(cellAt(item.index, column)) }}</template>
                </template>

                <!-- A key is worth nothing if seeing the row it names means
                     copying the value and going looking for the table. The mark
                     is drawn only under the pointer and on the cell the keyboard
                     is on, so a table of keys is not a table of buttons. -->
                <button
                  v-if="canFollow(item.index, column)"
                  type="button"
                  class="fk-jump"
                  :title="followHint(item.index, column)"
                  @pointerdown.stop
                  @dblclick.stop
                  @click.stop="follow(item.index, column)"
                >
                  <AppIcon name="jump" :size="13" />
                </button>
              </td>
              <td class="border-b border-edge" />
            </tr>

            <tr v-if="paddingBottom">
              <td :colspan="columns.visible.value.length + 2" class="p-0" :style="{ height: `${paddingBottom}px` }" />
            </tr>
          </tbody>
          </ContextMenuTrigger>

          <ContextMenuContent>
            <ContextMenuLabel>
              {{ selection.isRowSelection.value
                ? `${selection.rowCount.value} row${selection.rowCount.value === 1 ? '' : 's'}`
                : selection.size.value > 1
                  ? `${selection.size.value} cells`
                  : selection.activeCell.value?.column.name ?? 'No cell' }}
            </ContextMenuLabel>

            <ContextMenuItem
              icon="copy"
              hint="Ctrl+C"
              :disabled="!selection.block.value"
              @select="copySelection()"
            >
              Copy
            </ContextMenuItem>

            <ContextMenuItem
              icon="copy"
              hint="Ctrl+Shift+C"
              :disabled="!selection.block.value"
              @select="copySelection(true)"
            >
              Copy with Headers
            </ContextMenuItem>

            <ContextMenuSeparator />

            <ContextMenuItem icon="copy" :disabled="!result.rows.length" @select="copyAs('insert')">
              {{ copyAsLabel('INSERT') }}
            </ContextMenuItem>

            <ContextMenuItem icon="copy" :disabled="!result.rows.length" @select="copyAs('markdown')">
              {{ copyAsLabel('Markdown') }}
            </ContextMenuItem>

            <ContextMenuItem icon="copy" :disabled="!result.rows.length" @select="copyAs('json')">
              {{ copyAsLabel('JSON') }}
            </ContextMenuItem>

            <ContextMenuItem icon="copy" :disabled="!result.rows.length" @select="copyAs('csv')">
              {{ copyAsLabel('CSV') }}
            </ContextMenuItem>

            <ContextMenuSeparator />

            <ContextMenuItem
              icon="expand"
              :disabled="!selection.activeCell.value"
              @select="inspect()"
            >
              View Full Value…
            </ContextMenuItem>

            <ContextMenuItem
              v-if="activeReference"
              icon="jump"
              @select="followFocused()"
            >
              Go to {{ activeReference.table }} Row
            </ContextMenuItem>

            <!-- The value under the pointer, as a WHERE the owner re-reads
                 the table with. Only where there is a table to re-read: a
                 query tab's rows are whatever the statement said. -->
            <template v-if="quickFilters.length">
              <ContextMenuSeparator />
              <ContextMenuLabel>Filter rows</ContextMenuLabel>

              <ContextMenuItem
                v-for="item in quickFilters"
                :key="item.clause"
                :icon="item.icon"
                :title="item.clause"
                @select="emit('filter', item.clause)"
              >
                {{ item.label }}
              </ContextMenuItem>
            </template>

            <template v-if="canEdit">
              <ContextMenuSeparator />

              <ContextMenuItem
                icon="pencil"
                hint="Enter"
                :disabled="!selection.activeCell.value"
                @select="startEdit()"
              >
                Edit Cell
              </ContextMenuItem>

              <ContextMenuItem
                icon="close"
                hint="Ctrl+Backspace"
                :disabled="!selection.block.value"
                @select="setSelectionNull()"
              >
                Set NULL
              </ContextMenuItem>

              <ContextMenuSeparator />

              <ContextMenuItem icon="plus" @select="addRow()">
                Insert Row
              </ContextMenuItem>

              <ContextMenuItem
                icon="copy"
                :disabled="!selectedSourceRows.some((row) => row >= 0)"
                @select="duplicateSelected()"
              >
                Duplicate {{ rowsLabel }}
              </ContextMenuItem>

              <ContextMenuItem
                icon="trash"
                hint="Ctrl+Del"
                :danger="!selectionDeleted"
                :disabled="!selectedSourceRows.length"
                @select="toggleDeleteSelected()"
              >
                {{ selectionDeleted ? 'Restore' : 'Delete' }} {{ rowsLabel }}
              </ContextMenuItem>

              <ContextMenuSeparator />

              <ContextMenuItem
                icon="refresh"
                hint="Ctrl+Z"
                :disabled="!edits!.canUndo.value"
                @select="edits!.undo()"
              >
                Undo Last Change
              </ContextMenuItem>
            </template>
          </ContextMenuContent>
        </ContextMenu>
      </table>

      <p v-if="!displayRows.length" class="sticky left-0 px-3 py-3 text-faint">
        {{ result.rows.length ? 'No row matches this filter.' : 'No rows.' }}
      </p>

      <p
        v-if="result.truncated"
        class="sticky left-0 flex items-center gap-1.5 border-t border-edge px-3 py-1.5 text-warning"
      >
        <AppIcon name="warning" :size="12" />
        Showing the first {{ result.rows.length }} rows — the limit was reached.<template v-if="sort && !remote">
          Sorting orders these rows, not the whole table.</template>
      </p>
    </div>

    <RecordView
      v-if="recordOpen"
      v-model:width="recordWidth"
      :result="result"
      :columns="columns.visible.value"
      :row="recordRow"
      :total="displayRows.length"
      :row-offset="rowOffset"
      :edits="edits"
      :column-info="columnInfo"
      :editable="canEdit"
      :read-only-reason="readOnlyReason"
      :glyphs-of="headerGlyphs"
      @close="closeRecordView"
      @step="stepRecord"
      @inspect="inspectFromRecord"
      @stage="stageFromRecord"
      @toggle="toggleFromRecord"
    />
    </div>

    <!-- The whole of one cell, for the values a column is too narrow to show.
         A grid that truncates without somewhere to read the rest makes the user
         widen a column just to find out what is in it. -->
    <div
      v-if="selection.activeCell.value || stats"
      class="flex shrink-0 items-center gap-2 border-t border-edge bg-surface/60 px-2 py-1"
    >
      <template v-if="selection.activeCell.value">
        <span class="shrink-0 font-mono text-faint">{{ selection.activeCell.value.column.name }}</span>
        <!-- The table's own type where there is one: `tinyint(1)` says more than
             the `tiny` a result set reports for it. -->
        <span class="chip shrink-0 font-mono font-normal text-faint">
          {{ columnInfo?.[selection.activeCell.value.column.name]?.declaredType
            ?? selection.activeCell.value.column.type }}
        </span>

        <span v-if="focusedValue === null" class="null-pill">NULL</span>
        <span
          v-else
          class="selectable min-w-0 flex-1 truncate font-mono text-content"
        >{{ display(focusedValue) }}</span>
      </template>

      <!-- What the selection adds up to, the moment there is one: the answer
           to "how much is that?" without leaving the grid for a query. -->
      <span
        v-if="stats"
        class="chip shrink-0 gap-1.5 pr-1 font-mono font-normal tabular-nums text-faint"
        :title="statsText"
      >
        <template v-for="(part, index) in statsParts" :key="part">
          <span v-if="index" aria-hidden="true">·</span>
          <span>{{ part }}</span>
        </template>

        <button
          type="button"
          class="btn-icon p-0.5"
          title="Copy these statistics"
          @click="copy(statsText, 'the statistics')"
        >
          <AppIcon name="copy" :size="10" />
        </button>
      </span>

      <span class="ml-auto flex shrink-0 items-center gap-1">
        <button
          v-if="activeReference"
          type="button"
          class="btn btn-ghost"
          :title="`Open the ${activeReference.table} row this value names`"
          @click="followFocused"
        >
          <AppIcon name="jump" :size="11" class="text-accent-bright" />
          {{ activeReference.table }}
        </button>

        <button
          v-if="canEdit"
          type="button"
          class="btn-icon"
          title="Edit this cell (Enter) — Ctrl+Backspace while editing writes NULL"
          @click="startEdit"
        >
          <AppIcon name="pencil" :size="12" />
        </button>

        <button type="button" class="btn-icon" :title="canEdit ? 'Open this value (Shift+Enter)' : 'Open this value (Enter)'" @click="inspect">
          <AppIcon name="expand" :size="12" />
        </button>
        <button type="button" class="btn-icon" title="Copy this cell (Ctrl+C)" @click="copySelection(false)">
          <AppIcon name="copy" :size="12" />
        </button>
      </span>
    </div>
  </div>
</template>

<style scoped>
/*
 * Zebra striping and the row half of the crosshair, in CSS so that neither
 * costs a re-render. The stripe is keyed to the row's own position rather than
 * to `:nth-child`, which windowing would flip on every scroll.
 */
.result-grid tbody tr.is-odd td {
  background-color: color-mix(in oklab, var(--app-surface) 45%, transparent);
}

.result-grid tbody tr:hover td {
  background-color: var(--app-accent-soft);
}

/* The row number stays legible against both. */
.result-grid tbody tr:hover td:first-child {
  background-color: var(--app-surface-raised);
  color: var(--app-text);
}

/*
 * A row picked in the gutter. The number itself carries the mark — a bar down
 * the leading edge and the accent on the figure — so that a set of rows picked
 * with Ctrl reads as a list even where the rows are not adjacent, and stays
 * readable over the tint the cells themselves take.
 */
.result-grid tbody td.is-row-picked,
.result-grid tbody tr:hover td.is-row-picked {
  background-color: color-mix(in oklab, var(--app-accent) 30%, var(--app-surface-raised)) !important;
  box-shadow: inset 3px 0 0 var(--app-accent-bright), 1px 0 0 var(--app-border);
  color: var(--app-text);
  font-weight: 600;
}

/* Rows are a fixed height so the virtualizer's arithmetic holds: without this a
 * tall value would push one row out of step with every position below it. */
.result-grid tbody td {
  height: 26px;
  overflow: hidden;
}

/* A hairline on a pinned column's outer edge. It sits on top of whatever
 * scrolls under it, which is what keeps the seam readable mid-scroll — a plain
 * border would be painted over by the overlapping cells. */
.result-grid td:first-child,
.result-grid th:first-child,
.result-grid td.sticky,
.result-grid th.sticky {
  box-shadow: 1px 0 0 var(--app-border);
}

/*
 * A pinned cell must be opaque. Every tint above is mixed with `transparent`,
 * which is right for a cell that sits on the page background and wrong for
 * one that other cells scroll underneath: the text of two columns ends up
 * in one place. So each state is mixed with the page colour instead, to the
 * same shade, and a pinned column looks like the rest while covering what
 * passes under it.
 */
.result-grid tbody td.sticky {
  background-color: var(--app-bg);
}

.result-grid tbody tr.is-odd td.sticky {
  background-color: color-mix(in oklab, var(--app-surface) 45%, var(--app-bg));
}

.result-grid tbody tr:hover td.sticky {
  background-color: color-mix(in oklab, var(--app-accent) 16%, var(--app-bg));
}

.result-grid tbody td.sticky.is-selected {
  background-color: color-mix(in oklab, var(--app-accent) 22%, var(--app-bg)) !important;
}

.result-grid td.is-selected {
  background-color: color-mix(in oklab, var(--app-accent) 22%, transparent) !important;
  color: var(--app-text);
}

/* An edit that has not been written yet. The mark is a corner rather than a
 * fill, so it survives being selected, striped or hovered — all of which paint
 * the cell's background. */
.result-grid td.is-dirty {
  background-image: linear-gradient(225deg, var(--app-warning) 0 6px, transparent 6px);
  color: var(--app-text);
}

/* A row that does not exist yet. Tinted rather than outlined, so it reads as
 * part of the grid while plainly not being part of the table. */
.result-grid tbody tr.is-draft td {
  background-color: color-mix(in oklab, var(--app-success) 12%, transparent) !important;
}

.result-grid tbody tr.is-draft td.sticky {
  background-color: color-mix(in oklab, var(--app-success) 12%, var(--app-bg)) !important;
}

.result-grid tbody tr.is-draft td:first-child {
  color: var(--app-success);
  font-weight: 600;
}

/*
 * A boolean, as a box that is drawn entirely from the value.
 *
 * Every part of its appearance comes from a class, so the only way it can be
 * wrong is for the value to be wrong — there is no second copy of the state
 * inside the element to drift out of step with the one in the grid.
 */
.cell-bool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  vertical-align: -3px;
  border: 1.5px solid var(--app-border-strong);
  border-radius: 4px;
  background-color: var(--app-bg);
  color: var(--app-bg);
  transition: background-color 90ms, border-color 90ms;
}

button.cell-bool {
  cursor: pointer;
}

button.cell-bool:hover {
  border-color: var(--app-accent-bright);
}

.cell-bool.is-on {
  border-color: var(--app-accent-bright);
  background-color: var(--app-accent-bright);
}



/* Neither true nor false: the column holds nothing at all. */
.cell-bool.is-null {
  border-style: dashed;
  border-color: var(--app-type-null);
  background-color: transparent;
}

/* Read-only: still legible as set or not, plainly not a control. */
.cell-bool.is-readonly {
  opacity: 0.6;
}

/* A column the row cannot be saved without. */
.result-grid td.is-missing {
  box-shadow: inset 0 -2px 0 color-mix(in oklab, var(--app-danger) 70%, transparent);
}

/* What a new row's untouched cell is going to be: the server's own value, an
 * explicit NULL, or a gap the user still has to fill. */
.placeholder-pill {
  display: inline-block;
  border-radius: 3px;
  border: 1px dashed currentColor;
  padding-inline: 0.3rem;
  font-size: 9px;
  letter-spacing: 0.06em;
  opacity: 0.75;
}

.placeholder-pill.is-default {
  color: var(--app-success);
}

.placeholder-pill.is-null {
  color: var(--app-type-null);
}

.placeholder-pill.is-required {
  color: var(--app-danger);
  opacity: 1;
}

/* A row staged for deletion: still readable, plainly on its way out. */
.result-grid tbody tr.is-deleted td {
  color: var(--app-danger);
  text-decoration: line-through;
  text-decoration-color: color-mix(in oklab, var(--app-danger) 70%, transparent);
}

/* The one cell the keyboard is on, inside whatever else is selected. */
.result-grid td.is-focused {
  outline: 1px solid var(--app-accent-bright);
  outline-offset: -1px;
}

/* Where a dragged column would land. */
.result-grid th.is-drop-target {
  box-shadow: inset 2px 0 0 var(--app-accent-bright);
}

/*
 * The sort mark, in the slot the header button's right padding keeps clear.
 *
 * Out of the flow rather than in it, so that showing the hint under the pointer
 * cannot shorten the name beside it — the old inline arrow took its 12px out of
 * the name the moment the header was hovered, on exactly the narrow columns
 * that could least afford it.
 */
.result-grid .sort-mark {
  position: absolute;
  top: 50%;
  right: 5px;
  transform: translateY(-50%);
  pointer-events: none;
}

/*
 * The way out of a foreign key: the row it names, one click away.
 *
 * The slot it sits in is held open at every width — the cell's own trailing
 * padding — rather than the mark being drawn over the value when the pointer
 * arrives. A value covered on hover is a value you cannot read at the exact
 * moment you are pointing at it, and the ellipsis that truncation gives you is
 * at least honest about what it is hiding.
 */
.result-grid td.is-fk {
  padding-right: 24px;
}

.result-grid .fk-jump {
  position: absolute;
  top: 50%;
  right: 1px;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  border-radius: 3px;
  color: var(--app-accent-bright);
  /* Present at rest, so a key looks like something you can follow before you
   * touch it; only fully lit where the user already is. */
  opacity: 0.4;
  transition: opacity 90ms, background-color 90ms;
  cursor: pointer;
}

.result-grid tr:hover td.is-fk .fk-jump,
.result-grid td.is-fk.is-focused .fk-jump {
  opacity: 1;
}

.result-grid .fk-jump:hover {
  opacity: 1;
  background-color: var(--app-accent-soft);
  box-shadow: inset 0 0 0 1px var(--app-accent-line);
}

/* The divider is invisible until it is worth grabbing: a column edge that
 * lights up under the pointer, rather than a row of handles across the header. */
.resize-handle {
  position: absolute;
  top: 0;
  right: -3px;
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

/* NULL as a shape rather than a word in brackets: it stops reading as a value
 * the column happens to contain. */
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
