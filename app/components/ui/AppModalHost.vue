<script setup lang="ts">
import { ModalOverlay, ModalTarget } from '@kolirt/vue-modal'

/**
 * The single mount point for every dialog in the app. It lives in the layout,
 * above the workbench, so a dialog is never clipped by (or unmounted with) the
 * dockview panel that opened it.
 *
 * The z-indexes are deliberately low and layered: `confirm` sits above `dialog`
 * so a confirmation can be stacked on top of an open form.
 */
</script>

<template>
  <ModalTarget group="dialog" class="z-50">
    <ModalOverlay class="app-modal-overlay" />
  </ModalTarget>

  <ModalTarget group="confirm" class="z-60">
    <ModalOverlay class="app-modal-overlay" />
  </ModalTarget>
</template>

<style>
/* Unscoped: the overlays render inside the targets, not in this component. */
.app-modal-overlay {
  /* The sunken surface rather than plain black, and a light blur: the window
   * behind stays recognisable as the app instead of going flat. */
  background: color-mix(in oklab, var(--app-bg-sunken) 62%, transparent);
  backdrop-filter: blur(2px) saturate(0.8);
}

.app-modal-overlay[data-state="open"] {
  animation: app-modal-fade-in 120ms ease-out;
}

.app-modal-overlay[data-state="closed"] {
  animation: app-modal-fade-out 100ms ease-in forwards;
}

@keyframes app-modal-fade-in {
  from { opacity: 0; }
}

@keyframes app-modal-fade-out {
  to { opacity: 0; }
}
</style>
