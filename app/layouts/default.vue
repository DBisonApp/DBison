<script setup lang="ts">
/**
 * The desktop chrome: a menu bar on top, a status bar at the bottom, and a
 * single flexible region in between that the routed page fills edge to edge.
 */
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden bg-bg text-content">
    <AppMenuBar />

    <main class="min-h-0 flex-1">
      <slot />
    </main>

    <AppStatusBar />

    <AppLiveRegion />

    <AppModalHost />
    <CommandPalette />
  </div>
</template>
