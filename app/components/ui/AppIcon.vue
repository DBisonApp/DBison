<script setup lang="ts">
/**
 * The app's icon vocabulary, on top of `@nuxt/icon`.
 *
 * Call sites name what they mean — `table`, `warning`, `sortAsc` — and this
 * decides which drawing that is, so a change of icon set is a change to one
 * map rather than to fifty templates. Every name resolves to Lucide, whose set
 * is bundled into the build: an Electron window has no network to fetch an
 * icon over, and `nuxt.config.ts` lists these so none is ever requested.
 */
const ICONS = {
  chevronRight: 'lucide:chevron-right',
  chevronDown: 'lucide:chevron-down',
  chevronLeft: 'lucide:chevron-left',
  chevronUp: 'lucide:chevron-up',
  /** The direction a column is ordered in, as the bars a sort is drawn with. */
  sortAsc: 'lucide:arrow-up-narrow-wide',
  sortDesc: 'lucide:arrow-down-wide-narrow',
  /** Both directions at once: the column can be sorted, it is not yet. */
  sortable: 'lucide:chevrons-up-down',
  database: 'lucide:database',
  schema: 'lucide:layers',
  table: 'lucide:table-2',
  column: 'lucide:columns-3',
  play: 'lucide:play',
  stop: 'lucide:square',
  plus: 'lucide:plus',
  refresh: 'lucide:refresh-cw',
  close: 'lucide:x',
  search: 'lucide:search',
  sun: 'lucide:sun',
  moon: 'lucide:moon',
  panelLeft: 'lucide:panel-left',
  /** The record view: one row, stood on end beside the grid. */
  panelRight: 'lucide:panel-right',
  warning: 'lucide:triangle-alert',
  view: 'lucide:eye',
  check: 'lucide:check',
  pencil: 'lucide:pencil',
  trash: 'lucide:trash-2',
  link: 'lucide:link',
  key: 'lucide:key-round',
  /** Follow a foreign key to the row on the other end of it. */
  jump: 'lucide:external-link',
  /*
   * The families a column's values fall into, for the one glyph a grid header
   * has room for. A header that spells `character varying(255)` out spends more
   * width on the type than on the name; the exact type is a tooltip away, and
   * what the eye is actually scanning for — "which of these is a date?" — is a
   * shape, not a word.
   */
  typeText: 'lucide:case-sensitive',
  typeNumber: 'lucide:hash',
  typeBoolean: 'lucide:toggle-left',
  typeDate: 'lucide:calendar',
  typeTime: 'lucide:clock',
  typeDateTime: 'lucide:calendar-clock',
  typeJson: 'lucide:braces',
  typeBinary: 'lucide:binary',
  typeEnum: 'lucide:list',
  bolt: 'lucide:zap',
  server: 'lucide:server',
  keyboard: 'lucide:keyboard',
  layout: 'lucide:layout-dashboard',
  copy: 'lucide:copy',
  expand: 'lucide:maximize-2',
  pin: 'lucide:pin',
  eyeOff: 'lucide:eye-off',
  lock: 'lucide:lock',
  /** A row's overflow menu: the actions that do not fit on the row itself. */
  more: 'lucide:ellipsis',
  plug: 'lucide:plug',
  unplug: 'lucide:unplug',
  /** The ER diagram: tables as boxes, keys as the lines between them. */
  diagram: 'lucide:waypoints',
  /** What the editor has run before. */
  history: 'lucide:history',
  /** Reformat the statement. */
  format: 'lucide:wand-sparkles',
  save: 'lucide:save',
  folderOpen: 'lucide:folder-open',
  file: 'lucide:file-code-2',
  /** A table's definition rather than its rows. */
  structure: 'lucide:list-tree',
  code: 'lucide:code',
  /** The exact count, which is asked for rather than assumed. */
  count: 'lucide:calculator',
  index: 'lucide:list-ordered',
  settings: 'lucide:settings-2',
  zoomIn: 'lucide:zoom-in',
  zoomOut: 'lucide:zoom-out',
  /** A connection's tint, as a swatch to pick. */
  palette: 'lucide:palette',
  /** Take something out of the app as a file. */
  download: 'lucide:download',
  /** The same, as a picture. */
  imageDown: 'lucide:image-down',
  /** A heading connections are grouped under. */
  folder: 'lucide:folder',
  /** A new profile started from an existing one. */
  duplicate: 'lucide:copy-plus',
  /** Connections read from, and written to, a file. */
  import: 'lucide:import',
  fileJson: 'lucide:file-json',
  /** A statement kept under a name, and the act of keeping one. */
  bookmark: 'lucide:bookmark',
  bookmarkPlus: 'lucide:bookmark-plus',
  tag: 'lucide:tag',
  /** A query plan: the tree of steps the engine takes. */
  plan: 'lucide:git-fork',
  /** Rows leaving for a file, rows arriving from one, and the file once written. */
  fileDown: 'lucide:file-down',
  fileUp: 'lucide:file-up',
  folderSearch: 'lucide:folder-search',
  /** A database boxed up by its engine's own tool, and unpacked again. */
  archive: 'lucide:archive',
  archiveRestore: 'lucide:archive-restore',
  /** The command-line tool a backup runs through. */
  terminal: 'lucide:terminal',
} as const

export type IconName = keyof typeof ICONS

const props = withDefaults(
  defineProps<{ name: IconName, size?: number, strokeWidth?: number }>(),
  { size: 14, strokeWidth: 1.8 },
)

const icon = computed(() => ICONS[props.name])

/**
 * Lucide draws at 24px with a 2px stroke; scaled down to the 11–14px this UI
 * uses, that reads heavy. The width is exposed as a variable the collection
 * honours, so a tick can be made bolder where it stands alone.
 */
const style = computed(() => ({
  fontSize: `${props.size}px`,
  '--icon-stroke-width': String(props.strokeWidth),
}))
</script>

<template>
  <Icon
    :name="icon"
    :style="style"
    class="app-icon shrink-0"
    mode="svg"
    aria-hidden="true"
  />
</template>

<style>
/* Unscoped: the SVG is rendered by <Icon>, outside this component's scope. */
svg.app-icon {
  width: 1em;
  height: 1em;
}

/*
 * Lucide carries `stroke-width="2"` on the shapes themselves, not on the root,
 * so the override has to reach them: a presentation attribute loses to any CSS
 * declaration, but only one that actually matches the element carrying it.
 */
svg.app-icon,
svg.app-icon > * {
  stroke-width: var(--icon-stroke-width, 1.8);
}
</style>
