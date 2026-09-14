<script setup lang="ts">
import type { IDockviewPanelProps } from 'dockview-vue'
import type { CellValue, DriverError, QueryContext, QueryHistoryEntry, QueryResult, SavedQuery } from '#shared/db-types'
import type { SqlSlice } from '~/components/ui/SqlEditor.vue'
import { QUERY_LIMIT_OPTIONS } from '~/composables/useSettings'
import type { ParsedPlan } from '~/utils/plan-parse'
import { parsePlanResult } from '~/utils/plan-parse'
import type { SqlDialect } from '~/utils/serialize'

interface QueryPanelParams {
  connectionId: string | null
  database?: string | null
  schema?: string | null
  /**
   * The editor's text. Named for what it was — the text a tab opened with —
   * but written back as the user types, so a restored layout brings the
   * statement back and not just the empty tab it started as.
   */
  initialSql: string
  title?: string
  /** Whether the title is a generated one the database may be appended to. */
  autoTitle?: boolean
  /** The script file behind the tab, when it came from or went to disk. */
  filePath?: string | null
}

const props = defineProps<{ params: IDockviewPanelProps<QueryPanelParams> }>()

const connections = useConnections()
const { run } = useQueryRunner()
const completions = useSqlCompletions()
const history = useQueryHistory()
const queryPanels = useQueryPanels()
const { openQuery, saveLayout } = useWorkbench()
const { bridge, isAvailable } = useDatabaseBridge()
const { settings, rememberFile } = useSettings()
const { confirm, openParameters, openSaveQuery, openExport } = useDialogs()
const { announce } = useLiveAnnouncer()

const profile = computed(() => connections.profiles.value.find((p) => p.id === context.value.connectionId) ?? null)

/**
 * A tab runs where it is pointed, not where its connection profile happens to
 * be configured: two tabs on one server can sit in different databases.
 */
const context = ref<QueryContext>({
  connectionId: props.params.params.connectionId,
  database: props.params.params.database ?? undefined,
  schema: props.params.params.schema ?? undefined,
})

const sql = ref(props.params.params.initialSql ?? '')

const state = ref<'idle' | 'running' | 'done' | 'error' | 'cancelled'>('idle')

/**
 * What one statement of the last run produced. A script produces one of
 * these per statement, each with its own grid; a single run produces one.
 */
interface RunOutcome {
  /** The statement's first line, for the tab that shows its result. */
  label: string
  text: string
  slice: SqlSlice
  result?: QueryResult
  error?: DriverError
  cancelled?: boolean
  /** The result read as a plan tree, when a visual explain produced it. */
  plan?: ParsedPlan
}

const outcomes = ref<RunOutcome[]>([])
const activeOutcome = ref(0)
/** Bumped per run, so each result gets a grid of its own rather than a reused one. */
const runId = ref(0)

const current = computed(() => outcomes.value[activeOutcome.value] ?? null)
const result = computed(() => current.value?.result ?? null)
const error = computed(() => current.value?.error ?? null)

/**
 * The same failure as something the editor can point at, when the engine said
 * where it was. It is cleared on the first keystroke after the run: a marker is
 * pinned to a character offset and does not move with the text under it, so
 * keeping it would soon be underlining the wrong token.
 */
const problem = ref<SqlProblem | null>(null)
const editor = useTemplateRef<{
  revealProblem: () => void
  focus: () => void
  sliceToRun: () => SqlSlice | null
  markRan: (slice: SqlSlice | null) => void
  replaceRange: (start: number, end: number, text: string) => void
  hasSelection: () => boolean
  append: (text: string) => void
}>('editor')

watch(sql, () => { problem.value = null })

/* ------------------------------------------------------------ row limit -- */

/** The choices offered; the last is "as much as the grid can hold". */
const LIMIT_OPTIONS = QUERY_LIMIT_OPTIONS

/**
 * How many rows a result may bring back. Starts from the setting and is then
 * this tab's own: a one-off "give me everything" should not quietly become
 * the default for every tab opened after it.
 */
const maxRows = ref(settings.value.queryLimit)

function limitLabel(limit: number) {
  return limit >= 1_000_000 ? '1M' : limit >= 1_000 ? `${limit / 1_000}k` : String(limit)
}

/* --------------------------------------------------------------- file -- */

const filePath = ref<string | null>(props.params.params.filePath ?? null)
// A tab restored with a file is a use of that file as much as opening it was.
if (filePath.value) rememberFile(filePath.value)
/** The text as it was last read from or written to disk. */
const savedSql = ref(filePath.value ? sql.value : '')
const fileDirty = computed(() => Boolean(filePath.value) && sql.value !== savedSql.value)
const fileError = ref<string | null>(null)

/**
 * The dialect the grid's "Copy as INSERT" writes in. A query result has no
 * table of its own, so the statements name a placeholder to be edited.
 */
const dialect = computed<SqlDialect>(() => {
  const profile = connections.profiles.value.find((p) => p.id === context.value.connectionId)
  const driver = profile ? connections.driverOf(profile) : null

  return {
    table: quoteIdentifier('table_name', driver?.quote ?? '"'),
    quote: driver?.quote ?? '"',
    escapeBackslashes: driver?.id === 'mysql' || driver?.id === 'mariadb',
  }
})

/** Set while a statement is in flight, so the Run button can become Stop. */
const running = shallowRef<ReturnType<typeof run> | null>(null)
const stopping = ref(false)
const elapsed = ref(0)

