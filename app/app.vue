<script setup lang="ts">
const { restore } = useAppTheme()
const { applyZoom } = useSettings()

// Runs before paint on the client so the shell never flashes the wrong palette.
onBeforeMount(restore)
// Chromium keeps its own per-origin zoom, which may disagree with the saved
// setting after a cleared profile; the setting wins.
onMounted(applyZoom)
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
