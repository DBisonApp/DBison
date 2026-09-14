<script setup lang="ts">
import type { IDockviewPanelProps } from 'dockview-vue'
import { VueFlow, useVueFlow } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { MiniMap } from '@vue-flow/minimap'
import { nodeId } from '#shared/db-nodes'
import type { SchemaObject } from '#shared/db-types'
import type { GraphNode } from '@vue-flow/core'
import type { ErdEdge, ErdNode, ErdNodeData } from '~/utils/erd-graph'

/**
 * The ER diagram: every table in a scope as a box, every foreign key as a line.
 *
 * The scope is pinned in the params rather than read off the explorer, so the
 * tab keeps showing the database it was opened for while the sidebar moves on,
 * and a restored layout reopens it on the same one. The picture is drawn from
 * the same schema snapshot the explorer and the editor read, so opening it
 * costs no round trip once either of those has looked at the database.
 *
 * `focus` is the table the diagram was asked about, when it was asked about
 * one. It starts the tab in "related only" mode — that table and its
 * neighbours — because a whole database is rarely what anyone wanted to see.
 */
export interface DiagramParams {
  connectionId: string
  database?: string
  /** `null` draws every schema at once, qualified. */
  schema: string | null
  focus?: { schema: string, name: string } | null
}

const props = defineProps<{ params: IDockviewPanelProps<DiagramParams> }>()

const connections = useConnections()
const schemaIndex = useSchemaIndex()
const { openTableData } = useWorkbench()
const { bridge, isAvailable } = useDatabaseBridge()
const { notice, flash, copy } = useClipboard()

const scope = props.params.params

const profile = computed(
  () => connections.profiles.value.find((p) => p.id === scope.connectionId) ?? null,
)
const driver = computed(() => (profile.value ? connections.driverOf(profile.value) : null))
const connected = computed(() => connections.stateOf(scope.connectionId).status === 'connected')

const read = computed(() => {
  if (!connected.value) return { snapshot: null, loading: false, error: null }

  return schemaIndex.snapshotFor({
    connectionId: scope.connectionId,
    database: scope.database,
    quote: driver.value?.quote ?? '"',
  })
})

const filter = ref('')
const includeViews = ref(false)
const relatedOnly = ref(Boolean(scope.focus))

/** Mixed schemas are drawn qualified, as the explorer draws them. */
const qualified = computed(() => scope.schema === null && Boolean(driver.value?.levels.includes('schema')))

/** Everything the picture is built from, other than the pane's shape. */
const inputs = computed(() => ({
  snapshot: read.value.snapshot,
  schema: scope.schema,
  qualified: qualified.value,
  includeViews: includeViews.value,
  focus: relatedOnly.value ? scope.focus : null,
  filter: filter.value,
}))

/**
 * The boxes as drawn, which is the layout plus whatever the user dragged.
 *
 * A rebuild — a filter keystroke, a toggle, a refresh — replaces them
 * wholesale, and the dragged positions are laid back over the result from the
 * placement below. The graph computed above is the source and this is the
 * copy Vue Flow is free to move.
 */
const nodes = shallowRef<ErdNode[]>([])
const edges = shallowRef<ErdEdge[]>([])

/**
 * Where the user put the boxes, kept by table across rebuilds and reopenings.
 *
 * A dagre run after every keystroke would undo every drag, and a diagram
 * someone has spent a minute arranging is worth more than a tidy one. So a
 * drag is remembered per diagram — this scope, this focus — and a rebuilt
 * graph takes the remembered positions for the tables that have one; the
 * rest are dagre's. "Re-layout" is the one action that asks for a fresh
 * picture, and it forgets them.
 */
const positionsKey = `dbison.erd-positions:${[
  scope.connectionId,
  scope.database ?? '',
  scope.schema ?? '*',
  scope.focus ? `${scope.focus.schema}.${scope.focus.name}` : '',
].join('|')}`

type Placement = Record<string, { x: number, y: number }>

function placeKey(data: ErdNodeData) {
  return `${data.object.schema}.${data.object.name}`
}

function loadPlacement(): Placement {
  if (!import.meta.client) return {}

  try {
    return JSON.parse(localStorage.getItem(positionsKey) ?? '{}') as Placement
  }
  catch {
    // A placement from an older build is not worth recovering.
    return {}
  }
}

let placement = loadPlacement()

function savePlacement() {
  if (!import.meta.client) return

  try {
    if (Object.keys(placement).length) localStorage.setItem(positionsKey, JSON.stringify(placement))
    else localStorage.removeItem(positionsKey)
  }
  catch {
    // Out of quota, or a private window. A remembered position is not worth
    // an error the user has to dismiss.
  }
}

/** Its own store: several diagram tabs must not share one viewport. */
const flowId = `erd-${crypto.randomUUID()}`
const {
  fitView,
  dimensions,
  getNodes,
  onNodesInitialized,
  onPaneReady,
  onNodeDoubleClick,
  onNodeDragStop,
} = useVueFlow({ id: flowId })

/**
 * The pane's shape, for packing the picture to it. Read once per layout rather
 * than followed: a picture that re-packed itself on every drag of the sash
 * would be impossible to work in. Falls back to a landscape guess before the
 * pane has a size.
 */
