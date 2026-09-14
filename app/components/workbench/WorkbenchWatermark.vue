<script setup lang="ts">
import type { IWatermarkPanelProps } from 'dockview-vue'

/**
 * Shown by dockview whenever a group has no panels left. Watermarks receive
 * `{ group, containerApi }` rather than the usual panel props.
 */
defineProps<{ params: IWatermarkPanelProps }>()

const { openQuery } = useWorkbench()
const { activeId, profiles } = useConnections()
</script>

<template>
  <div class="app-grid-field flex h-full flex-col items-center justify-center gap-4 bg-bg">
    <!-- The mark as a ghost: enough to make an empty split feel like part of
         the app rather than a hole in it. -->
    <AppLogo :size="56" tone="current" class="text-faint opacity-25" />

    <p class="text-faint">
      Nothing open here
    </p>

    <button
      type="button"
      class="btn btn-outline"
      :disabled="!profiles.length"
      @click="openQuery({ connectionId: activeId })"
    >
      <AppIcon name="play" :size="12" />
      New query
    </button>
  </div>
</template>
