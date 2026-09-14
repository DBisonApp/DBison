<script setup lang="ts">
import type { ParsedPlan, PlanNode } from '~/utils/plan-parse'
import { compactCount } from '~/utils/measures'

/**
 * A query plan as a tree of steps with the figures that matter beside each.
 *
 * The text an engine prints is written to be read top to bottom once; the
 * question someone brings to a plan is "where did the time go?", which is a
 * comparison across nodes. So every node gets the same columns, the time (or
 * the cost, when the statement did not run) is drawn as a bar against the
 * slowest node, and a row estimate that missed by an order of magnitude is
 * tinted, since that is what a stale statistic looks like from here.
 */
const props = defineProps<{ plan: ParsedPlan }>()

interface TreeRow {
  /** The path of child indexes from the root, so a parent's id is a prefix. */
  id: string
  parent: string | null
  depth: number
  node: PlanNode
}

/** Every node in document order, parents before children, with a stable id each. */
const rows = computed<TreeRow[]>(() => {
  const out: TreeRow[] = []
  const stack: TreeRow[] = [{ id: '0', parent: null, depth: 0, node: props.plan.root }]

  while (stack.length) {
    const row = stack.pop()!
    out.push(row)
    for (let at = row.node.children.length - 1; at >= 0; at--) {
      stack.push({ id: `${row.id}.${at}`, parent: row.id, depth: row.depth + 1, node: row.node.children[at]! })
    }
  }

  return out
})

/**
 * Which branches are shut. Everything starts open: a plan is rarely more
 * than a few dozen nodes, and the shape of the whole thing is the point.
 */
const collapsed = ref(new Set<string>())
const selected = ref<string | null>(null)
const showRaw = ref(false)

watch(() => props.plan, () => {
  collapsed.value = new Set()
  selected.value = null
})

const visible = computed(() => {
  const hidden = new Set<string>()

  return rows.value.filter((row) => {
    if (row.parent !== null && (hidden.has(row.parent) || collapsed.value.has(row.parent))) {
      hidden.add(row.id)
      return false
    }
    return true
  })
})

const selectedRow = computed(() => rows.value.find((row) => row.id === selected.value) ?? null)

function toggle(row: TreeRow) {
  const next = new Set(collapsed.value)
  if (next.has(row.id)) next.delete(row.id)
  else next.add(row.id)
  collapsed.value = next
}

const anyCollapsed = computed(() => collapsed.value.size > 0)

function toggleAll() {
  collapsed.value = anyCollapsed.value
    ? new Set()
    : new Set(rows.value.filter((row) => row.node.children.length).map((row) => row.id))
}

const tree = useTemplateRef<HTMLElement>('tree')

function select(row: TreeRow) {
  selected.value = row.id
  nextTick(() => {
    tree.value?.querySelector(`[data-id="${CSS.escape(row.id)}"]`)?.scrollIntoView({ block: 'nearest' })
  })
}

/**
 * Up and Down walk the painted rows; Right opens a branch, or steps into one
 * already open; Left shuts a branch, or steps out to the parent of a leaf —
 * the way every file tree on the desktop reads the arrow keys.
 */
function onKeydown(event: KeyboardEvent) {
  const painted = visible.value
  if (!painted.length) return

  const at = painted.findIndex((row) => row.id === selected.value)
  const row = at >= 0 ? painted[at]! : null

  switch (event.key) {
    case 'ArrowDown':
      select(painted[Math.min(at + 1, painted.length - 1)]!)
      break
    case 'ArrowUp':
      select(painted[Math.max(at - 1, 0)]!)
      break
    case 'Home':
      select(painted[0]!)
      break
    case 'End':
      select(painted[painted.length - 1]!)
      break
    case 'ArrowRight':
      if (!row) select(painted[0]!)
      else if (row.node.children.length && collapsed.value.has(row.id)) toggle(row)
      else if (row.node.children.length) select(painted[at + 1]!)
      break
    case 'ArrowLeft': {
      if (!row) return
      if (row.node.children.length && !collapsed.value.has(row.id)) {
        toggle(row)
        break
      }
      const parent = painted.find((candidate) => candidate.id === row.parent)
      if (parent) select(parent)
      break
    }
    default:
      return
  }

  event.preventDefault()
}