const connected = computed(
  () => Boolean(context.value.connectionId)
    && connections.stateOf(context.value.connectionId!).status === 'connected',
)

/**
 * Whether the editor's completions have a schema behind them.
 *
 * A read that fails leaves the suggestion list quietly reduced to keywords,
 * which looks exactly like a feature that does not work; this says which it is.
 */
const schema = computed(
  () => completions.statusFor(context.value.connectionId, context.value.database),
)

/** The name the tab was opened under, before the context is appended to it. */
const openedAs = props.params.params.title ?? props.params.api.title ?? 'Query'
const autoTitle = computed(() => !filePath.value && (props.params.params.autoTitle ?? true))

/** A file's name once there is a file; the tab's own name until then. */
const baseTitle = computed(() => (filePath.value ? fileName(filePath.value) : openedAs))

const connectionName = computed(
  () => connections.profiles.value.find((p) => p.id === context.value.connectionId)?.name ?? null,
)

// The toolbar only speaks for the focused tab; the tab strip has to answer
// "which server is that one on?" for all of them at once — the question two
// tabs of the same query, one on prod and one on dev, exist to raise.
watch(
  [connectionName, () => context.value.database, baseTitle, fileDirty],
  ([name, database, base, dirty]) => {
    const where = [name, autoTitle.value ? database : null].filter(Boolean).join(' · ')
    const title = where ? `${base} · ${where}` : base
    props.params.api.setTitle(dirty ? `● ${title}` : title)
  },
  { immediate: true },
)

/**
 * Panel params are what a restored layout reads back, so the context and the
 * text are written into them rather than living only in this component. The
 * text goes through on a debounce: every keystroke is a change, and the
 * layout store does not need to hear about each one.
 *
 * The layout is saved explicitly afterwards: dockview does not count a change
 * of parameters as a change of layout, so without this the text would sit in
 * the params until something else — a tab opening — happened to persist them.
 */
function writeParams() {
  props.params.api.updateParameters({
    connectionId: context.value.connectionId,
    database: context.value.database ?? null,
    schema: context.value.schema ?? null,
    initialSql: sql.value,
    title: openedAs,
    autoTitle: props.params.params.autoTitle ?? true,
    filePath: filePath.value,
  } satisfies QueryPanelParams)

  saveLayout()
}

watch([context, filePath], writeParams, { deep: true })

let paramsTimer: number | undefined
watch(sql, () => {
  window.clearTimeout(paramsTimer)
  paramsTimer = window.setTimeout(writeParams, 600)
})
onBeforeUnmount(() => window.clearTimeout(paramsTimer))

/**
 * What the last run was about: the selection, one statement, or the script.
 * The summary line says which, so "0 rows" is never a mystery about which
 * of five statements it describes.
 */
const ranSlice = ref<SqlSlice | null>(null)

/**
 * The statements of a script, each with where it sits in the buffer.
 *
 * Split here rather than sent whole: MySQL refuses a script with two
 * statements in it and SQLite runs the first and drops the rest, so the only
 * way a script behaves the same on every engine is one statement at a time.
 * Comments between statements are dropped; a trailing semicolon is not sent.
 */
function statementsOf(text: string, base = 0): SqlSlice[] {
  const tokens = tokenize(text)
  const slices: SqlSlice[] = []
  let body: typeof tokens = []

  const flush = () => {
    const meaningful = body.filter((token) => token.kind !== 'comment')
    if (meaningful.length) {
      const start = meaningful[0]!.start
      const end = meaningful.at(-1)!.end
      slices.push({ text: text.slice(start, end), start: base + start, end: base + end, source: 'statement' })
    }
    body = []
  }

  for (const token of tokens) {
    if (token.kind === 'punct' && token.text === ';') flush()
    else body.push(token)
  }
  flush()

  return slices
}

/** How each engine spells "show me the plan", and "run it and show me". */
const EXPLAIN_PREFIX: Record<string, string> = {
  postgres: 'explain ',
  mysql: 'explain ',
  mariadb: 'explain ',
  sqlite: 'explain query plan ',
}

const EXPLAIN_ANALYZE_PREFIX: Record<string, string> = {
  postgres: 'explain (analyze, buffers) ',
  mysql: 'explain analyze ',
  mariadb: 'analyze ',
}

/**
 * The same two questions in the shape the plan tree is read from. MariaDB
 * has no EXPLAIN ANALYZE; its `ANALYZE FORMAT=JSON` is the JSON plan with
 * the actual figures added, so it is read the same way as the estimate.
 */
const PLAN_PREFIX: Record<string, string> = {
  postgres: 'explain (format json) ',
  mysql: 'explain format=json ',
  mariadb: 'explain format=json ',
  sqlite: 'explain query plan ',
}

const PLAN_ANALYZE_PREFIX: Record<string, string> = {
  postgres: 'explain (analyze, buffers, format json) ',
  mysql: 'explain analyze ',
  mariadb: 'analyze format=json ',
}

const driverId = computed(() => (profile.value ? connections.driverOf(profile.value).id : null))
const canAnalyze = computed(() => Boolean(driverId.value && EXPLAIN_ANALYZE_PREFIX[driverId.value]))
const canPlanAnalyze = computed(() => Boolean(driverId.value && PLAN_ANALYZE_PREFIX[driverId.value]))

type RunMode = 'statement' | 'script' | 'explain' | 'analyze' | 'plan' | 'planAnalyze'

