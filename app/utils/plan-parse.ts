/**
 * The engines' EXPLAIN output, read into one tree shape.
 *
 * Each engine describes a plan in its own way — Postgres and MySQL as JSON of
 * two unrelated shapes, MySQL's EXPLAIN ANALYZE as indented text, SQLite as
 * rows with parent ids — and the view that draws a plan should not have to
 * know which. Everything the view paints as a column is lifted onto the node;
 * everything else is kept, as text, for the details pane.
 */

export interface PlanNode {
  /** "Seq Scan", "Hash Join", "users (ref)", "SCAN users USING INDEX …". */
  label: string
  /** Relation, index, condition — the one line that says what the node is on. */
  detail?: string
  estimatedRows?: number
  actualRows?: number
  loops?: number
  /** Total cost, in the engine's own units. */
  cost?: number
  startupMs?: number
  /** Actual time per loop, children included. */
  totalMs?: number
  /** Time spent in this node alone, across all loops; never negative. */
  selfMs?: number
  buffers?: { sharedHit?: number, sharedRead?: number, tempWritten?: number }
  /** Everything else the engine said about the node. */
  extras: Record<string, string | number | boolean>
  children: PlanNode[]
}

export interface ParsedPlan {
  root: PlanNode
  engine: 'postgres' | 'mysql' | 'sqlite'
  planningMs?: number
  executionMs?: number
  /** Whether the statement actually ran, so the actual columns mean something. */
  analyzed: boolean
  raw: string
}

type Scalar = string | number | boolean

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A number, whether the engine wrote one or quoted it — MySQL quotes its costs. */
function num(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * A value as something the details pane can print on one line: scalars as
 * they are, a list of scalars comma-joined, anything deeper as compact JSON.
 */
function scalarize(value: unknown): Scalar {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value) && value.every((item) => typeof item !== 'object' || item === null)) {
    return value.map((item) => String(item)).join(', ')
  }
  return JSON.stringify(value)
}

function makeNode(label: string, children: PlanNode[] = []): PlanNode {
  return { label, extras: {}, children }
}

/**
 * Exclusive times, bottom up. A node's actual time includes its children's,
 * and both are per loop, so the subtraction is on the totals; the clamp is
 * for the rounding the engines do, which can leave a parent a hair under the
 * sum of its children.
 */
function computeSelfTimes(node: PlanNode) {
  for (const child of node.children) computeSelfTimes(child)

  if (node.totalMs === undefined) return

  const own = node.totalMs * (node.loops ?? 1)
  const below = node.children.reduce((sum, child) => sum + (child.totalMs ?? 0) * (child.loops ?? 1), 0)
  node.selfMs = Math.max(0, own - below)
}

function hasActuals(node: PlanNode): boolean {
  return node.totalMs !== undefined || node.actualRows !== undefined || node.children.some(hasActuals)
}

/* ----------------------------------------------------------- postgres -- */

/** The keys lifted onto the node's numeric fields, so they are not repeated as extras. */
const PG_LIFTED = new Set([
  'Node Type', 'Plans', 'Plan Rows', 'Actual Rows', 'Actual Loops', 'Total Cost',
  'Actual Startup Time', 'Actual Total Time', 'Shared Hit Blocks', 'Shared Read Blocks', 'Temp Written Blocks',
])

/** The clauses worth reading on the row itself, in the order the text format prints them. */
const PG_CLAUSES = [
  'Index Cond', 'Hash Cond', 'Merge Cond', 'Join Filter', 'Recheck Cond', 'Filter', 'One-Time Filter',
  'Sort Key', 'Group Key', 'TID Cond',
]

