<script setup lang="ts">
import { DockviewVue, themeAbyss, themeLight } from 'dockview-vue'
import type { DockviewReadyEvent } from 'dockview-vue'

import DiagramPanel from './panels/DiagramPanel.vue'
import ExplorerPanel from './panels/ExplorerPanel.vue'
import QueryPanel from './panels/QueryPanel.vue'
import TableDataPanel from './panels/TableDataPanel.vue'
import WelcomePanel from './panels/WelcomePanel.vue'
import WorkbenchTab from './WorkbenchTab.vue'
import WorkbenchWatermark from './WorkbenchWatermark.vue'

const { theme } = useAppTheme()
const { setApi, loadLayout, saveLayout, api } = useWorkbench()

/** The panel registry dockview resolves `component: '<key>'` against. */
const components = {
  [PANEL_COMPONENTS.navigator]: panelComponent(ExplorerPanel),
  [PANEL_COMPONENTS.welcome]: panelComponent(WelcomePanel),
  [PANEL_COMPONENTS.query]: panelComponent(QueryPanel),
  [PANEL_COMPONENTS.tableData]: panelComponent(TableDataPanel),
  [PANEL_COMPONENTS.diagram]: panelComponent(DiagramPanel),
}

const watermarkComponent = panelComponent(WorkbenchWatermark)
const tabComponent = panelComponent(WorkbenchTab)

// The window asks before closing on unsaved work; this is what tells it.
useCloseGuards().reportToWindow()

const dockviewTheme = computed(() => (theme.value === 'light' ? themeLight : themeAbyss))

function onReady(event: DockviewReadyEvent) {
  setApi(event.api)

  const saved = loadLayout()

  if (saved) {
    try {
      event.api.fromJSON(saved as never)

      // A layout saved with the last tab closed would restore as a blank
      // window, which is no way to open an app; seed it instead.
      if (event.api.panels.length) return
    }
    catch {
      // Panel components can disappear between builds; fall through to default.
    }

    event.api.clear()
  }

  seedDefaultLayout(event.api)
}

// Persist on change rather than on unload: an Electron window can be closed
// without a reliable beforeunload.
let disposeListener: (() => void) | undefined

watch(api, (value) => {
  disposeListener?.()
  if (!value) return

  const listener = value.onDidLayoutChange(() => saveLayout())
  disposeListener = () => listener.dispose()
})

onBeforeUnmount(() => disposeListener?.())
</script>

<template>
  <DockviewVue
    class="h-full"
    :components="components"
    :watermark-component="watermarkComponent"
    :default-tab-component="tabComponent"
    :theme="dockviewTheme"
    :single-tab-mode="'default'"
    :disable-floating-groups="false"
    @ready="onReady"
  />
</template>
