<script setup lang="ts">
import type { EditRole } from '#shared/db-types'
import type { IconName } from '~/components/ui/AppIcon.vue'

/**
 * The window's menu bar.
 *
 * Built on Reka's `Menubar` (through `~/components/ui/menubar`) rather than by
 * hand: one menu open at a time, dragging the pointer along the bar moving the
 * open menu with it, Alt and the arrow keys walking it, typeahead, Esc closing,
 * focus handed back to the trigger, panels that flip when the window edge is
 * close, and the ARIA roles that make it a menu bar to a screen reader. None of
 * that was true of the `openMenu = ref<string>()` version this replaces.
 *
 * Every row is an `AppCommand`, which carries its own keystroke. `useShortcuts`
 * binds that same list to the window, so the hints printed here are the keys
 * that actually work.
 */

const { theme, toggle } = useAppTheme()
const palette = useCommandPalette()
const {
  openQuery,
  toggleNavigator,
  resetLayout,
  navigatorOpen,
  activePanel,
  closeActivePanel,
  hasClosed,
  reopenClosed,
  cycleTabs,
} = useWorkbench()
const { activeId, profiles, importProfiles, exportProfiles } = useConnections()
const { openConnectionDialog, openAbout, openShortcuts, openSettings } = useDialogs()
const queryPanels = useQueryPanels()
const { isAvailable, bridge } = useDatabaseBridge()
const { settings, zoomBy, setZoom } = useSettings()
const registry = useCommandRegistry()
const refreshables = useRefreshables()
const explorer = useExplorer()

interface AppCommand {
  label: string
  icon?: IconName
  /** Written once, matched by `useShortcuts` and printed by this bar. */
  keys?: string
  disabled?: boolean
  /**
   * The keystroke is Chromium's own — Ctrl+Z, Ctrl+V — and already works
   * everywhere text is edited. The row prints it but must not bind it: a
   * binding here would steal it from the field that was handling it fine.
   */
  native?: boolean
  run: () => void
}

type CommandId =
  | 'newQuery'
  | 'newConnection'
  | 'importConnections'
  | 'exportConnections'
  | 'openFile'
  | 'saveFile'
  | 'saveFileAs'
  | 'saveQuery'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'selectAll'
  | 'formatSql'
  | 'commandPalette'
  | 'refresh'
  | 'settings'
  | 'closeTab'
  | 'reopenTab'
  | 'nextTab'
  | 'previousTab'
  | 'exit'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'resetLayout'
  | 'shortcuts'
  | 'openLog'
  | 'about'

/** Which menu each command is drawn in; the palette shows it as a prefix. */
const GROUP_OF: Record<CommandId, string> = {
  newQuery: 'File',
  newConnection: 'File',
  importConnections: 'File',
  exportConnections: 'File',
  openFile: 'File',
  saveFile: 'File',
  saveFileAs: 'File',
  saveQuery: 'File',
  closeTab: 'File',
  settings: 'File',
  exit: 'File',
  undo: 'Edit',
  redo: 'Edit',
  cut: 'Edit',
  copy: 'Edit',
  paste: 'Edit',
  selectAll: 'Edit',
  formatSql: 'Edit',
  commandPalette: 'View',
  reopenTab: 'View',
  nextTab: 'View',
  previousTab: 'View',
  refresh: 'View',
  zoomIn: 'View',
  zoomOut: 'View',
  zoomReset: 'View',
  resetLayout: 'View',
  shortcuts: 'Help',
  openLog: 'Help',
  about: 'Help',
}

/** An Edit menu row that Chromium performs against whatever has focus. */
function editRole(label: string, role: EditRole, keys: string, icon?: IconName): AppCommand {
  return {
    label,
    icon,
    keys,
    native: true,
    disabled: !isAvailable.value,
    run: () => { bridge().editAction(role).catch(() => {}) },
  }
}

