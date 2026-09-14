<script setup lang="ts">
/**
 * The one live region in the shell; see `useLiveAnnouncer`. Visually hidden, not
 * `display: none` — a hidden element is not read either.
 */
const { polite, assertive } = useLiveAnnouncer()
</script>

<template>
  <div class="sr-only" aria-live="polite" aria-atomic="true">
    {{ polite }}
  </div>
  <div class="sr-only" aria-live="assertive" aria-atomic="true">
    {{ assertive }}
  </div>
</template>
