import type { DockviewApi, IDockviewPanel, VueComponent } from 'dockview-vue'
import type { Component } from 'vue'
import type { DbNode } from '#shared/db-types'

/**
 * Component keys registered with dockview in `WorkbenchLayout.vue`.
 *
 * `navigator` is the sidebar, which is now the explorer. The key keeps its old
 * name because it is written into every layout saved by an earlier build, and
 * renaming it would throw those away for nothing.
 */
export const PANEL_COMPONENTS = {
  navigator: 'navigator',
  welcome: 'welcome',
  query: 'query',
  tableData: 'tableData',
  diagram: 'diagram',
} as const

/**
 * dockview instantiates panel components itself, so they must not be reactive.
 *
 * The cast covers a typing gap rather than a behavioural one: dockview declares
 * its registry as `DefineComponent<any>`, and Vue's contravariant prop checking
 * refuses a component with concrete props there. Every panel does accept the
 * single `{ params }` prop dockview mounts it with.
 */
export function panelComponent(component: Component): VueComponent {
  return markRaw(component) as unknown as VueComponent
}

const LAYOUT_STORAGE_KEY = 'dbison.layout.v1'

let untitledCounter = 0

/** Everything a closed document tab was, enough to open it again. */
interface ClosedTab {
  component: string
  title: string
  params: Record<string, unknown>
}

/** Beyond this the stack is a history nobody scrolls back through. */
const MAX_REOPENABLE = 10

/**
 * The document tabs closed most recently, newest first.
 *
 * Module-level like the close guards, and for the same reason: the tab that
 * records a close is mounted by dockview outside the app tree, while the menu
 * that reopens it is not, and both have to be looking at the same stack.
 */
const closedTabs = shallowRef<ClosedTab[]>([])

/** The panel kinds that can be reopened: the ones that are documents. */
const DOCUMENT_COMPONENTS: string[] = [
  PANEL_COMPONENTS.query,
  PANEL_COMPONENTS.tableData,
  PANEL_COMPONENTS.diagram,
]

/**
 * The arrangement a fresh workbench starts from: the explorer down the left,
 * a welcome tab in the space beside it.
 *
 * Shared by the first run and by Reset Layout, so "reset" means the layout
 * people were given on day one rather than an empty window.
 */
export function seedDefaultLayout(target: DockviewApi) {
  const navigator = target.addPanel({
    id: PANEL_COMPONENTS.navigator,
    component: PANEL_COMPONENTS.navigator,
    title: 'Database',
  })

  target.addPanel({
    id: PANEL_COMPONENTS.welcome,
    component: PANEL_COMPONENTS.welcome,
    title: 'Welcome',
    position: { referencePanel: PANEL_COMPONENTS.navigator, direction: 'right' },
  })

  // After the split, not before it: splitting a panel that fills the window
  // halves it, which would throw away any width set on the way in and leave
  // the explorer sharing the window down the middle instead of edging it.
  navigator.api.setSize({ width: 300 })
}

/**
 * Wraps the dockview API so the rest of the app opens panels by intent
 * ("show me this table") instead of by juggling panel ids and positions.
 */