const aspect = computed(() => {
  const { width, height } = dimensions.value
  return width > 0 && height > 0 ? width / height : 1.6
})

/**
 * Fitting is owed after every relayout and paid once there is something to
 * fit to and something to fit with: boxes that have been measured, a pane
 * that has a size, and the pane's zoom controller, which only exists once the
 * canvas reports itself ready.
 *
 * None of that is a given when the boxes are handed over. dockview mounts a
 * new panel into a container it has not sized yet, the boxes measure
 * themselves before the pane does, and the canvas's own fit-on-init can run
 * before its zoom exists. The order the three land in is not fixed either, so
 * every one of them tries to settle the debt, and the debt is only cleared
 * when the canvas says the fit took — it answers false to a fit it could not
 * do — with a short series of retries behind a relayout for the case where
 * nothing re-measures at all.
 */
let fitPending = true
let paneReady = false

const paneSized = computed(() => dimensions.value.width > 0 && dimensions.value.height > 0)

async function settle() {
  if (!fitPending || !paneReady || !paneSized.value) return

  // Not animated: a tab that has just opened has no previous view to move
  // from, and a transition rides on animation frames, which a window that is
  // covered does not get.
  if (await fitView({ padding: 0.15 })) fitPending = false
}

function relayout() {
  const { snapshot, ...options } = inputs.value
  const built = snapshot
    ? buildGraph(snapshot, { ...options, aspect: aspect.value })
    : { nodes: [] as ErdNode[], edges: [] as ErdEdge[] }

  // Laid out whole, then the dragged tables moved back to where they were
  // put: the layout still decides the tables nobody has touched.
  nodes.value = built.nodes.map((node) => {
    const kept = node.data && placement[placeKey(node.data)]
    return kept ? { ...node, position: kept } : node
  })
  edges.value = built.edges
  fitPending = true

  // Boxes already on screen keep their measurements and never re-initialise;
  // a beat later is soon enough for them.
  for (const delay of [80, 250, 600]) setTimeout(settle, delay)
}

/** A fresh picture: forgets every drag and lays all the tables out again. */
function resetLayout() {
  placement = {}
  savePlacement()
  relayout()
}

watch(inputs, relayout, { immediate: true })

onNodeDragStop(({ nodes: moved }) => {
  for (const node of moved) {
    placement[placeKey(node.data as ErdNodeData)] = {
      x: Math.round(node.position.x),
      y: Math.round(node.position.y),
    }
  }
  savePlacement()
})

onNodesInitialized(settle)

onPaneReady(() => {
  paneReady = true
  settle()
})

watch(paneSized, settle)

onNodeDoubleClick(({ node }) => open((node.data as ErdNodeData).object))

function open(object: SchemaObject) {
  openTableData({
    id: nodeId(scope.connectionId, object.kind, object.path),
    connectionId: scope.connectionId,
    kind: object.kind,
    name: object.name,
    expandable: true,
    path: object.path,
  })
}

function refresh() {
  schemaIndex.reload({
    connectionId: scope.connectionId,
    database: scope.database,
    quote: driver.value?.quote ?? '"',
  })
}

/** How much of the schema is off the picture, so a filtered view says so. */
const total = computed(() => {
  const objects = read.value.snapshot?.objects ?? []
  return objects.filter((object) =>
    (includeViews.value || object.kind === 'table')
    && (scope.schema === null || object.schema === scope.schema),
  ).length
})

const scopeLabel = computed(() => {
  const parts = [profile.value?.name ?? 'connection']
  if (scope.database) parts.push(scope.database)
  if (scope.schema) parts.push(scope.schema)
  return parts.join(' › ')
})

/** A file name from the tab's title: `shop-public-orders-erd`. */
const exportName = computed(() => {
  const title = relatedOnly.value && scope.focus ? `${scopeLabel.value} ${scope.focus.name}` : scopeLabel.value
  return `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-erd`
})

/**
 * Writes the picture as it stands — the live boxes, dragged positions and
 * all — to a file. Outside the desktop app there is no disk to write to, so
 * the SVG goes to the clipboard instead; a PNG has nowhere to go there.
 */
async function exportAs(format: 'svg' | 'png') {
  const theme = readErdTheme()
  const svg = toSvg(getNodes.value, edges.value, theme)

  if (!isAvailable.value) {
    if (format === 'svg') await copy(svg, 'the diagram as SVG')
    else flash('Saving a PNG needs the desktop app')
    return
  }

  try {
    const content = format === 'svg' ? svg : await svgToPng(svg, theme.bg)

    const saved = await bridge().saveFile({
      suggestedName: `${exportName.value}.${format}`,
      content,
      encoding: format === 'png' ? 'base64' : 'utf8',
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    })

    if (saved.saved) flash(`Saved to ${saved.path}`)
  }
  catch (cause) {
    flash(cause instanceof Error ? cause.message : String(cause))
  }
}

/** The minimap colours boxes itself; these read the theme's tokens for it. */
function minimapColor(node: GraphNode) {
  return (node.data as ErdNodeData | undefined)?.focused
    ? 'var(--app-accent)'
    : 'var(--app-border-strong)'
}
</script>