/** How the statement is wrapped for each mode that asks the engine about it. */
const MODE_PREFIXES: Partial<Record<RunMode, Record<string, string>>> = {
  explain: EXPLAIN_PREFIX,
  analyze: EXPLAIN_ANALYZE_PREFIX,
  plan: PLAN_PREFIX,
  planAnalyze: PLAN_ANALYZE_PREFIX,
}

/**
 * Values for the bind parameters this tab has been asked for, kept so the
 * next run of the same statement starts from them.
 */
const parameterValues = ref<Record<string, string>>({})

/**
 * Fills in `:name` and `$1` markers, asking for whatever is not known yet.
 * Returns null when the prompt was dismissed, which cancels the run.
 */
async function bindParameters(statements: SqlSlice[]): Promise<boolean> {
  const names = [...new Set(statements.flatMap((statement) => findParameters(statement.text).map((p) => p.name)))]
  if (!names.length) return true

  const values = await openParameters(names, parameterValues.value)
  if (!values) return false

  parameterValues.value = { ...parameterValues.value, ...values }
  const escapeBackslashes = driverId.value === 'mysql' || driverId.value === 'mariadb'

  for (const statement of statements) {
    statement.text = substituteParameters(statement.text, values, escapeBackslashes)
  }

  return true
}

/**
 * Runs the statement under the caret — or the selection, when there is one —
 * with Ctrl+Enter, and the whole buffer with Ctrl+Shift+Enter or the menu.
 * "Explain" runs the same statement under the engine's EXPLAIN.
 *
 * "Statement" is the default because it is what every other client does. A
 * script runs one statement at a time, each into a result tab of its own,
 * and stops at the first that fails: what follows usually depended on it.
 */
async function execute(mode: RunMode = 'statement') {
  if (state.value === 'running') return

  const picked: SqlSlice | null = mode === 'script'
    ? { text: sql.value, start: 0, end: sql.value.length, source: 'all' }
    : editor.value?.sliceToRun() ?? null

  // Nothing under the caret and nothing selected: fall back to the whole
  // buffer rather than to a "nothing to run" error the user has to decode.
  const target = picked ?? { text: sql.value, start: 0, end: sql.value.length, source: 'all' as const }

  const statements = target.source === 'all'
    ? statementsOf(target.text)
    : [target]

  if (!statements.length) return

  // Parameters first: a guard should see the statement as it will run.
  if (!await bindParameters(statements)) return

  const prefixes = MODE_PREFIXES[mode]
  if (prefixes) {
    const prefix = prefixes[driverId.value ?? ''] ?? 'explain '

    for (const statement of statements) statement.text = prefix + statement.text
  }

  // Analyze runs the statement for real, so the guards apply to it too.
  // The consent given here travels with the statements: the main process
  // refuses a write on a read-only connection unless it hears it.
  const consent = mode === 'explain' || mode === 'plan' ? 'read' : await guardWrites(statements.map((statement) => statement.text))
  if (!consent) return
  const allowWrite = consent === 'write'

  if (!await ensureTransaction()) return

  lastMode.value = mode
  state.value = 'running'
  problem.value = null
  stopping.value = false
  ranSlice.value = target
  outcomes.value = []
  activeOutcome.value = 0
  runId.value += 1
  editor.value?.markRan(target)

  // A visible timer is what tells someone a statement is worth stopping.
  elapsed.value = 0
  const startedAt = performance.now()
  const ticker = window.setInterval(() => {
    elapsed.value = Math.round((performance.now() - startedAt) / 100) / 10
  }, 100)

  try {
    for (const statement of statements) {
      const outcome: RunOutcome = { label: headlineOf(statement.text), text: statement.text, slice: statement }
      const position = outcomes.value.length
      outcomes.value = [...outcomes.value, outcome]
      activeOutcome.value = position

      // Rows are drawn as they arrive: the first batch brings the columns
      // and a provisional result, and each batch after it grows the copy the
      // grid reads. Copied per batch on purpose — the array the batches fill
      // is raw, and the one in `outcomes` is a proxy of a different object.
      const arrived: CellValue[][] = []
      const handle = run(
        { ...context.value, transactionId: transactionId.value ?? undefined },
        statement.text,
        maxRows.value,
        {
          stream: true,
          allowWrite,
          onRows: (rows, columns) => {
            for (const row of rows) arrived.push(row)
            outcome.result = {
              columns,
              rows: arrived.slice(),
              rowCount: arrived.length,
              truncated: false,
              durationMs: Math.round(performance.now() - startedAt),
            }
            outcomes.value = outcomes.value.map((item, index) => (index === position ? { ...outcome } : item))
          },
        },
      )
      running.value = handle

      try {
        outcome.result = await handle.result
        if (transactionId.value) pendingCount.value += 1
        if (mode === 'plan' || mode === 'planAnalyze') outcome.plan = planOf(outcome.result, mode === 'planAnalyze')
      }
      catch (cause) {
        if (isCancellation(cause)) {
          outcome.cancelled = true
          state.value = 'cancelled'
        }
        else {
          outcome.error = toDriverError(cause)
          problem.value = offsetProblem(toSqlProblem(outcome.error), statement)
          state.value = 'error'
        }
      }

      // Written back as a fresh object at its position: `outcome` itself is
      // the raw object, and the array holds a reactive proxy of it, so a
      // mutation of the raw one is invisible to everything watching the
      // array — the grid included.
      outcomes.value = outcomes.value.map((item, index) => (index === position ? { ...outcome } : item))
      remember(outcome)

      if (outcome.error || outcome.cancelled) break
    }

    if (state.value === 'running') state.value = 'done'
  }
  finally {
    window.clearInterval(ticker)
    running.value = null
    stopping.value = false
  }

  // The summary line changes silently; a screen reader hears it here.
  if (state.value === 'error') announce(`Query failed: ${error.value?.message ?? ''}`, 'assertive')
  else announce(summary.value ?? '')
}

