<script setup lang="ts">
import { useModalContext } from '@kolirt/vue-modal'

/**
 * The keystrokes the app listens for.
 *
 * The rows are handed in by `AppMenuBar` off the same command list that both
 * binds the keys and labels the menu, so this cannot list a shortcut that does
 * nothing — which is exactly what the menu's hints used to do.
 */
defineProps<{ items: { label: string, keys: string }[] }>()

defineOptions({ modalGroup: 'dialog' })

const { close } = useModalContext()
</script>

<template>
  <AppDialog title="Keyboard Shortcuts" size="sm">
    <div class="grid gap-4 p-4">
      <dl class="grid gap-1">
        <div
          v-for="item in items"
          :key="item.label"
          class="flex items-center justify-between gap-4 rounded px-2 py-1.5 odd:bg-sunken"
        >
          <dt class="text-muted">
            {{ item.label }}
          </dt>
          <dd><kbd class="kbd">{{ item.keys }}</kbd></dd>
        </div>
      </dl>

      <footer class="flex justify-end">
        <button type="button" class="btn btn-accent px-3 py-1.5" autofocus @click="close()">
          Close
        </button>
      </footer>
    </div>
  </AppDialog>
</template>