function pgNode(source: Record<string, unknown>): PlanNode {
  const nodeType = String(source['Node Type'] ?? 'Unknown')
  const joinType = typeof source['Join Type'] === 'string' ? source['Join Type'] : null
  const partial = typeof source['Partial Mode'] === 'string' && source['Partial Mode'] !== 'Simple' ? source['Partial Mode'] : null

  // Spelled the way the text format spells it — "Parallel Seq Scan", "Hash
  // Left Join", "Partial Aggregate" — since that is what people search for.
  let label = nodeType
  if (joinType && joinType !== 'Inner') {
    label = label.includes('Join') ? label.replace('Join', `${joinType} Join`) : `${label} ${joinType} Join`
  }
  if (partial) label = `${partial} ${label}`
  if (source['Parallel Aware'] === true) label = `Parallel ${label}`

  const node = makeNode(label)

  const relation = source['Relation Name'] ?? source['CTE Name'] ?? source['Function Name']
  const alias = source['Alias']
  const index = source['Index Name']
  const where: string[] = []
  if (typeof index === 'string') where.push(`using ${index}`)
  if (typeof relation === 'string') where.push(`on ${relation}${typeof alias === 'string' && alias !== relation ? ` ${alias}` : ''}`)
  else if (typeof alias === 'string') where.push(`on ${alias}`)

  const clauses = PG_CLAUSES
    .filter((key) => source[key] !== undefined)
    .map((key) => `${key}: ${scalarize(source[key])}`)

  const detail = [where.join(' '), ...clauses].filter(Boolean).join(' · ')
  if (detail) node.detail = detail

  node.estimatedRows = num(source['Plan Rows'])
  node.actualRows = num(source['Actual Rows'])
  node.loops = num(source['Actual Loops'])
  node.cost = num(source['Total Cost'])
  node.startupMs = num(source['Actual Startup Time'])
  node.totalMs = num(source['Actual Total Time'])

  const buffers = {
    sharedHit: num(source['Shared Hit Blocks']),
    sharedRead: num(source['Shared Read Blocks']),
    tempWritten: num(source['Temp Written Blocks']),
  }
  if (Object.values(buffers).some((value) => value !== undefined)) node.buffers = buffers

  for (const [key, value] of Object.entries(source)) {
    if (!PG_LIFTED.has(key)) node.extras[key] = scalarize(value)
  }

  const plans = source['Plans']
  if (Array.isArray(plans)) node.children = plans.filter(isObject).map(pgNode)

  return node
}

/** `EXPLAIN (FORMAT JSON …)`: one cell holding `[{ "Plan": … }]`. */
export function parsePostgresJsonPlan(text: string): ParsedPlan {
  const parsed: unknown = JSON.parse(text)
  const top = Array.isArray(parsed) ? parsed[0] : parsed
  if (!isObject(top) || !isObject(top['Plan'])) throw new Error('Not a Postgres JSON plan')

  const root = pgNode(top['Plan'])
  computeSelfTimes(root)

  return {
    root,
    engine: 'postgres',
    planningMs: num(top['Planning Time']),
    executionMs: num(top['Execution Time']),
    analyzed: hasActuals(root),
    raw: text,
  }
}

/* -------------------------------------------------------------- mysql -- */

/** The keys under which MySQL nests one operation inside another, and what to call each. */
const MYSQL_OPERATIONS: Record<string, string> = {
  query_block: 'Query block',
  ordering_operation: 'Sort',
  grouping_operation: 'Group',
  duplicates_removal: 'Distinct',
  buffer_result: 'Buffer',
  windowing: 'Window',
  union_result: 'Union',
  materialized_from_subquery: 'Materialize',
  insert_from: 'Insert from',
}

/** Lists of `{ dependent, cacheable, query_block }`, one subquery each. */
const MYSQL_SUBQUERY_LISTS = new Set([
  'subqueries', 'attached_subqueries', 'select_list_subqueries', 'having_subqueries', 'order_by_subqueries',
  'group_by_subqueries', 'optimized_away_subqueries', 'update_value_subqueries', 'query_specifications',
])

/** Table keys drawn as columns or in the detail line rather than as extras. */
const MYSQL_TABLE_LIFTED = new Set([
  'table_name', 'access_type', 'key', 'ref', 'attached_condition', 'rows_examined_per_scan',
])

/** Keys every MySQL and MariaDB node may carry that map onto the node's own fields. */
const MYSQL_COMMON_LIFTED = new Set(['cost_info', 'r_loops', 'r_total_time_ms', 'r_rows'])

/**
 * The cost and, on a MariaDB `ANALYZE`, the actual figures — the `r_` keys,
 * which sit beside the estimates on whichever node they describe.
 */
function applyMysqlCommon(node: PlanNode, source: Record<string, unknown>, skip: Set<string>) {
  const costInfo = source['cost_info']
  if (isObject(costInfo)) {
    const queryCost = num(costInfo['query_cost'])
    const read = num(costInfo['read_cost'])
    const evaluate = num(costInfo['eval_cost'])
    if (queryCost !== undefined) node.cost = queryCost
    else if (read !== undefined || evaluate !== undefined) node.cost = (read ?? 0) + (evaluate ?? 0)

    for (const [key, value] of Object.entries(costInfo)) {
      if (key !== 'query_cost' && key !== 'read_cost' && key !== 'eval_cost') node.extras[`cost_info.${key}`] = scalarize(value)
    }
  }

  node.loops = num(source['r_loops'])
  node.totalMs = num(source['r_total_time_ms'])
  node.actualRows = num(source['r_rows'])

  for (const [key, value] of Object.entries(source)) {
    if (skip.has(key) || MYSQL_COMMON_LIFTED.has(key)) continue
    if (key === 'table' || key === 'nested_loop' || key in MYSQL_OPERATIONS || MYSQL_SUBQUERY_LISTS.has(key)) continue
    node.extras[key] = scalarize(value)
  }
}