/** The statement's first meaningful line, for a result tab's label. */
function headlineOf(text: string) {
  const line = text.split('\n').map((part) => part.trim()).find((part) => part && !part.startsWith('--')) ?? text.trim()
  return line.length > 40 ? `${line.slice(0, 39)}…` : line
}

/**
 * The plan tree in a visual explain's result, or nothing when it cannot be
 * read — an engine version with a shape the reader does not know, say. The
 * result itself is still there, so the grid shows the text as it came.
 */
function planOf(produced: QueryResult, analyzed: boolean): ParsedPlan | undefined {
  if (!driverId.value || !produced.rows.length) return undefined

  try {
    return parsePlanResult(driverId.value, analyzed, produced.rows)
  }
  catch {
    return undefined
  }
}

/** The last run's mode, so F5 can do it again the same way. */
const lastMode = ref<RunMode | null>(null)

// F5 runs again what ran last — statement, script or explain — and, before
// anything has run, the statement at the cursor.
const unregisterRefresh = useRefreshables().register(
  props.params.api.id,
  () => execute(lastMode.value ?? 'statement'),
)
onBeforeUnmount(unregisterRefresh)

/* ------------------------------------------------------- transactions -- */

/**
 * Whether each statement commits by itself. Off, the tab holds one
 * connection open and every statement joins the same transaction until
 * Commit or Rollback — the way to try an UPDATE and look at the result
 * before it is real.
 */
const autoCommit = ref(true)
const transactionId = ref<string | null>(null)
/** Statements run inside the open transaction, for the badge. */
const pendingCount = ref(0)

/** Opens the transaction a manual-commit tab runs in, once. */
async function ensureTransaction() {
  if (autoCommit.value || transactionId.value || !context.value.connectionId) return true

  try {
    const opened = await bridge().transaction.begin(context.value.connectionId, {
      database: context.value.database,
      schema: context.value.schema,
    })
    transactionId.value = opened.transactionId
    pendingCount.value = 0
    return true
  }
  catch (cause) {
    fileError.value = `Could not begin a transaction: ${cause instanceof Error ? cause.message : String(cause)}`
    return false
  }
}

async function endTransaction(action: 'commit' | 'rollback') {
  const id = transactionId.value
  if (!id) return

  transactionId.value = null
  const count = pendingCount.value
  pendingCount.value = 0

  try {
    await bridge().transaction.end(id, action)
    announce(action === 'commit' ? `Committed ${count} statement${count === 1 ? '' : 's'}` : 'Rolled back')
    fileError.value = null
  }
  catch (cause) {
    fileError.value = `Could not ${action}: ${cause instanceof Error ? cause.message : String(cause)}`
  }
}

// A transaction belongs to one connection and one database; pointing the
// tab elsewhere while one is open would leave it dangling on the old one.
watch(
  [() => context.value.connectionId, () => context.value.database],
  () => { if (transactionId.value) endTransaction('rollback') },
)

// Closing the tab must not leave a connection pinned to a dead transaction.
onBeforeUnmount(() => { if (transactionId.value) endTransaction('rollback') })

/* ------------------------------------------------------ close guard -- */

const closeGuards = useCloseGuards()

const unregisterGuard = closeGuards.register(props.params.api.id, {
  dirty: () => fileDirty.value || transactionId.value !== null,
  mayClose: async () => {
    const reasons = [
      fileDirty.value ? `${baseTitle.value} has unsaved changes.` : null,
      transactionId.value ? `An open transaction with ${pendingCount.value} statement${pendingCount.value === 1 ? '' : 's'} will be rolled back.` : null,
    ].filter(Boolean)

    return confirm({
      title: 'Close this tab?',
      message: reasons.join(' '),
      confirmLabel: 'Close',
      danger: true,
    })
  },
})
onBeforeUnmount(unregisterGuard)

/** Statements that only read, as their first word says. */
const READ_ONLY_VERBS = new Set(['select', 'with', 'show', 'explain', 'describe', 'desc', 'pragma', 'values', 'table'])

/**
 * Whether a statement could change anything, judged by its first keyword.
 *
 * A guess on purpose: `with … as (delete …)` writes, and `select` into a
 * function can too. The question here is only "is it worth asking?", and the
 * cost of a wrong answer is one extra dialog, so the guess errs towards
 * asking. Comments and leading whitespace are skipped by the tokenizer.
 */
function mayWrite(text: string) {
  const first = tokenize(text).find((token) => token.kind === 'word')
  return !first || !READ_ONLY_VERBS.has(first.text.toLowerCase())
}

/**
 * A DELETE or UPDATE with no WHERE at all, which touches every row.
 *
 * Judged on the top level of the statement only: a WHERE inside a
 * subquery does not narrow the outer statement, so parentheses are
 * skipped over. `update … from` and `delete … using` are still caught,
 * since neither adds a WHERE by itself.
 */
