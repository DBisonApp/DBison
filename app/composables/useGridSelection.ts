import type { CellValue, QueryResult } from '#shared/db-types'
import type { GridColumn } from '~/composables/useGridColumns'

/** A cell, addressed by where it currently sits on screen. */
export interface GridCell {
  row: number
  col: number
}

export interface GridRange {
  top: number
  bottom: number
  left: number
  right: number
}

/**
 * A block of cells to act on: which rows, and which columns of them.
 *
 * Rows are listed rather than given as a span, because a selection of rows does
 * not have to be one run — Ctrl-picking three rows out of a hundred is a normal
 * thing to want to copy, delete or export, and a top/bottom pair cannot say it.
 */
export interface GridBlock {
  /** Display positions, top to bottom, each appearing once. */
  rows: number[]
  left: number
  right: number
}

/**
 * What is selected on screen, and the text it becomes.
 *
 * Two shapes, because a grid is used two ways. Dragging across cells makes a
 * rectangle — the spreadsheet gesture, and what copying a corner of a result
 * means. Picking rows in the number gutter makes a set of whole rows, which may
 * have gaps in it: a row is the thing that gets deleted, duplicated and pasted
 * elsewhere, and the three rows worth acting on are rarely adjacent.
 *
 * Everything downstream reads `block`, so neither shape has to be special-cased
 * by the grid, the clipboard or the export.
 *
 * Positions are display positions, not source indexes: a selection is what the
 * user pointed at, so it follows the order and the column layout on screen
 * rather than the order the server sent.
 */