/** The operations nested inside an object, as nodes, in the order they appear. */
function mysqlChildren(source: Record<string, unknown>): PlanNode[] {
  const children: PlanNode[] = []

  for (const [key, value] of Object.entries(source)) {
    if (key === 'table' && isObject(value)) {
      children.push(mysqlTable(value))
    }
    else if (key === 'nested_loop' && Array.isArray(value)) {
      const joined = value.filter(isObject).flatMap(mysqlChildren)
      children.push(makeNode('Nested loop', joined))
    }
    else if (key in MYSQL_OPERATIONS && isObject(value)) {
      children.push(mysqlOperation(MYSQL_OPERATIONS[key]!, value))
    }
    else if (MYSQL_SUBQUERY_LISTS.has(key) && Array.isArray(value)) {
      for (const item of value.filter(isObject)) {
        children.push(mysqlOperation(key === 'query_specifications' ? 'Query specification' : 'Subquery', item))
      }
    }
  }

  return children
}

function mysqlOperation(label: string, source: Record<string, unknown>): PlanNode {
  const selectId = num(source['select_id'])
  const node = makeNode(label === 'Query block' && selectId !== undefined ? `Query block #${selectId}` : label)
  node.children = mysqlChildren(source)
  applyMysqlCommon(node, source, new Set())
  return node
}

function mysqlTable(source: Record<string, unknown>): PlanNode {
  const name = String(source['table_name'] ?? 'table')
  const access = typeof source['access_type'] === 'string' ? source['access_type'] : null
  const node = makeNode(access ? `${name} (${access})` : name)

  const parts: string[] = []
  if (typeof source['key'] === 'string') parts.push(`using ${source['key']}`)
  if (source['ref'] !== undefined) parts.push(`ref ${scalarize(source['ref'])}`)
  if (typeof source['attached_condition'] === 'string') parts.push(`where ${source['attached_condition']}`)
  if (parts.length) node.detail = parts.join(' · ')

  node.estimatedRows = num(source['rows_examined_per_scan'])
  node.children = mysqlChildren(source)
  applyMysqlCommon(node, source, MYSQL_TABLE_LIFTED)

  return node
}

/** `EXPLAIN FORMAT=JSON`, and MariaDB's `ANALYZE FORMAT=JSON`, which adds actual figures to the same shape. */
export function parseMysqlJsonPlan(text: string): ParsedPlan {
  const parsed: unknown = JSON.parse(text)
  if (!isObject(parsed) || !isObject(parsed['query_block'])) throw new Error('Not a MySQL JSON plan')

  const root = mysqlOperation('Query block', parsed['query_block'])
  computeSelfTimes(root)

  return { root, engine: 'mysql', analyzed: hasActuals(root), raw: text }
}

/**
 * One line of MySQL's EXPLAIN ANALYZE tree, without its arrow:
 * `Index lookup on t2 using idx (a=t1.a)  (cost=0.35 rows=1) (actual time=0.008..0.009 rows=1 loops=2)`.
 */
function mysqlTextNode(body: string): PlanNode {
  let description = body

  const cost = /\(cost=(?:[\d.]+\.\.)?([\d.eE+-]+)(?: rows=([\d.eE+-]+))?\)/.exec(description)
  const actual = /\(actual time=([\d.eE+-]+)\.\.([\d.eE+-]+) rows=([\d.eE+-]+) loops=([\d.eE+-]+)\)/.exec(description)
  const never = /\(never executed\)/.exec(description)

  for (const match of [cost, actual, never]) {
    if (match) description = description.replace(match[0], '')
  }
  description = description.trim()

  // "Filter: (t1.a > 1)" and "Aggregate: count(0)" name the operation before
  // the colon; "Index lookup on t2 using idx" names it before the relation.
  let label = description
  let detail: string | undefined
  const colon = description.indexOf(': ')
  const on = description.indexOf(' on ')
  if (colon > 0 && (on < 0 || colon < on)) {
    label = description.slice(0, colon)
    detail = description.slice(colon + 2)
  }
  else if (on > 0) {
    label = description.slice(0, on)
    detail = description.slice(on + 1)
  }

  const node = makeNode(label)
  if (detail) node.detail = detail

  if (cost) {
    node.cost = num(cost[1])
    node.estimatedRows = num(cost[2])
  }
  if (actual) {
    node.startupMs = num(actual[1])
    node.totalMs = num(actual[2])
    node.actualRows = num(actual[3])
    node.loops = num(actual[4])
  }
  if (never) {
    node.actualRows = 0
    node.loops = 0
    node.extras['never executed'] = true
  }

  return node
}

