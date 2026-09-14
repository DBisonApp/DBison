<script setup lang="ts">
import type { IDockviewPanelProps } from 'dockview-vue'

defineProps<{ params: IDockviewPanelProps }>()

const { openQuery } = useWorkbench()
const { activeId, profiles } = useConnections()
const { openConnectionDialog } = useDialogs()

const shortcuts = [
  { keys: ['Ctrl', 'Enter'], label: 'Run the current statement' },
  { keys: ['Ctrl', '1'], label: 'Show or hide the explorer' },
  { keys: ['Esc'], label: 'Stop a statement in flight' },
]

const gestures = [
  { icon: 'layout', label: 'Drag a tab', detail: 'Split the workspace anywhere' },
  { icon: 'table', label: 'Click a table', detail: 'Open its data in a grid' },
  { icon: 'search', label: 'Filter the explorer', detail: 'Reaches column names too' },
] as const
</script>

<template>
  <div
    class="app-aurora app-grid-field flex h-full flex-col items-center justify-center gap-8 overflow-auto bg-bg p-8"
  >
    <header class="flex flex-col items-center gap-3 text-center">
      <!-- The mark at the one size where it is a picture rather than an icon. -->
      <AppLogo :size="72" class="drop-shadow-[0_6px_24px_var(--app-accent-line)]" />

      <h1 class="font-display text-4xl font-bold tracking-[0.18em] app-gradient-text">
        DBISON
      </h1>

      <p class="max-w-sm text-muted">
        A database workspace that stays out of the way.
      </p>
    </header>

    <div class="flex items-center gap-2">
      <button type="button" class="btn btn-accent px-3.5 py-2" @click="openConnectionDialog()">
        <AppIcon name="plus" />
        New connection
      </button>

      <button
        type="button"
        class="btn btn-outline px-3.5 py-2"
        :disabled="!profiles.length"
        :title="profiles.length ? undefined : 'Add a connection first'"
        @click="openQuery({ connectionId: activeId })"
      >
        <AppIcon name="play" :size="12" />
        New query
      </button>
    </div>

    <div class="grid gap-8 sm:grid-cols-2">
      <section class="grid content-start gap-2">
        <h2 class="mb-1 flex items-center gap-1.5 text-[10px] font-bold tracking-[0.08em] text-faint uppercase">
          <AppIcon name="keyboard" :size="12" />
          Keys
        </h2>

        <div
          v-for="shortcut in shortcuts"
          :key="shortcut.label"
          class="flex items-center gap-2.5"
        >
          <span class="flex shrink-0 items-center gap-1">
            <template v-for="(key, index) in shortcut.keys" :key="key">
              <span v-if="index" class="text-faint">+</span>
              <kbd class="kbd">{{ key }}</kbd>
            </template>
          </span>
          <span class="text-muted">{{ shortcut.label }}</span>
        </div>
      </section>

      <section class="grid content-start gap-2">
        <h2 class="mb-1 flex items-center gap-1.5 text-[10px] font-bold tracking-[0.08em] text-faint uppercase">
          <AppIcon name="bolt" :size="12" />
          Gestures
        </h2>

        <div
          v-for="gesture in gestures"
          :key="gesture.label"
          class="flex items-center gap-2.5"
        >
          <span class="flex size-6 shrink-0 items-center justify-center rounded-md bg-surface text-accent">
            <AppIcon :name="gesture.icon" :size="13" />
          </span>
          <span>
            <span class="text-content">{{ gesture.label }}</span>
            <span class="text-faint"> · {{ gesture.detail }}</span>
          </span>
        </div>
      </section>
    </div>
  </div>
</template>