function touchesEveryRow(text: string) {
  const tokens = tokenize(text).filter((token) => token.kind !== 'comment')
  const first = tokens[0]
  if (!first || first.kind !== 'word') return false

  const verb = first.text.toLowerCase()
  if (verb !== 'delete' && verb !== 'update') return false

  let depth = 0
  for (const token of tokens) {
    if (token.kind === 'punct') {
      if (token.text === '(') depth += 1
      else if (token.text === ')') depth = Math.max(0, depth - 1)
      continue
    }
    if (depth === 0 && token.kind === 'word' && token.text.toLowerCase() === 'where') return false
  }

  return true
}

/**
 * The questions worth asking before a run, asked once for the whole batch.
 *
 * A DELETE or UPDATE without a WHERE asks on every connection: it is the one
 * statement nobody meant. A connection marked read-only asks about any
 * write — not refused, confirmed. The mark exists for the tab that turned
 * out to be on production; the person who meant it can still say so.
 *
 * Resolves with `false` to stop, `'read'` to run without a word to the
 * read-only guard, and `'write'` when the user confirmed a write on a
 * read-only connection, which the main process has to be told.
 */
async function guardWrites(texts: string[]): Promise<false | 'read' | 'write'> {
  const unbounded = texts.filter(touchesEveryRow)

  if (unbounded.length) {
    const ok = await confirm({
      title: 'No WHERE clause',
      message: unbounded.length === 1
        ? `This statement has no WHERE clause, so it affects every row: ${headlineOf(unbounded[0]!)}`
        : `${unbounded.length} statements have no WHERE clause and would affect every row of their tables.`,
      confirmLabel: 'Run anyway',
      danger: true,
    })
    if (!ok) return false
  }

  if (!profile.value?.readOnly) return 'read'

  const writes = texts.filter(mayWrite)
  if (!writes.length) return 'read'

  const ok = await confirm({
    title: `${profile.value.name} is marked read-only`,
    message: writes.length === 1
      ? 'This statement may write to the database. Run it anyway?'
      : `${writes.length} of these statements may write to the database. Run them anyway?`,
    confirmLabel: 'Run',
    danger: true,
  })

  return ok ? 'write' : false
}

/**
 * The engine counts lines from the start of what it was sent, which for a
 * statement in the middle of a buffer is not line one of the editor. Shifted
 * here so the marker lands on the token the engine meant.
 */
function offsetProblem(found: SqlProblem | null, slice: SqlSlice): SqlProblem | null {
  if (!found || slice.start === 0) return found

  const before = sql.value.slice(0, slice.start)
  const linesBefore = before.split('\n').length - 1
  const lastBreak = before.lastIndexOf('\n')
  // A fault on the slice's first line is offset by whatever precedes the
  // slice on that same editor line; later lines start at column one anyway.
  const columnShift = found.line === 1 ? before.length - lastBreak - 1 : 0

  return { ...found, line: found.line + linesBefore, column: found.column + columnShift }
}

/** Files the run in the history, whatever became of it. */
function remember(outcome: RunOutcome) {
  if (!context.value.connectionId || profile.value?.noHistory) return

  const produced = outcome.result

  history.record({
    connectionId: context.value.connectionId,
    database: context.value.database,
    schema: context.value.schema,
    sql: outcome.text,
    outcome: outcome.error ? 'error' : outcome.cancelled ? 'cancelled' : 'ok',
    durationMs: produced?.durationMs,
    rowCount: produced?.columns.length ? produced.rowCount : undefined,
    affectedRows: produced?.affectedRows,
    error: outcome.error?.message,
  })
}

/* ------------------------------------------------------------ history -- */

function useHistoryEntry(entry: QueryHistoryEntry) {
  editor.value?.append(entry.sql)
}

function openHistoryEntry(entry: QueryHistoryEntry) {
  openQuery({
    connectionId: entry.connectionId,
    database: entry.database,
    schema: entry.schema,
    sql: entry.sql,
  })
}

/* ------------------------------------------------------ saved queries -- */

/**
 * Keeps the selection, or the whole buffer when nothing is selected, under
 * a name. The tab's context goes with it: a query saved for one connection
 * is offered on that connection first.
 */
async function saveQuery() {
  const target = editor.value?.hasSelection() ? editor.value.sliceToRun() : null
  const text = (target?.text ?? sql.value).trim()
  if (!text) return

  await openSaveQuery({
    sql: text,
    connectionId: context.value.connectionId,
    database: context.value.database,
    schema: context.value.schema,
  })
}

function useSavedQuery(query: SavedQuery) {
  editor.value?.append(query.sql)
}

/** A saved query opens on its own connection; an unscoped one on this tab's. */
function openSavedQuery(query: SavedQuery) {
  openQuery({
    connectionId: query.connectionId ?? context.value.connectionId,
    database: query.database,
    schema: query.schema,
    sql: query.sql,
    title: query.name,
  })
}

/* ------------------------------------------------------------- format -- */

/** sql-formatter's name for each engine's dialect. */
const FORMATTER_LANGUAGE = {
  postgres: 'postgresql',
  mysql: 'mysql',
  mariadb: 'mariadb',
  sqlite: 'sqlite',
} as const

/**
 * Reformats the selection, or the whole buffer when nothing is selected.
 *
 * Loaded on first use: the formatter is a parser of its own and most sessions
 * never ask for it. Keyword case is left as typed — a formatter that also
 * changes the words is two opinions where one was asked for.
 */
