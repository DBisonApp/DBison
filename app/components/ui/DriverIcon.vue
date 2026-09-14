<script setup lang="ts">
import type { DriverId } from '#shared/db-types'

/**
 * The logo of a database engine, where a connection is named.
 *
 * Devicon draws the real marks — the Postgres elephant, the MySQL dolphin —
 * which read faster in a list of connections than a two-letter tag does. Like
 * `AppIcon`, the names resolve here and are listed in `nuxt.config.ts` so the
 * SVGs ship in the bundle rather than being fetched at runtime.
 */
const ICONS: Record<DriverId, string> = {
  postgres: 'devicon:postgresql',
  mysql: 'devicon:mysql',
  mariadb: 'devicon:mariadb',
  sqlite: 'devicon:sqlite',
}

const props = withDefaults(defineProps<{ driver: DriverId, size?: number }>(), { size: 14 })

const icon = computed(() => ICONS[props.driver])
</script>

<template>
  <Icon
    v-if="icon"
    :name="icon"
    :data-driver="driver"
    :style="{ fontSize: `${size}px` }"
    class="driver-icon shrink-0"
    mode="svg"
    aria-hidden="true"
  />
</template>

<style>
/* Unscoped: the SVG is rendered by <Icon>, outside this component's scope. */
svg.driver-icon {
  width: 1em;
  height: 1em;
}

/*
 * The marks are drawn in their brand colours. Postgres and SQLite carry
 * enough light to stand on the dark theme; MySQL's dolphin and MariaDB's seal
 * are a single near-black fill and vanish into it. Those two are lifted to a
 * paler tint of the same hue there, and only there.
 */
[data-theme="dark"] svg.driver-icon[data-driver="mysql"] path {
  fill: #4aa8d8;
}

[data-theme="dark"] svg.driver-icon[data-driver="mariadb"] path {
  fill: #6fbccb;
}
</style>
