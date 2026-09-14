import type { CellValue, QueryResult, RowChange } from '#shared/db-types'

/** One row's staged state: the cells rewritten, and whether it is to go. */
interface PendingRow {
  /** Column name to the value it should become. */
  updates: Map<string, CellValue>
  deleted: boolean
}

/** What a single undo step puts back. */
interface HistoryStep {
  row: number
  column?: string
  /** The pending value before this step, or undefined if there was none. */
  previous: CellValue | undefined
  hadValue: boolean
  deleted: boolean
  /** Set when the step created a draft row, so undoing it takes the row away. */
  addedDraft?: boolean
}

/**
 * Draft rows are addressed by negative numbers.
 *
 * Everything downstream — the selection, the virtualizer, the clipboard — works
 * in row indexes, and a new row has no index into a result it is not in yet.
 * Negative ids keep it a row index all the same: one number space, one set of
 * code paths, and `row < 0` is the whole of the distinction.
 */
function isDraftRow(row: number) {
  return row < 0
}

/**
 * The edits a grid has staged but not yet written.
 *
 * Typing into a cell does not touch the database. Changes collect here, the
 * grid paints them, and one save applies all of them in a transaction — the way
 * every serious client works, and for the same three reasons: a screen of
 * corrections is one intent rather than a dozen, half of it landing is worse
 * than none of it, and an edit made by accident should be undoable without a
 * second write. Nothing here knows how to talk to a database: the panel that
 * owns the table turns `changes` into SQL.
 */