// Annotated rather than inferred: `satisfies` would keep each row's own literal
// shape, and a row without a `keys` would then have no such property to read.
const commands = computed<Record<CommandId, AppCommand>>(() => ({
  newQuery: {
    label: 'New Query',
    icon: 'play',
    keys: 'Ctrl+N',
    // Nothing to point a query at until a connection exists.
    disabled: !profiles.value.length,
    run: () => openQuery({ connectionId: activeId.value }),
  },
  newConnection: {
    label: 'New Connection…',
    icon: 'plus',
    keys: 'Ctrl+Shift+N',
    run: () => { openConnectionDialog() },
  },
  // Both go through the system file dialogs, which only the desktop app has.
  importConnections: {
    label: 'Import Connections…',
    icon: 'import',
    disabled: !isAvailable.value,
    run: () => { importProfiles().catch(() => {}) },
  },
  exportConnections: {
    label: 'Export Connections…',
    icon: 'fileJson',
    disabled: !isAvailable.value || !profiles.value.length,
    run: () => { exportProfiles().catch(() => {}) },
  },
  openFile: {
    label: 'Open SQL File…',
    icon: 'folderOpen',
    keys: 'Ctrl+O',
    // Only the desktop app can read a file; a browser tab has no disk.
    disabled: !isAvailable.value,
    run: () => { queryPanels.openSqlFile() },
  },
  // Save and Format mean the focused query tab. The tab handles the chord
  // itself while it has focus; these rows are for the menu, and for when the
  // focus is elsewhere — on the explorer, say — but the tab is still active.
  saveFile: {
    label: 'Save',
    icon: 'save',
    keys: 'Ctrl+S',
    disabled: !queryPanels.active.value || !isAvailable.value,
    run: () => { queryPanels.active.value?.save() },
  },
  saveFileAs: {
    label: 'Save As…',
    icon: 'save',
    keys: 'Ctrl+Shift+S',
    disabled: !queryPanels.active.value || !isAvailable.value,
    run: () => { queryPanels.active.value?.saveAs() },
  },
  // Not a file: the statement kept under a name, in the app's own shelf.
  saveQuery: {
    label: 'Save Query…',
    icon: 'bookmarkPlus',
    keys: 'Ctrl+Alt+S',
    disabled: !queryPanels.active.value || !isAvailable.value,
    run: () => { queryPanels.active.value?.saveQuery() },
  },
  undo: editRole('Undo', 'undo', 'Ctrl+Z'),
  redo: editRole('Redo', 'redo', 'Ctrl+Y'),
  cut: editRole('Cut', 'cut', 'Ctrl+X'),
  copy: editRole('Copy', 'copy', 'Ctrl+C', 'copy'),
  paste: editRole('Paste', 'paste', 'Ctrl+V'),
  selectAll: editRole('Select All', 'selectAll', 'Ctrl+A'),
  formatSql: {
    label: 'Format SQL',
    icon: 'format',
    keys: 'Ctrl+Shift+F',
    disabled: !queryPanels.active.value,
    run: () => { queryPanels.active.value?.format() },
  },
  commandPalette: {
    label: 'Command Palette',
    icon: 'search',
    keys: 'Ctrl+Shift+P',
    // Bound by the palette itself, which also answers to Ctrl+K.
    native: true,
    run: () => { palette.show() },
  },
  refresh: {
    label: 'Refresh',
    icon: 'refresh',
    keys: 'F5',
    // The active tab decides what a refresh is; with no tab that knows, the
    // explorer re-reads the schema, which is the next most likely wish.
    run: () => { (refreshables.active.value ?? (() => explorer.refresh()))() },
  },
  settings: {
    label: 'Settings…',
    icon: 'settings',
    keys: 'Ctrl+,',
    run: () => { openSettings() },
  },
  zoomIn: {
    label: 'Zoom In',
    icon: 'zoomIn',
    keys: 'Ctrl+=',
    run: () => zoomBy(1),
  },
  zoomOut: {
    label: 'Zoom Out',
    icon: 'zoomOut',
    keys: 'Ctrl+-',
    run: () => zoomBy(-1),
  },
  zoomReset: {
    label: 'Reset Zoom',
    keys: 'Ctrl+0',
    run: () => setZoom(1),
  },
  closeTab: {
    label: 'Close Tab',
    icon: 'close',
    keys: 'Ctrl+W',
    disabled: !activePanel.value,
    run: () => closeActivePanel(),
  },
  reopenTab: {
    label: 'Reopen Closed Tab',
    keys: 'Ctrl+Shift+T',
    disabled: !hasClosed.value,
    run: () => reopenClosed(),
  },
  // Ctrl+Tab reaches the window as a plain keydown whose key is "Tab", so it
  // binds like any other chord; Chromium has no use of its own for it here.
  nextTab: {
    label: 'Next Tab',
    keys: 'Ctrl+Tab',
    disabled: !activePanel.value,
    run: () => cycleTabs(1),
  },
  previousTab: {
    label: 'Previous Tab',
    keys: 'Ctrl+Shift+Tab',
    disabled: !activePanel.value,
    run: () => cycleTabs(-1),
  },
  exit: {
    label: 'Exit',
    icon: 'close',
    run: () => window.close(),
  },
  resetLayout: {
    label: 'Reset Layout',
    icon: 'layout',
    run: () => resetLayout(),
  },
  shortcuts: {
    label: 'Keyboard Shortcuts',
    icon: 'keyboard',
    run: () => { openShortcuts(bindings.value) },
  },
  // Reveals the app's log file in the system file manager, for the bug report
  // that needs it. The log is the main process's; a browser tab has none.
  openLog: {
    label: 'Open Log Folder',
    icon: 'folderOpen',
    disabled: !isAvailable.value,
    run: () => {
      bridge().logPath()
        .then(({ path }) => bridge().reveal(path))
        .catch(() => {})
    },
  },
  about: {
    label: 'About DBison',
    icon: 'database',
    run: () => { openAbout() },
  },
}))

