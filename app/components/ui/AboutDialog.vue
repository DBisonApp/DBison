<script setup lang="ts">
import { useModalContext } from '@kolirt/vue-modal'

/** What "About DBison" opens. The Help item used to have no action at all. */
defineProps<{ version: string, author: { name: string, email: string | null } }>()

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

/**
 * The legal documents, served under /legal (`modules/legal`). The dialog
 * shows one in place of its own content, so it needs no second modal.
 */
const DOCUMENTS = {
  'eula': 'Licence agreement',
  'privacy': 'Privacy',
  'third-party-notices': 'Third-party notices',
} as const

type LegalDocument = keyof typeof DOCUMENTS

const shown = ref<LegalDocument | null>(null)
const documentText = ref('')

async function showDocument(name: LegalDocument) {
  shown.value = name
  documentText.value = 'Loading…'
  try {
    const response = await fetch(`/legal/${name}.txt`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const text = await response.text()
    if (shown.value === name) documentText.value = text
  }
  catch {
    // The notices are written by a production build; a dev server may not
    // have them yet.
    if (shown.value === name) documentText.value = 'This document is not included in this build.'
  }
}
</script>

<template>
  <AppDialog :title="shown ? DOCUMENTS[shown] : 'About DBison'" :size="shown ? 'lg' : 'sm'">
    <div v-if="shown" class="grid gap-4 p-4">
      <pre class="selectable max-h-[60vh] overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-muted">{{ documentText }}</pre>

      <footer class="flex items-center justify-between gap-2">
        <button type="button" class="btn px-3 py-1.5" @click="shown = null">
          Back
        </button>
        <button type="button" class="btn btn-accent px-3 py-1.5" @click="close()">
          Close
        </button>
      </footer>
    </div>

    <div v-else class="grid gap-4 p-4">
      <div class="grid gap-1">
        <p class="text-muted">
          A desktop client for managing database connections and queries.
        </p>
        <p class="selectable text-faint">
          Version {{ version }}
        </p>
        <p class="text-faint">
          Made by {{ author.name }}<template v-if="author.email">
            ·
            <!-- A new window, which the main process hands to the mail app. -->
            <a :href="`mailto:${author.email}`" target="_blank" class="selectable text-accent-bright hover:underline">{{ author.email }}</a>
          </template>
        </p>
        <p class="text-faint">
          © 2026 {{ author.name }}. All rights reserved.
        </p>
      </div>

      <div class="flex flex-wrap gap-2">
        <button
          v-for="(label, name) in DOCUMENTS"
          :key="name"
          type="button"
          class="btn px-2 py-1 text-xs"
          @click="showDocument(name)"
        >
          {{ label }}
        </button>
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