async function format() {
  const target = editor.value?.hasSelection()
    ? editor.value.sliceToRun()
    : { text: sql.value, start: 0, end: sql.value.length, source: 'all' as const }

  if (!target?.text.trim()) return

  const profile = connections.profiles.value.find((p) => p.id === context.value.connectionId)
  const driverId = profile ? connections.driverOf(profile).id : null
  const language = driverId ? FORMATTER_LANGUAGE[driverId] : 'sql'

  try {
    const { format: formatSql } = await import('sql-formatter')
    const pretty = formatSql(target.text, {
      language,
      keywordCase: 'preserve',
      tabWidth: 2,
      linesBetweenQueries: 2,
    })

    editor.value?.replaceRange(target.start, target.end, pretty)
  }
  catch (cause) {
    // The formatter has a stricter grammar than the engines do; what it
    // cannot parse is left exactly as it was, and said so.
    fileError.value = `Could not format: ${cause instanceof Error ? cause.message : String(cause)}`
  }
}

/* --------------------------------------------------------------- file -- */

const SQL_FILTERS = [{ name: 'SQL', extensions: ['sql'] }, { name: 'All files', extensions: ['*'] }]

/** Writes the buffer to its file, asking where only when it has none yet. */
async function saveFile(askWhere = false) {
  if (!isAvailable.value) return

  fileError.value = null

  try {
    const saved = await bridge().saveFile({
      suggestedName: filePath.value ? fileName(filePath.value) : `${openedAs.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.sql`,
      content: sql.value,
      path: askWhere ? undefined : filePath.value ?? undefined,
      filters: SQL_FILTERS,
    })

    if (!saved.saved || !saved.path) return

    filePath.value = saved.path
    savedSql.value = sql.value
    rememberFile(saved.path)
  }
  catch (cause) {
    fileError.value = cause instanceof Error ? cause.message : String(cause)
  }
}

// The File menu reaches this tab through the registry, by its panel id.
const unregister = queryPanels.register(props.params.api.id, {
  save: () => saveFile(false),
  saveAs: () => saveFile(true),
  format,
  saveQuery,
  filePath: () => filePath.value,
})
onBeforeUnmount(unregister)

async function stop() {
  if (!running.value) return

  stopping.value = true
  await running.value.stop()
}

/**
 * Ctrl/Cmd+Enter runs and Esc stops, as in every other SQL client.
 *
 * Bound on the panel in the capture phase, and the propagation is stopped
 * rather than only the default action: the editor sits inside this element and
 * binds both keys itself — Ctrl+Enter to insert a line below, Escape to
 * dismiss its own widgets — and it acts on the event directly, so preventing
 * the browser's default does nothing to it. Capturing here is also what makes
 * the shortcuts work from the toolbar.
 */
function onKeydown(event: KeyboardEvent) {
  const chord = event.ctrlKey || event.metaKey

  if (chord && event.key === 'Enter') {
    event.preventDefault()
    event.stopPropagation()
    execute(event.shiftKey ? 'script' : 'statement')
    return
  }

  if (chord && event.key.toLowerCase() === 's') {
    // Ctrl+S in the grid below is "save the edits", which a query result
    // cannot have; here the whole panel is the script, and this is its save.
    // With Alt it is the menu's "Save Query…", which this capture handler
    // would otherwise swallow before the window binding saw it.
    event.preventDefault()
    event.stopPropagation()
    if (event.altKey) saveQuery()
    else saveFile(event.shiftKey)
    return
  }

  if (chord && event.shiftKey && event.key.toLowerCase() === 'f') {
    event.preventDefault()
    event.stopPropagation()
    format()
    return
  }

  if (event.key === 'Escape' && state.value === 'running') {
    event.preventDefault()
    event.stopPropagation()
    stop()
  }
}

// A statement outlives its tab otherwise, holding a server-side connection.
onBeforeUnmount(() => running.value?.stop())

/**
 * The shown result again, whole, to a file. The grid holds at most `maxRows`
 * of it; the statement that produced it is run once more on the server with
 * no cap, and what it returns is streamed to disk rather than to the grid.
 */
function exportAll() {
  const outcome = current.value
  if (!outcome || !context.value.connectionId) return

  openExport({
    connectionId: context.value.connectionId,
    sql: outcome.text,
    database: context.value.database,
    schema: context.value.schema,
    suggestedName: baseTitle.value.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    dialect: dialect.value,
    description: 'every row the statement returns',
  })
}

const summary = computed(() => {
  if (state.value === 'running') return `${stopping.value ? 'Stopping' : 'Executing'}… ${elapsed.value.toFixed(1)}s`
  if (state.value === 'cancelled') return 'Cancelled'
  if (state.value === 'error') return null
  if (!result.value) return 'Ctrl+Enter runs the statement at the cursor'

  const outcome = result.value
  const parts: string[] = []

  // A script's summary is the whole script first, the shown tab second.
  if (outcomes.value.length > 1) {
    const total = outcomes.value.reduce((sum, item) => sum + (item.result?.durationMs ?? 0), 0)
    parts.push(`${outcomes.value.length} statements · ${total} ms`)
  }

  if (outcome.affectedRows !== undefined && !outcome.columns.length) {
    parts.push(`${outcome.affectedRows} row${outcome.affectedRows === 1 ? '' : 's'} affected`)
  }
  else {
    parts.push(outcome.truncated
      ? `first ${outcome.rowCount.toLocaleString()} rows`
      : `${outcome.rowCount.toLocaleString()} row${outcome.rowCount === 1 ? '' : 's'}`)
  }

  parts.push(`${outcome.durationMs} ms`)

  if (ranSlice.value?.source === 'selection') parts.push('selection')
  if (transactionId.value) parts.push('in transaction')

  return parts.join(' · ')
})
</script>

