<script setup lang="ts">
const connections = useConnections()
const { active } = connections

const state = computed(() => (active.value ? connections.stateOf(active.value.id) : null))
const reconnecting = computed(() => Boolean(active.value && connections.reconnecting.value[active.value.id]))

const target = computed(() => {
  const profile = active.value
  if (!profile) return ''

  if (connections.driverOf(profile).target === 'file') return profile.file ?? ''

  const user = profile.username ? `${profile.username}@` : ''
  const database = profile.database ? `/${profile.database}` : ''
  return `${user}${profile.host ?? ''}:${profile.port ?? ''}${database}`
})

/** The dot's colour, and whether it should be breathing. */
const dot = computed(() => {
  if (reconnecting.value) return { class: 'bg-warning', pulse: true }

  switch (state.value?.status) {
    case 'connected': return { class: 'bg-success', pulse: false }
    case 'connecting': return { class: 'bg-warning', pulse: true }
    case 'error': return { class: 'bg-danger', pulse: false }
    default: return { class: 'bg-faint', pulse: false }
  }
})
</script>

<template>
  <div class="app-edge-glow" />

  <footer
    class="flex h-7 shrink-0 items-center gap-0 bg-surface pr-3 pl-2 text-faint"
  >
    <!-- The connection pill. Its own tinted ground, because "which server am I
         about to run this on" is the one thing on this bar worth a glance. -->
    <span
      v-if="active && state"
      class="flex items-center gap-2 rounded-full bg-raised py-0.5 pr-2.5 pl-2"
      :style="active.color ? { boxShadow: `inset 0 0 0 1px ${active.color}` } : undefined"
    >
      <span
        class="size-1.5 rounded-full"
        :class="[dot.class, dot.pulse ? 'app-pulse' : '']"
      />
      <ConnectionSwatch :profile="active" lock />
      <span class="font-medium text-content">{{ active.name }}</span>
      <span class="text-muted">{{ connections.driverOf(active).label }}</span>
    </span>

    <span v-else class="py-0.5 pl-1">No connection</span>

    <!-- The path is the elastic part of the bar: a long one gives way before
         the version and the error do, and the whole of it is in the tooltip. -->
    <span v-if="target" class="ml-3 min-w-0 truncate font-mono text-muted" :title="target">{{ target }}</span>

    <span v-if="reconnecting" class="ml-3 truncate text-warning">Connection lost — reconnecting…</span>

    <span
      v-else-if="state?.status === 'error'"
      class="selectable ml-3 truncate text-danger"
    >{{ state.error?.lost ? 'Connection lost. ' : '' }}{{ state.error?.message }}</span>

    <span v-else-if="state?.serverVersion" class="ml-3 shrink-0">{{ state.serverVersion }}</span>

    <span class="ml-auto flex items-center gap-3 pl-3">
      <span class="font-mono">UTF-8</span>
      <AppLogo :size="13" tone="current" class="opacity-40" />
    </span>
  </footer>
</template>