export function useGridEdits(result: () => QueryResult, keyColumns: () => string[]) {
  /** Keyed by index into `result.rows` — the row as the server sent it. */
  const rows = ref(new Map<number, PendingRow>())
  const history = ref<HistoryStep[]>([])

  /**
   * New rows, in the order they were added, keyed by their negative id.
   *
   * A draft holds only what has been typed into it. A column nobody touched is
   * absent rather than null, which is what lets the INSERT leave it out and the
   * server's own default, sequence or identity fill it in.
   */
  const drafts = ref(new Map<number, Map<string, CellValue>>())
  let nextDraftId = -1

  /** Bumped on every change, so watchers see edits that mutate a Map in place. */
  const version = ref(0)

  function touch() {
    version.value += 1
  }

  function rowAt(row: number) {
    return rows.value.get(row)
  }

  /** The staged value of a cell, or `undefined` when it is untouched. */
  function pendingValue(row: number, column: string): CellValue | undefined {
    void version.value

    if (isDraftRow(row)) {
      const draft = drafts.value.get(row)
      return draft?.has(column) ? draft.get(column) : undefined
    }

    const pending = rows.value.get(row)
    return pending?.updates.has(column) ? pending.updates.get(column) : undefined
  }

  function isDirty(row: number, column: string) {
    void version.value

    if (isDraftRow(row)) return Boolean(drafts.value.get(row)?.has(column))
    return Boolean(rows.value.get(row)?.updates.has(column))
  }

  function isDeleted(row: number) {
    void version.value
    return Boolean(rows.value.get(row)?.deleted)
  }

  function isDraft(row: number) {
    void version.value
    return isDraftRow(row) && drafts.value.has(row)
  }

  /** The draft rows, oldest first, as the ids the grid paints them under. */
  const draftRows = computed(() => {
    void version.value
    return [...drafts.value.keys()]
  })

  /**
   * The staged state of a row, created on first use.
   *
   * Always read back out of the map rather than returned directly: what goes in
   * is a plain object, what comes out is the reactive proxy around it, and only
   * writes through the proxy are seen by anything watching. Handing back the raw
   * object would make every mutation invisible.
   */
  function ensure(row: number) {
    if (!rows.value.has(row)) rows.value.set(row, { updates: new Map(), deleted: false })
    return rows.value.get(row)!
  }

  /** Drops a row that has nothing staged, so it stops counting as a change. */
  function prune(row: number) {
    const pending = rows.value.get(row)
    if (pending && !pending.deleted && !pending.updates.size) rows.value.delete(row)
  }

  /**
   * Stages one cell.
   *
   * A value typed back to what the server sent is not a change: it drops out
   * rather than being written, which keeps a save from touching rows — and
   * firing triggers, and bumping row versions — for nothing.
   */
  function set(row: number, column: string, value: CellValue) {
    if (isDraftRow(row)) {
      const draft = drafts.value.get(row)
      if (!draft) return

      history.value.push({
        row,
        column,
        hadValue: draft.has(column),
        previous: draft.get(column),
        deleted: false,
      })

      draft.set(column, value)
      touch()
      return
    }

    const columnIndex = result().columns.findIndex((c) => c.name === column)
    const original = result().rows[row]?.[columnIndex] ?? null
    const pending = ensure(row)

    history.value.push({
      row,
      column,
      hadValue: pending.updates.has(column),
      previous: pending.updates.get(column),
      deleted: pending.deleted,
    })

    if (value === original) pending.updates.delete(column)
    else pending.updates.set(column, value)

    prune(row)
    touch()
  }

  /**
   * Adds a new row, optionally seeded from an existing one.
   *
   * A seed copies only what the seed row holds; the key columns are dropped, so
   * duplicating a row does not try to reuse its id. Returns the draft's id so
   * the grid can put the cursor in it.
   */
  function addDraft(seedRow?: number) {
    const id = nextDraftId--
    const values = new Map<string, CellValue>()

    if (seedRow !== undefined) {
      const columns = result().columns
      const source = result().rows[seedRow]
      const key = new Set(keyColumns())

      columns.forEach((column, index) => {
        // The key is what the server assigns or the user chooses fresh; copying
        // it would only produce a duplicate-key error on save.
        if (key.has(column.name)) return

        const pending = pendingValue(seedRow, column.name)
        values.set(column.name, pending !== undefined ? pending : source?.[index] ?? null)
      })
    }

    drafts.value.set(id, values)
    history.value.push({ row: id, hadValue: false, previous: undefined, deleted: false, addedDraft: true })
    touch()

    return id
  }

  /** Throws a draft away. Nothing was written, so nothing has to be undone. */
  function removeDraft(row: number) {
    drafts.value.delete(row)
    history.value = history.value.filter((step) => step.row !== row)
    touch()
  }

  /** Marks a row for deletion, or takes the mark off again. */
  function toggleDeleted(row: number) {
    // A row that only exists here goes away entirely: there is nothing on the
    // server to delete, and leaving an empty draft marked "to delete" would be
    // a change that means nothing.
    if (isDraftRow(row)) {
      removeDraft(row)
      return
    }

    const pending = ensure(row)

    history.value.push({
      row,
      hadValue: false,
      previous: undefined,
      deleted: pending.deleted,
    })

    pending.deleted = !pending.deleted

    prune(row)
    touch()
  }

  function undo() {
    const step = history.value.pop()
    if (!step) return

    if (step.addedDraft) {
      drafts.value.delete(step.row)
      touch()
      return
    }

    if (isDraftRow(step.row)) {
      const draft = drafts.value.get(step.row)

      if (draft && step.column !== undefined) {
        if (step.hadValue) draft.set(step.column, step.previous as CellValue)
        else draft.delete(step.column)
      }

      touch()
      return
    }

    const pending = ensure(step.row)

    if (step.column !== undefined) {
      if (step.hadValue) pending.updates.set(step.column, step.previous as CellValue)
      else pending.updates.delete(step.column)
    }

    pending.deleted = step.deleted

    prune(step.row)
    touch()
  }

  function clear() {
    rows.value.clear()
    drafts.value.clear()
    history.value = []
    touch()
  }

  /** How many cells and rows are staged, for the toolbar to report. */
  const summary = computed(() => {
    void version.value

    let cells = 0
    let deleted = 0

    for (const pending of rows.value.values()) {
      cells += pending.updates.size
      if (pending.deleted) deleted += 1
    }

    const added = drafts.value.size

    return {
      cells,
      deleted,
      added,
      rows: rows.value.size,
      total: cells + deleted + added,
    }
  })

  const dirty = computed(() => summary.value.total > 0)

  /**
   * The staged edits as changes a driver can execute.
   *
   * Deletions come last: a row that was edited and then deleted should not have
   * its update skipped, and running them in this order means the same statements
   * whichever way the user got there. A row marked for deletion contributes only
   * the DELETE — updating what is about to go would be a write for nothing.
   */
  const changes = computed<RowChange[]>(() => {
    void version.value

    const columns = result().columns
    const key = keyColumns()
    const updates: RowChange[] = []
    const deletes: RowChange[] = []

    for (const [row, pending] of rows.value) {
      const source = result().rows[row]
      if (!source) continue

      const rowKey = key.map((name) => ({
        column: name,
        value: source[columns.findIndex((column) => column.name === name)] ?? null,
      }))

      if (pending.deleted) {
        deletes.push({ kind: 'delete', key: rowKey })
        continue
      }

      if (!pending.updates.size) continue

      updates.push({
        kind: 'update',
        key: rowKey,
        set: [...pending.updates].map(([column, value]) => ({ column, value })),
      })
    }

    // Inserts before deletes so a row can be replaced in one save, and after
    // updates so the statements read in the order the user made them.
    const inserts: RowChange[] = [...drafts.value].map(([, values]) => ({
      kind: 'insert',
      values: [...values].map(([column, value]) => ({ column, value })),
    }))

    return [...updates, ...inserts, ...deletes]
  })

  /** Writes the staged values into the result, once the server has taken them. */
  function commitLocally() {
    const columns = result().columns

    for (const [row, pending] of rows.value) {
      const source = result().rows[row]
      if (!source || pending.deleted) continue

      for (const [column, value] of pending.updates) {
        const index = columns.findIndex((c) => c.name === column)
        if (index !== -1) source[index] = value
      }
    }

    clear()
  }

  /**
   * The columns a draft row must be given before it can be inserted: not
   * nullable, and with nothing the server would fill in itself.
   *
   * Reported per draft so the grid can mark the cells and the save can refuse
   * with a name rather than with the engine's "null value violates not-null
   * constraint" after a round trip.
   */
  function missingFor(row: number, required: (column: string) => boolean) {
    void version.value

    const draft = drafts.value.get(row)
    if (!draft) return []

    return result().columns
      .map((column) => column.name)
      .filter((name) => required(name) && !draft.has(name))
  }

  return {
    rows,
    drafts,
    draftRows,
    pendingValue,
    isDirty,
    isDeleted,
    isDraft,
    rowAt,
    set,
    addDraft,
    removeDraft,
    missingFor,
    toggleDeleted,
    undo,
    clear,
    commitLocally,
    changes,
    summary,
    dirty,
    canUndo: computed(() => history.value.length > 0),
  }
}