/**
 * The explorer toggle is a checkbox row rather than a command, so its keystroke
 * is named here and bound below with the rest.
 */
const explorerKeys = 'Ctrl+1'

const bound = computed(() => [
  ...Object.values(commands.value),
  { label: 'Toggle Database Explorer', keys: explorerKeys, run: () => toggleNavigator() },
])

// Native rows keep their keystroke for Chromium; see `AppCommand.native`.
// Ctrl+= is also matched as Ctrl++ so the key beside 0 works without Shift.
useShortcuts(() => bound.value.flatMap((command) => {
  if (command.native) return []
  if (command.keys === 'Ctrl+=') return [command, { ...command, keys: 'Ctrl++' }]
  return [command]
}))

// Everything the menu can do, the palette can do: same list, same state.
const unregister = registry.register('menu', () => [
  ...(Object.entries(commands.value) as [CommandId, AppCommand][])
    .filter(([id]) => id !== 'commandPalette')
    .map(([id, command]) => ({
      id: `menu:${id}`,
      label: command.label.replace(/…$/, ''),
      group: GROUP_OF[id],
      icon: command.icon,
      keys: command.keys,
      disabled: command.disabled,
      run: command.run,
    })),
  {
    id: 'menu:explorer',
    label: 'Toggle Database Explorer',
    group: 'View',
    icon: 'panelLeft',
    keys: explorerKeys,
    run: () => toggleNavigator(),
  },
  {
    id: 'menu:theme',
    label: theme.value === 'dark' ? 'Switch to Light Theme' : 'Switch to Dark Theme',
    group: 'View',
    icon: theme.value === 'dark' ? 'sun' : 'moon',
    run: () => toggle(),
  },
])
onBeforeUnmount(unregister)

/**
 * The scripts opened or saved most recently, for the File menu. Read through
 * the settings so the list is the one the query tabs write to.
 */
const recentFiles = computed(() => settings.value.recentFiles)

/** The bound subset, for the dialog that lists them. */
const bindings = computed(() =>
  bound.value
    .filter((command) => !!command.keys)
    .map((command) => ({ label: command.label, keys: formatKeys(command.keys!) })),
)
</script>