/** MySQL 8.0.18+ `EXPLAIN ANALYZE`: an indented text tree, one `->` per node. */
export function parseMysqlAnalyzeTree(text: string): ParsedPlan {
  const roots: PlanNode[] = []
  const stack: { indent: number, node: PlanNode }[] = []

  for (const line of text.split(/\r?\n/)) {
    const match = /^(\s*)->\s*(.*)$/.exec(line)
    if (!match) continue

    const indent = match[1]!.length
    const node = mysqlTextNode(match[2]!)

    // The parent is the nearest line above with less indentation.
    while (stack.length && stack.at(-1)!.indent >= indent) stack.pop()

    if (stack.length) stack.at(-1)!.node.children.push(node)
    else roots.push(node)

    stack.push({ indent, node })
  }

  if (!roots.length) throw new Error('Not a MySQL EXPLAIN ANALYZE tree')

  const root = roots.length === 1 ? roots[0]! : makeNode('Query', roots)
  computeSelfTimes(root)

  return { root, engine: 'mysql', analyzed: hasActuals(root), raw: text }
}

/* ------------------------------------------------------------- sqlite -- */

/** `EXPLAIN QUERY PLAN`: rows of `id, parent, notused, detail`, a tree by parent id. */
export function parseSqliteQueryPlan(rows: readonly (readonly unknown[])[]): ParsedPlan {
  const nodes = new Map<number, PlanNode>()
  const parents: { id: number, parent: number }[] = []

  for (const row of rows) {
    const id = num(row[0])
    if (id === undefined) continue

    const node = makeNode(String(row[3] ?? ''))
    node.extras['id'] = id
    nodes.set(id, node)
    parents.push({ id, parent: num(row[1]) ?? 0 })
  }

  if (!nodes.size) throw new Error('Not a SQLite query plan')

  // Attached in a second pass: the rows come parents first in practice, but
  // nothing promises it, and a child before its parent would otherwise be lost.
  const roots: PlanNode[] = []
  for (const { id, parent } of parents) {
    const node = nodes.get(id)!
    const above = nodes.get(parent)
    if (above && above !== node) above.children.push(node)
    else roots.push(node)
  }

  const root = roots.length === 1 ? roots[0]! : makeNode('Query', roots)
  const raw = rows.map((row) => row.map((cell) => String(cell ?? '')).join('  ')).join('\n')

  return { root, engine: 'sqlite', analyzed: false, raw }
}

/* ----------------------------------------------------------- dispatch -- */

/** The first column of every row as one text, which is how each engine returns a plan. */
function textOf(rows: readonly (readonly unknown[])[]): string {
  return rows
    .map((row) => {
      const cell = row[0]
      return typeof cell === 'string' ? cell : JSON.stringify(cell)
    })
    .join('\n')
}

/**
 * The plan a result holds, for the engine and mode that produced it.
 *
 * MariaDB has no EXPLAIN ANALYZE; its `ANALYZE FORMAT=JSON` is the JSON shape
 * with actual figures added, so both of its modes go through the JSON reader.
 */
export function parsePlanResult(driver: string, analyzed: boolean, rows: readonly (readonly unknown[])[]): ParsedPlan {
  switch (driver) {
    case 'postgres': return parsePostgresJsonPlan(textOf(rows))
    case 'mysql': return analyzed ? parseMysqlAnalyzeTree(textOf(rows)) : parseMysqlJsonPlan(textOf(rows))
    case 'mariadb': return parseMysqlJsonPlan(textOf(rows))
    case 'sqlite': return parseSqliteQueryPlan(rows)
    default: throw new Error(`No plan reader for ${driver}`)
  }
}

/** Every node of a plan, parents before children. */
export function flattenPlan(root: PlanNode): PlanNode[] {
  const out: PlanNode[] = []
  const stack = [root]
  while (stack.length) {
    const node = stack.pop()!
    out.push(node)
    for (let at = node.children.length - 1; at >= 0; at--) stack.push(node.children[at]!)
  }
  return out
}