<template>
  <div class="@container flex h-full flex-col bg-bg" @keydown.capture="onKeydown">
    <div class="flex items-center gap-2 bg-surface/40 px-2 py-1.5">
      <button
        v-if="state === 'running'"
        type="button"
        class="btn btn-danger"
        :disabled="stopping"
        title="Stop (Esc)"
        @click="stop"
      >
        <AppIcon name="stop" :size="12" />
        {{ stopping ? 'Stopping…' : 'Stop' }}
      </button>

      <span v-else class="flex shrink-0 items-stretch">
        <button
          type="button"
          class="btn btn-accent rounded-r-none"
          :disabled="!connected"
          :title="connected ? 'Run the selection or the statement at the cursor (Ctrl+Enter)' : 'Connect first'"
          @click="execute('statement')"
        >
          <AppIcon name="play" :size="12" />
          Run
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger>
            <button
              type="button"
              class="btn btn-accent rounded-l-none border-l border-l-bg/30 px-1"
              :disabled="!connected"
              aria-label="More ways to run"
              title="More ways to run"
            >
              <AppIcon name="chevronDown" :size="12" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem icon="play" hint="Ctrl+Enter" @select="execute('statement')">
              Run Statement at Cursor
            </DropdownMenuItem>
            <DropdownMenuItem icon="play" hint="Ctrl+Shift+Enter" @select="execute('script')">
              Run Whole Script
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem icon="structure" @select="execute('explain')">
              Explain Statement
            </DropdownMenuItem>
            <DropdownMenuItem v-if="canAnalyze" icon="structure" @select="execute('analyze')">
              Explain Analyze
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem icon="plan" @select="execute('plan')">
              Visual Explain
            </DropdownMenuItem>
            <DropdownMenuItem v-if="canPlanAnalyze" icon="plan" @select="execute('planAnalyze')">
              Visual Explain Analyze
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>

      <QueryContextPicker v-model="context" />

      <ConnectionSwatch :profile="profile" lock />

      <label class="flex shrink-0 items-center gap-1 text-faint" title="How many rows a result may bring back">
        <span class="hidden @lg:inline">Rows</span>
        <select v-model.number="maxRows" class="field w-auto bg-surface px-1 py-0.5" aria-label="Row limit">
          <option v-for="option in LIMIT_OPTIONS" :key="option" :value="option">
            {{ limitLabel(option) }}
          </option>
        </select>
      </label>

      <!-- Manual commit: the checkbox is locked while a transaction is open,
           because flipping it then would have to mean commit or roll back,
           and a checkbox should never silently mean either. -->
      <label
        class="flex shrink-0 items-center gap-1 text-faint select-none"
        :title="transactionId ? 'Commit or roll back first' : 'Off: statements join one transaction until you commit'"
      >
        <input
          v-model="autoCommit"
          type="checkbox"
          class="accent-accent"
          :disabled="transactionId !== null || !connected"
        >
        <span class="hidden @lg:inline">Auto-commit</span>
      </label>

      <button
        type="button"
        class="btn-icon shrink-0"
        title="Format the selection, or everything (Ctrl+Shift+F)"
        aria-label="Format SQL"
        :disabled="!sql.trim()"
        @click="format"
      >
        <AppIcon name="format" :size="13" />
      </button>

      <QueryHistoryPopover
        :connection-id="context.connectionId"
        @use="useHistoryEntry"
        @open-in-tab="openHistoryEntry"
      />

      <SavedQueriesPopover
        :connection-id="context.connectionId"
        @use="useSavedQuery"
        @open-in-tab="openSavedQuery"
        @save-current="saveQuery"
      />

      <button
        type="button"
        class="btn-icon shrink-0"
        :class="fileDirty ? 'text-warning' : ''"
        :title="filePath ? `Save to ${filePath} (Ctrl+S)` : 'Save as a .sql file (Ctrl+S)'"
        aria-label="Save script"
        :disabled="!isAvailable || !sql.trim()"
        @click="saveFile(false)"
      >
        <AppIcon name="save" :size="13" />
      </button>

      <span
        v-if="schema.error"
        class="ml-auto flex items-center gap-1.5 text-warning"
        :title="`Completions are keyword-only: ${schema.error}`"
      >
        <AppIcon name="warning" :size="12" />
        No schema
      </span>

      <span
        class="min-w-0 truncate"
        :class="[schema.error ? '' : 'ml-auto', state === 'running' ? 'text-accent-bright tabular-nums' : 'text-faint']"
        :title="summary ?? undefined"
      >{{ summary }}</span>
    </div>

    <!-- Its own strip while a transaction is open: the toolbar is full, and
         a commit is a decision that deserves a line of its own to read. -->
    <div
      v-if="transactionId"
      class="flex shrink-0 items-center gap-2 border-b border-edge bg-warning/10 px-2 py-1"
      role="status"
    >
      <AppIcon name="pencil" :size="12" class="text-warning" />
      <span class="text-warning">
        Transaction open · {{ pendingCount }} statement{{ pendingCount === 1 ? '' : 's' }} not committed
      </span>
      <span class="ml-auto flex items-center gap-1">
        <button type="button" class="btn btn-ghost" title="Roll the transaction back" @click="endTransaction('rollback')">
          Rollback
        </button>
        <button type="button" class="btn btn-accent" title="Commit the transaction" @click="endTransaction('commit')">
          <AppIcon name="check" :size="12" />
          Commit
        </button>
      </span>
    </div>

    <p
      v-if="fileError"
      class="flex shrink-0 items-start gap-2 border-b border-edge bg-danger/10 px-3 py-1 text-danger"
    >
      <AppIcon name="warning" class="mt-0.5" />
      <span class="selectable min-w-0 flex-1">{{ fileError }}</span>
      <button type="button" class="btn-icon shrink-0" title="Dismiss" @click="fileError = null">
        <AppIcon name="close" :size="11" />
      </button>
    </p>

    <!-- Two pixels of "something is happening", in the one place the eye is
         already resting while a statement runs. Otherwise the connection's
         own colour, so a tab on production is marked along its whole width. -->
    <div
      class="h-0.5 shrink-0"
      :class="state === 'running' ? 'app-progress' : profile?.color ? '' : 'bg-edge'"
      :style="state !== 'running' && profile?.color ? { backgroundColor: profile.color } : undefined"
    />

    <SqlEditor
      ref="editor"
      v-model="sql"
      :problem="problem"
      :context="context"
      placeholder="select 1;"
      class="h-[30%] min-h-[96px] w-full"
    />

    <div class="h-px shrink-0 bg-edge" />

    <!-- One tab per statement of a script, each with its own outcome. -->
    <div
      v-if="outcomes.length > 1"
      class="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-edge bg-surface/40 px-2 py-1"
      role="tablist"
      aria-label="Statement results"
    >
      <button
        v-for="(outcome, index) in outcomes"
        :key="index"
        type="button"
        role="tab"
        class="btn btn-ghost max-w-64 shrink-0 gap-1.5 px-2 py-0.5"
        :data-active="index === activeOutcome"
        :aria-selected="index === activeOutcome"
        :title="outcome.text"
        @click="activeOutcome = index"
      >
        <span
          class="size-1.5 shrink-0 rounded-full"
          :class="outcome.error ? 'bg-danger' : outcome.cancelled ? 'bg-warning' : outcome.result ? 'bg-success' : 'bg-faint app-pulse'"
        />
        <span class="text-faint tabular-nums">{{ index + 1 }}</span>
        <span class="truncate font-mono">{{ outcome.label }}</span>
        <span v-if="outcome.result" class="shrink-0 text-faint tabular-nums">
          {{ outcome.result.columns.length ? outcome.result.rowCount : `${outcome.result.affectedRows ?? 0} affected` }}
        </span>
      </button>
    </div>

    <div class="min-h-0 flex-1">
      <div v-if="error" class="h-full overflow-auto p-3">
        <p
          class="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-danger"
        >
          <AppIcon name="warning" class="mt-0.5" />
          <span class="selectable font-mono">{{ error.message }}</span>
        </p>

        <div class="mt-1 flex flex-wrap items-center gap-x-3 pl-6 text-faint">
          <button
            v-if="problem"
            type="button"
            class="underline decoration-dotted underline-offset-2 hover:text-danger"
            title="Jump to it in the editor"
            @click="editor?.revealProblem()"
          >
            Line {{ problem.line }}, column {{ problem.column }}
          </button>

          <span v-if="error.code">{{ error.code }}</span>
        </div>

        <!-- What Postgres calls DETAIL and HINT: often the whole answer. -->
        <p v-if="error.detail" class="selectable mt-2 pl-6 text-muted">
          {{ error.detail }}
        </p>
        <p v-if="error.hint" class="selectable mt-1 pl-6 text-muted">
          Hint: {{ error.hint }}
        </p>

        <!-- Kept verbatim so the engine's own phrasing is still searchable. -->
        <p v-if="error.raw" class="selectable mt-2 pl-6 font-mono text-faint">
          {{ error.raw }}
        </p>
      </div>

      <p v-else-if="current?.cancelled" class="p-3 text-warning">
        Cancelled.
      </p>

      <!-- A visual explain, drawn as a tree; a plan that could not be read
           falls through to the grid, where the engine's text still is. -->
      <PlanView
        v-else-if="current?.plan"
        :key="`${runId}:${activeOutcome}`"
        :plan="current.plan"
      />

      <!-- Keyed per result: a grid handed a result of a different shape keeps
           the old one's measurements, and a fresh mount is cheaper than
           teaching every piece of grid state to notice. -->
      <ResultGrid
        v-else-if="result?.columns.length"
        :key="`${runId}:${activeOutcome}`"
        :result="result"
        :export-name="baseTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-')"
        :dialect="dialect"
        :export-all="connected ? exportAll : undefined"
        read-only-reason="A query result has no single table behind it, so its rows cannot be written back. Open the table itself to edit it."
      />

      <p v-else-if="result" class="p-3 text-muted">
        Statement completed.
        <span v-if="result.affectedRows !== undefined">{{ result.affectedRows }} rows affected.</span>
      </p>

      <div v-else class="flex h-full flex-col items-center justify-center gap-1.5 text-faint">
        <p class="flex items-center gap-2">
          <kbd class="kbd">Ctrl</kbd><span>+</span><kbd class="kbd">Enter</kbd>
          runs the statement at the cursor, or the selection
        </p>
        <p class="flex items-center gap-2">
          <kbd class="kbd">Ctrl</kbd><span>+</span><kbd class="kbd">Shift</kbd><span>+</span><kbd class="kbd">Enter</kbd>
          runs the whole script
        </p>
      </div>
    </div>
  </div>
</template>
