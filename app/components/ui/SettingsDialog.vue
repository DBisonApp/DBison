<script setup lang="ts">
import { useModalContext } from '@kolirt/vue-modal'
import { QUERY_LIMIT_OPTIONS, ZOOM_STEPS } from '~/composables/useSettings'

/**
 * The few preferences the app has, in one place.
 *
 * Every row applies as it is changed: there is no Apply button to forget, and
 * a zoom step is something you want to see before deciding on the next one.
 */
defineOptions({ modalGroup: 'dialog' })

const { close } = useModalContext()
const { settings, update, zoomBy, setZoom } = useSettings()
const { theme, setTheme } = useAppTheme()

const zoomPercent = computed(() => `${Math.round(settings.value.zoom * 100)}%`)

function limitLabel(limit: number) {
  return limit >= 1_000_000 ? '1,000,000' : limit.toLocaleString()
}
</script>

<template>
  <AppDialog title="Settings" size="md">
    <div class="grid gap-5 p-4">
      <section class="grid gap-2">
        <h3 class="text-faint">
          Appearance
        </h3>

        <div class="flex items-center justify-between gap-4">
          <label id="settings-theme" class="text-muted">Theme</label>
          <span class="flex rounded-md bg-raised p-0.5" role="radiogroup" aria-labelledby="settings-theme">
            <button
              v-for="option in (['dark', 'light'] as const)"
              :key="option"
              type="button"
              role="radio"
              class="btn btn-ghost px-2 py-0.5 capitalize"
              :data-active="theme === option"
              :aria-checked="theme === option"
              @click="setTheme(option)"
            >
              <AppIcon :name="option === 'dark' ? 'moon' : 'sun'" :size="11" />
              {{ option }}
            </button>
          </span>
        </div>

        <div class="flex items-center justify-between gap-4">
          <span class="text-muted">
            Zoom
            <span class="block text-faint">Ctrl and + or − anywhere</span>
          </span>
          <span class="flex items-center gap-1">
            <button
              type="button"
              class="btn-icon"
              aria-label="Zoom out"
              :disabled="settings.zoom <= ZOOM_STEPS[0]!"
              @click="zoomBy(-1)"
            >
              −
            </button>
            <button
              type="button"
              class="btn btn-ghost min-w-14 justify-center tabular-nums"
              title="Reset to 100%"
              :disabled="settings.zoom === 1"
              @click="setZoom(1)"
            >
              {{ zoomPercent }}
            </button>
            <button
              type="button"
              class="btn-icon"
              aria-label="Zoom in"
              :disabled="settings.zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]!"
              @click="zoomBy(1)"
            >
              +
            </button>
          </span>
        </div>
      </section>

      <section class="grid gap-2">
        <h3 class="text-faint">
          Queries
        </h3>

        <label class="flex items-center justify-between gap-4">
          <span class="text-muted">
            Default row limit
            <span class="block text-faint">What a new query tab starts with; each tab can change its own</span>
          </span>
          <select
            class="field w-auto bg-surface px-1.5 py-1"
            :value="settings.queryLimit"
            @change="update({ queryLimit: Number(($event.target as HTMLSelectElement).value) })"
          >
            <option v-for="option in QUERY_LIMIT_OPTIONS" :key="option" :value="option">
              {{ limitLabel(option) }}
            </option>
          </select>
        </label>
      </section>

      <section class="grid gap-2">
        <h3 class="text-faint">
          Safety
        </h3>

        <label class="flex items-start justify-between gap-4">
          <span class="text-muted">
            Ask before every save
            <span class="block text-faint">
              Connections marked read-only always ask. This asks on the others too.
            </span>
          </span>
          <input
            type="checkbox"
            class="mt-1 accent-accent"
            :checked="settings.confirmAllWrites"
            @change="update({ confirmAllWrites: ($event.target as HTMLInputElement).checked })"
          >
        </label>
      </section>

      <footer class="flex justify-end">
        <button type="button" class="btn btn-accent px-3 py-1.5" @click="close()">
          Done
        </button>
      </footer>
    </div>
  </AppDialog>
</template>