<template>
  <div class="flex h-full flex-col bg-bg">
    <div class="flex items-center gap-1.5 border-b border-edge bg-surface/40 px-2 py-1.5">
      <AppIcon name="diagram" :size="13" class="text-muted" />
      <span class="min-w-0 truncate text-muted" :title="scopeLabel">{{ scopeLabel }}</span>

      <label class="relative ml-2 block w-44">
        <AppIcon name="search" class="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-faint" />
        <input
          v-model="filter"
          type="search"
          placeholder="Filter tables"
          class="field bg-surface py-1 pr-2 pl-6.5"
        >
      </label>

      <button
        v-if="scope.focus"
        type="button"
        class="btn btn-ghost"
        :data-active="relatedOnly"
        :title="`Only ${scope.focus.name} and the tables it is joined to`"
        :aria-pressed="relatedOnly"
        @click="relatedOnly = !relatedOnly"
      >
        <AppIcon name="link" :size="12" />
        Related only
      </button>

      <button
        type="button"
        class="btn btn-ghost"
        :data-active="includeViews"
        title="Draw views alongside tables"
        :aria-pressed="includeViews"
        @click="includeViews = !includeViews"
      >
        <AppIcon name="view" :size="12" />
        Views
      </button>

      <span class="ml-auto shrink-0 text-faint">
        {{ nodes.length }}<template v-if="nodes.length !== total"> of {{ total }}</template>
        table{{ total === 1 ? '' : 's' }} · {{ edges.length }} key{{ edges.length === 1 ? '' : 's' }}
        <span v-if="read.snapshot?.truncated" class="text-warning" title="The schema was larger than one snapshot holds">
          · partial schema
        </span>
      </span>

      <span v-if="notice" class="min-w-0 shrink truncate text-accent-bright">{{ notice }}</span>

      <button type="button" class="btn-icon" title="Fit the diagram to the window" @click="fitView({ padding: 0.15, duration: 200 })">
        <AppIcon name="expand" />
      </button>

      <button type="button" class="btn-icon" title="Lay the tables out again, forgetting where they were dragged" @click="resetLayout()">
        <AppIcon name="layout" />
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger>
          <button
            type="button"
            class="btn btn-ghost"
            title="Save the diagram as a picture"
            :disabled="!nodes.length"
          >
            <AppIcon name="download" :size="12" />
            Export
            <AppIcon name="chevronDown" :size="10" class="text-faint" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>The diagram as drawn</DropdownMenuLabel>
          <DropdownMenuItem icon="file" @select="exportAs('svg')">
            Save as SVG…
          </DropdownMenuItem>
          <DropdownMenuItem icon="imageDown" @select="exportAs('png')">
            Save as PNG…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <button
        type="button"
        class="btn-icon"
        title="Re-read the schema"
        :disabled="!connected"
        @click="refresh()"
      >
        <AppIcon name="refresh" :class="read.loading ? 'animate-spin' : ''" />
      </button>
    </div>

    <div v-if="!connected" class="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <p class="text-faint">
        {{ profile ? `${profile.name} is not connected.` : 'This connection no longer exists.' }}
      </p>
      <button
        v-if="profile"
        type="button"
        class="btn btn-accent"
        @click="connections.connect(scope.connectionId)"
      >
        Connect
      </button>
    </div>

    <p
      v-else-if="read.error"
      class="selectable m-3 flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 px-2.5 py-2 text-danger"
    >
      <AppIcon name="warning" class="mt-0.5" />
      <span>{{ read.error }}</span>
    </p>

    <div v-else-if="!read.snapshot" class="flex flex-1 flex-col items-center justify-center">
      <p class="text-faint">
        Reading schema…
      </p>
      <div class="app-progress mt-3 h-0.5 w-32 rounded-full" />
    </div>

    <div v-else class="relative min-h-0 flex-1">
      <VueFlow
        :id="flowId"
        :nodes="nodes"
        :edges="edges"
        :min-zoom="0.05"
        :max-zoom="2.5"
        :nodes-connectable="false"
        :edges-updatable="false"
        :delete-key-code="null"
        :elevate-edges-on-select="true"
        class="erd-flow h-full"
      >
        <template #node-table="nodeProps">
          <ErdTableNode v-bind="nodeProps" @open="open(nodeProps.data.object)" />
        </template>

        <Background :gap="24" :size="1" />
        <MiniMap
          pannable
          zoomable
          :width="160"
          :height="100"
          :node-color="minimapColor"
          mask-color="var(--app-bg-sunken)"
          class="erd-minimap"
        />
      </VueFlow>

      <div
        v-if="!nodes.length"
        class="pointer-events-none absolute inset-0 flex items-center justify-center"
      >
        <p class="rounded-md bg-surface/80 px-4 py-2 text-faint">
          {{ filter.trim()
            ? `No table matches “${filter.trim()}”`
            : total
              ? 'Nothing in this scope has columns to draw.'
              : 'No tables here.' }}
        </p>
      </div>
    </div>
  </div>
</template>