<template>
  <!-- This is the window's title bar: `.app-titlebar` makes it draggable, keeps
       it clear of the native window buttons, and exempts the menus and buttons
       from the drag so they stay clickable. -->
  <header class="app-titlebar flex h-10 shrink-0 items-center bg-surface px-2.5">
    <!-- The brand lockup. The mark carries the only warm colour in the app and
         the wordmark is the only place the display face is used at this size,
         so the corner of the window is unmistakably this app. -->
    <span class="mr-3 flex items-center gap-2 select-none">
      <AppLogo :size="19" />
      <span class="font-display text-[15px] font-bold tracking-[0.14em] app-gradient-text">
        DBISON
      </span>
    </span>

    <Menubar>
      <MenubarMenu>
        <MenubarTrigger>File</MenubarTrigger>
        <MenubarContent>
          <MenubarItem
            v-for="key in ['newQuery', 'newConnection', 'importConnections', 'exportConnections'] as const"
            :key="key"
            :icon="commands[key].icon"
            :hint="formatKeys(commands[key].keys ?? '')"
            :disabled="commands[key].disabled"
            @select="commands[key].run()"
          >
            {{ commands[key].label }}
          </MenubarItem>

          <MenubarSeparator />

          <MenubarItem
            v-for="key in ['openFile', 'saveFile', 'saveFileAs', 'saveQuery'] as const"
            :key="key"
            :icon="commands[key].icon"
            :hint="formatKeys(commands[key].keys ?? '')"
            :disabled="commands[key].disabled"
            @select="commands[key].run()"
          >
            {{ commands[key].label }}
          </MenubarItem>

          <!-- Named by file only; the full path is in the tooltip, where it
               does not push the menu to the width of the longest one. -->
          <template v-if="recentFiles.length">
            <MenubarSeparator />

            <MenubarLabel>Recent</MenubarLabel>

            <MenubarItem
              v-for="path in recentFiles"
              :key="path"
              icon="file"
              :title="path"
              :disabled="!isAvailable"
              @select="queryPanels.openRecent(path)"
            >
              {{ fileName(path) }}
            </MenubarItem>
          </template>

          <MenubarSeparator />

          <MenubarItem
            :icon="commands.closeTab.icon"
            :hint="formatKeys(commands.closeTab.keys ?? '')"
            :disabled="commands.closeTab.disabled"
            @select="commands.closeTab.run()"
          >
            {{ commands.closeTab.label }}
          </MenubarItem>

          <MenubarSeparator />

          <MenubarItem
            :icon="commands.settings.icon"
            :hint="formatKeys(commands.settings.keys ?? '')"
            @select="commands.settings.run()"
          >
            {{ commands.settings.label }}
          </MenubarItem>

          <MenubarSeparator />

          <MenubarItem :icon="commands.exit.icon" @select="commands.exit.run()">
            {{ commands.exit.label }}
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>Edit</MenubarTrigger>
        <MenubarContent>
          <MenubarItem
            v-for="key in ['undo', 'redo'] as const"
            :key="key"
            :icon="commands[key].icon"
            :hint="formatKeys(commands[key].keys ?? '')"
            :disabled="commands[key].disabled"
            @select="commands[key].run()"
          >
            {{ commands[key].label }}
          </MenubarItem>

          <MenubarSeparator />

          <MenubarItem
            v-for="key in ['cut', 'copy', 'paste', 'selectAll'] as const"
            :key="key"
            :icon="commands[key].icon"
            :hint="formatKeys(commands[key].keys ?? '')"
            :disabled="commands[key].disabled"
            @select="commands[key].run()"
          >
            {{ commands[key].label }}
          </MenubarItem>

          <MenubarSeparator />

          <MenubarItem
            :icon="commands.formatSql.icon"
            :hint="formatKeys(commands.formatSql.keys ?? '')"
            :disabled="commands.formatSql.disabled"
            @select="commands.formatSql.run()"
          >
            {{ commands.formatSql.label }}
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>View</MenubarTrigger>
        <MenubarContent>
          <MenubarCheckboxItem
            :model-value="navigatorOpen"
            :hint="formatKeys(explorerKeys)"
            @update:model-value="toggleNavigator()"
          >
            Database Explorer
          </MenubarCheckboxItem>

          <MenubarCheckboxItem
            :model-value="theme === 'dark'"
            @update:model-value="toggle()"
          >
            Dark Theme
          </MenubarCheckboxItem>

          <MenubarSeparator />

          <MenubarItem
            :icon="commands.commandPalette.icon"
            :hint="formatKeys(commands.commandPalette.keys ?? '')"
            @select="commands.commandPalette.run()"
          >
            {{ commands.commandPalette.label }}
          </MenubarItem>

          <MenubarItem
            v-for="key in ['reopenTab', 'nextTab', 'previousTab'] as const"
            :key="key"
            :icon="commands[key].icon"
            :hint="formatKeys(commands[key].keys ?? '')"
            :disabled="commands[key].disabled"
            @select="commands[key].run()"
          >
            {{ commands[key].label }}
          </MenubarItem>

          <MenubarItem
            :icon="commands.refresh.icon"
            :hint="formatKeys(commands.refresh.keys ?? '')"
            @select="commands.refresh.run()"
          >
            {{ commands.refresh.label }}
          </MenubarItem>

          <MenubarSeparator />

          <MenubarItem
            v-for="key in ['zoomIn', 'zoomOut', 'zoomReset'] as const"
            :key="key"
            :icon="commands[key].icon"
            :hint="formatKeys(commands[key].keys ?? '')"
            @select="commands[key].run()"
          >
            {{ commands[key].label }}
          </MenubarItem>

          <MenubarSeparator />

          <MenubarItem :icon="commands.resetLayout.icon" @select="commands.resetLayout.run()">
            {{ commands.resetLayout.label }}
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>Help</MenubarTrigger>
        <MenubarContent>
          <MenubarItem :icon="commands.shortcuts.icon" @select="commands.shortcuts.run()">
            {{ commands.shortcuts.label }}
          </MenubarItem>

          <MenubarItem
            :icon="commands.openLog.icon"
            :disabled="commands.openLog.disabled"
            @select="commands.openLog.run()"
          >
            {{ commands.openLog.label }}
          </MenubarItem>

          <MenubarSeparator />

          <MenubarItem :icon="commands.about.icon" @select="commands.about.run()">
            {{ commands.about.label }}
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>
    </Menubar>

    <div class="ml-auto flex items-center gap-0.5">
      <button
        type="button"
        class="btn-icon"
        :class="navigatorOpen ? 'text-accent-bright' : ''"
        :title="`Toggle database explorer (${formatKeys(explorerKeys)})`"
        @click="toggleNavigator"
      >
        <AppIcon name="panelLeft" />
      </button>

      <button
        type="button"
        class="btn-icon"
        :title="theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'"
        @click="toggle"
      >
        <AppIcon :name="theme === 'dark' ? 'sun' : 'moon'" />
      </button>
    </div>
  </header>

  <div class="app-edge-glow" />
</template>
