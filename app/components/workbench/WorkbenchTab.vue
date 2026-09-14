<script setup lang="ts">
import type { IDockviewPanelHeaderProps } from 'dockview-vue'

/**
 * The tab itself, drawn by the app rather than by dockview.
 *
 * dockview's own tab closes the panel the moment its X is clicked, and offers
 * no way to say "not yet". This one asks the panel first, through the close
 * guards, so a script with unsaved changes or a grid with staged edits gets
 * the same question from the X that it gets from Ctrl+W. The class names are
 * dockview's, so its theme styles the tab exactly as it did before.
 *
 * It also carries the gestures a tab strip is expected to answer: a middle
 * click closes, and a right click offers the "close the others" family that
 * anyone with twenty tabs open goes looking for.
 */
const props = defineProps<{ params: IDockviewPanelHeaderProps }>()

const { closePanel, closeOthers, closeToTheRight, closeAll } = useWorkbench()

const title = ref(props.params.api.title ?? '')
const listener = props.params.api.onDidTitleChange((event) => { title.value = event.title })
onBeforeUnmount(() => listener.dispose())

/**
 * The navigator is a sidebar rather than a document: its tab has no siblings
 * to close, and the commands that close documents leave it alone anyway.
 */
const isDocument = computed(() => props.params.api.id !== PANEL_COMPONENTS.navigator)

function close(event: MouseEvent) {
  event.preventDefault()
  event.stopPropagation()
  closePanel(props.params.api.id)
}

/** Middle click, which is how every tab strip since the browser's closes. */
function onAuxClick(event: MouseEvent) {
  if (event.button !== 1) return
  close(event)
}
</script>

<template>
  <ContextMenu>
    <ContextMenuTrigger>
      <div class="dv-default-tab" @auxclick="onAuxClick">
        <div class="dv-default-tab-content">
          {{ title }}
        </div>
        <div
          class="dv-default-tab-action"
          role="button"
          tabindex="-1"
          :aria-label="`Close ${title}`"
          @pointerdown.prevent
          @click="close"
        >
          <AppIcon name="close" :size="11" aria-hidden="true" />
        </div>
      </div>
    </ContextMenuTrigger>

    <ContextMenuContent>
      <ContextMenuItem icon="close" :hint="formatKeys('Ctrl+W')" @select="closePanel(params.api.id)">
        Close
      </ContextMenuItem>

      <template v-if="isDocument">
        <ContextMenuItem @select="closeOthers(params.api.id)">
          Close Others
        </ContextMenuItem>
        <ContextMenuItem @select="closeToTheRight(params.api.id)">
          Close to the Right
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem @select="closeAll()">
          Close All
        </ContextMenuItem>
      </template>
    </ContextMenuContent>
  </ContextMenu>
</template>
