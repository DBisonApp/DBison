import type { CellValue, QueryResult } from '#shared/db-types'
import type { ColumnFacts } from '~/utils/cell-types'

/**
 * One column as the grid draws it: where it sits, how wide it is, and whether
 * it is pinned to the left edge.
 */
export interface GridColumn {
  /** Index into `result.columns`, and into every row. */
  index: number
  name: string
  type: string
  width: number
  frozen: boolean
  /** Distance from the grid's left edge, which a pinned column sticks at. */
  offset: number
}

/** What is remembered between sessions, keyed by column name rather than position. */
interface StoredLayout {
  widths: Record<string, number>
  order: string[]
  hidden: string[]
  frozen: number
}

const STORAGE_PREFIX = 'dbison.grid.v1:'

/**
 * One character of the grid's monospace face, in pixels.
 *
 * Every glyph in a monospace font advances the same distance, so a column's
 * natural width is a character count — no per-cell measurement, which is what
 * makes sizing a thousand rows affordable. 0.6em is the advance of the stacks
 * this app uses at 12px; being a few pixels out only shifts the starting width
 * of a column the user can drag.
 */
const CH = 7.2

/**
 * What a cell spends on padding rather than on its value.
 *
 * Deliberately small. A grid is read by comparing values down a column, and
 * every pixel of gutter is a character the column cannot show — at 12px
 * monospace, the 24px this used to be cost three characters in every column on
 * screen, which is the difference between reading a timestamp and reading
 * `2024-05-0…`.
 */
const CELL_PADDING = 20

/**
 * The header's own furniture: its padding, and the slot on the right the sort
 * arrow is drawn in. Reserved at every width rather than added on hover, so a
 * header does not reflow under the pointer.
 */
const HEADER_PADDING = 30

/** One glyph in a header — the type mark, the key, the link — and its gap. */
const GLYPH = 17

/**
 * The slot a foreign-key cell holds open on its trailing edge for the button
 * that follows the key. Held open rather than drawn over the value, so it has
 * to be paid for in the width.
 */
const FOLLOW_SLOT = 18

/**
 * Narrow enough to fit a lot of columns, wide enough that one still says
 * something. Below about this a column is a row of ellipses.
 */
const MIN_WIDTH = 64
/** A first guess only: wider columns are reachable by dragging. */
const MAX_AUTO_WIDTH = 420
/** How many rows a width is guessed from; the rest would not change it much. */
const SAMPLE_ROWS = 120

function textLength(value: CellValue) {
  if (value === null || value === undefined) return 4
  if (typeof value === 'boolean') return 5

  // Only the first line is ever shown, so a JSON blob's later lines must not
  // stretch the column to the width of the document.
  const text = String(value)
  const newline = text.indexOf('\n')
  return newline === -1 ? text.length : newline
}

/**
 * The column layout of one grid: widths, order, what is hidden, what is pinned.
 *
 * Held outside the component so the grid itself stays about drawing rows, and
 * so the column menu can drive the same state without a chain of events. When
 * `storageKey` returns a name, the layout outlives the tab that made it — the
 * width someone dragged for `orders.description` is still there tomorrow.
 */
