<script setup lang="ts">
import type { ConnectionProfile } from '#shared/db-types'

/**
 * A connection's tint and its read-only mark, wherever its name is shown.
 *
 * The two facts a person wants before running anything are "which server" and
 * "may I write to it". The name answers the first only if the names differ
 * enough; a colour answers it from across the room, and the lock answers the
 * second without a tooltip.
 */
const props = defineProps<{
  profile: Pick<ConnectionProfile, 'color' | 'readOnly'> | null | undefined
  /** Draw the lock too, where there is room for it. */
  lock?: boolean
}>()

const color = computed(() => props.profile?.color ?? null)
const readOnly = computed(() => Boolean(props.profile?.readOnly))
</script>

<template>
  <span v-if="color || (lock && readOnly)" class="inline-flex shrink-0 items-center gap-1">
    <span
      v-if="color"
      class="inline-block size-2.5 rounded-sm ring-1 ring-black/20"
      :style="{ backgroundColor: color }"
      role="img"
      aria-label="Connection colour"
    />
    <AppIcon
      v-if="lock && readOnly"
      name="lock"
      :size="10"
      class="text-warning"
      title="Marked read-only: writes ask first"
      aria-label="Read-only connection"
    />
  </span>
</template>