/* ------------------------------------------------------------ figures -- */

/**
 * What the bar measures: exclusive time once the statement has run, the
 * estimated cost before that, and nothing on an engine that reports neither.
 */
const metric = computed<'time' | 'cost' | null>(() => {
  if (rows.value.some((row) => row.node.selfMs !== undefined)) return 'time'
  if (rows.value.some((row) => row.node.cost !== undefined)) return 'cost'
  return null
})

function measureOf(node: PlanNode) {
  return metric.value === 'time' ? node.selfMs : metric.value === 'cost' ? node.cost : undefined
}

/** The heaviest node, which the bars are scaled against and which is marked. */
const heaviest = computed(() => {
  let best: { id: string, value: number } | null = null
  for (const row of rows.value) {
    const value = measureOf(row.node)
    if (value !== undefined && (!best || value > best.value)) best = { id: row.id, value }
  }
  return best
})

function barWidth(node: PlanNode) {
  const value = measureOf(node)
  if (value === undefined || !heaviest.value || heaviest.value.value <= 0) return 0
  return Math.max(1, Math.round((value / heaviest.value.value) * 100))
}

const hasRows = computed(() => rows.value.some((row) => row.node.estimatedRows !== undefined || row.node.actualRows !== undefined))
const hasLoops = computed(() => rows.value.some((row) => (row.node.loops ?? 1) > 1))

/** The grid's columns, only those with anything in them. */
const columns = computed(() => [
  'minmax(0, 1fr)',
  hasRows.value ? '7rem' : null,
  metric.value ? '8.5rem' : null,
  hasLoops.value ? '3rem' : null,
].filter(Boolean).join(' '))