export function useGridColumns(
  result: () => QueryResult,
  storageKey: () => string | undefined,
  /**
   * What the table says about each column, when the owner knows.
   *
   * Only the header's glyphs are read from it: a primary key and a foreign key
   * each wear one, and a column that is both wears two. They are part of what a
   * header has to fit, so a width guessed without them would truncate the name
   * of the one column — the key — that most needs to stay readable.
   */
  columnInfo: () => Record<string, ColumnFacts> | undefined = () => undefined,
) {
  const widths = ref<number[]>([])
  const order = ref<number[]>([])
  const hidden = ref<number[]>([])
  const frozen = ref(0)

  /**
   * Identifies the shape of a result, not its contents. Sorting a table view
   * re-runs the statement, so a new result object arrives for what is still the
   * same set of columns; the layout is keyed to this and survives that.
   */
  const signature = computed(
    () => result().columns.map((column) => `${column.name}:${column.type}`).join('|'),
  )

  /**
   * How many glyphs a header carries.
   *
   * One, almost always: the type — or the key, or the link, either of which
   * takes the type's place. Two only for a column that is both, which is every
   * column of a junction table and few others.
   */
  function glyphsOf(index: number) {
    const facts = columnInfo()?.[nameOf(index)]
    return facts?.primaryKey && facts?.references ? 2 : 1
  }

  function nameOf(index: number) {
    return result().columns[index]?.name ?? ''
  }

  /**
   * The width a column would like: enough for its header, or for its values,
   * whichever asks for more.
   *
   * The two are measured apart because they are padded apart — a header pays
   * for its glyphs and its sort slot, a cell pays for almost nothing — and
   * because the header no longer spells the type out. Adding a type name to
   * the name was what used to make a two-character `id` column 105px wide
   * while the description beside it went to ellipses.
   */
  function naturalWidth(index: number, sampleRows: number) {
    const column = result().columns[index]
    if (!column) return MIN_WIDTH

    const facts = columnInfo()?.[column.name]
    const header = column.name.length * CH + HEADER_PADDING + glyphsOf(index) * GLYPH
    const cellPadding = CELL_PADDING + (facts?.references ? FOLLOW_SLOT : 0)

    let longest = 0
    const rows = result().rows
    const sample = Math.min(rows.length, sampleRows)
    for (let row = 0; row < sample; row++) {
      const length = textLength(rows[row]?.[index] ?? null)
      if (length > longest) longest = length
    }

    return Math.round(Math.max(header, longest * CH + cellPadding))
  }

  function stored(): StoredLayout | null {
    const key = storageKey()
    if (!key || !import.meta.client) return null

    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + key)
      return raw ? (JSON.parse(raw) as StoredLayout) : null
    }
    catch {
      // A layout from an older build is not worth recovering.
      return null
    }
  }

  function persist() {
    const key = storageKey()
    if (!key || !import.meta.client) return

    const layout: StoredLayout = {
      widths: Object.fromEntries(widths.value.map((width, index) => [nameOf(index), width])),
      order: order.value.map(nameOf),
      hidden: hidden.value.map(nameOf),
      frozen: frozen.value,
    }

    try {
      localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(layout))
    }
    catch {
      // Out of quota, or a private window. A remembered width is not worth an
      // error the user has to dismiss.
    }
  }

  /** Rebuilds the layout for a new set of columns, reusing anything remembered. */
  function reset(fromStorage = true) {
    const columns = result().columns
    const saved = fromStorage ? stored() : null

    widths.value = columns.map((column, index) =>
      saved?.widths[column.name]
      ?? Math.min(MAX_AUTO_WIDTH, Math.max(MIN_WIDTH, naturalWidth(index, SAMPLE_ROWS))),
    )

    // A remembered order names columns; anything it does not name — a column
    // added to the table since — keeps its natural place at the end.
    const byName = new Map(columns.map((column, index) => [column.name, index]))
    const ordered = (saved?.order ?? [])
      .map((name) => byName.get(name))
      .filter((index): index is number => index !== undefined)

    order.value = [
      ...ordered,
      ...columns.map((_, index) => index).filter((index) => !ordered.includes(index)),
    ]

    hidden.value = (saved?.hidden ?? [])
      .map((name) => byName.get(name))
      .filter((index): index is number => index !== undefined)

    frozen.value = Math.min(saved?.frozen ?? 0, order.value.length)
  }

  /**
   * The glyphs the headers are going to carry, as a string.
   *
   * A table's definition lands a moment after its first page of rows does, and
   * it changes what a header has to fit. Folding it into what the layout is
   * keyed to means the widths are worked out once, against the header the user
   * will actually see — and the extra reset happens before anyone has had time
   * to drag an edge, so nothing of theirs is thrown away.
   */
  const glyphSignature = computed(
    () => result().columns.map((_, index) => glyphsOf(index)).join(''),
  )

  watch([signature, glyphSignature], () => reset(), { immediate: true })

  // Written back once the user stops, not on every pixel of a drag.
  let writeTimer: ReturnType<typeof setTimeout> | undefined
  watch([widths, order, hidden, frozen], () => {
    clearTimeout(writeTimer)
    writeTimer = setTimeout(persist, 400)
  }, { deep: true })

  onScopeDispose(() => clearTimeout(writeTimer))

  /** Wide enough for the largest row number, and no wider. */
  const rowNumberWidth = computed(
    () => Math.max(38, 20 + String(result().rows.length).length * 8),
  )

  /** The columns to draw, in display order, with their pinned offsets resolved. */
  const visible = computed<GridColumn[]>(() => {
    const columns = result().columns
    let offset = rowNumberWidth.value

    return order.value
      .filter((index) => !hidden.value.includes(index))
      .map((index, position) => {
        const column = columns[index]!
        const width = widths.value[index] ?? MIN_WIDTH
        const item: GridColumn = {
          index,
          name: column.name,
          type: column.type,
          width,
          frozen: position < frozen.value,
          offset,
        }

        offset += width
        return item
      })
  })

  /** Every column, hidden ones included, for the menu that manages them. */
  const all = computed(() => order.value.map((index) => ({
    index,
    name: nameOf(index),
    type: result().columns[index]?.type ?? '',
    hidden: hidden.value.includes(index),
  })))

  const tableWidth = computed(
    () => visible.value.reduce((total, column) => total + column.width, rowNumberWidth.value),
  )

  /** Where the pinned columns end, which is what the body must not scroll under. */
  const frozenWidth = computed(() => {
    const pinned = visible.value.filter((column) => column.frozen)
    const last = pinned.at(-1)
    return last ? last.offset + last.width : rowNumberWidth.value
  })

  function resize(index: number, width: number) {
    widths.value = widths.value.with(index, Math.max(MIN_WIDTH, Math.round(width)))
  }

  /** Fits a column to what is in it — every loaded row, not a sample. */
  function autoFit(index: number) {
    resize(index, Math.max(MIN_WIDTH, naturalWidth(index, result().rows.length)))
  }

  function widthOf(index: number) {
    return widths.value[index] ?? MIN_WIDTH
  }

  /** Moves a column to another display position, dragging its neighbours along. */
  function move(from: number, to: number) {
    const next = [...order.value]
    const [moved] = next.splice(from, 1)
    if (moved === undefined) return

    next.splice(Math.max(0, Math.min(next.length, to)), 0, moved)
    order.value = next
  }

  function toggleHidden(index: number) {
    hidden.value = hidden.value.includes(index)
      ? hidden.value.filter((other) => other !== index)
      : [...hidden.value, index]
  }

  function showAll() {
    hidden.value = []
  }

  /**
   * Pins every column up to and including this display position.
   *
   * A pinned header carries one glyph more — the pin — and a column sized to
   * its name would otherwise lose the name to an ellipsis the moment it was
   * pinned. Each newly pinned column is widened by that glyph, once; a width
   * the user dragged is left alone, since it was chosen with eyes open.
   */
  function freezeThrough(position: number) {
    const before = frozen.value
    frozen.value = before === position + 1 ? 0 : position + 1

    const shown = order.value.filter((index) => !hidden.value.includes(index))
    for (let at = before; at < frozen.value; at++) {
      const index = shown[at]
      if (index === undefined || widths.value[index] === undefined) continue
      const auto = Math.min(MAX_AUTO_WIDTH, Math.max(MIN_WIDTH, naturalWidth(index, SAMPLE_ROWS)))
      if (widths.value[index] === auto) widths.value[index] = auto + GLYPH
    }
  }

  function forget() {
    const key = storageKey()
    if (key && import.meta.client) localStorage.removeItem(STORAGE_PREFIX + key)
    reset(false)
  }

  return {
    visible,
    all,
    widths,
    order,
    hidden,
    frozen,
    rowNumberWidth,
    tableWidth,
    frozenWidth,
    widthOf,
    resize,
    autoFit,
    move,
    toggleHidden,
    showAll,
    freezeThrough,
    forget,
    MIN_WIDTH,
  }
}
