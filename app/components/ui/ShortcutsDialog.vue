<script setup lang="ts">
import { useModalContext } from '@kolirt/vue-modal'

/**
 * The keystrokes the app listens for.
 *
 * The rows are handed in by `AppMenuBar` off the same command list that both
 * binds the keys and labels the menu, so this cannot list a shortcut that does
 * nothing — which is exactly what the menu's hints used to do.
 */
const props = defineProps<{ items: { label: string, keys: string, group: string }[] }>()

defineOptions({ modalGroup: 'dialog' })

const { close } = useModalContext()

/** One section per menu, in the order the menus sit on the bar. */
const sections = computed(() => {
  const byGroup = new Map<string, { label: string, keys: string }[]>()
  for (const item of props.items) {
    if (!byGroup.has(item.group)) byGroup.set(item.group, [])
    byGroup.get(item.group)!.push(item)
  }
  return [...byGroup].map(([group, rows]) => ({ group, rows }))
})
</script>

<template>
  <AppDialog title="Keyboard Shortcuts" size="lg">
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="min-h-0 flex-1 overflow-y-auto p-4">
        <div class="columns-1 gap-6 sm:columns-2">
          <section
            v-for="section in sections"
            :key="section.group"
            class="mb-4 break-inside-avoid"
          >
            <h3 class="mb-1.5 px-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
              {{ section.group }}
            </h3>
            <dl class="grid">
              <div
                v-for="item in section.rows"
                :key="item.label"
                class="flex items-center justify-between gap-4 rounded px-2 py-1 odd:bg-sunken"
              >
                <dt class="min-w-0 truncate">
                  {{ item.label }}
                </dt>
                <dd class="shrink-0">
                  <kbd class="kbd">{{ item.keys }}</kbd>
                </dd>
              </div>
            </dl>
          </section>
        </div>
      </div>

      <footer class="flex justify-end border-t border-edge px-4 py-3">
        <button type="button" class="btn btn-accent px-3 py-1.5" autofocus @click="close()">
          Close
        </button>
      </footer>
    </div>
  </AppDialog>
</template>