function formatMs(ms: number) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`
  if (ms >= 100) return `${Math.round(ms)} ms`
  if (ms >= 10) return `${ms.toFixed(1)} ms`
  return `${ms.toFixed(2)} ms`
}

function formatCost(cost: number) {
  return cost >= 1000 ? compactCount(cost) : cost.toFixed(cost >= 100 ? 0 : 2)
}

function measureText(node: PlanNode) {
  const value = measureOf(node)
  if (value === undefined) return ''
  return metric.value === 'time' ? formatMs(value) : formatCost(value)
}

function measureTitle(node: PlanNode) {
  if (metric.value === 'time') {
    const parts = [`Self time ${node.selfMs === undefined ? '—' : formatMs(node.selfMs)}`]
    if (node.totalMs !== undefined) parts.push(`total ${formatMs(node.totalMs)} per loop`)
    if (node.cost !== undefined) parts.push(`cost ${node.cost.toLocaleString()}`)
    return parts.join(' · ')
  }
  return node.cost === undefined ? '' : `Estimated cost ${node.cost.toLocaleString()}`
}

/** Whether the estimate and the count are more than an order of magnitude apart. */
function misestimated(node: PlanNode) {
  if (node.estimatedRows === undefined || node.actualRows === undefined) return false
  const low = Math.min(node.estimatedRows, node.actualRows)
  const high = Math.max(node.estimatedRows, node.actualRows)
  return high / Math.max(low, 1) > 10
}

function rowsText(node: PlanNode) {
  const estimated = node.estimatedRows === undefined ? null : compactCount(node.estimatedRows)
  const actual = node.actualRows === undefined ? null : compactCount(node.actualRows)
  if (estimated !== null && actual !== null) return `${estimated} → ${actual}`
  return actual ?? estimated ?? ''
}

function rowsTitle(node: PlanNode) {
  const parts: string[] = []
  if (node.estimatedRows !== undefined) parts.push(`Estimated ${node.estimatedRows.toLocaleString()} rows`)
  if (node.actualRows !== undefined) parts.push(`actual ${node.actualRows.toLocaleString()} rows${(node.loops ?? 1) > 1 ? ' per loop' : ''}`)
  if (misestimated(node)) parts.push('more than 10× apart — statistics may be stale')
  return parts.join(' · ')
}

const headline = computed(() => {
  const { plan } = props

  if (!plan.analyzed) {
    return plan.engine === 'sqlite'
      ? 'Estimated plan only — SQLite reports no costs or times'
      : 'Estimated costs only — run Visual Explain Analyze for actual times'
  }

  const parts: string[] = []
  if (plan.planningMs !== undefined) parts.push(`Planning ${formatMs(plan.planningMs)}`)
  if (plan.executionMs !== undefined) parts.push(`Execution ${formatMs(plan.executionMs)}`)
  if (!parts.length && plan.root.totalMs !== undefined) {
    parts.push(`Total ${formatMs(plan.root.totalMs * (plan.root.loops ?? 1))}`)
  }
  return parts.length ? parts.join(' · ') : 'Actual figures'
})

/* ------------------------------------------------------------ details -- */

/**
 * The selected node's figures in full, then whatever else the engine said.
 * The row shows compact numbers; here there is room for the exact ones.
 */
const details = computed<[string, string][]>(() => {
  const node = selectedRow.value?.node
  if (!node) return []

  const entries: [string, string][] = []
  const push = (key: string, value: unknown) => {
    if (value !== undefined && value !== '') entries.push([key, String(value)])
  }

  push('Estimated rows', node.estimatedRows?.toLocaleString())
  push('Actual rows', node.actualRows?.toLocaleString())
  push('Loops', node.loops)
  push('Cost', node.cost?.toLocaleString())
  push('Startup time', node.startupMs === undefined ? undefined : `${node.startupMs} ms`)
  push('Total time', node.totalMs === undefined ? undefined : `${node.totalMs} ms per loop`)
  push('Self time', node.selfMs === undefined ? undefined : formatMs(node.selfMs))
  push('Shared blocks hit', node.buffers?.sharedHit?.toLocaleString())
  push('Shared blocks read', node.buffers?.sharedRead?.toLocaleString())
  push('Temp blocks written', node.buffers?.tempWritten?.toLocaleString())

  for (const [key, value] of Object.entries(node.extras)) push(key, value)

  return entries
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col" :style="{ '--plan-columns': columns }">
    <div class="flex shrink-0 items-center gap-2 border-b border-edge bg-surface/40 px-2 py-1">
      <AppIcon name="plan" :size="12" class="text-faint" />
      <span
        class="min-w-0 truncate tabular-nums"
        :class="plan.analyzed ? 'text-muted' : 'text-faint'"
        :title="headline"
      >{{ headline }}</span>

      <span class="ml-auto flex shrink-0 items-center gap-1">
        <button type="button" class="btn btn-ghost" @click="toggleAll">
          {{ anyCollapsed ? 'Expand all' : 'Collapse all' }}
        </button>
        <button
          type="button"
          class="btn btn-ghost"
          :data-active="showRaw"
          :title="showRaw ? 'Back to the tree' : 'The plan as the engine printed it'"
          @click="showRaw = !showRaw"
        >
          <AppIcon name="code" :size="11" />
          Raw
        </button>
      </span>
    </div>

    <pre
      v-if="showRaw"
      class="selectable min-h-0 flex-1 overflow-auto p-3 font-mono text-[12px] leading-relaxed whitespace-pre"
    >{{ plan.raw }}</pre>

    <template v-else>
      <div class="plan-row shrink-0 border-b border-edge py-1 text-[11px] font-medium text-faint uppercase tracking-wide">
        <span>Step</span>
        <span v-if="hasRows" class="text-right">Rows</span>
        <span v-if="metric">{{ metric === 'time' ? 'Self time' : 'Cost' }}</span>
        <span v-if="hasLoops" class="text-right">Loops</span>
      </div>

      <div
        ref="tree"
        role="tree"
        tabindex="0"
        aria-label="Query plan"
        class="min-h-0 flex-1 overflow-auto py-0.5 focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent-line"
        @keydown="onKeydown"
      >
        <div
          v-for="row in visible"
          :key="row.id"
          role="treeitem"
          :data-id="row.id"
          :aria-level="row.depth + 1"
          :aria-selected="row.id === selected"
          :aria-expanded="row.node.children.length ? !collapsed.has(row.id) : undefined"
          class="plan-row cursor-default py-0.5"
          :class="row.id === selected ? 'bg-accent-soft' : 'hover:bg-raised'"
          @click="select(row)"
          @dblclick="row.node.children.length && toggle(row)"
        >
          <span class="flex min-w-0 items-center gap-1" :style="{ paddingLeft: `${row.depth * 14}px` }">
            <!-- A leaf keeps the chevron's width, so labels of one level line up. -->
            <button
              v-if="row.node.children.length"
              type="button"
              class="plan-toggle text-faint hover:bg-raised"
              :title="collapsed.has(row.id) ? 'Open this branch' : 'Close this branch'"
              :aria-label="collapsed.has(row.id) ? 'Open this branch' : 'Close this branch'"
              tabindex="-1"
              @click.stop="toggle(row)"
            >
              <AppIcon :name="collapsed.has(row.id) ? 'chevronRight' : 'chevronDown'" :size="11" />
            </button>
            <span v-else class="plan-toggle" />

            <span class="shrink-0 truncate" :class="row.id === heaviest?.id ? 'font-medium text-warning' : ''" :title="row.node.label">
              {{ row.node.label }}
            </span>
            <span
              v-if="row.node.detail"
              class="min-w-0 truncate font-mono text-[11px] text-faint"
              :title="row.node.detail"
            >{{ row.node.detail }}</span>
          </span>

          <span
            v-if="hasRows"
            class="truncate text-right tabular-nums"
            :class="misestimated(row.node) ? 'text-warning' : 'text-muted'"
            :title="rowsTitle(row.node)"
          >
            <AppIcon v-if="misestimated(row.node)" name="warning" :size="10" class="mr-0.5 inline align-[-1px]" />{{ rowsText(row.node) }}
          </span>

          <span v-if="metric" class="relative flex h-4 items-center" :title="measureTitle(row.node)">
            <span
              class="absolute inset-y-0.5 left-0 rounded-sm"
              :class="row.id === heaviest?.id ? 'bg-warning/70' : 'bg-accent/30'"
              :style="{ width: `${barWidth(row.node)}%` }"
            />
            <span class="relative truncate pl-1 text-[11px] tabular-nums" :class="row.id === heaviest?.id ? 'text-content' : 'text-muted'">
              {{ measureText(row.node) }}
            </span>
          </span>

          <span v-if="hasLoops" class="text-right text-faint tabular-nums">
            {{ (row.node.loops ?? 1) > 1 ? `×${compactCount(row.node.loops!)}` : '' }}
          </span>
        </div>
      </div>

      <!-- Below rather than beside: the tree is wide, and a condition or a
           sort key reads better on a full line than in a narrow column. -->
      <div
        v-if="selectedRow"
        class="max-h-[40%] shrink-0 overflow-auto border-t border-edge bg-surface/40 px-3 py-2"
      >
        <div class="flex items-center gap-2">
          <span class="shrink-0 font-medium">{{ selectedRow.node.label }}</span>
          <span v-if="selectedRow.node.detail" class="selectable min-w-0 truncate font-mono text-[11px] text-faint" :title="selectedRow.node.detail">
            {{ selectedRow.node.detail }}
          </span>
          <button type="button" class="btn-icon ml-auto shrink-0" title="Close details" aria-label="Close details" @click="selected = null">
            <AppIcon name="close" :size="11" />
          </button>
        </div>

        <p v-if="!details.length" class="mt-1 text-faint">
          Nothing more to say about this step.
        </p>

        <dl v-else class="mt-1 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-0.5 font-mono text-[12px]">
          <template v-for="[key, value] in details" :key="key">
            <dt class="text-faint">{{ key }}</dt>
            <dd class="selectable break-words whitespace-pre-wrap">{{ value }}</dd>
          </template>
        </dl>
      </div>
    </template>
  </div>
</template>

<style scoped>
.plan-row {
  display: grid;
  grid-template-columns: var(--plan-columns);
  column-gap: 0.75rem;
  align-items: center;
  padding-inline: 0.5rem;
}

.plan-toggle {
  display: inline-flex;
  width: 14px;
  height: 18px;
  flex: none;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
}
</style>