export function useGridSelection(
  result: () => QueryResult,
  rows: () => number[],
  columns: () => GridColumn[],
) {
  /** Where the selection started, and where it currently reaches. */
  const anchor = ref<GridCell | null>(null)
  const focus = ref<GridCell | null>(null)

  /**
   * Whether the user is picking cells or rows. The other shape's state is left
   * alone rather than cleared, and simply stops being read.
   */
  const mode = ref<'cells' | 'rows'>('cells')

  /** The rows picked in the gutter, by display position, when `mode` is rows. */
  const picked = ref<Set<number>>(new Set())

  /**
   * What was already picked when the current gutter drag began.
   *
   * A drag paints a run from the anchor to the pointer, and Ctrl means "as well
   * as what I had". Without a base to union with, dragging after a Ctrl-click
   * would quietly throw the earlier picks away halfway through the gesture.
   */
  let pickBase = new Set<number>()

  const range = computed<GridRange | null>(() => {
    if (!anchor.value || !focus.value) return null

    return {
      top: Math.min(anchor.value.row, focus.value.row),
      bottom: Math.max(anchor.value.row, focus.value.row),
      left: Math.min(anchor.value.col, focus.value.col),
      right: Math.max(anchor.value.col, focus.value.col),
    }
  })

  /** The rows of a rectangle, as the positions a block lists. */
  function rowsOf(box: GridRange) {
    const list: number[] = []
    for (let row = box.top; row <= box.bottom; row++) list.push(row)
    return list
  }

  /**
   * What is selected, whichever way it was selected. Everything that acts on a
   * selection — copy, export, delete, NULL — reads this and nothing else.
   */
  const block = computed<GridBlock | null>(() => {
    const colCount = columns().length

    if (mode.value === 'rows') {
      if (!picked.value.size || !colCount) return null

      return {
        rows: [...picked.value].sort((a, b) => a - b),
        left: 0,
        right: colCount - 1,
      }
    }

    const box = range.value
    return box ? { rows: rowsOf(box), left: box.left, right: box.right } : null
  })

  /** Whether whole rows are what is selected, rather than a corner of them. */
  const isRowSelection = computed(() => mode.value === 'rows' && picked.value.size > 0)

  /** How many rows the selection covers — the count worth reporting for rows. */
  const rowCount = computed(() => block.value?.rows.length ?? 0)

  const isMultiple = computed(() => {
    const it = block.value
    return it !== null && (it.rows.length > 1 || it.left !== it.right)
  })

  /** How many cells are selected, for the status line. */
  const size = computed(() => {
    const it = block.value
    return it ? it.rows.length * (it.right - it.left + 1) : 0
  })

  function contains(row: number, col: number) {
    if (mode.value === 'rows') return picked.value.has(row)

    const box = range.value
    return Boolean(box) && row >= box!.top && row <= box!.bottom && col >= box!.left && col <= box!.right
  }

  function containsRow(row: number) {
    if (mode.value === 'rows') return picked.value.has(row)

    const box = range.value
    return Boolean(box) && row >= box!.top && row <= box!.bottom
  }

  function clear() {
    anchor.value = null
    focus.value = null
    picked.value = new Set()
    pickBase = new Set()
    mode.value = 'cells'
  }

  /** Clicking sets both ends; shift-clicking moves only the far one. */
  function select(row: number, col: number, extend = false) {
    mode.value = 'cells'
    picked.value = new Set()

    if (!extend || !anchor.value) anchor.value = { row, col }
    focus.value = { row, col }
  }

  /**
   * Picks whole rows in the number gutter.
   *
   * Plain replaces, Shift paints the run from wherever the last one started,
   * and Ctrl adds a row on its own — or takes one back out, which is the half
   * of multiple selection that grids usually forget and that is what makes the
   * other half safe to use.
   */
  function selectRow(
    row: number,
    { extend = false, additive = false }: { extend?: boolean, additive?: boolean } = {},
  ) {
    const colCount = columns().length
    if (!colCount) return

    mode.value = 'rows'

    if (additive && !extend) {
      const next = new Set(picked.value)

      if (next.has(row)) next.delete(row)
      else next.add(row)

      picked.value = next

      // The run a drag from here paints is added to what survives this click.
      pickBase = new Set(next)
      pickBase.delete(row)

      anchor.value = { row, col: 0 }
      focus.value = { row, col: colCount - 1 }
      return
    }

    if (!extend || !anchor.value) {
      pickBase = additive ? new Set(picked.value) : new Set()
      anchor.value = { row, col: 0 }
    }

    const from = anchor.value.row
    const run = new Set(pickBase)
    for (let at = Math.min(from, row); at <= Math.max(from, row); at++) run.add(at)

    picked.value = run
    focus.value = { row, col: colCount - 1 }
  }

  /** Arrow-key movement, clamped to the grid; shift keeps the anchor put. */
  function moveBy(rowDelta: number, colDelta: number, extend = false) {
    const rowCount = rows().length
    const colCount = columns().length
    if (!rowCount || !colCount) return

    const from = focus.value ?? { row: 0, col: 0 }
    const row = Math.min(rowCount - 1, Math.max(0, from.row + rowDelta))
    const col = Math.min(colCount - 1, Math.max(0, from.col + colDelta))

    select(row, col, extend)
  }

  function selectAll() {
    const total = rows().length
    const colCount = columns().length
    if (!total || !colCount) return

    mode.value = 'cells'
    picked.value = new Set()
    anchor.value = { row: 0, col: 0 }
    focus.value = { row: total - 1, col: colCount - 1 }
  }

  /** Every row, as a row selection — what clicking the `#` corner means. */
  function selectAllRows() {
    const total = rows().length
    const colCount = columns().length
    if (!total || !colCount) return

    mode.value = 'rows'
    pickBase = new Set()
    picked.value = new Set(rows().map((_, position) => position))
    anchor.value = { row: 0, col: 0 }
    focus.value = { row: total - 1, col: colCount - 1 }
  }

  /** The value under the focused cell, with the column it belongs to. */
  const activeCell = computed(() => {
    const at = focus.value
    const column = at ? columns()[at.col] : undefined
    const sourceRow = at ? rows()[at.row] : undefined
    if (!at || !column || sourceRow === undefined) return null

    return {
      column,
      sourceRow,
      value: result().rows[sourceRow]?.[column.index] ?? null,
    }
  })

  /** A value as it should leave the app: NULL is nothing, not the word "null". */
  function asText(value: CellValue) {
    if (value === null || value === undefined) return ''
    if (typeof value === 'boolean') return value ? 'true' : 'false'
    return String(value)
  }

  /** The cells of a block, row by row, as they are on screen. */
  function cellsOf(box: GridBlock) {
    const data = result().rows
    const rowOrder = rows()
    const cols = columns()
    const lines: CellValue[][] = []

    for (const row of box.rows) {
      const source = data[rowOrder[row] ?? -1]
      if (!source) continue

      const line: CellValue[] = []
      for (let col = box.left; col <= box.right; col++) {
        const column = cols[col]
        line.push(column ? source[column.index] ?? null : null)
      }
      lines.push(line)
    }

    return lines
  }

  /** The column names of a block, in the order they are on screen. */
  function headersOf(box: GridBlock) {
    return columns().slice(box.left, box.right + 1).map((column) => column.name)
  }

  /** The whole result, for an export that ignores the selection. */
  const everything = computed<GridBlock>(() => ({
    rows: rows().map((_, position) => position),
    left: 0,
    right: Math.max(0, columns().length - 1),
  }))

  /** Tab separated, which is what a spreadsheet pastes as cells. */
  function toTsv(box: GridBlock, withHeader: boolean) {
    const body = cellsOf(box).map((line) => line.map(asText).join('\t'))
    return (withHeader ? [headersOf(box).join('\t'), ...body] : body).join('\n')
  }

  /** RFC 4180 quoting: only what needs quotes gets them, and "" escapes one. */
  function csvField(value: CellValue) {
    const text = asText(value)
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }

  function toCsv(box: GridBlock) {
    const header = headersOf(box).map((name) => csvField(name)).join(',')
    const body = cellsOf(box).map((line) => line.map(csvField).join(','))
    return [header, ...body].join('\r\n')
  }

  function toJson(box: GridBlock) {
    const names = headersOf(box)
    const objects = cellsOf(box).map(
      (line) => Object.fromEntries(line.map((value, index) => [names[index] ?? `column${index}`, value])),
    )

    return JSON.stringify(objects, null, 2)
  }

  return {
    anchor,
    focus,
    range,
    block,
    everything,
    isMultiple,
    isRowSelection,
    rowCount,
    size,
    activeCell,
    contains,
    containsRow,
    clear,
    select,
    selectRow,
    moveBy,
    selectAll,
    selectAllRows,
    asText,
    cellsOf,
    headersOf,
    toTsv,
    toCsv,
    toJson,
  }
}