export function useWorkbench() {
  const api = useState<DockviewApi | null>('workbench-api', () => null)

  /**
   * Bumped whenever dockview rearranges itself.
   *
   * The api object is `markRaw`ed — it has to be, dockview owns its own
   * mutation — so nothing derived from it would ever recompute on its own. Menu
   * items that report the layout back to the user ("Database Explorer" ticked,
   * "Close Tab" enabled) read this counter to know when to look again.
   */
  const revision = useState('workbench-revision', () => 0)

  let disposeWatchers: (() => void) | undefined

  function setApi(next: DockviewApi) {
    // A hot reload runs this again against a fresh api; the old subscriptions
    // would otherwise keep firing into a dockview instance nobody can see.
    disposeWatchers?.()

    api.value = markRaw(next)
    revision.value++

    const listeners = [
      next.onDidLayoutChange(() => revision.value++),
      next.onDidActivePanelChange(() => revision.value++),
    ]

    disposeWatchers = () => listeners.forEach((listener) => listener.dispose())
  }

  /** Whether the explorer is currently docked, for the View menu's tick. */
  const navigatorOpen = computed(() => {
    void revision.value
    return !!api.value?.getPanel(PANEL_COMPONENTS.navigator)
  })

  /** The focused tab, or `null` when the workbench is empty. */
  const activePanel = computed(() => {
    void revision.value
    return api.value?.activePanel ?? null
  })

  const closeGuards = useCloseGuards()

  /**
   * Closes a panel, after asking it whether that is all right. Every way a
   * tab can close goes through here — its X, Ctrl+W, a middle click — so a
   * dirty script is never dropped by one route that forgot to ask.
   */
  async function closePanel(id: string) {
    const panel = api.value?.getPanel(id)
    if (!panel) return

    if (!(await closeGuards.mayClose(id))) return

    remember(panel)
    panel.api.close()
  }

  /**
   * Puts a document tab on the reopen stack before it goes.
   *
   * Read at the moment of closing rather than when the tab opened, because a
   * query tab writes its text and context back into its params as the user
   * works, and it is the text at the end that they want back. The navigator
   * and the welcome page are not recorded: one is brought back from the View
   * menu, the other has nothing to restore.
   */
  function remember(panel: IDockviewPanel) {
    const component = panel.view.contentComponent
    if (!DOCUMENT_COMPONENTS.includes(component)) return

    closedTabs.value = [
      { component, title: panel.title ?? '', params: { ...(panel.params ?? {}) } },
      ...closedTabs.value,
    ].slice(0, MAX_REOPENABLE)
  }

  /** Whether Reopen Closed Tab has anything to reopen. */
  const hasClosed = computed(() => closedTabs.value.length > 0)

  /**
   * Brings back the tab closed most recently, the way a browser does.
   *
   * A table or diagram goes through its own opener, which finds a tab already
   * showing the same thing rather than adding a second; a query tab is added
   * directly under a fresh id, because its title and whether that title was
   * generated are exactly what the recorded params say, and the opener would
   * number it anew.
   */
  function reopenClosed() {
    const [closed, ...rest] = closedTabs.value
    if (!closed || !api.value) return

    closedTabs.value = rest

    const params = closed.params

    switch (closed.component) {
      case PANEL_COMPONENTS.tableData:
        openTableData(params.node as DbNode, { where: (params.where as string) || undefined })
        return

      case PANEL_COMPONENTS.diagram:
        openDiagram({
          connectionId: params.connectionId as string,
          database: params.database as string | undefined,
          schema: (params.schema as string | null) ?? null,
          focus: (params.focus as { schema: string, name: string } | null) ?? null,
          title: closed.title,
        })
        return

      default:
        api.value.addPanel({
          id: `query:${crypto.randomUUID()}`,
          component: closed.component,
          title: closed.title,
          params,
          position: documentGroup() ? { referenceGroup: documentGroup()! } : undefined,
        })
    }
  }

  /** Closes the focused tab, which is what Ctrl+W means everywhere else. */
  function closeActivePanel() {
    const active = api.value?.activePanel
    if (active) closePanel(active.id)
  }

  /**
   * The tabs beside a given one, in the order they are drawn. The navigator
   * is never among them: it is a sidebar, not a document, and "close all"
   * means the documents.
   */
  function siblingsOf(id: string): IDockviewPanel[] {
    const panel = api.value?.getPanel(id)
    if (!panel) return []

    return panel.api.group.panels.filter((sibling) => sibling.id !== PANEL_COMPONENTS.navigator)
  }

  /**
   * Closes a list of tabs one after another, each through its guard. A refused
   * close leaves that tab open and moves on: the user said no to losing one
   * script, not to closing the rest.
   */
  async function closeEach(panels: IDockviewPanel[]) {
    for (const panel of panels) await closePanel(panel.id)
  }

  /** Every other tab in the group, leaving this one where it is. */
  function closeOthers(id: string) {
    return closeEach(siblingsOf(id).filter((panel) => panel.id !== id))
  }

  /** The tabs drawn after this one in its group. */
  function closeToTheRight(id: string) {
    const siblings = siblingsOf(id)
    const index = siblings.findIndex((panel) => panel.id === id)

    return closeEach(index === -1 ? [] : siblings.slice(index + 1))
  }

  /** Every document tab in the workbench, whichever group it is in. */
  function closeAll() {
    const panels = (api.value?.panels ?? []).filter((panel) => panel.id !== PANEL_COMPONENTS.navigator)
    return closeEach(panels)
  }

  /**
   * Ctrl+Tab and Ctrl+Shift+Tab: the next or previous tab of the focused
   * group, wrapping at either end. Confined to the group on purpose — the
   * groups sit side by side on screen, and a keystroke that walks along one
   * row of tabs should not jump across to another row.
   */
  function cycleTabs(direction: 1 | -1) {
    const group = api.value?.activeGroup
    if (!group || group.panels.length < 2) return

    const panels = group.panels
    const current = panels.findIndex((panel) => panel.id === group.activePanel?.id)
    const next = panels[(current + direction + panels.length) % panels.length]

    next?.api.setActive()
  }

  /** Focuses an already-open panel and reports whether it existed. */
  function focus(id: string): boolean {
    const panel = api.value?.getPanel(id)
    if (!panel) return false

    panel.api.setActive()
    return true
  }

  /** The group new document panels should land in: never the navigator's. */
  function documentGroup() {
    const navigator = api.value?.getPanel(PANEL_COMPONENTS.navigator)
    const groups = api.value?.groups ?? []

    return groups.find((group) => group.id !== navigator?.api.group?.id)
  }

  function openQuery(
    options: {
      connectionId?: string | null
      database?: string
      schema?: string
      sql?: string
      title?: string
      /** The script file the text came from, so Save goes back to it. */
      filePath?: string
    } = {},
  ) {
    if (!api.value) return

    const id = `query:${crypto.randomUUID()}`
    // A caller-supplied title already names the thing the tab is about; only a
    // generated "Query 3" gains from having the database appended to it.
    const autoTitle = !options.title
    const title = options.title ?? `Query ${++untitledCounter}`

    api.value.addPanel({
      id,
      component: PANEL_COMPONENTS.query,
      title,
      // The context lives in the panel params so a restored layout reopens the
      // tab where it was, rather than back on the profile's default database.
      // `title` goes with it because the panel appends the database to it, and
      // a restored tab must not decorate an already-decorated name.
      params: {
        connectionId: options.connectionId ?? null,
        database: options.database ?? null,
        schema: options.schema ?? null,
        initialSql: options.sql ?? '',
        title,
        autoTitle,
        filePath: options.filePath ?? null,
      },
      position: documentGroup() ? { referenceGroup: documentGroup()! } : undefined,
    })
  }

  /**
   * Opens (or re-focuses) the data grid for a table or view.
   *
   * `where` is how a foreign key is followed: the tab opens already showing the
   * rows the key names, rather than the top of the table with the user left to
   * type the filter that they just clicked a button to avoid. A table that is
   * already open is re-filtered in place — the point of following a key is to
   * end up looking at the row, and a second tab on the same table would leave
   * two of them disagreeing about what is on screen.
   */
  function openTableData(node: DbNode, options: { where?: string } = {}) {
    if (!api.value || (node.kind !== 'table' && node.kind !== 'view')) return

    const id = `table:${node.id}`
    const open = api.value.getPanel(id)

    if (open) {
      // The token is what the panel watches: the same key followed twice in a
      // row is the same `where`, and the second click has to land too.
      if (options.where !== undefined) {
        open.api.updateParameters({
          ...open.params,
          where: options.where,
          filterToken: crypto.randomUUID(),
        })
      }

      open.api.setActive()
      return
    }

    api.value.addPanel({
      id,
      component: PANEL_COMPONENTS.tableData,
      title: node.name,
      // Panel params are serialized with the layout and handed back to the IPC
      // bridge, so the reactive tree node must be flattened on the way in.
      params: { node: toPlain(node), where: options.where ?? '' },
      position: documentGroup() ? { referenceGroup: documentGroup()! } : undefined,
    })
  }

  /**
   * Opens (or re-focuses) the ER diagram for a database, or the part of it one
   * table is joined to.
   *
   * One tab per scope: asking for the diagram of a database twice finds the
   * tab already showing it. A table focus is a different picture, and gets a
   * tab of its own, because it is what the user was looking at that the whole
   * database view would have buried.
   */
  function openDiagram(options: {
    connectionId: string
    database?: string
    schema: string | null
    focus?: { schema: string, name: string } | null
    title?: string
  }) {
    if (!api.value) return

    const scope = [options.connectionId, options.database ?? '', options.schema ?? '*']
    const focusKey = options.focus ? `${options.focus.schema}.${options.focus.name}` : ''
    const id = `diagram:${scope.join('/')}#${focusKey}`

    if (focus(id)) return

    const title = options.title
      ?? (options.focus ? `${options.focus.name} relations` : `${options.schema ?? options.database ?? 'Database'} diagram`)

    api.value.addPanel({
      id,
      component: PANEL_COMPONENTS.diagram,
      title,
      params: {
        connectionId: options.connectionId,
        database: options.database ?? undefined,
        schema: options.schema,
        focus: options.focus ? toPlain(options.focus) : null,
      },
      position: documentGroup() ? { referenceGroup: documentGroup()! } : undefined,
    })
  }

  /** Hides the navigator when it is open, brings it back on the left when not. */
  function toggleNavigator() {
    if (!api.value) return

    const panel = api.value.getPanel(PANEL_COMPONENTS.navigator)
    if (panel) {
      panel.api.close()
      return
    }

    api.value.addPanel({
      id: PANEL_COMPONENTS.navigator,
      component: PANEL_COMPONENTS.navigator,
      title: 'Database',
      position: { direction: 'left' },
      initialWidth: 280,
    })
  }

  function saveLayout() {
    if (!api.value || !import.meta.client) return
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(api.value.toJSON()))
  }

  function loadLayout(): object | null {
    if (!import.meta.client) return null

    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY)
    if (!raw) return null

    try {
      return JSON.parse(raw)
    }
    catch {
      // A layout from an older build is not worth recovering; start fresh.
      localStorage.removeItem(LAYOUT_STORAGE_KEY)
      return null
    }
  }

  /**
   * Puts the workbench back the way it starts, rather than leaving an empty
   * window: the explorer returns to the left and a welcome tab fills the space
   * beside it.
   *
   * A reset is about the arrangement, so it asks before dropping a tab with
   * unsaved work, and a single refusal calls the whole thing off — once the
   * layout has been torn down there is no part of it left to keep.
   */
  async function resetLayout() {
    if (!api.value) return

    for (const panel of api.value.panels) {
      if (!(await closeGuards.mayClose(panel.id))) return
    }

    if (import.meta.client) localStorage.removeItem(LAYOUT_STORAGE_KEY)

    api.value.clear()
    seedDefaultLayout(api.value)
  }

  return {
    api,
    revision,
    setApi,
    navigatorOpen,
    activePanel,
    closePanel,
    closeActivePanel,
    closeOthers,
    closeToTheRight,
    closeAll,
    hasClosed,
    reopenClosed,
    cycleTabs,
    focus,
    openQuery,
    openTableData,
    openDiagram,
    toggleNavigator,
    saveLayout,
    loadLayout,
    resetLayout,
  }
}
