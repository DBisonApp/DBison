<script setup lang="ts">
import { useModalContext } from '@kolirt/vue-modal'

/** What "About DBison" opens. The Help item used to have no action at all. */
defineProps<{ version: string }>()

defineOptions({ modalGroup: 'dialog' })

const { close } = useModalContext()
const { isAvailable, bridge } = useDatabaseBridge()

/**
 * Where the app writes its log, so a bug report can say where to look. Asked
 * for on open rather than known statically: the path is the main process's
 * to decide, and a browser tab has no log at all.
 */
const logPath = ref<string | null>(null)

onMounted(async () => {
  if (!isAvailable.value) return
  try {
    logPath.value = (await bridge().logPath()).path
  }
  catch {
    // The dialog is still useful without the path; the row simply stays hidden.
  }
})

function openLogFolder() {
  if (!logPath.value) return
  bridge().reveal(logPath.value).catch(() => {})
}
</script>

<template>
  <AppDialog title="About DBison" size="sm">
    <div class="grid gap-4 p-4">
      <div class="grid gap-1">
        <p class="text-muted">
          A desktop client for managing database connections and queries.
        </p>
        <p class="selectable text-faint">
          Version {{ version }}
        </p>
      </div>

      <div v-if="logPath" class="grid gap-1">
        <p class="text-muted">
          Log file
        </p>
        <p class="selectable break-all font-mono text-xs text-faint" :title="logPath">
          {{ logPath }}
        </p>
      </div>

      <footer class="flex items-center justify-between gap-2">
        <button
          v-if="logPath"
          type="button"
          class="btn px-3 py-1.5"
          title="Show the log file in the system file manager"
          @click="openLogFolder"
        >
          Open log folder
        </button>
        <span v-else />

        <button type="button" class="btn btn-accent px-3 py-1.5" autofocus @click="close()">
          Close
        </button>
      </footer>
    </div>
  </AppDialog>
</template>
